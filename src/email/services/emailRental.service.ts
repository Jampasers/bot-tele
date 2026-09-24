import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import type { Api } from "grammy";
import { EmailDomain } from "../../models/EmailDomain.js";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailMailbox } from "../../models/EmailMailbox.js";
import { EmailMessage } from "../../models/EmailMessage.js";
import { EmailOtpService } from "../../models/EmailOtpService.js";
import { EmailPaymentEffect } from "../../models/EmailPaymentEffect.js";
import { EmailProvider } from "../../models/EmailProvider.js";
import { EmailRental, type IEmailRental } from "../../models/EmailRental.js";
import { EmailRentalCounter } from "../../models/EmailRentalCounter.js";
import { EmailRentalPrice } from "../../models/EmailRentalPrice.js";
import { EmailRentalSettings } from "../../models/EmailRentalSettings.js";
import { BalanceLog } from "../../models/BalanceLog.js";
import { User } from "../../models/User.js";
import { getTenantId } from "../../tenant/context.js";
import { decryptSecret, encryptSecret } from "../../services/crypto.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { generateQris } from "../../services/payment/paymentService.js";
import type { PaymentTransaction } from "../../services/payment/types.js";
import { getTenantPaymentClients } from "../../payments/tenantPayment.service.js";
import { claimSettlement, matchesSettlement, reservePaymentAmount } from "../../payments/paymentLedger.service.js";
import { cloudflareEmailDomainProvider } from "../providers/cloudflareDomainProvider.js";
import { imapMailboxProvider, ImapMailboxProviderError } from "../providers/imapProvider.js";
import { assertEmailUsageIndex, commitEmailUsage } from "./emailUsage.service.js";
import { getEligibleMailboxCount, reserveDomainAlias, reserveMailboxCandidate, releaseReservedResource, reserveUserRentalSlot, releaseUserRentalSlot } from "./emailReservation.service.js";

const RESERVATION_MS = 10 * 60_000;
const duplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === 11000;
const isEnabled = (): boolean => process.env.EMAIL_RENTAL_ENABLED === "true";

export interface EmailRentalOption {
  resourceType: "MAILBOX" | "DOMAIN_ALIAS"; providerId?: string; domainId?: string; providerName: string; stock: number; price: number;
}

async function settings() {
  return EmailRentalSettings.findOneAndUpdate({}, { $setOnInsert: {} }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();
}
async function releaseCounter(rentalId: string, userId: string, session?: mongoose.ClientSession): Promise<void> {
  const release = async (transaction?: mongoose.ClientSession): Promise<void> => {
    const rental = await EmailRental.findOneAndUpdate(
      { _id: rentalId, userId, counterReleased: false },
      { $set: { counterReleased: true } }, { returnDocument: "after", ...(transaction ? { session: transaction } : {}) },
    );
    if (rental) await EmailRentalCounter.updateOne({ userId, activeCount: { $gt: 0 } }, { $inc: { activeCount: -1 } }, transaction ? { session: transaction } : undefined);
  };
  if (session) return release(session);
  const ownedSession = await mongoose.startSession();
  try { await ownedSession.withTransaction(() => release(ownedSession)); }
  finally { await ownedSession.endSession(); }
}
async function releaseResource(rental: IEmailRental): Promise<void> {
  await releaseReservedResource(rental.resourceType, rental.resourceId, rental.userId);
}

async function mailboxConnection(mailboxId: string): Promise<void> {
  const mailbox = await EmailMailbox.findById(mailboxId).select("+credentialEncrypted").lean();
  if (!mailbox || !mailbox.enabled || mailbox.status === "BROKEN" || mailbox.status === "DISABLED") {
    throw new Error("Mailbox tidak tersedia.");
  }
  const provider = await EmailProvider.findOne({ _id: mailbox.providerId, enabled: true }).lean();
  if (!provider) throw new Error("Provider IMAP tidak tersedia.");
  const password = decryptSecret(mailbox.credentialEncrypted, "email-mailbox:" + String(mailbox._id) + ":credential");
  await imapMailboxProvider.testConnection({ host: provider.imapHost, port: provider.imapPort, secure: provider.imapSecure,
    username: mailbox.username, password, mailbox: "INBOX" });
  await EmailMailbox.updateOne({ _id: mailbox._id, enabled: true }, {
    $set: { lastCheckedAt: new Date(), lastSuccessfulLoginAt: new Date() }, $unset: { lastError: 1 },
  });
}

async function replaceReservedMailbox(rental: IEmailRental): Promise<IEmailRental | undefined> {
  if (rental.resourceType !== "MAILBOX") return undefined;
  const original = await EmailMailbox.findById(rental.resourceId).lean();
  if (!original) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    let candidate: Awaited<ReturnType<typeof reserveMailboxCandidate>>;
    try {
      candidate = await reserveMailboxCandidate({ serviceId: rental.serviceId, providerId: String(original.providerId), userId: rental.userId,
        reservationExpiresAt: rental.status === "PROCESSING" ? new Date(Date.now() + RESERVATION_MS)
          : rental.expiresAt ?? rental.reservationExpiresAt ?? new Date(Date.now() + RESERVATION_MS) });
    } catch { return undefined; }
    const provider = await EmailProvider.findById(candidate.providerId).lean();
    if (!provider) {
      await releaseReservedResource("MAILBOX", String(candidate._id), rental.userId);
      return undefined;
    }
    const changed = await EmailRental.findOneAndUpdate({ _id: rental._id, userId: rental.userId, status: rental.status, resourceId: rental.resourceId }, {
      $set: {
        resourceId: String(candidate._id), emailAddress: candidate.email, providerId: String(candidate.providerId), providerName: provider.name,
        ...(rental.status === "PROCESSING" ? { reservationExpiresAt: new Date(Date.now() + RESERVATION_MS) } : {}),
      },
    }, { returnDocument: "after" }).lean();
    if (!changed) {
      await releaseReservedResource("MAILBOX", String(candidate._id), rental.userId);
      return undefined;
    }
    const updated = changed as IEmailRental;
    try {
      await mailboxConnection(String(candidate._id));
      return updated;
    } catch (error) {
      if (!(error instanceof ImapMailboxProviderError) || error.kind !== "AUTH") throw error;
      await EmailMailbox.updateOne({ _id: candidate._id }, { $set: { status: "BROKEN", enabled: false, lastCheckedAt: new Date(), lastError: "IMAP authentication failed" } });
      await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "mailbox_broken" });
      // Keep the current rental pointed at the failed (now unavailable) resource
      // until the next successful compare-and-set replacement.
      rental = updated;
    }
  }
  return undefined;
}

async function ensureReservedMailbox(rental: IEmailRental): Promise<IEmailRental> {
  try {
    await mailboxConnection(rental.resourceId);
    return rental;
  } catch (error) {
    if (!(error instanceof ImapMailboxProviderError) || error.kind !== "AUTH") throw new Error("Mailbox sementara tidak dapat diperiksa. Pembayaran belum diproses; coba lagi sebentar.");
    await EmailMailbox.updateOne({ _id: rental.resourceId, status: "RESERVED" }, {
      $set: { status: "BROKEN", enabled: false, lastCheckedAt: new Date(), lastError: "IMAP authentication failed" },
      $unset: { reservedBy: 1, reservedUntil: 1 },
    });
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "mailbox_broken" });
    const replacement = await replaceReservedMailbox(rental);
    if (replacement) return replacement;
    await failAndRelease(rental, rental.status === "PROCESSING");
    throw new Error(rental.status === "PROCESSING"
      ? "Mailbox tidak tersedia dan stok pengganti habis. Pembayaran dikembalikan ke saldo."
      : "Mailbox tidak tersedia dan stok pengganti habis. Reservasi dibatalkan tanpa memotong saldo.");
  }
}

