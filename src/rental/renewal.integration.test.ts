import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHmac, randomBytes } from "node:crypto";
import mongoose, { Types } from "mongoose";
import { Bot } from "grammy";
import { BotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { RentalPayment } from "../models/RentalPayment.js";
import { PaymentAmountReservation, PaymentSettlementClaim } from "../models/PaymentLedger.js";
import { TopupSession } from "../models/TopupSession.js";
import { User } from "../models/User.js";
import { createRentalInvoice, checkRentalPayment, pollPendingRentalPayments } from "./rentalPayment.service.js";
import { applyRenewal, DAY_MS, refreshRentalState, synchronizeRentalLifecycle } from "./rental.service.js";
import { createRentalWebhookServer } from "./rentalWebhook.js";
import { getPlatformPaymentClients } from "../payments/platformPayment.service.js";
import { GopayMerchant } from "../services/payment/gopay-merchant.js";
import type { PaymentTransaction } from "../services/payment/types.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import digitalPlugin from "../plugins/digital/index.js";
import { rentalMiddleware } from "./rental.middleware.js";

const uri = process.env.TEST_MONGODB_URI;

test("renewal payment and bot gating with disposable MongoDB and mocked providers", { skip: !uri }, async t => {
  assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  const dbName = `rental_flow_test_${randomUUID().replaceAll("-", "")}`;
  const saved = { ...process.env };
  process.env.GOPAY_MERCHANT_ID = "test-platform-merchant";
  process.env.GOBIZ_EMAIL = "test@example.invalid";
  process.env.GOBIZ_PASSWORD = "offline-test-password";
  process.env.QRIS_STATIC_PAYLOAD = "00020101021126190015ID.CO.GOPAY.WWW53033605802ID5908PLATFORM6007JAKARTA";
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  await mongoose.connect(uri!, { dbName, autoCreate: false, autoIndex: false });
  try {
    for (const model of [BotRental, RentalPlan, RentalPayment, PaymentAmountReservation, PaymentSettlementClaim, TopupSession, User]) {
      await model.createCollection();
      await model.createIndexes();
    }
    const plan = await RentalPlan.create({ code: "month", name: "30 Hari", durationDays: 30, price: 25000, enabledFeatures: ["digital", "affiliate"] });
    const initialExpiry = new Date(Date.now() + 10 * DAY_MS);
    const aId = new Types.ObjectId();
    const bId = new Types.ObjectId();
    const a = { tenantId: aId.toString(), rentalId: aId.toString(), ownerTelegramId: "101", adminTelegramIds: ["102"] };
    const b = { tenantId: bId.toString(), rentalId: bId.toString(), ownerTelegramId: "201", adminTelegramIds: [] };
    for (const [context, id] of [[a, aId], [b, bId]] as const) {
      await BotRental.create({ _id: id, ...context, botId: context.ownerTelegramId, botTokenEncrypted: "opaque-test-token",
        botUsername: `test_${context.ownerTelegramId}_bot`, status: "active", plan: String(plan._id), expiresAt: initialExpiry });
    }
    let transactions: PaymentTransaction[] = [];
    let providerReads = 0;
    t.mock.method(GopayMerchant.prototype, "getQrisSettlements", async () => { providerReads++; return transactions; });

    const [invoice, sameInvoice] = await Promise.all([
      runWithTenant(a, () => createRentalInvoice(a.rentalId, "101", String(plan._id))),
      runWithTenant(a, () => createRentalInvoice(a.rentalId, "102", String(plan._id))),
    ]);
    const reference = invoice.payment.providerReference;
    await t.test("repeated invoice clicks reuse platform invoice; other tenant/customer is denied", async () => {
      assert.equal(reference, sameInvoice.payment.providerReference);
      assert.equal(await RentalPayment.countDocuments({ rentalId: a.rentalId }), 1);
      assert.equal(invoice.payment.merchantId, "test-platform-merchant");
      assert.match(invoice.qris.payload, /PLATFORM/);
      assert.equal(getPlatformPaymentClients().merchantId, "test-platform-merchant");
      await assert.rejects(runWithTenant(a, () => createRentalInvoice(a.rentalId, "999", String(plan._id))), /access denied/);
      await assert.rejects(runWithTenant(b, () => checkRentalPayment(reference, "201")), /access denied/);
      await assert.rejects(runWithTenant(a, () => checkRentalPayment(reference)), /platform context/);
    });
    await t.test("wrong merchant cannot settle renewal; concurrent valid callbacks extend exactly once", async () => {
      transactions = [{ merchantId: "renter-merchant", amount: invoice.payment.amount, paidAt: Date.now(), paymentType: "QRIS", status: "SETTLEMENT", transactionId: "tx-a" }];
      assert.equal((await runWithTenant(a, () => checkRentalPayment(reference, "101"))).status, "pending");
      transactions[0]!.merchantId = "test-platform-merchant";
      const results = await Promise.all(Array.from({ length: 8 }, () => runWithTenant(a, () => checkRentalPayment(reference, "101"))));
      assert.ok(results.every(result => result.status === "paid"));
      assert.equal((await BotRental.findById(aId).lean())!.expiresAt.getTime(), initialExpiry.getTime() + 30 * DAY_MS);
      assert.equal((await BotRental.findById(bId).lean())!.expiresAt.getTime(), initialExpiry.getTime());
      assert.equal(await PaymentSettlementClaim.countDocuments({ transactionId: "tx-a" }), 1);
    });
    await t.test("duplicate authenticated webhook ignores tenant body and does not reapply paid receipt", async () => {
      const secret = randomBytes(32).toString("hex");
      const server = createRentalWebhookServer(secret);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const url = `http://127.0.0.1:${address.port}/webhooks/rental-payment`;
      const body = JSON.stringify({ providerReference: reference, tenantId: b.tenantId, rentalId: b.rentalId, amount: 1, status: "paid" });
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      try {
        const unauthorized = await fetch(url, { method: "POST", body });
        assert.equal(unauthorized.status, 401);
        for (let n = 0; n < 2; n++) {
          const response = await fetch(url, { method: "POST", body, headers: { "x-rental-timestamp": timestamp, "x-rental-signature": signature } });
          assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: "paid" });
        }
        assert.equal((await BotRental.findById(aId).lean())!.expiresAt.getTime(), initialExpiry.getTime() + 30 * DAY_MS);
        assert.equal((await BotRental.findById(bId).lean())!.expiresAt.getTime(), initialExpiry.getTime());
      } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
    });
    await t.test("crash after rental update before payment paid marker is recovered without extending twice", async () => {
      const crashReference = randomUUID();
      await RentalPayment.create({ rentalId: a.rentalId, tenantId: a.tenantId, ownerTelegramId: "101", planId: String(plan._id),
        amount: 25002, baseAmount: 25000, durationDays: 30, merchantId: "test-platform-merchant", providerReference: crashReference,
        status: "processing", matchedTransactionId: "tx-crash", expiresAt: new Date(Date.now() + 60_000), paidAt: new Date() });
      await applyRenewal(a.rentalId, crashReference, 30, String(plan._id));
      const afterApply = (await BotRental.findById(aId).lean())!.expiresAt.getTime();
      await runWithTenant(platformContext(), pollPendingRentalPayments);
      assert.equal((await RentalPayment.findOne({ providerReference: crashReference }).lean())!.status, "paid");
      assert.equal((await BotRental.findById(aId).lean())!.expiresAt.getTime(), afterApply);
    });
    await t.test("expired, grace and suspended bot middleware blocks business but renewal reopens it without restart", async () => {
      const bot = new Bot("101:offline-test-token", { botInfo: { id: 101, username: "test_101_bot", is_bot: true, first_name: "Test",
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
      const replies: string[] = [];
      let businessCalls = 0;
      bot.api.config.use(async (_previous, method, payload) => {
        if (method === "sendMessage") replies.push((payload as { text: string }).text);
        return { ok: true, result: true } as never;
      });
      bot.use((_ctx, next) => runWithTenant(a, next));
      bot.use(rentalMiddleware);
      bot.use(() => { businessCalls++; });
      const update = (text: string, userId: number, updateId: number) => ({ update_id: updateId, message: {
        message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: userId, type: "private" as const, first_name: "Test" },
        from: { id: userId, first_name: "Test", is_bot: false }, text,
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.length }] } : {}),
      } });
      await BotRental.updateOne({ _id: aId }, { status: "active", expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await synchronizeRentalLifecycle(a.rentalId))!.status, "expired_grace");
      await bot.handleUpdate(update("buy", 999, 1));
      await bot.handleUpdate(update("/status", 101, 2));
      assert.equal(businessCalls, 0); assert.match(replies.join("\n"), /tenggang 24 jam/);
      await BotRental.updateOne({ _id: aId }, { expiresAt: new Date(Date.now() - 25 * 60 * 60_000) });
      assert.equal((await synchronizeRentalLifecycle(a.rentalId))!.status, "suspended");
      await bot.handleUpdate(update("buy", 101, 3));
      await bot.handleUpdate(update("/renew", 101, 4));
      assert.equal(businessCalls, 0); assert.match(replies.at(-1)!, /Pilih paket/);
      await applyRenewal(a.rentalId, randomUUID(), 30, String(plan._id));
      const active = (await refreshRentalState(a.rentalId))!;
      assert.equal(active.status, "active"); assert.equal(active.graceEndsAt, null);
      await bot.handleUpdate(update("buy", 999, 5));
      assert.equal(businessCalls, 1);
    });
    await t.test("digital payment callbacks cannot check or cancel another customer's invoice", async () => {
      const session = await runWithTenant(a, () => TopupSession.create({ telegramId: "101", chatId: 101, messageId: 1, orderId: "private-invoice", amountIDR: 5001 }));
      const bot = new Bot("101:offline-test-token", { botInfo: { id: 101, username: "test_101_bot", is_bot: true, first_name: "Test",
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } });
      const replies: string[] = [];
      bot.api.config.use(async (_previous, method, payload) => { if (method === "sendMessage") replies.push((payload as { text: string }).text); return { ok: true, result: true } as never; });
      bot.use((_ctx, next) => runWithTenant(a, next));
      await digitalPlugin.register(bot);
      const before = providerReads;
      for (const [index, action] of ["dg_chk_", "dg_cncl_"].entries()) {
        await bot.handleUpdate({ update_id: 100 + index, callback_query: { id: String(index), from: { id: 999, is_bot: false, first_name: "Other" }, chat_instance: "test",
          data: `${action}${session._id}`, message: { message_id: 1, date: 1, chat: { id: 999, type: "private", first_name: "Test" } } } });
      }
      assert.equal(providerReads, before);
      assert.equal(replies.filter(reply => reply.includes("bukan milik")).length, 2);
      assert.equal((await runWithTenant(a, () => TopupSession.findById(session._id).lean()))!.status, "PENDING");
    });
  } finally {
    assert.equal(mongoose.connection.db?.databaseName, dbName);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    for (const name of ["GOPAY_MERCHANT_ID", "GOBIZ_EMAIL", "GOBIZ_PASSWORD", "QRIS_STATIC_PAYLOAD", "CREDENTIAL_ENCRYPTION_KEY"]) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
});
