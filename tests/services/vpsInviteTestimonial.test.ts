import assert from "node:assert/strict";
import test from "node:test";
import type { Api } from "grammy";
import { TestimonialService } from "../../src/services/testimonial.js";
import { ReceiptService } from "../../src/services/receipt.js";
import { BotConfig } from "../../src/models/BotConfig.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

test("free install uses the normal testimonial and receipt with zero charge and masked buyer ID", async t => {
  t.mock.method(console, "log", () => {});
  t.mock.method(BotConfig, "getOrCreate", async () => ({ testimonialEnabled: true, testimonialChannel: "@testimonials" }) as never);
  const receipts: any[] = [], messages: any[] = [];
  t.mock.method(ReceiptService, "generateReceiptBuffer", async data => { receipts.push(data); return Buffer.from("receipt"); });
  const api = { getMe: async () => ({ username: "test_bot" }), sendPhoto: async (channel: string, _photo: unknown, options: any) => { messages.push({ channel, ...options }); } } as unknown as Api;
  const sent = await runWithTenant(platformContext(), () => TestimonialService.sendVpsPurchaseTestimonial(api, {
    orderId: "test-free-install", service: "install", planName: "Windows Install", os: "windows2022", totalPrice: 0,
    method: "Undangan Gratis", buyer: { telegramId: "123456789", firstName: "Buyer" },
  }));
  assert.equal(sent, true); assert.equal(receipts.length, 1); assert.equal(messages.length, 1);
  assert.equal(receipts[0].totalIdr, 0); assert.equal(receipts[0].method, "Undangan Gratis");
  assert.equal(receipts[0].category, "Jasa Install VPS");
  assert.match(messages[0].caption, /TESTIMONI JASA INSTALL VPS BERHASIL/);
  assert.match(messages[0].caption, /Undangan Gratis/);
  assert.doesNotMatch(messages[0].caption, /123456789/);
  assert.doesNotMatch(receipts[0].buyerName, /123456789/);
});