export async function getEmailRentalOptions(serviceId: string): Promise<EmailRentalOption[]> {
  if (!isEnabled()) return [];
  const service = await EmailOtpService.findOne({ _id: serviceId, enabled: true }).lean();
  if (!service) return [];
  const options: EmailRentalOption[] = [];
  const providers = await EmailProvider.find({ enabled: true }).sort({ name: 1 }).lean();
  for (const provider of providers) {
    const stock = await getEligibleMailboxCount(serviceId, String(provider._id)).catch(() => 0);
    if (!stock) continue;
    const price = await EmailRentalPrice.findOne({ serviceId, resourceType: "MAILBOX", providerId: String(provider._id), enabled: true }).lean();
    if (price) options.push({ resourceType: "MAILBOX", providerId: String(provider._id), providerName: provider.name, stock, price: price.price });
  }
  const domains = await EmailDomain.find({ enabled: true, sellable: true, routingMode: "FORWARD" }).sort({ domain: 1 }).lean();
  for (const domain of domains) {
    const collector = await EmailMailbox.findOne({ _id: domain.destinationMailboxId, enabled: true, status: { $in: ["AVAILABLE", "COOLDOWN"] } }).lean();
    if (!collector || !(await EmailProvider.exists({ _id: collector.providerId, enabled: true }))) continue;
    const price = await EmailRentalPrice.findOne({ serviceId, resourceType: "DOMAIN_ALIAS", enabled: true, providerId: { $in: [null] } }).lean();
    if (price) options.push({ resourceType: "DOMAIN_ALIAS", domainId: String(domain._id), providerName: "@" + domain.domain, stock: 1, price: price.price });
  }
  return options;
}

export async function createEmailRentalReservation(input: {
  userId: string; serviceId: string; resourceType: "MAILBOX" | "DOMAIN_ALIAS"; providerId?: string; domainId?: string;
}): Promise<IEmailRental> {
  if (!isEnabled()) throw new Error("Layanan OTP Email sedang dinonaktifkan.");
  await assertEmailUsageIndex();
  const service = await EmailOtpService.findOne({ _id: input.serviceId, enabled: true }).lean();
  if (!service) throw new Error("Layanan OTP tidak tersedia.");
  const options = await getEmailRentalOptions(input.serviceId);
  const option = options.find((item) => item.resourceType === input.resourceType &&
    (input.resourceType === "MAILBOX" ? item.providerId === input.providerId : item.domainId === input.domainId));
  if (!option) throw new Error("Stok atau harga pilihan ini sudah berubah. Pilih ulang dari katalog.");
  const config = await settings();
  await reserveUserRentalSlot(input.userId, config?.maxConcurrentEmailRentalsPerUser ?? 3);
  const reservationExpiresAt = new Date(Date.now() + (config?.reservationMinutes ?? 10) * 60_000);
  let resourceId = "";
  let emailAddress = "";
  let providerId: string | undefined;
  let providerName = option.providerName;
  try {
    if (input.resourceType === "MAILBOX") {
      const mailbox = await reserveMailboxCandidate({ serviceId: input.serviceId, providerId: input.providerId!, userId: input.userId, reservationExpiresAt });
      resourceId = String(mailbox._id); emailAddress = mailbox.email; providerId = String(mailbox.providerId);
    } else {
      const alias = await reserveDomainAlias({ serviceId: input.serviceId, domainId: input.domainId!, userId: input.userId, reservationExpiresAt });
      resourceId = String(alias._id); emailAddress = alias.address;
    }
    const rental = await EmailRental.create({
      _id: new Types.ObjectId(),
      userId: input.userId, serviceId: String(service._id), resourceType: input.resourceType, resourceId, emailAddress,
      ...(providerId ? { providerId } : {}), providerName, serviceSnapshot: {
        code: service.code, name: service.name, icon: service.icon, durationMinutes: service.rentalDurationMinutes,
        cooldownMinutes: service.cooldownMinutes, senderPatterns: service.senderPatterns, subjectPatterns: service.subjectPatterns,
        otpPatterns: service.otpPatterns, allowMagicLink: service.allowMagicLink, allowVerificationLink: service.allowVerificationLink,
      }, price: option.price, status: "WAITING_PAYMENT", reservedAt: new Date(), reservationExpiresAt,
      startUid: 0, usageCommitted: false, counterReleased: false,
    });
    if (input.resourceType === "DOMAIN_ALIAS") await EmailDomainAlias.updateOne({ _id: resourceId, status: "RESERVED" }, { $set: { rentalId: String(rental._id) } });
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
      event: "reserved", rentalId: String(rental._id), userId: input.userId, emailAddress, serviceName: service.name,
    });
    return rental;
  } catch (error) {
    if (resourceId) await releaseReservedResource(input.resourceType, resourceId, input.userId).catch(() => {});
    await releaseUserRentalSlot(input.userId).catch(() => {});
    if (duplicate(error)) throw new Error("Batas rental email aktif sudah tercapai.");
    throw error;
  }
}

async function loadOwnedRental(rentalId: string, userId: string): Promise<IEmailRental> {
  if (!Types.ObjectId.isValid(rentalId)) throw new Error("Rental email tidak ditemukan.");
  const rental = await EmailRental.findOne({ _id: rentalId, userId }).lean();
  if (!rental) throw new Error("Rental email tidak ditemukan.");
  return rental as IEmailRental;
}

