import { randomUUID } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { BalanceLog } from "../../models/BalanceLog.js";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailMailbox } from "../../models/EmailMailbox.js";
import { EmailPaymentEffect } from "../../models/EmailPaymentEffect.js";
import { EmailRental } from "../../models/EmailRental.js";
import { EmailRentalPrice } from "../../models/EmailRentalPrice.js";
import { EmailRentalRenewal, type IEmailRentalRenewal } from "../../models/EmailRentalRenewal.js";
import { User } from "../../models/User.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { generateQris } from "../../services/payment/paymentService.js";
import { getTenantPaymentClients } from "../../payments/tenantPayment.service.js";
import { claimSettlement, matchesSettlement, reservePaymentAmount } from "../../payments/paymentLedger.service.js";
import { getTenantId } from "../../tenant/context.js";

async function ownedRenewal(renewalId: string, userId: string): Promise<IEmailRentalRenewal> {
  if (!Types.ObjectId.isValid(renewalId)) throw new Error("Perpanjangan tidak ditemukan.");
  const renewal = await EmailRentalRenewal.findOne({ _id: renewalId, userId }).lean();
  if (!renewal) throw new Error("Perpanjangan tidak ditemukan.");
  return renewal as IEmailRentalRenewal;
}

export async function createEmailRenewal(rentalId: string, userId: string): Promise<IEmailRentalRenewal> {
  const rental = await EmailRental.findOne({ _id: rentalId, userId, status: "ACTIVE" }).lean();
  if (!rental) throw new Error("Hanya rental email yang masih aktif yang bisa diperpanjang.");
  const price = await EmailRentalPrice.findOne({
    serviceId: rental.serviceId, resourceType: rental.resourceType, enabled: true,
    ...(rental.providerId ? { providerId: rental.providerId } : { providerId: { $in: [null] } }),
  }).lean();
  if (!price) throw new Error("Harga perpanjangan belum tersedia.");
  const existing = await EmailRentalRenewal.findOne({ rentalId, userId, status: "WAITING_PAYMENT" }).lean();
  if (existing) return existing as IEmailRentalRenewal;
  try {
    return await EmailRentalRenewal.create({
      _id: new Types.ObjectId(),
      rentalId, userId, price: price.price, durationMinutes: rental.serviceSnapshot.durationMinutes, status: "WAITING_PAYMENT",
    }) as IEmailRentalRenewal;
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
    const retry = await EmailRentalRenewal.findOne({ rentalId, userId, status: "WAITING_PAYMENT" }).lean();
    if (!retry) throw new Error("Perpanjangan sedang diproses.");
    return retry as IEmailRentalRenewal;
  }
}

async function extendRental(renewal: IEmailRentalRenewal, session: mongoose.ClientSession): Promise<void> {
  const rental = await EmailRental.findOne({ _id: renewal.rentalId, userId: renewal.userId, status: "ACTIVE" }).session(session).lean();
  if (!rental) throw new Error("Rental email sudah selesai; perpanjangan tidak dapat diproses.");
  const now = new Date();
  const expiresAt = new Date(Math.max(rental.expiresAt?.getTime() ?? now.getTime(), now.getTime()) + renewal.durationMinutes * 60_000);
  const updated = await EmailRental.updateOne({
    _id: rental._id, status: "ACTIVE", ...(rental.expiresAt ? { expiresAt: rental.expiresAt } : { expiresAt: { $exists: false } }),
  }, { $set: { expiresAt } }, { session });
  if (!updated.modifiedCount) throw new Error("Rental berubah saat perpanjangan.");
  if (rental.resourceType === "MAILBOX") {
    await EmailMailbox.updateOne({ _id: rental.resourceId, status: "RENTED", rentedBy: renewal.userId }, { $set: { rentedUntil: expiresAt } }, { session });
  } else {
    await EmailDomainAlias.updateOne({ _id: rental.resourceId, status: "ACTIVE" }, { $unset: { cleanupAfter: 1 } }, { session });
  }
}

