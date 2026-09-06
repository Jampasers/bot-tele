import { createHash } from "node:crypto";
import { PaymentAmountReservation, PaymentSettlementClaim } from "../models/PaymentLedger.js";
import type { PaymentTransaction } from "../services/payment/types.js";

const key = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const duplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === 11000;

export async function reservePaymentAmount(merchantId: string, tenantId: string, baseAmount: number): Promise<{
  baseAmount: number; uniqueCode: number; totalAmount: number;
}> {
  if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(merchantId) || !/^[A-Za-z0-9_-]{1,100}$/.test(tenantId)) throw new Error("Identitas payment tidak valid.");
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 1 || baseAmount > 1_000_000_000) throw new Error("Nominal pembayaran tidak valid.");
  const now = new Date();
  for (let uniqueCode = 1; uniqueCode <= 1000; uniqueCode++) {
    const totalAmount = baseAmount + uniqueCode;
    try {
      // _id is the uniqueness boundary, including different base amounts that
      // would otherwise produce the same final amount for the same merchant.
      await PaymentAmountReservation.findOneAndUpdate({
        _id: key(merchantId, String(totalAmount)), expiresAt: { $lte: now },
      }, { $set: { merchantId, tenantId, amount: totalAmount, reservedAt: now, expiresAt: new Date(now.getTime() + 30 * 60_000) } },
      { upsert: true, returnDocument: "after", runValidators: true });
      return { baseAmount, uniqueCode, totalAmount };
    } catch (error) { if (!duplicate(error)) throw error; }
  }
  throw new Error("Slot nominal payment sedang penuh. Coba lagi nanti.");
}

export async function claimSettlement(input: {
  merchantId: string; tenantId: string; invoiceReference: string; kind: "store" | "rental"; transaction: PaymentTransaction;
}): Promise<{ owned: boolean; created: boolean }> {
  const transaction = input.transaction;
  if (transaction.merchantId !== input.merchantId || !transaction.transactionId?.trim() || !input.invoiceReference?.trim() ||
      !Number.isSafeInteger(transaction.amount) || transaction.amount <= 0 || !Number.isFinite(transaction.paidAt) ||
      transaction.paymentType?.toUpperCase() !== "QRIS" || !["SETTLEMENT", "SETTLED"].includes(transaction.status?.toUpperCase())) {
    return { owned: false, created: false };
  }
  const id = key(input.merchantId, transaction.transactionId);
  try {
    await PaymentSettlementClaim.create({
      _id: id, merchantId: input.merchantId, tenantId: input.tenantId,
      invoiceReference: input.invoiceReference, kind: input.kind,
      transactionId: transaction.transactionId, paidAt: new Date(transaction.paidAt),
    });
    return { owned: true, created: true };
  } catch (error) {
    if (!duplicate(error)) throw error;
    const existing = await PaymentSettlementClaim.findById(id).lean();
    return { owned: existing?.invoiceReference === input.invoiceReference && existing.tenantId === input.tenantId && existing.kind === input.kind, created: false };
  }
}

export function matchesSettlement(transaction: PaymentTransaction, invoice: {
  merchantId: string; amount: number; createdAt: Date; expiresAt: Date;
}): boolean {
  return transaction.merchantId === invoice.merchantId && transaction.paymentType.toUpperCase() === "QRIS" &&
    ["SETTLEMENT", "SETTLED"].includes(transaction.status.toUpperCase()) && transaction.amount === invoice.amount &&
    transaction.paidAt >= invoice.createdAt.getTime() && transaction.paidAt <= invoice.expiresAt.getTime();
}