async function activateMailboxRental(rental: IEmailRental, method: "BALANCE" | "QRIS", chargeBalance: boolean): Promise<IEmailRental> {
  const session = await mongoose.startSession();
  let result: IEmailRental | undefined;
  try {
    await session.withTransaction(async () => {
      const current = await EmailRental.findOne({ _id: rental._id, userId: rental.userId }).session(session).lean();
      if (current?.status === "ACTIVE") { result = current as IEmailRental; return; }
      if (!current || current.status !== (method === "BALANCE" ? "WAITING_PAYMENT" : "PROCESSING")) throw new Error("Status rental sudah berubah.");
      if (current.reservationExpiresAt && current.reservationExpiresAt <= new Date()) throw new Error("Reservasi email sudah kedaluwarsa.");
      if (chargeBalance) {
        const userBefore = await User.findOne({ telegramId: current.userId }).session(session).lean();
        const debited = await User.findOneAndUpdate({ telegramId: current.userId, balance: { $gte: current.price } },
          { $inc: { balance: -current.price, totalOrders: 1 } }, { session, returnDocument: "after" });
        if (!debited || !userBefore) throw new Error("Saldo tidak mencukupi.");
        await EmailPaymentEffect.create([{ effectId: "initial:" + String(current._id), rentalId: String(current._id), userId: current.userId, kind: "BALANCE_DEBIT", amount: current.price }], { session });
        await BalanceLog.create([{ userId: current.userId, type: "PURCHASE", amount: current.price,
          balanceBefore: userBefore.balance, balanceAfter: debited.balance, reason: "Sewa OTP Email " + current.serviceSnapshot.name }], { session });
      }
      const usage = await commitEmailUsage({ type: current.resourceType, address: current.emailAddress, serviceId: current.serviceId,
        rentalId: String(current._id), userId: current.userId }, session);
      if (!usage) throw new Error("Email ini sudah pernah dipakai untuk layanan tersebut.");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + current.serviceSnapshot.durationMinutes * 60_000);
      let mailbox: (Awaited<ReturnType<typeof EmailMailbox.findOneAndUpdate>> & { lastUid?: number }) | null = null;
      if (current.resourceType === "MAILBOX") {
        mailbox = await EmailMailbox.findOneAndUpdate({
          _id: current.resourceId, status: "RESERVED", reservedBy: current.userId, reservedUntil: { $gt: now },
        }, { $set: { status: "RENTED", rentedBy: current.userId, rentedUntil: expiresAt }, $inc: { totalRentals: 1 },
          $unset: { reservedBy: 1, reservedUntil: 1 } }, { session, returnDocument: "after" });
        if (!mailbox) throw new Error("Reservasi mailbox sudah tidak berlaku.");
      }
      if (current.resourceType === "DOMAIN_ALIAS") {
        const alias = await EmailDomainAlias.findOneAndUpdate({ _id: current.resourceId, status: "RESERVED", rentalId: String(current._id) },
          { $set: { status: "ACTIVE" } }, { session, returnDocument: "after" }).lean();
        if (!alias) throw new Error("Reservasi alamat domain sudah tidak berlaku.");
      }
      const startUid = current.resourceType === "MAILBOX" ? (mailbox?.lastUid ?? 0) : current.startUid;
      const updated = await EmailRental.findOneAndUpdate({ _id: current._id, status: current.status, userId: current.userId }, {
        $set: { status: "ACTIVE", paymentMethod: method, paidAt: current.paidAt ?? now, startedAt: now, expiresAt, startUid, usageCommitted: true },
      }, { session, returnDocument: "after" }).lean();
      if (!updated) throw new Error("Rental berubah saat aktivasi.");
      result = updated as IEmailRental;
    });
  } finally { await session.endSession(); }
  if (!result) throw new Error("Gagal mengaktifkan rental email.");
  await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
    event: "activated", rentalId: String(result._id), userId: result.userId, emailAddress: result.emailAddress, serviceName: result.serviceSnapshot.name,
  });
  return result;
}

function isEmailUsageDuplicate(error: unknown): boolean {
  if (!duplicate(error)) return false;
  const value = error as { keyPattern?: Record<string, unknown>; message?: string };
  return Boolean(value.keyPattern?.emailResourceId && value.keyPattern?.serviceId) ||
    /tenantId_1_emailResourceId_1_serviceId_1/.test(value.message ?? "");
}

async function activateReservedMailboxWithRecovery(
  rental: IEmailRental, method: "BALANCE" | "QRIS", chargeBalance: boolean,
): Promise<IEmailRental> {
  let current = await ensureReservedMailbox(rental);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await activateMailboxRental(current, method, chargeBalance); }
    catch (error) {
      const latest = await EmailRental.findOne({ _id: rental._id, userId: rental.userId }).lean();
      if (latest?.status === "ACTIVE") return latest as IEmailRental;
      if (isEmailUsageDuplicate(error)) {
        await releaseReservedResource("MAILBOX", current.resourceId, current.userId).catch(() => {});
        const replacement = await replaceReservedMailbox({ ...(latest ?? current) } as IEmailRental);
        if (replacement) { current = await ensureReservedMailbox(replacement); continue; }
        await failAndRelease((latest ?? current) as IEmailRental, method === "QRIS");
        throw new Error(method === "QRIS"
          ? "Email sudah pernah dipakai untuk layanan ini dan stok pengganti habis. Pembayaran dikembalikan ke saldo."
          : "Email sudah pernah dipakai untuk layanan ini dan stok pengganti habis. Silakan buat reservasi baru.");
      }
      if (latest && latest.status === "PROCESSING" && /reservasi mailbox sudah tidak berlaku/i.test(error instanceof Error ? error.message : "")) {
        await failAndRelease(latest as IEmailRental, true);
        throw new Error("Reservasi mailbox berakhir setelah pembayaran. Nominal dikembalikan ke saldo.");
      }
      throw error;
    }
  }
  await failAndRelease(current, method === "QRIS");
  throw new Error("Mailbox tidak dapat diaktifkan. Silakan coba lagi.");
}

/** Repairs a mailbox that failed authentication after an active rental started. */
export async function recoverActiveMailboxFailure(mailboxId: string, api?: Api): Promise<IEmailRental[]> {
  const rentals = await EmailRental.find({ resourceType: "MAILBOX", resourceId: mailboxId, status: "ACTIVE" }).limit(25).lean();
  const recovered: IEmailRental[] = [];
  for (const source of rentals) {
    let current = source as IEmailRental;
    let activated = false;
    const original = await EmailMailbox.findById(mailboxId).lean();
    if (!original) continue;
    for (let attempt = 0; attempt < 3; attempt++) {
      let candidate: Awaited<ReturnType<typeof reserveMailboxCandidate>>;
      try {
        candidate = await reserveMailboxCandidate({ serviceId: current.serviceId, providerId: String(original.providerId), userId: current.userId,
          reservationExpiresAt: current.expiresAt ?? new Date(Date.now() + RESERVATION_MS) });
      } catch { break; }
      try { await mailboxConnection(String(candidate._id)); }
      catch (error) {
        if (error instanceof ImapMailboxProviderError && error.kind === "AUTH") {
          await EmailMailbox.updateOne({ _id: candidate._id }, {
            $set: { status: "BROKEN", enabled: false, lastCheckedAt: new Date(), lastError: "IMAP authentication failed" },
            $unset: { reservedBy: 1, reservedUntil: 1 },
          });
          continue;
        }
        await releaseReservedResource("MAILBOX", String(candidate._id), current.userId).catch(() => {});
        break;
      }
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const usage = await commitEmailUsage({ type: "MAILBOX", address: candidate.email, serviceId: current.serviceId,
            rentalId: String(current._id), userId: current.userId }, session);
          if (!usage) throw new Error("Email usage conflict.");
          const mailbox = await EmailMailbox.findOneAndUpdate({ _id: candidate._id, status: "RESERVED", reservedBy: current.userId }, {
            $set: { status: "RENTED", rentedBy: current.userId, rentedUntil: current.expiresAt }, $inc: { totalRentals: 1 },
            $unset: { reservedBy: 1, reservedUntil: 1 },
          }, { session, returnDocument: "after" }).lean();
          if (!mailbox) throw new Error("Replacement reservation changed.");
          const provider = await EmailProvider.findById(candidate.providerId).session(session).lean();
          if (!provider) throw new Error("Replacement provider changed.");
          const updated = await EmailRental.findOneAndUpdate({ _id: current._id, status: "ACTIVE", resourceId: mailboxId }, {
            $set: { resourceId: String(candidate._id), emailAddress: candidate.email, providerId: String(candidate.providerId), providerName: provider.name, startUid: mailbox.lastUid ?? 0 },
          }, { session, returnDocument: "after" }).lean();
          if (!updated) throw new Error("Rental already recovered.");
          current = updated as IEmailRental;
        });
        recovered.push(current);
        activated = true;
      } catch (error) {
        await releaseReservedResource("MAILBOX", String(candidate._id), current.userId).catch(() => {});
        const latest = await EmailRental.findOne({ _id: current._id, userId: current.userId }).lean();
        if (latest?.status === "ACTIVE" && latest.resourceId !== mailboxId) { recovered.push(latest as IEmailRental); activated = true; }
        else if (isEmailUsageDuplicate(error)) continue;
      } finally { await session.endSession(); }
      if (activated) break;
    }
    if (!activated) {
      await EmailRental.updateOne({ _id: current._id, status: "ACTIVE", resourceId: mailboxId }, { $set: { status: "FAILED", completedAt: new Date() } });
      const refunded = await refundWallet(current).catch(() => false);
      await releaseCounter(String(current._id), current.userId).catch(() => {});
      await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
        event: refunded ? "failed_refunded" : "failed", rentalId: String(current._id), userId: current.userId, serviceName: current.serviceSnapshot.name,
      });
      if (api) await api.sendMessage(current.userId, refunded
        ? "⚠️ Mailbox rental gagal tersambung dan stok pengganti tidak tersedia. Pembayaran sudah dikembalikan ke saldo bot."
        : "⚠️ Mailbox rental gagal tersambung dan stok pengganti tidak tersedia. Pengembalian sedang diproses otomatis.").catch(() => {});
    }
  }
  return recovered;
}

