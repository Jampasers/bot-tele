import { User } from "../models/User.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { PaymentSettlementClaim } from "../models/PaymentLedger.js";
import { getTenantContext, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { generatePlatformQris, getPlatformPaymentClients } from "../payments/platformPayment.service.js";
import { claimSettlement, matchesSettlement, reservePaymentAmount } from "../payments/paymentLedger.service.js";

export type VpsBalanceResult =
  | { status: "paid"; orderId: string; remainingBalance: number }
  | { status: "insufficient"; orderId: string; currentBalance: number; requiredAmount: number; methodLocked: boolean };
export type VpsPaymentResult = { orderId: string; status: "unpaid" | "pending" | "expired" | "paid" | "refunding" | "refunded" | "cancelled" };
export type VpsRefundReason = "cancelled_before_create" | "create_rejected" | "validation_failed" | "capacity_unavailable";
const refundReasons = new Set<string>(["cancelled_before_create", "create_rejected", "validation_failed", "capacity_unavailable"]);
const INVOICE_LIFETIME_MS = 15 * 60_000;
const INVOICE_LEASE_MS = 60_000;

function platformOnly(): void {
  const context = getTenantContext();
  if (context.tenantId !== PLATFORM_TENANT_ID || context.rentalId) throw new Error("VPS payment requires platform context.");
}

function scope(orderId: string, buyerId?: string) {
  platformOnly();
  if (!/^[a-f0-9-]{36}$/i.test(orderId) || (buyerId !== undefined && !/^\d{1,20}$/.test(buyerId))) throw new Error("VPS payment access denied.");
  return { _id: orderId, tenantId: PLATFORM_TENANT_ID, ...(buyerId === undefined ? {} : { buyerId }) };
}

async function loadOrder(orderId: string, buyerId?: string): Promise<IVpsOrder> {
  const order = await VpsOrder.findOne(scope(orderId, buyerId)).lean();
  if (!order) throw new Error("VPS payment access denied.");
  if (!Number.isSafeInteger(order.snapshot.price) || order.snapshot.price < 1 || order.snapshot.price > 1_000_000_000) {
    throw new Error("Nominal snapshot pesanan VPS tidak valid.");
  }
  return order;
}

async function claimMethod(order: IVpsOrder, method: "balance" | "qris"): Promise<IVpsOrder> {
  if (order.paymentStatus === "unpaid") {
    await VpsOrder.updateOne({ ...scope(order._id, order.buyerId), paymentStatus: "unpaid", stage: { $in: ["queued", "needs_token"] }, paymentMethod: null }, {
      $set: { paymentStatus: "paying", paymentMethod: method },
    });
    order = await loadOrder(order._id, order.buyerId);
  }
  if (order.paymentStatus === "paid") return order;
  if (order.paymentStatus !== "paying") throw new Error("Pesanan VPS sudah dibayar atau ditutup.");
  if (order.paymentMethod !== method) throw new Error(`Metode pembayaran pesanan sudah dipilih (${order.paymentMethod === "qris" ? "QRIS" : "saldo"}).`);
  return order;
}

async function markPaid(order: IVpsOrder, paidAt = new Date(), transactionId?: string): Promise<void> {
  await VpsOrder.updateOne({ ...scope(order._id, order.buyerId), paymentStatus: "paying", paymentMethod: order.paymentMethod }, { $set: {
    paymentStatus: "paid", paymentPaidAt: paidAt, nextRunAt: new Date(),
    ...(transactionId === undefined ? {} : { "paymentInvoice.matchedTransactionId": transactionId, "paymentInvoice.paidAt": paidAt }),
  } });
}

/** The receipt and balance mutation share ONE MongoDB document update. The
 * persistent order intent survives a crash before/after that update; no separate
 * wallet insert or in-memory lock is trusted to prevent debit/refund replay. */
async function applyWalletEffect(order: IVpsOrder, kind: "debit" | "refund", amount: number): Promise<{ balance: number; applied: boolean } | null> {
  platformOnly();
  const effectId = `vps:${kind}:${order._id}`;
  const debitId = `vps:debit:${order._id}`;
  const wallet = { telegramId: order.buyerId, tenantId: PLATFORM_TENANT_ID };
  const changed = await User.findOneAndUpdate({
    ...wallet,
    appliedVpsPaymentEffectIds: { $ne: effectId },
    ...(kind === "debit" ? { balance: { $gte: amount } } : {}),
    ...(kind === "refund" && order.paymentMethod === "balance" ? { $and: [{ appliedVpsPaymentEffectIds: debitId }] } : {}),
  }, {
    $inc: { balance: kind === "debit" ? -amount : amount, ...(kind === "debit" ? { totalOrders: 1 } : {}) },
    $addToSet: { appliedVpsPaymentEffectIds: effectId },
  }, { returnDocument: "after" }).select("balance").lean();
  if (changed) {
    // Audit delivery is best effort. An audit/logging failure must never reverse
    // a successful payment or be confused with a provisioning failure.
    await BalanceLog.create({
      userId: order.buyerId, type: kind === "debit" ? "PURCHASE" : "REFUND", amount,
      balanceBefore: changed.balance + (kind === "debit" ? amount : -amount), balanceAfter: changed.balance,
      reason: `VPS ${kind === "debit" ? "payment" : "refund"} ${order._id}`,
    }).catch(() => console.warn("[VPS] Balance audit log write failed; durable wallet receipt retained."));
    return { balance: changed.balance, applied: true };
  }
  const existing = await User.findOne({ ...wallet, appliedVpsPaymentEffectIds: effectId }).select("balance").lean();
  return existing ? { balance: existing.balance, applied: false } : null;
}

export async function payVpsFromBalance(orderId: string, buyerId: string): Promise<VpsBalanceResult> {
  let order = await loadOrder(orderId, buyerId);
  const wallet = await User.findOne({ telegramId: buyerId, tenantId: PLATFORM_TENANT_ID }).select("balance").lean();
  if (order.paymentStatus === "paid") return { status: "paid", orderId, remainingBalance: wallet?.balance ?? 0 };
  // A normal insufficient-balance result does not choose a method, allowing QRIS.
  // Once claimed, a durable balance intent cannot switch methods while recovery
  // may still be completing its single-document wallet mutation.
  if (order.paymentStatus === "unpaid" && (wallet?.balance ?? 0) < order.snapshot.price) {
    return { status: "insufficient", orderId, currentBalance: wallet?.balance ?? 0, requiredAmount: order.snapshot.price, methodLocked: false };
  }
  order = await claimMethod(order, "balance");
  if (order.paymentStatus === "paid") {
    const latestWallet = await User.findOne({ telegramId: buyerId, tenantId: PLATFORM_TENANT_ID }).select("balance").lean();
    return { status: "paid", orderId, remainingBalance: latestWallet?.balance ?? 0 };
  }
  const effect = await applyWalletEffect(order, "debit", order.snapshot.price);
  if (!effect) {
    const latestWallet = await User.findOne({ telegramId: buyerId, tenantId: PLATFORM_TENANT_ID }).select("balance").lean();
    return { status: "insufficient", orderId, currentBalance: latestWallet?.balance ?? 0, requiredAmount: order.snapshot.price, methodLocked: true };
  }
  await markPaid(order);
  return { status: "paid", orderId, remainingBalance: effect.balance };
}

export async function createVpsInvoice(orderId: string, buyerId: string) {
  let order = await claimMethod(await loadOrder(orderId, buyerId), "qris");
  if (order.paymentStatus === "paid") throw new Error("Pesanan VPS sudah dibayar.");
  if (!order.paymentInvoice) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + INVOICE_LEASE_MS);
    const leased = await VpsOrder.findOneAndUpdate({ ...scope(orderId, buyerId), paymentStatus: "paying", paymentMethod: "qris",
      paymentInvoice: { $exists: false }, $or: [{ paymentInvoiceLeaseUntil: null }, { paymentInvoiceLeaseUntil: { $lte: now } }],
    }, { $set: { paymentInvoiceLeaseUntil: leaseUntil } }, { returnDocument: "after" }).lean();
    if (!leased) {
      order = await loadOrder(orderId, buyerId);
      if (!order.paymentInvoice) throw new Error("Invoice VPS sedang disiapkan. Tekan QRIS lagi sebentar.");
    } else {
      try {
        const { merchantId } = getPlatformPaymentClients();
        const amount = await reservePaymentAmount(merchantId, PLATFORM_TENANT_ID, order.snapshot.price);
        const createdAt = new Date();
        await VpsOrder.updateOne({ ...scope(orderId, buyerId), paymentStatus: "paying", paymentMethod: "qris", paymentInvoice: { $exists: false }, paymentInvoiceLeaseUntil: leaseUntil }, {
          $set: { paymentInvoice: { reference: `vps-${orderId}`, merchantId, amount: amount.totalAmount, createdAt, expiresAt: new Date(createdAt.getTime() + INVOICE_LIFETIME_MS) } },
        });
      } finally {
        await VpsOrder.updateOne({ ...scope(orderId, buyerId), paymentInvoiceLeaseUntil: leaseUntil }, { $set: { paymentInvoiceLeaseUntil: null } });
      }
      order = await loadOrder(orderId, buyerId);
    }
  }
  const invoice = order.paymentInvoice;
  if (!invoice) throw new Error("Invoice VPS perlu dicoba kembali.");
  if (invoice.expiresAt.getTime() <= Date.now()) throw new Error("Invoice QRIS sudah kedaluwarsa. Cek pembayaran sebelum membuat pesanan baru.");
  if (invoice.merchantId !== getPlatformPaymentClients().merchantId) throw new Error("Merchant platform berubah; invoice VPS perlu pemeriksaan.");
  return { orderId, invoice, qris: await generatePlatformQris(invoice.amount) };
}

