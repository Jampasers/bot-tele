import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { TestimonialService } from "../../src/services/testimonial.js";
import { ReceiptService } from "../../src/services/receipt.js";
import { BotConfig } from "../../src/models/BotConfig.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

test("complimentary install testimonial hides free payment details and only shows completed status", async t => {
  t.mock.method(console, "log", () => {});
  t.mock.method(BotConfig, "getOrCreate", async () => ({ testimonialEnabled: true, testimonialChannel: "@testimonials" }) as never);
  const receipts: any[] = [], messages: any[] = [];
  t.mock.method(ReceiptService, "generateReceiptBuffer", async data => { receipts.push(data); return Buffer.from("receipt"); });
  const api = {
    getMe: async () => ({ username: "test_bot" }),
    sendPhoto: async () => { throw new Error("receipt must not be generated for hidden payment details"); },
    sendMessage: async (channel: string, text: string, options: any) => { messages.push({ channel, text, ...options }); },
  } as unknown as Api;
  const sent = await runWithTenant(platformContext(), () => TestimonialService.sendVpsPurchaseTestimonial(api, {
    orderId: "test-free-install", service: "install", planName: "Windows Install", os: "windows2022", totalPrice: 0,
    method: "Undangan Gratis", hidePaymentDetails: true, buyer: { telegramId: "123456789", firstName: "Buyer" },
  }));
  assert.equal(sent, true); assert.equal(receipts.length, 0); assert.equal(messages.length, 1);
  assert.match(messages[0].text, /TESTIMONI JASA INSTALL VPS BERHASIL/);
  assert.match(messages[0].text, /Selesai &amp; Siap Digunakan/);
  assert.doesNotMatch(messages[0].text, /Undangan Gratis|Total Transaksi|Metode Pembayaran|Rp\s*0/);
  assert.doesNotMatch(messages[0].text, /123456789/);
});