async function reserveAliasRule(rental: IEmailRental): Promise<void> {
  const alias = await EmailDomainAlias.findById(rental.resourceId).lean();
  if (!alias) throw new Error("Alamat domain tidak ditemukan.");
  if (alias.cloudflareRuleId) return;
  const domain = await EmailDomain.findById(alias.domainId).lean();
  const collector = domain ? await EmailMailbox.findById(domain.destinationMailboxId).lean() : null;
  if (!domain || !collector || domain.routingMode !== "FORWARD") throw new Error("Domain atau collector mailbox belum siap.");
  const created = await cloudflareEmailDomainProvider.createAlias({
    zoneId: domain.zoneId, domain: domain.domain, localPart: alias.localPart, destinationEmail: collector.email,
  });
  if (created.address.toLowerCase() !== alias.address.toLowerCase()) {
    await cloudflareEmailDomainProvider.deleteAlias({ zoneId: domain.zoneId, ruleId: created.ruleId }).catch(() => {});
    throw new Error("Alamat Cloudflare tidak cocok dengan reservasi.");
  }
  try {
    const saved = await EmailDomainAlias.updateOne({ _id: alias._id, status: "RESERVED", cloudflareRuleId: { $exists: false } }, {
      $set: { cloudflareRuleId: created.ruleId, cloudflareZoneId: domain.zoneId },
    });
    if (!saved.modifiedCount) {
      const current = await EmailDomainAlias.findById(alias._id).lean();
      if (!current?.cloudflareRuleId) throw new Error("Alias Cloudflare gagal disimpan.");
      await cloudflareEmailDomainProvider.deleteAlias({ zoneId: domain.zoneId, ruleId: created.ruleId });
    } else {
      await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "alias_created" });
    }
  } catch (error) {
    await cloudflareEmailDomainProvider.deleteAlias({ zoneId: domain.zoneId, ruleId: created.ruleId }).catch(() => {});
    throw error;
  }
}

async function refundWallet(rental: IEmailRental): Promise<boolean> {
  const session = await mongoose.startSession();
  let refunded = false;
  try {
    await session.withTransaction(async () => {
      if (await EmailPaymentEffect.exists({ effectId: "refund:" + String(rental._id), kind: "REFUND" }).session(session)) return;
      const user = await User.findOneAndUpdate({ telegramId: rental.userId }, { $inc: { balance: rental.price } }, { session, returnDocument: "after" });
      if (!user) throw new Error("Pengguna untuk pengembalian saldo tidak ditemukan.");
      await EmailPaymentEffect.create([{ effectId: "refund:" + String(rental._id), rentalId: String(rental._id), userId: rental.userId, kind: "REFUND", amount: rental.price }], { session });
      await BalanceLog.create([{ userId: rental.userId, type: "REFUND", amount: rental.price,
        balanceBefore: user.balance - rental.price, balanceAfter: user.balance, reason: "Pengembalian gagal sewa OTP Email" }], { session });
      refunded = true;
    });
  } finally { await session.endSession(); }
  return refunded;
}

async function activateAliasRental(rental: IEmailRental): Promise<IEmailRental> {
  const initial = await EmailRental.findOne({ _id: rental._id, userId: rental.userId }).lean();
  if (initial?.status === "ACTIVE") return initial as IEmailRental;
  if (!initial || initial.status !== "PROCESSING") throw new Error("Status rental domain sudah berubah.");
  try {
    await reserveAliasRule(rental);
    const session = await mongoose.startSession();
    let activated: IEmailRental | undefined;
    try {
      await session.withTransaction(async () => {
        const current = await EmailRental.findOne({ _id: rental._id, userId: rental.userId, status: "PROCESSING" }).session(session).lean();
        if (!current) throw new Error("Status rental domain sudah berubah.");
        const usage = await commitEmailUsage({ type: current.resourceType, address: current.emailAddress, serviceId: current.serviceId,
          rentalId: String(current._id), userId: current.userId }, session);
        if (!usage) throw new Error("Alamat email ini sudah pernah digunakan untuk layanan tersebut.");
        const now = new Date();
        const expiresAt = new Date(now.getTime() + current.serviceSnapshot.durationMinutes * 60_000);
        const alias = await EmailDomainAlias.findOneAndUpdate({ _id: current.resourceId, status: "RESERVED" },
          { $set: { status: "ACTIVE" } }, { session, returnDocument: "after" }).lean();
        if (!alias) throw new Error("Reservasi alamat domain sudah tidak berlaku.");
        const updated = await EmailRental.findOneAndUpdate({ _id: current._id, status: "PROCESSING" }, {
          $set: { status: "ACTIVE", startedAt: now, expiresAt, usageCommitted: true },
        }, { session, returnDocument: "after" }).lean();
        if (!updated) throw new Error("Rental domain berubah saat aktivasi.");
        activated = updated as IEmailRental;
      });
    } finally { await session.endSession(); }
    if (!activated) throw new Error("Gagal mengaktifkan rental domain.");
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
      event: "activated", rentalId: String(activated._id), userId: activated.userId,
      emailAddress: activated.emailAddress, serviceName: activated.serviceSnapshot.name,
    });
    return activated;
  } catch (error) {
    const latest = await EmailRental.findOne({ _id: rental._id, userId: rental.userId }).lean();
    // A duplicate settlement/check may lose the activation race after the
    // winner has committed. Never tear down the active renter's Cloudflare rule.
    if (latest?.status === "ACTIVE") return latest as IEmailRental;
    const failed = await EmailRental.updateOne({ _id: rental._id, userId: rental.userId, status: "PROCESSING" }, {
      $set: { status: "FAILED", completedAt: new Date() },
    });
    if (!failed.modifiedCount) {
      const after = await EmailRental.findOne({ _id: rental._id, userId: rental.userId }).lean();
      if (after?.status === "ACTIVE") return after as IEmailRental;
      throw error;
    }
    const alias = await EmailDomainAlias.findById(rental.resourceId).lean();
    if (alias?.cloudflareRuleId) await cloudflareEmailDomainProvider.deleteAlias({ zoneId: alias.cloudflareZoneId, ruleId: alias.cloudflareRuleId }).catch(() => {});
    await EmailDomainAlias.updateOne({ _id: rental.resourceId }, { $set: { status: "RETIRED", retiredAt: new Date(), ruleDeleted: true } });
    await refundWallet((latest ?? rental) as IEmailRental);
    await releaseCounter(String(rental._id), rental.userId);
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
      event: "failed_refunded", rentalId: String(rental._id), userId: rental.userId, serviceName: rental.serviceSnapshot.name,
    });
    throw error;
  }
}