export async function checkVpsPayment(orderId: string, buyerId?: string, signal?: AbortSignal): Promise<VpsPaymentResult> {
  signal?.throwIfAborted();
  const order = await loadOrder(orderId, buyerId);
  signal?.throwIfAborted();
  if (order.paymentStatus !== "paying") return { orderId, status: order.paymentStatus };
  if (order.paymentMethod === "balance") {
    const result = await payVpsFromBalance(orderId, order.buyerId);
    return { orderId, status: result.status === "paid" ? "paid" : "pending" };
  }
  const invoice = order.paymentInvoice;
  if (!invoice) return { orderId, status: "pending" };
  // A crash after the global settlement claim must be recoverable even if the
  // merchant API later becomes unavailable or stops returning an old payment.
  const claimed = await PaymentSettlementClaim.findOne({ merchantId: invoice.merchantId, tenantId: PLATFORM_TENANT_ID,
    invoiceReference: invoice.reference, kind: "vps" }).lean();
  if (claimed) {
    await markPaid(order, claimed.paidAt, claimed.transactionId);
    return { orderId, status: "paid" };
  }
  const clients = getPlatformPaymentClients();
  if (clients.merchantId !== invoice.merchantId) throw new Error("Merchant platform berubah; invoice VPS perlu pemeriksaan.");
  const transactions = await clients.merchant.getQrisSettlements({ startTime: invoice.createdAt, endTime: new Date(Math.min(Date.now(), invoice.expiresAt.getTime())) }, signal);
  signal?.throwIfAborted();
  for (const transaction of transactions) {
    if (!matchesSettlement(transaction, invoice)) continue;
    const claim = await claimSettlement({ merchantId: invoice.merchantId, tenantId: PLATFORM_TENANT_ID, invoiceReference: invoice.reference, kind: "vps", transaction });
    if (!claim.owned) continue;
    await markPaid(order, new Date(transaction.paidAt), transaction.transactionId);
    return { orderId, status: "paid" };
  }
  // Expiry is a display state, not a destructive payment transition. Keeping the
  // original matching window allows delayed provider indexing without recreating
  // an invoice, releasing an ambiguous payment, or racing a concurrent settlement.
  return { orderId, status: invoice.expiresAt.getTime() <= Date.now() ? "expired" : "pending" };
}

