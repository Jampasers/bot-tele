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
  const email = (process.env["GOJEK_EMAIL"] || process.env["GOBIZ_EMAIL"] || "").trim();
  const password = process.env["GOJEK_PASSWORD"] || process.env["GOBIZ_PASSWORD"] || "";
  const accessToken = (
    process.env["GOPAY_ACCESS_TOKEN"]
    || process.env["GOBIZ_ACCESS_TOKEN"]
    || process.env["GOJEK_ACCESS_TOKEN"]
    || ""
  ).trim();

  // Invoice creation still needs a stable merchant identity for amount
  // reservation and settlement ownership. Authentication, however, is only
  // required when settlement data is actually queried. Keeping those concerns
  // separate preserves the legacy behavior where QRIS can be generated from a
  // static payload/image even before GoBiz login is configured.
  if (!merchantId) {
    throw new Error("Payment platform belum dikonfigurasi (GOPAY_MERCHANT_ID wajib tersedia).");
  }

  platformClients = {
    merchantId,
    version: 1,
    generator: new QrisGenerator(
      payload
        ? { qrisStaticPayload: payload }
        : { qrisImage: process.env["QRIS_IMAGE_PATH"] || "./qris-static.png" },
    ),
    merchant: new GopayMerchant({
      merchantId,
      ...(email && password
        ? { email, password }
        : accessToken
          ? { accessToken }
          : {}),
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