export async function payEmailRentalFromBalance(rentalId: string, userId: string): Promise<IEmailRental> {
  const rental = await loadOwnedRental(rentalId, userId);
  if (rental.status === "ACTIVE") return rental;
  if (rental.status !== "WAITING_PAYMENT") throw new Error("Rental tidak menunggu pembayaran.");
  if (rental.reservationExpiresAt && rental.reservationExpiresAt <= new Date()) throw new Error("Reservasi rental sudah kedaluwarsa.");
  if (rental.resourceType === "MAILBOX") {
    try { return await activateReservedMailboxWithRecovery(rental, "BALANCE", true); }
    catch (error) { if (/sudah pernah dipakai|reservasi mailbox/i.test(String(error))) await failAndRelease(rental, false); throw error; }
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await EmailRental.findOne({ _id: rental._id, userId, status: "WAITING_PAYMENT" }).session(session).lean();
      if (!current || (current.reservationExpiresAt && current.reservationExpiresAt <= new Date())) throw new Error("Reservasi rental sudah kedaluwarsa.");
      const before = await User.findOne({ telegramId: userId }).session(session).lean();
      const updated = await User.findOneAndUpdate({ telegramId: userId, balance: { $gte: current.price } },
        { $inc: { balance: -current.price, totalOrders: 1 } }, { session, returnDocument: "after" });
      if (!updated || !before) throw new Error("Saldo tidak mencukupi.");
      await EmailPaymentEffect.create([{ effectId: "initial:" + String(current._id), rentalId: String(current._id), userId, kind: "BALANCE_DEBIT", amount: current.price }], { session });
      await BalanceLog.create([{ userId, type: "PURCHASE", amount: current.price, balanceBefore: before.balance, balanceAfter: updated.balance,
        reason: "Sewa OTP Email " + current.serviceSnapshot.name }], { session });
      const processing = await EmailRental.findOneAndUpdate({ _id: current._id, status: "WAITING_PAYMENT" },
        { $set: { status: "PROCESSING", paymentMethod: "BALANCE", paidAt: new Date() } }, { session, returnDocument: "after" });
      if (!processing) throw new Error("Rental berubah saat pembayaran.");
    });
  } finally { await session.endSession(); }
  return activateAliasRental((await loadOwnedRental(rentalId, userId)) as IEmailRental);
}

export async function createEmailRentalQrisInvoice(rentalId: string, userId: string): Promise<{ rental: IEmailRental; qr: Buffer }> {
  const rental = await loadOwnedRental(rentalId, userId);
  if (rental.status === "ACTIVE") throw new Error("Rental email sudah aktif.");
  if (rental.status !== "WAITING_PAYMENT") throw new Error("Rental tidak menunggu pembayaran.");
  if (rental.reservationExpiresAt && rental.reservationExpiresAt <= new Date()) throw new Error("Reservasi rental sudah kedaluwarsa.");
  const clients = await getTenantPaymentClients();
  let invoice = rental;
  if (!rental.paymentReference || !rental.paymentExpiresAt || rental.paymentExpiresAt <= new Date()) {
    const amount = await reservePaymentAmount(clients.merchantId, getTenantId(), rental.price);
    const reference = "email-" + randomUUID();
    const expiresAt = new Date(Math.min(rental.reservationExpiresAt?.getTime() ?? Date.now() + RESERVATION_MS, Date.now() + 10 * 60_000));
    const updated = await EmailRental.findOneAndUpdate({ _id: rental._id, userId, status: "WAITING_PAYMENT", $or: [{ paymentReference: { $exists: false } }, { paymentExpiresAt: { $lte: new Date() } }] }, {
      $set: { paymentMethod: "QRIS", paymentReference: reference, qrisAmount: amount.totalAmount,
        paymentMerchantId: clients.merchantId, paymentConfigVersion: clients.version, paymentExpiresAt: expiresAt },
    }, { returnDocument: "after" }).lean();
    if (updated) invoice = updated as IEmailRental;
    else invoice = await loadOwnedRental(rentalId, userId);
  }
  if (!invoice.qrisAmount || !invoice.paymentMerchantId || !invoice.paymentExpiresAt || invoice.paymentExpiresAt <= new Date()) throw new Error("Invoice QRIS kedaluwarsa. Batalkan lalu buat rental baru.");
  if (invoice.paymentMerchantId !== clients.merchantId || invoice.paymentConfigVersion !== clients.version) throw new Error("Konfigurasi QRIS berubah; hubungi admin.");
  return { rental: invoice, qr: (await generateQris(invoice.qrisAmount)).buffer };
}

async function findRentalSettlement(rental: IEmailRental): Promise<PaymentTransaction | undefined> {
  if (rental.paymentMethod !== "QRIS" || !rental.paymentReference || !rental.qrisAmount || !rental.paymentMerchantId || !rental.paymentExpiresAt) return undefined;
  const clients = await getTenantPaymentClients();
  if (clients.merchantId !== rental.paymentMerchantId || clients.version !== rental.paymentConfigVersion) {
    throw new Error("Konfigurasi QRIS berubah; hubungi admin untuk rekonsiliasi pembayaran.");
  }
  const transactions = await clients.merchant.getQrisSettlements({
    startTime: rental.createdAt, endTime: new Date(Math.min(Date.now(), rental.paymentExpiresAt.getTime())),
  });
  return transactions.find((transaction) => matchesSettlement(transaction, {
    merchantId: rental.paymentMerchantId!, amount: rental.qrisAmount!, createdAt: rental.createdAt, expiresAt: rental.paymentExpiresAt!,
  }));
}

async function refundExpiredQrRental(rental: IEmailRental, transaction: PaymentTransaction): Promise<void> {
  const changed = await EmailRental.findOneAndUpdate({ _id: rental._id, userId: rental.userId, status: { $in: ["WAITING_PAYMENT", "CANCELLED", "FAILED"] } }, {
    $set: { status: "FAILED", paymentMethod: "QRIS", paidAt: new Date(transaction.paidAt), matchedTransactionId: transaction.transactionId, completedAt: new Date() },
  }, { returnDocument: "after" }).lean();
  const latest = (changed ?? await loadOwnedRental(String(rental._id), rental.userId)) as IEmailRental;
  await releaseReservedResource(rental.resourceType, rental.resourceId, rental.userId).catch(() => {});
  await refundWallet({ ...latest, paymentMethod: "QRIS" });
  await releaseCounter(String(rental._id), rental.userId);
  await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
    event: "failed_refunded", rentalId: String(rental._id), userId: rental.userId, serviceName: rental.serviceSnapshot.name,
  });
}