/** Only terminal, confirmed no-create outcomes can enter refunding. A create
 * timeout/unknown result, existing droplet, or notification failure never qualifies.
 * QRIS refunds are credited to platform balance, including the unique amount. */
export async function refundVpsOrder(orderId: string, reason: VpsRefundReason): Promise<{ orderId: string; status: "refunded" }> {
  if (!refundReasons.has(reason)) throw new Error("Alasan refund VPS tidak valid.");
  let order = await loadOrder(orderId);
  if (order.paymentStatus === "refunded") return { orderId, status: "refunded" };
  if (!["failed", "cancelled"].includes(order.stage) || order.createAttemptedAt !== null || order.dropletId !== null) {
    throw new Error("Refund VPS ditolak: hasil create belum pasti atau droplet sudah ada.");
  }
  if (order.paymentStatus === "paid") {
    await VpsOrder.updateOne({ ...scope(orderId, order.buyerId), paymentStatus: "paid", stage: { $in: ["failed", "cancelled"] }, createAttemptedAt: null, dropletId: null }, {
      $set: { paymentStatus: "refunding", refundReason: reason },
    });
    order = await loadOrder(orderId);
  }
  if (order.paymentStatus === "refunded") return { orderId, status: "refunded" };
  if (order.paymentStatus !== "refunding") throw new Error("Transisi refund VPS tidak tersedia.");
  if (order.paymentMethod !== "balance" && order.paymentMethod !== "qris") throw new Error("Bukti pembayaran untuk refund VPS tidak tersedia.");
  const amount = order.paymentMethod === "qris" ? order.paymentInvoice?.amount : order.snapshot.price;
  if (!amount || !Number.isSafeInteger(amount) || amount < 1 || (order.paymentMethod === "qris" && !order.paymentInvoice?.matchedTransactionId)) {
    throw new Error("Bukti pembayaran untuk refund VPS tidak tersedia.");
  }
  const effect = await applyWalletEffect(order, "refund", amount);
  if (!effect) throw new Error("Refund VPS menunggu pemulihan wallet; pesanan tetap tercatat.");
  await VpsOrder.updateOne({ ...scope(orderId, order.buyerId), paymentStatus: "refunding" }, { $set: { paymentStatus: "refunded", refundedAt: new Date() } });
  return { orderId, status: "refunded" };
}

