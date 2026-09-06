import { GopayMerchant } from "../services/payment/gopay-merchant.js";
import { QrisGenerator } from "../services/payment/qris.js";
import type { PaymentClients } from "./tenantPayment.service.js";
import type { GeneratedQris } from "../services/payment/paymentService.js";

let platformClients: PaymentClients | undefined;

/** Explicit platform merchant. Never consults tenant payment configuration. */
export function getPlatformPaymentClients(): PaymentClients {
  if (platformClients) return platformClients;
  const merchantId = process.env["GOPAY_MERCHANT_ID"]?.trim() ?? "";
  const payload = process.env["QRIS_STATIC_PAYLOAD"]?.trim();
  const email = process.env["GOJEK_EMAIL"] || process.env["GOBIZ_EMAIL"] || "";
  const password = process.env["GOJEK_PASSWORD"] || process.env["GOBIZ_PASSWORD"] || "";
  if (!merchantId || !email.trim() || !password) throw new Error("Payment platform belum dikonfigurasi (merchant dan login GoBiz wajib tersedia).");
  platformClients = {
    merchantId, version: 1,
    generator: new QrisGenerator(payload ? { qrisStaticPayload: payload } : { qrisImage: process.env["QRIS_IMAGE_PATH"] || "./qris-static.png" }),
    merchant: new GopayMerchant({
      merchantId,
      email,
      password,
    }),
  };
  return platformClients;
}

export async function generatePlatformQris(amount: number): Promise<GeneratedQris> {
  const { generator } = getPlatformPaymentClients();
  const dataUri = await generator.generate(amount);
  const payload = await generator.getDynamicPayload(amount);
  return { dataUri, payload, buffer: Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64") };
}