export async function checkEmailRentalQris(rentalId: string, userId: string): Promise<IEmailRental> {
  let rental = await loadOwnedRental(rentalId, userId);
  if (rental.status === "ACTIVE") return rental;
  if (rental.status === "PROCESSING" && rental.resourceType === "DOMAIN_ALIAS") return activateAliasRental(rental);
  if (rental.status === "PROCESSING" && rental.resourceType === "MAILBOX") return activateReservedMailboxWithRecovery(rental, "QRIS", false);
  if (rental.status === "CANCELLED" || rental.status === "FAILED") {
    const lateSettlement = await findRentalSettlement(rental);
    if (!lateSettlement) throw new Error("Reservasi sudah berakhir. Jika pembayaran baru saja berhasil, hubungi admin dengan bukti transfer.");
    const claim = await claimSettlement({ merchantId: rental.paymentMerchantId!, tenantId: getTenantId(),
      invoiceReference: rental.paymentReference!, kind: "email_rental", transaction: lateSettlement });
    if (claim.owned) await refundExpiredQrRental(rental, lateSettlement);
    throw new Error("Pembayaran ditemukan setelah reservasi berakhir. Nominal dasar rental sudah dikembalikan ke saldo bot.");
  }
  if (rental.status !== "WAITING_PAYMENT" || rental.paymentMethod !== "QRIS" || !rental.paymentReference ||
      !rental.qrisAmount || !rental.paymentMerchantId || !rental.paymentExpiresAt) throw new Error("Invoice QRIS tidak ditemukan.");
  const transaction = await findRentalSettlement(rental);
  if (!transaction) {
    if (rental.paymentExpiresAt <= new Date() || (rental.reservationExpiresAt && rental.reservationExpiresAt <= new Date())) {
      await failAndRelease(rental, false);
      throw new Error("Invoice QRIS kedaluwarsa dan pembayaran belum terdeteksi.");
    }
    throw new Error("Pembayaran belum terdeteksi. Tunggu sebentar lalu tekan cek pembayaran.");
  }
  {
    const claim = await claimSettlement({ merchantId: rental.paymentMerchantId, tenantId: getTenantId(),
      invoiceReference: rental.paymentReference, kind: "email_rental", transaction });
    if (!claim.owned) throw new Error("Pembayaran ini sudah dikaitkan ke invoice lain. Hubungi admin untuk rekonsiliasi.");
    const reservationExpired = rental.paymentExpiresAt <= new Date() ||
      Boolean(rental.reservationExpiresAt && rental.reservationExpiresAt <= new Date());
    if (reservationExpired) {
      await refundExpiredQrRental(rental, transaction);
      throw new Error("Pembayaran QRIS diterima setelah reservasi berakhir. Nominal dasar rental dikembalikan ke saldo bot.");
    }
    const processing = await EmailRental.findOneAndUpdate({ _id: rental._id, userId, status: "WAITING_PAYMENT" }, {
      $set: { status: "PROCESSING", paymentMethod: "QRIS", paidAt: new Date(transaction.paidAt), matchedTransactionId: transaction.transactionId },
    }, { returnDocument: "after" }).lean();
    if (!processing) {
      const latest = await loadOwnedRental(rentalId, userId);
      if (latest.status === "CANCELLED" || latest.status === "FAILED") {
        await refundExpiredQrRental(latest, transaction);
        throw new Error("Pembayaran QRIS diterima setelah reservasi berakhir. Nominal dasar rental dikembalikan ke saldo bot.");
      }
      return latest;
    }
    rental = processing as IEmailRental;
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
      event: "payment_success", rentalId, userId, emailAddress: rental.emailAddress, serviceName: rental.serviceSnapshot.name,
    });
    return rental.resourceType === "DOMAIN_ALIAS" ? activateAliasRental(rental) : activateReservedMailboxWithRecovery(rental, "QRIS", false);
  }
  return loadOwnedRental(rentalId, userId);
}

export async function cancelEmailRental(rentalId: string, userId: string): Promise<void> {
  const rental = await loadOwnedRental(rentalId, userId);
  if (rental.status !== "WAITING_PAYMENT") throw new Error("Hanya reservasi yang belum dibayar yang bisa dibatalkan.");
  const cancelled = await EmailRental.findOneAndUpdate({ _id: rental._id, userId, status: "WAITING_PAYMENT" }, {
    $set: { status: "CANCELLED", completedAt: new Date() },
  });
  if (!cancelled) throw new Error("Status rental berubah; coba refresh.");
  await releaseResource(rental);
  await releaseCounter(String(rental._id), userId);
}

async function failAndRelease(rental: IEmailRental, refund: boolean): Promise<void> {
  const changed = await EmailRental.updateOne({ _id: rental._id, status: { $in: ["WAITING_PAYMENT", "PROCESSING"] } }, { $set: { status: "FAILED", completedAt: new Date() } });
  if (!changed.modifiedCount) return;
  await releaseResource(rental).catch(() => {});
  if (refund && (rental.paymentMethod === "QRIS" || rental.paymentMethod === "BALANCE")) await refundWallet(rental);
  await releaseCounter(String(rental._id), rental.userId);
  await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
    event: refund ? "failed_refunded" : "failed", rentalId: String(rental._id), userId: rental.userId, serviceName: rental.serviceSnapshot.name,
  });
}

export async function completeEmailRental(rentalId: string, userId: string, expired = false): Promise<void> {
  const rental = await loadOwnedRental(rentalId, userId);
  if (rental.status !== "ACTIVE") throw new Error("Rental email tidak aktif.");
  const now = new Date();
  const updated = await EmailRental.findOneAndUpdate({ _id: rental._id, userId, status: "ACTIVE" }, {
    $set: { status: expired ? "EXPIRED" : "COMPLETED", completedAt: now },
  });
  if (!updated) return;
  if (rental.resourceType === "MAILBOX") {
    await EmailMailbox.updateOne({ _id: rental.resourceId, status: "RENTED", rentedBy: userId }, {
      $set: { status: "COOLDOWN", cooldownUntil: new Date(now.getTime() + Math.max(rental.serviceSnapshot.cooldownMinutes, (await settings())?.messageGraceMinutes ?? 5) * 60_000) },
      $unset: { rentedBy: 1, rentedUntil: 1 },
    });
  } else {
    const config = await settings();
    await EmailDomainAlias.updateOne({ _id: rental.resourceId, status: "ACTIVE" }, {
      $set: { status: "RETIRED", retiredAt: now, cleanupAfter: new Date(now.getTime() + Math.max(config?.aliasGraceMinutes ?? 15, config?.messageGraceMinutes ?? 5) * 60_000 + (config?.pollIntervalSeconds ?? 15) * 1000) },
    });
  }
  await releaseCounter(String(rental._id), userId);
  await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
    event: expired ? "expired" : "completed", rentalId, userId, emailAddress: rental.emailAddress, serviceName: rental.serviceSnapshot.name,
  });
}