/** Called by the platform worker at startup and on each payment polling tick. */
export async function reconcileVpsPayments(options: { signal?: AbortSignal; concurrency?: number } = {}): Promise<void> {
  platformOnly();
  if (options.signal?.aborted) return;
  const concurrency = Number.isSafeInteger(options.concurrency) && options.concurrency! > 0 ? Math.min(4, options.concurrency!) : 2;
  const cursor = VpsOrder.find({ tenantId: PLATFORM_TENANT_ID, paymentStatus: { $in: ["paying", "refunding"] } })
    .select("_id buyerId paymentStatus paymentMethod paymentInvoice refundReason").lean().cursor();
  const active = new Set<Promise<void>>();
  const reconcile = async (order: IVpsOrder): Promise<void> => {
    try {
      options.signal?.throwIfAborted();
      if (order.paymentStatus === "refunding") {
        if (!order.refundReason || !refundReasons.has(order.refundReason)) throw new Error("Missing refund reason");
        await refundVpsOrder(order._id, order.refundReason as VpsRefundReason);
      } else if (order.paymentMethod === "qris" && !order.paymentInvoice) {
        await createVpsInvoice(order._id, order.buyerId);
      } else await checkVpsPayment(order._id, undefined, options.signal);
    } catch {
      if (!options.signal?.aborted) console.warn("[VPS] Payment reconciliation pending; retry retained.");
    }
  };
  try {
    for await (const order of cursor) {
      if (options.signal?.aborted) break;
      const job = reconcile(order);
      active.add(job);
      void job.finally(() => active.delete(job));
      if (active.size >= concurrency) await Promise.race(active);
    }
  } finally {
    await Promise.all(active);
  }
}
