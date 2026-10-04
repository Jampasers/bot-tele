import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { TestimonialService } from "../../src/services/testimonial.js";
import { ReceiptService } from "../../src/services/receipt.js";
import { BotConfig } from "../../src/models/BotConfig.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

test("complimentary install testimonial looks like a normal service completion without exposing invite status", async t => {
  t.mock.method(console, "log", () => {});
  t.mock.method(BotConfig, "getOrCreate", async () => ({ testimonialEnabled: true, testimonialChannel: "@testimonials" }) as never);
  const receipts: any[] = [], messages: any[] = [];
  t.mock.method(ReceiptService, "generateReceiptBuffer", async data => { receipts.push(data); return Buffer.from("receipt"); });
  const api = {
    getMe: async () => ({ username: "test_bot" }),
    sendPhoto: async () => { throw new Error("payment receipt must not be generated for complimentary installs"); },
    sendMessage: async (channel: string, text: string, options: any) => { messages.push({ channel, text, ...options }); },
  } as unknown as Api;
  const sent = await runWithTenant(platformContext(), () => TestimonialService.sendVpsPurchaseTestimonial(api, {
    orderId: "test-free-install", service: "install", planName: "Windows Install", os: "windows2022", totalPrice: 0,
    serviceValue: 25000, buyer: { telegramId: "123456789", firstName: "Buyer" },
  }));
  assert.equal(sent, true); assert.equal(receipts.length, 0); assert.equal(messages.length, 1);
  assert.match(messages[0].text, /TESTIMONI JASA INSTALL VPS BERHASIL/);
  assert.match(messages[0].text, /Harga Layanan/);
  assert.match(messages[0].text, /25\.000/);
  assert.match(messages[0].text, /Selesai &amp; Siap Digunakan/);
  assert.doesNotMatch(messages[0].text, /Undangan Gratis|Metode Pembayaran|Total Transaksi|Rp\s*0/);
  assert.doesNotMatch(messages[0].text, /123456789/);
});