export async function sweepEmailRentalLifecycle(): Promise<void> {
  const now = new Date();
  const processingRentals = await EmailRental.find({ status: "PROCESSING" }).sort({ paidAt: 1 }).limit(100).lean();
  for (const rental of processingRentals) {
    try {
      if (rental.resourceType === "DOMAIN_ALIAS") await activateAliasRental(rental as IEmailRental);
      else await activateReservedMailboxWithRecovery(rental as IEmailRental, rental.paymentMethod ?? "QRIS", false);
    } catch { /* a temporary IMAP/Cloudflare failure is retried on the next bounded poll */ }
  }
  const expiredReservations = await EmailRental.find({ status: "WAITING_PAYMENT", reservationExpiresAt: { $lte: now } }).limit(100).lean();
  for (const rental of expiredReservations) {
    const changed = await EmailRental.updateOne({ _id: rental._id, status: "WAITING_PAYMENT", reservationExpiresAt: { $lte: now } }, { $set: { status: "CANCELLED", completedAt: now } });
    if (!changed.modifiedCount) continue;
    await releaseResource(rental as IEmailRental).catch(() => {});
    await releaseCounter(String(rental._id), rental.userId).catch(() => {});
  }
  const expiredRentals = await EmailRental.find({ status: "ACTIVE", expiresAt: { $lte: now } }).limit(100).lean();
  for (const rental of expiredRentals) await completeEmailRental(String(rental._id), rental.userId, true).catch(() => {});
  const refundsPending = await EmailRental.find({ status: "FAILED", paidAt: { $exists: true }, paymentMethod: { $in: ["BALANCE", "QRIS"] } }).limit(100).lean();
  for (const rental of refundsPending) {
    try {
      const refunded = await refundWallet(rental as IEmailRental);
      await releaseCounter(String(rental._id), rental.userId);
      if (refunded) await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
        event: "failed_refunded", rentalId: String(rental._id), userId: rental.userId, serviceName: rental.serviceSnapshot.name,
      });
    } catch { console.warn("[EmailRental] A failed rental refund will retry on the next poll."); }
  }
  const staleRentedMailboxes = await EmailMailbox.find({ status: "RENTED", rentedUntil: { $lte: now } }).limit(100).select("_id rentedBy").lean();
  for (const mailbox of staleRentedMailboxes) {
    const lastRental = await EmailRental.findOne({ resourceType: "MAILBOX", resourceId: String(mailbox._id), status: { $in: ["COMPLETED", "EXPIRED"] } })
      .sort({ completedAt: -1 }).select("serviceSnapshot.cooldownMinutes completedAt").lean();
    const completedAt = lastRental?.completedAt ?? now;
    const config = await settings();
    const cooldownMinutes = Math.max(lastRental?.serviceSnapshot.cooldownMinutes ?? 0, config?.messageGraceMinutes ?? 5);
    await EmailMailbox.updateOne({ _id: mailbox._id, status: "RENTED", rentedUntil: { $lte: now } }, {
      $set: { status: "COOLDOWN", cooldownUntil: new Date(completedAt.getTime() + cooldownMinutes * 60_000) },
      $unset: { rentedBy: 1, rentedUntil: 1 },
    });
  }
  await EmailMailbox.updateMany({ status: "COOLDOWN", enabled: true, cooldownUntil: { $lte: now } }, {
    $set: { status: "AVAILABLE" }, $unset: { cooldownUntil: 1 },
  });
  const pendingMailboxRentals = await EmailRental.distinct("resourceId", {
    resourceType: "MAILBOX", status: { $in: ["WAITING_PAYMENT", "PROCESSING"] },
  });
  await EmailMailbox.updateMany({ status: "RESERVED", reservedUntil: { $lte: now }, _id: { $nin: pendingMailboxRentals } }, {
    $set: { status: "AVAILABLE" }, $unset: { reservedBy: 1, reservedUntil: 1 },
  });
  const aliases = await EmailDomainAlias.find({ status: "RETIRED", ruleDeleted: false, cleanupAfter: { $lte: now }, cloudflareRuleId: { $exists: true } }).limit(25).lean();
  for (const alias of aliases) {
    try {
      await cloudflareEmailDomainProvider.deleteAlias({ zoneId: alias.cloudflareZoneId, ruleId: alias.cloudflareRuleId! });
      await EmailDomainAlias.updateOne({ _id: alias._id, status: "RETIRED" }, { $set: { ruleDeleted: true } });
      await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "alias_retired", emailAddress: alias.address });
    } catch { console.warn("[EmailRental] Cloudflare alias cleanup will retry."); }
  }
}

export async function getUserEmailRentals(userId: string, limit = 10): Promise<IEmailRental[]> {
  return EmailRental.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(50, Math.max(1, limit))).lean() as unknown as IEmailRental[];
}
export async function getRentalInbox(rentalId: string, userId: string): Promise<unknown[]> {
  const rental = await loadOwnedRental(rentalId, userId);
  if (rental.status !== "ACTIVE") throw new Error("Rental email tidak aktif.");
  return EmailMessage.find({ rentalId: String(rental._id), dispatchStatus: "SENT" }).sort({ receivedAt: -1 }).limit(10)
    .select("sender recipient subject receivedAt otpCode verificationLink magicLink preview").lean();
}

