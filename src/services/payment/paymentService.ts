import type { QrisGenerator } from "./qris.js";
import type { GopayMerchant } from "./gopay-merchant.js";
import type { PaymentTransaction } from "./types.js";
import { TopupSession, type ITopupSession } from "../../models/TopupSession.js";
import { getTenantId, PLATFORM_TENANT_ID } from "../../tenant/context.js";
import { getTenantPaymentClients, withTenantPaymentLock } from "../../payments/tenantPayment.service.js";
import { claimSettlement, matchesSettlement, reservePaymentAmount } from "../../payments/paymentLedger.service.js";

export async function getQrisGenerator(): Promise<QrisGenerator> { return (await getTenantPaymentClients()).generator; }
export async function getGopayMerchant(): Promise<GopayMerchant> { return (await getTenantPaymentClients()).merchant; }

export interface GeneratedQris { buffer: Buffer; dataUri: string; payload: string }
export interface UniquePaymentResult {
  baseAmount: number;
  uniqueCode: number;
  totalAmount: number;
  paymentMerchantId: string;
  paymentConfigVersion: number;
}

/** Reserve against the merchant, including invoices with a different base amount. */
export async function getUniquePaymentAmount(baseAmount: number): Promise<UniquePaymentResult> {
  return withTenantPaymentLock(async () => {
    const clients = await getTenantPaymentClients();
    const amounts = await reservePaymentAmount(clients.merchantId, getTenantId(), Math.round(baseAmount));
    return { ...amounts, paymentMerchantId: clients.merchantId, paymentConfigVersion: clients.version };
  });
}

export async function generateQris(amountIDR: number): Promise<GeneratedQris> {
  if (!Number.isSafeInteger(amountIDR) || amountIDR < 1) throw new Error("Nominal QRIS tidak valid.");
  const generator = await getQrisGenerator();
  const dataUri = await generator.generate(amountIDR);
  const payload = await generator.getDynamicPayload(amountIDR);
  return { dataUri, payload, buffer: Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64") };
}

/** Only one caller receives a settlement. Persistent claims survive process restarts. */
export async function checkSessionSettlement(session: ITopupSession): Promise<PaymentTransaction | null> {
  const tenantId = getTenantId();
  if (session.tenantId !== tenantId) throw new Error("Cross-tenant invoice rejected.");
  if (session.status !== "PENDING") return null;
  const clients = await getTenantPaymentClients();
  // Only old platform invoices may lack the merchant snapshot after migration.
  if (session.paymentMerchantId !== clients.merchantId && !(tenantId === PLATFORM_TENANT_ID && !session.paymentMerchantId)) {
    throw new Error("Merchant configuration differs from the invoice.");
  }
  if (session.paymentConfigVersion !== undefined && session.paymentConfigVersion !== clients.version) {
    throw new Error("Payment configuration differs from the invoice.");
  }
  const expiresAt = new Date(session.createdAt.getTime() + 14 * 60_000);
  const transactions = await clients.merchant.getQrisSettlements({ startTime: session.createdAt, endTime: new Date(Math.min(Date.now(), expiresAt.getTime())) });
  for (const tx of transactions) {
    if (!matchesSettlement(tx, { merchantId: clients.merchantId, amount: session.amountIDR, createdAt: session.createdAt, expiresAt })) continue;
    const current = await TopupSession.exists({ _id: session._id, status: "PENDING" });
    if (!current) return null;
    const claimed = await claimSettlement({ merchantId: clients.merchantId, tenantId, invoiceReference: session.orderId, kind: "store", transaction: tx });
    if (claimed.owned && claimed.created) return tx;
  }
  return null;
}