export async function renewEmailRentalFromBalance(renewalId: string, userId: string): Promise<IEmailRentalRenewal> {
  const renewal = await ownedRenewal(renewalId, userId);
  if (renewal.status === "PAID") return renewal;
  if (renewal.status !== "WAITING_PAYMENT") throw new Error("Perpanjangan tidak menunggu pembayaran.");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await EmailRentalRenewal.findOne({ _id: renewal._id, userId, status: "WAITING_PAYMENT" }).session(session).lean();
      if (!current) throw new Error("Perpanjangan sudah diproses.");
      const before = await User.findOne({ telegramId: userId }).session(session).lean();
      const updated = await User.findOneAndUpdate({ telegramId: userId, balance: { $gte: current.price } },
        { $inc: { balance: -current.price, totalOrders: 1 } }, { session, returnDocument: "after" });
      if (!updated || !before) throw new Error("Saldo tidak mencukupi.");
      await EmailPaymentEffect.create([{ effectId: String(current._id), rentalId: current.rentalId, userId,
        kind: "BALANCE_DEBIT", amount: current.price }], { session });
      await BalanceLog.create([{ userId, type: "PURCHASE", amount: current.price, balanceBefore: before.balance, balanceAfter: updated.balance,
        reason: "Perpanjangan sewa OTP Email" }], { session });
      await extendRental(current as IEmailRentalRenewal, session);
      const paid = await EmailRentalRenewal.findOneAndUpdate({ _id: current._id, status: "WAITING_PAYMENT" },
        { $set: { status: "PAID", paymentMethod: "BALANCE", paidAt: new Date() } }, { session, returnDocument: "after" }).lean();
      if (!paid) throw new Error("Perpanjangan berubah saat pembayaran.");
    });
  } finally { await session.endSession(); }
  const paid = await ownedRenewal(renewalId, userId);
  await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
    event: "renewed", rentalId: renewal.rentalId, userId,
  });
  return paid;
}

export async function createEmailRenewalQrisInvoice(renewalId: string, userId: string): Promise<{ renewal: IEmailRentalRenewal; qr: Buffer }> {
  let renewal = await ownedRenewal(renewalId, userId);
  if (renewal.status !== "WAITING_PAYMENT") throw new Error("Perpanjangan tidak menunggu pembayaran.");
  const clients = await getTenantPaymentClients();
  if (renewal.paymentReference && renewal.paymentExpiresAt && renewal.paymentExpiresAt <= new Date()) {
    throw new Error("Invoice perpanjangan kedaluwarsa. Batalkan perpanjangan ini sebelum membuat yang baru.");
  }
  if (!renewal.paymentReference || !renewal.paymentExpiresAt) {
    const amount = await reservePaymentAmount(clients.merchantId, getTenantId(), renewal.price);
    const updated = await EmailRentalRenewal.findOneAndUpdate({ _id: renewal._id, status: "WAITING_PAYMENT", $or: [
      { paymentReference: { $exists: false } }, { paymentExpiresAt: { $lte: new Date() } },
    ] }, { $set: {
      paymentMethod: "QRIS", paymentReference: "email-renewal-" + randomUUID(), qrisAmount: amount.totalAmount,
      paymentMerchantId: clients.merchantId, paymentConfigVersion: clients.version, paymentExpiresAt: new Date(Date.now() + 10 * 60_000),
    } }, { returnDocument: "after" }).lean();
    if (updated) renewal = updated as IEmailRentalRenewal;
    else renewal = await ownedRenewal(renewalId, userId);
  }
  if (!renewal.qrisAmount || !renewal.paymentReference || !renewal.paymentMerchantId || !renewal.paymentExpiresAt ||
      renewal.paymentExpiresAt <= new Date()) throw new Error("Invoice perpanjangan kedaluwarsa.");
  if (renewal.paymentMerchantId !== clients.merchantId || renewal.paymentConfigVersion !== clients.version) throw new Error("Konfigurasi QRIS berubah; hubungi admin.");
  return { renewal, qr: (await generateQris(renewal.qrisAmount)).buffer };
}

