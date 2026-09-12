import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { VpsOrder } from "../models/VpsOrder.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { payVpsFromBalance, refundVpsOrder } from "./payment.js";

const uri = process.env["VPS_TEST_MONGODB_URI"];

test("isolated Mongo: concurrent VPS debit and refund use atomic wallet receipts", { skip: !uri }, async t => {
  if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(\/|$)/.test(uri)) {
    throw new Error("VPS_TEST_MONGODB_URI must target an isolated local MongoDB.");
  }
  const dbName = `vps_payment_test_${randomUUID().replaceAll("-", "")}`;
  await mongoose.connect(uri, { dbName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    if (mongoose.connection.name !== dbName || !dbName.startsWith("vps_payment_test_")) throw new Error("Refusing cleanup outside VPS test database.");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  for (const model of [User, BalanceLog, VpsOrder]) { await model.createCollection(); await model.createIndexes(); }
  await runWithTenant(platformContext(), async () => {
    await User.create({ telegramId: "101", firstName: "Offline test", balance: 100_000 });
    const orderId = randomUUID();
    await VpsOrder.create({ _id: orderId, tenantId: "platform", buyerId: "101", chatId: "101", service: "purchase", createName: `vps-${orderId}`,
      passwordEncrypted: "offline-placeholder-unused-by-payment", snapshot: { planId: "basic", planName: "Basic", size: "s-1vcpu-1gb", region: "sgp1",
        os: "ubuntu-24.04", image: "ubuntu-24-04-x64", price: 25_000, vcpus: 1, memory: 1024, disk: 25 } });
    // Some callers can see the already-paid transition between reads; replay may
    // report that state, but must never reapply the money effect.
    const payments = await Promise.allSettled(Array.from({ length: 12 }, () => payVpsFromBalance(orderId, "101")));
    assert.ok(payments.some(result => result.status === "fulfilled"));
    assert.equal((await User.findOne({ telegramId: "101" }).lean())?.balance, 75_000);
    assert.equal((await VpsOrder.findOne({ _id: orderId }).lean())?.paymentStatus, "paid");
    await VpsOrder.updateOne({ _id: orderId }, { $set: { stage: "failed" } });
    await Promise.all(Array.from({ length: 12 }, () => refundVpsOrder(orderId, "create_rejected")));
    const user = await User.findOne({ telegramId: "101" }).select("+appliedVpsPaymentEffectIds").lean();
    assert.equal(user?.balance, 100_000);
    assert.equal(user?.appliedVpsPaymentEffectIds.length, 2);
    assert.equal(await BalanceLog.countDocuments({ userId: "101" }), 2);
  });
});