export async function markMailboxHealthy(mailboxId: string): Promise<void> {
  const inUse = await EmailRental.exists({ resourceType: "MAILBOX", resourceId: mailboxId, status: { $in: ["ACTIVE", "PROCESSING", "WAITING_PAYMENT"] } });
  await EmailMailbox.updateOne({ _id: mailboxId }, {
    $set: { lastSuccessfulLoginAt: new Date(), lastCheckedAt: new Date(), ...(!inUse ? { status: "AVAILABLE", enabled: true } : {}) },
    $unset: { lastError: 1 },
  });
}
export async function testMailbox(mailboxId: string, replacementPassword?: string): Promise<void> {
  const mailbox = await EmailMailbox.findById(mailboxId).select("+credentialEncrypted").lean();
  if (!mailbox) throw new Error("Mailbox tidak ditemukan.");
  const provider = await EmailProvider.findOne({ _id: mailbox.providerId, enabled: true }).lean();
  if (!provider) throw new Error("Provider tidak tersedia.");
  const { decryptSecret } = await import("../../services/crypto.js");
  const password = replacementPassword ?? decryptSecret(mailbox.credentialEncrypted, "email-mailbox:" + String(mailbox._id) + ":credential");
  const credentials = { host: provider.imapHost, port: provider.imapPort, secure: provider.imapSecure, username: mailbox.username, password, mailbox: "INBOX" };
  try { await imapMailboxProvider.testConnection(credentials); }
  catch (error) {
    if (error instanceof ImapMailboxProviderError && error.kind === "AUTH") {
      await EmailMailbox.updateOne({ _id: mailbox._id, status: { $nin: ["RENTED", "RESERVED"] } }, {
        $set: { status: "BROKEN", enabled: false, lastCheckedAt: new Date(), lastError: "IMAP authentication failed" },
      });
      await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "mailbox_broken" });
    }
    throw error;
  }
  await markMailboxHealthy(String(mailbox._id));
}
export async function storeMailboxCredential(mailboxId: string, password: string): Promise<void> {
  if (!password || password.length > 4096) throw new Error("Credential tidak valid.");
  const mailbox = await EmailMailbox.findById(mailboxId).select("+credentialEncrypted").lean();
  if (!mailbox) throw new Error("Mailbox tidak ditemukan.");
  if (await EmailRental.exists({ resourceType: "MAILBOX", resourceId: mailboxId, status: { $in: ["WAITING_PAYMENT", "PROCESSING"] } })) {
    throw new Error("Credential mailbox tidak bisa diganti saat ada reservasi pembayaran.");
  }
  const provider = await EmailProvider.findById(mailbox.providerId).lean();
  if (!provider) throw new Error("Provider tidak tersedia.");
  await imapMailboxProvider.testConnection({ host: provider.imapHost, port: provider.imapPort, secure: provider.imapSecure, username: mailbox.username, password, mailbox: "INBOX" });
  const activeRental = await EmailRental.findOne({ resourceType: "MAILBOX", resourceId: mailboxId, status: "ACTIVE" }).sort({ startedAt: -1 }).lean();
  const stillCooling = mailbox.status === "COOLDOWN" && mailbox.cooldownUntil && mailbox.cooldownUntil > new Date();
  await EmailMailbox.updateOne({ _id: mailbox._id }, { $set: {
    credentialEncrypted: encryptSecret(password, "email-mailbox:" + String(mailbox._id) + ":credential"),
    status: activeRental ? "RENTED" : stillCooling ? "COOLDOWN" : "AVAILABLE",
    ...(activeRental ? { rentedBy: activeRental.userId, rentedUntil: activeRental.expiresAt } : {}),
    enabled: true, lastSuccessfulLoginAt: new Date(), lastCheckedAt: new Date(),
  }, $unset: {
    lastError: 1,
    ...((activeRental || !stillCooling) ? { reservedBy: 1, reservedUntil: 1, cooldownUntil: 1 } : {}),
    ...(!activeRental && !stillCooling ? { rentedBy: 1, rentedUntil: 1 } : {}),
  } });
}
export async function createMailbox(input: { providerId: string; email: string; username?: string; password: string }): Promise<void> {
  const provider = await EmailProvider.findOne({ _id: input.providerId, enabled: true }).lean();
  if (!provider) throw new Error("Provider IMAP tidak tersedia.");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Alamat email tidak valid.");
  const id = new Types.ObjectId();
  const username = input.username?.trim() || email;
  await imapMailboxProvider.testConnection({ host: provider.imapHost, port: provider.imapPort, secure: provider.imapSecure, username, password: input.password, mailbox: "INBOX" });
  await EmailMailbox.create({
    _id: id, providerId: String(provider._id), email, username,
    credentialEncrypted: encryptSecret(input.password, "email-mailbox:" + String(id) + ":credential"),
    status: "AVAILABLE", enabled: true, lastSuccessfulLoginAt: new Date(), lastCheckedAt: new Date(),
  });
}
export async function disableMailbox(mailboxId: string): Promise<void> {
  if (await EmailRental.exists({ resourceType: "MAILBOX", resourceId: mailboxId, status: { $in: ["ACTIVE", "WAITING_PAYMENT", "PROCESSING"] } })) throw new Error("Mailbox sedang dipakai rental.");
  await EmailMailbox.updateOne({ _id: mailboxId }, { $set: { status: "DISABLED", enabled: false }, $unset: { reservedBy: 1, reservedUntil: 1, rentedBy: 1, rentedUntil: 1 } });
}
export async function removeMailboxIfSafe(mailboxId: string): Promise<void> {
  const mailbox = await EmailMailbox.findById(mailboxId).select("email").lean();
  if (!mailbox) return;
  if (await EmailRental.exists({ resourceType: "MAILBOX", resourceId: mailboxId }) || await import("../../models/EmailUsage.js").then(({ EmailUsage }) => EmailUsage.exists({ emailResourceId: mailbox.email }))) {
    throw new Error("Mailbox punya histori/rental dan tidak bisa dihapus. Nonaktifkan agar tetap aman.");
  }
  await EmailMailbox.deleteOne({ _id: mailboxId });
}
export async function upsertEmailService(input: {
  id?: string; code: string; name: string; icon: string; durationMinutes: number; cooldownMinutes: number;
  senderPatterns: string[]; subjectPatterns: string[]; otpPatterns: string[]; allowMagicLink: boolean; allowVerificationLink: boolean;
}): Promise<void> {
  const values = {
    code: input.code.trim().toUpperCase(), name: input.name.trim(), icon: input.icon.trim() || "📧",
    rentalDurationMinutes: input.durationMinutes, cooldownMinutes: input.cooldownMinutes,
    senderPatterns: input.senderPatterns, subjectPatterns: input.subjectPatterns, otpPatterns: input.otpPatterns,
    allowMagicLink: input.allowMagicLink, allowVerificationLink: input.allowVerificationLink, enabled: true,
  };
  if (!/^[A-Z0-9_-]{2,32}$/.test(values.code) || !values.name || input.durationMinutes < 1 || input.durationMinutes > 1440) throw new Error("Konfigurasi service tidak valid.");
  if (!values.senderPatterns.length && !values.subjectPatterns.length) throw new Error("Isi sender matcher atau subject matcher agar inbox tidak bocor antar layanan.");
  await EmailOtpService.findOneAndUpdate(input.id ? { _id: input.id } : { code: values.code }, { $set: values }, { upsert: true, returnDocument: "after", runValidators: true });
}
export async function upsertEmailProvider(input: {
  id?: string; code: string; name: string; icon: string; host: string; port: number; secure: boolean; authType: "PASSWORD" | "APP_PASSWORD";
}): Promise<void> {
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code) || !input.host.trim() || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Provider IMAP tidak valid.");
  await EmailProvider.findOneAndUpdate(input.id ? { _id: input.id } : { code }, {
    $set: { code, name: input.name.trim(), icon: input.icon.trim() || "📮", protocol: "IMAP", imapHost: input.host.trim(), imapPort: input.port, imapSecure: input.secure, authType: input.authType, enabled: true },
  }, { upsert: true, returnDocument: "after", runValidators: true });
}
export async function setEmailRentalPrice(input: { serviceId: string; resourceType: "MAILBOX" | "DOMAIN_ALIAS"; providerId?: string; price: number }): Promise<void> {
  if (!Number.isSafeInteger(input.price) || input.price < 1) throw new Error("Harga harus angka rupiah positif.");
  await EmailRentalPrice.findOneAndUpdate({
    serviceId: input.serviceId, resourceType: input.resourceType,
    ...(input.providerId ? { providerId: input.providerId } : { providerId: { $in: [null] } }),
  }, { $set: { price: input.price, enabled: true, ...(input.providerId ? { providerId: input.providerId } : {}) } }, { upsert: true, returnDocument: "after", runValidators: true });
}
export async function toggleService(serviceId: string): Promise<void> {
  const service = await EmailOtpService.findById(serviceId);
  if (service) { service.enabled = !service.enabled; await service.save(); }
}
export async function listEmailMessages(rentalId: string, userId: string): Promise<unknown[]> { return getRentalInbox(rentalId, userId); }