async function refundRenewal(renewal: IEmailRentalRenewal): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const effectId = "refund:" + String(renewal._id);
      if (await EmailPaymentEffect.exists({ effectId, kind: "REFUND" }).session(session)) return;
      const user = await User.findOneAndUpdate({ telegramId: renewal.userId }, { $inc: { balance: renewal.price } }, { session, returnDocument: "after" });
      if (!user) throw new Error("Pengguna untuk refund tidak ditemukan.");
      await EmailPaymentEffect.create([{ effectId, rentalId: renewal.rentalId, userId: renewal.userId, kind: "REFUND", amount: renewal.price }], { session });
      await BalanceLog.create([{ userId: renewal.userId, type: "REFUND", amount: renewal.price,
        balanceBefore: user.balance - renewal.price, balanceAfter: user.balance, reason: "Pengembalian perpanjangan OTP Email" }], { session });
    });
  } finally { await session.endSession(); }
}

export async function checkEmailRenewalQris(renewalId: string, userId: string): Promise<IEmailRentalRenewal> {
  const renewal = await ownedRenewal(renewalId, userId);
  if (renewal.status === "PAID") return renewal;
  if (renewal.status !== "WAITING_PAYMENT" || renewal.paymentMethod !== "QRIS" || !renewal.paymentReference ||
      !renewal.qrisAmount || !renewal.paymentMerchantId || !renewal.paymentExpiresAt) throw new Error("Invoice perpanjangan tidak ditemukan.");
  if (renewal.paymentExpiresAt <= new Date()) throw new Error("Invoice perpanjangan kedaluwarsa.");
  const clients = await getTenantPaymentClients();
  if (clients.merchantId !== renewal.paymentMerchantId || clients.version !== renewal.paymentConfigVersion) throw new Error("Konfigurasi QRIS berubah; hubungi admin.");
  const transactions = await clients.merchant.getQrisSettlements({
    startTime: renewal.createdAt, endTime: new Date(Math.min(Date.now(), renewal.paymentExpiresAt.getTime())),
  });
  for (const transaction of transactions) {
    if (!matchesSettlement(transaction, { merchantId: renewal.paymentMerchantId, amount: renewal.qrisAmount,
      createdAt: renewal.createdAt, expiresAt: renewal.paymentExpiresAt })) continue;
    const claim = await claimSettlement({ merchantId: renewal.paymentMerchantId, tenantId: getTenantId(),
      invoiceReference: renewal.paymentReference, kind: "email_rental", transaction });
    if (!claim.owned) continue;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await EmailRentalRenewal.findOne({ _id: renewal._id, status: "WAITING_PAYMENT" }).session(session).lean();
        if (!current) throw new Error("Perpanjangan sudah diproses.");
        await extendRental(current as IEmailRentalRenewal, session);
        await EmailRentalRenewal.updateOne({ _id: current._id, status: "WAITING_PAYMENT" }, { $set: {
          status: "PAID", paymentMethod: "QRIS", paidAt: new Date(transaction.paidAt), matchedTransactionId: transaction.transactionId,
        } }, { session });
      });
    } catch (error) {
      const rental = await EmailRental.findOne({ _id: renewal.rentalId, userId, status: "ACTIVE" }).lean();
      if (!rental) {
        await refundRenewal(renewal);
        await EmailRentalRenewal.updateOne({ _id: renewal._id }, { $set: { status: "FAILED", paidAt: new Date(transaction.paidAt) } });
        throw new Error("Rental sudah selesai; nominal pembayaran dikembalikan ke saldo.");
      }
      throw error;
    } finally { await session.endSession(); }
    const paid = await ownedRenewal(renewalId, userId);
    await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "renewed", rentalId: renewal.rentalId, userId });
    return paid;
  }
  throw new Error("Pembayaran perpanjangan belum terdeteksi. Coba cek lagi sebentar.");
}
