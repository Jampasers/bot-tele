import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { BotRental } from "../models/BotRental.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { RentalPayment, type IRentalPayment } from "../models/RentalPayment.js";
import { User } from "../models/User.js";
import { getTenantContext, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { generatePlatformQris, getPlatformPaymentClients } from "../payments/platformPayment.service.js";
import { claimSettlement, matchesSettlement, reservePaymentAmount } from "../payments/paymentLedger.service.js";
import { applyRenewal, refreshRentalState, type RentalRuntimeState } from "./rental.service.js";

export interface RentalPaymentResult {
  status: IRentalPayment["status"];
  rentalId: string;
  rental?: RentalRuntimeState;
}
export type RentalBalancePaymentResult =
  | { status: "paid"; rentalId: string; rental: RentalRuntimeState; remainingBalance: number }
  | { status: "insufficient"; rentalId: string; currentBalance: number; requiredAmount: number }
  | { status: "invoice_pending"; rentalId: string };
const invoiceLocks = new Map<string, Promise<void>>();

async function authorizeRental(rentalId: string, actorTelegramId: string) {
  const context = getTenantContext();
  if (!Types.ObjectId.isValid(rentalId)) throw new Error("Rental access denied.");
  const platformRequest = context.tenantId === PLATFORM_TENANT_ID && !context.rentalId;
  if (!platformRequest && context.rentalId !== rentalId) throw new Error("Rental access denied.");
  const rental = await BotRental.findOne({
    _id: rentalId,
    ...(platformRequest ? {} : { tenantId: context.tenantId }),
    status: { $ne: "terminated" },
  }).select("+appliedRentalPaymentIds").lean();
  if (!rental || (rental.ownerTelegramId !== actorTelegramId && !rental.adminTelegramIds.includes(actorTelegramId))) throw new Error("Rental access denied.");
  return rental;
}

/** Initial self-service activation uses the same platform balance as digital products. */
export async function activatePendingRentalFromBalance(
  rentalId: string,
  actorTelegramId: string,
  planId: string,
): Promise<RentalBalancePaymentResult> {
  const rental = await authorizeRental(rentalId, actorTelegramId);
  if (!Types.ObjectId.isValid(planId)) throw new Error("Paket tidak valid.");
  const plan = await RentalPlan.findOne({ _id: planId, enabled: true }).lean();
  if (!plan) throw new Error("Paket tidak tersedia.");
  const paymentId = `balance-initial-${rentalId}`;

  if (rental.appliedRentalPaymentIds.includes(paymentId)) {
    const state = await applyRenewal(rentalId, paymentId, plan.durationDays, String(plan._id));
    const user = await User.findOne({ telegramId: actorTelegramId }).select("balance").lean();
    return { status: "paid", rentalId, rental: state, remainingBalance: user?.balance ?? 0 };
  }
  if (rental.status !== "pending") throw new Error("Pembayaran saldo hanya tersedia untuk aktivasi awal rental.");
  const pendingInvoice = await RentalPayment.exists({
    rentalId,
    $or: [
      { status: "processing" },
      { status: "pending", expiresAt: { $gt: new Date() } },
    ],
  });
  if (pendingInvoice) return { status: "invoice_pending", rentalId };

  const before = await User.findOne({ telegramId: actorTelegramId }).select("balance").lean();
  const updated = await User.findOneAndUpdate({
    telegramId: actorTelegramId,
    balance: { $gte: plan.price },
    appliedRentalBalancePaymentIds: { $ne: paymentId },
  }, {
    $inc: { balance: -plan.price, totalOrders: 1 },
    $addToSet: { appliedRentalBalancePaymentIds: paymentId },
  }, { returnDocument: "after" }).select("+appliedRentalBalancePaymentIds");

  if (!updated) {
    const alreadyDebited = await User.findOne({
      telegramId: actorTelegramId,
      appliedRentalBalancePaymentIds: paymentId,
    }).select("balance").lean();
    if (!alreadyDebited) {
      return {
        status: "insufficient",
        rentalId,
        currentBalance: before?.balance ?? 0,
        requiredAmount: plan.price,
      };
    }
    const state = await applyRenewal(rentalId, paymentId, plan.durationDays, String(plan._id));
    return { status: "paid", rentalId, rental: state, remainingBalance: alreadyDebited.balance };
  }

  // If activation is interrupted after the debit, keep the durable payment key.
  // A retry reuses it and applies the rental without charging the user again.
  const state = await applyRenewal(rentalId, paymentId, plan.durationDays, String(plan._id));
  await BalanceLog.create({
    userId: actorTelegramId,
    type: "PURCHASE",
    amount: plan.price,
    balanceBefore: before?.balance ?? updated.balance + plan.price,
    balanceAfter: updated.balance,
    reason: `Aktivasi rental @${rental.botUsername} (${plan.name})`,
  }).catch(() => console.warn(`[Rental:${rentalId}] Balance audit log write failed.`));
  return { status: "paid", rentalId, rental: state, remainingBalance: updated.balance };
}

export async function createRentalInvoice(rentalId: string, actorTelegramId: string, planId: string) {
  await authorizeRental(rentalId, actorTelegramId);
  if (!Types.ObjectId.isValid(planId)) throw new Error("Paket tidak valid.");
  const before = invoiceLocks.get(rentalId) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  const lock = before.then(() => done);
  invoiceLocks.set(rentalId, lock);
  await before;
  try {
    // Reuse an active invoice, limiting repeated button taps to one reservation.
    let payment = await RentalPayment.findOne({ rentalId, status: "pending", expiresAt: { $gt: new Date() } }).lean();
    if (!payment) {
      const plan = await RentalPlan.findOne({ _id: planId, enabled: true }).lean();
      if (!plan) throw new Error("Paket tidak tersedia.");
      const rental = await BotRental.findById(rentalId).lean();
      if (!rental) throw new Error("Rental tidak ditemukan.");
      const { merchantId } = getPlatformPaymentClients();
      const amount = await reservePaymentAmount(merchantId, rental.tenantId, plan.price);
      payment = (await RentalPayment.create({
        rentalId, tenantId: rental.tenantId, ownerTelegramId: rental.ownerTelegramId,
        planId: String(plan._id), durationDays: plan.durationDays, baseAmount: plan.price,
        amount: amount.totalAmount, merchantId, provider: "GOPAY", providerReference: randomUUID(),
        status: "pending", expiresAt: new Date(Date.now() + 15 * 60_000),
      })).toObject();
    }
    if (payment.merchantId !== getPlatformPaymentClients().merchantId) throw new Error("Payment platform berubah; hubungi platform.");
    return { payment, qris: await generatePlatformQris(payment.amount) };
  } finally {
    release();
    if (invoiceLocks.get(rentalId) === lock) invoiceLocks.delete(rentalId);
  }
}

export async function checkRentalPayment(providerReference: string, actorTelegramId?: string): Promise<RentalPaymentResult> {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(providerReference)) throw new Error("Referensi invoice tidak valid.");
  const payment = await RentalPayment.findOne({ providerReference }).lean();
  if (!payment) throw new Error("Invoice tidak ditemukan.");
  if (actorTelegramId !== undefined) await authorizeRental(payment.rentalId, actorTelegramId);
  else if (getTenantContext().tenantId !== PLATFORM_TENANT_ID) throw new Error("Payment reconciliation requires platform context.");
  if (payment.status === "paid") {
    const rental = await refreshRentalState(payment.rentalId);
    return rental ? { status: "paid", rentalId: payment.rentalId, rental } : { status: "paid", rentalId: payment.rentalId };
  }
  if (payment.status === "expired") return { status: "expired", rentalId: payment.rentalId };
  if (payment.status !== "processing") {
    const clients = getPlatformPaymentClients();
    if (clients.merchantId !== payment.merchantId) throw new Error("Platform merchant changed; invoice needs reconciliation.");
    const transactions = await clients.merchant.getQrisSettlements({
      startTime: payment.createdAt, endTime: new Date(Math.min(Date.now(), payment.expiresAt.getTime())),
    });
    let found = false;
    for (const transaction of transactions) {
      if (!matchesSettlement(transaction, payment)) continue;
      const claim = await claimSettlement({ merchantId: payment.merchantId, tenantId: payment.tenantId,
        invoiceReference: payment.providerReference, kind: "rental", transaction });
      if (!claim.owned) continue;
      await RentalPayment.updateOne({ _id: payment._id, status: "pending" }, { $set: {
        status: "processing", matchedTransactionId: transaction.transactionId, paidAt: new Date(transaction.paidAt),
      } });
      found = true;
      break;
    }
    if (!found) {
      // Allow five minutes for provider indexing, still matching the invoice's
      // original payment window; late transfers never extend another invoice.
      if (payment.expiresAt.getTime() + 5 * 60_000 < Date.now()) {
        await RentalPayment.updateOne({ _id: payment._id, status: "pending" }, { $set: { status: "expired" } });
      }
      const latest = await RentalPayment.findById(payment._id).lean();
      return { status: latest?.status ?? "pending", rentalId: payment.rentalId };
    }
  }
  const durablePayment = await RentalPayment.findById(payment._id).lean();
  if (!durablePayment || !["processing", "paid"].includes(durablePayment.status)) {
    return { status: durablePayment?.status ?? "pending", rentalId: payment.rentalId };
  }
  // Retry after a crash is safe: the payment receipt and expiry change are one
  // atomic update inside BotRental, before this separate ledger is marked paid.
  const rental = await applyRenewal(payment.rentalId, payment.providerReference, payment.durationDays, payment.planId);
  await RentalPayment.updateOne({ _id: payment._id, status: "processing" }, { $set: { status: "paid" } });
  return { status: "paid", rentalId: payment.rentalId, rental };
}

export async function pollPendingRentalPayments(): Promise<void> {
  if (getTenantContext().tenantId !== PLATFORM_TENANT_ID) throw new Error("Platform context required.");
  const cursor = RentalPayment.find({ status: { $in: ["pending", "processing"] } }).select("providerReference rentalId").lean().cursor();
  for await (const invoice of cursor) {
    try { await checkRentalPayment(invoice.providerReference); }
    catch { console.warn(`[Rental:${invoice.rentalId}] Payment reconciliation failed; retry pending.`); }
  }
}
