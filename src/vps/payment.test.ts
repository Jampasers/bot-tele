import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { User } from "../models/User.js";
import { VpsOrder } from "../models/VpsOrder.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { PaymentAmountReservation, PaymentSettlementClaim } from "../models/PaymentLedger.js";
import { GopayMerchant } from "../services/payment/gopay-merchant.js";
import { GobizAuthService } from "../services/payment/gobiz-auth.js";
import { QrisGenerator } from "../services/payment/qris.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { checkVpsPayment, createVpsInvoice, payVpsFromBalance, refundVpsOrder, reconcileVpsPayments } from "./payment.js";

type Row = Record<string, any>;
const read = (row: Row, path: string): any => path.split(".").reduce((value, name) => value?.[name], row);
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((part: Row) => matches(row, part));
    if (key === "$and") return expected.every((part: Row) => matches(row, part));
    const actual = read(row, key);
    if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]: [string, any]) => {
        if (operator === "$ne") return Array.isArray(actual) ? !actual.includes(value) : actual !== value;
        if (operator === "$in") return value.includes(actual);
        if (operator === "$gte") return actual >= value;
        if (operator === "$lte") return actual <= value;
        if (operator === "$exists") return (actual !== undefined) === value;
        throw new Error(`Unexpected mock operator: ${operator}`);
      });
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return expected instanceof Date ? actual?.getTime() === expected.getTime() : actual === expected || (expected === null && actual === undefined);
  });
}
function update(row: Row, change: Row): void {
  for (const [operator, values] of Object.entries(change)) {
    for (const [path, value] of Object.entries(values as Row)) {
      const names = path.split(".");
      let parent = row;
      for (const name of names.slice(0, -1)) parent = parent[name] ??= {};
      const name = names.at(-1)!;
      if (operator === "$set") parent[name] = value;
      else if (operator === "$inc") parent[name] = (parent[name] ?? 0) + Number(value);
      else if (operator === "$addToSet") { parent[name] ??= []; if (!parent[name].includes(value)) parent[name].push(value); }
      else if (operator === "$unset") delete parent[name];
      else if (operator !== "$setOnInsert") throw new Error(`Unexpected mock update: ${operator}`);
    }
  }
}
function query<T>(load: () => T) {
  return {
    lean: () => query(load), select: () => query(load), sort: () => query(load), limit: () => query(load),
    then: <R>(resolve: (value: T) => R, reject?: (error: unknown) => R) => Promise.resolve().then(load).then(resolve, reject),
    cursor: async function* () { for (const row of load() as Row[]) yield row; },
  };
}
function database(t: TestContext, balance = 100_000) {
  const orders: Row[] = [];
  const users: Row[] = [{ tenantId: "platform", telegramId: "101", balance, totalOrders: 0, appliedVpsPaymentEffectIds: [] }];
  const claims: Row[] = [];
  const audit: Row[] = [];
  let failPaidOnce = false;
  let failRefundedOnce = false;
  for (const [model, rows] of [[VpsOrder, orders], [User, users], [PaymentSettlementClaim, claims]] as const) {
    t.mock.method(model, "findOne", (filter: Row) => query(() => structuredClone(rows.find(row => matches(row, filter)) ?? null)));
    t.mock.method(model, "find", (filter: Row) => query(() => structuredClone(rows.filter(row => matches(row, filter)))));
    t.mock.method(model, "findOneAndUpdate", (filter: Row, change: Row) => query(() => {
      const row = rows.find(row => matches(row, filter));
      if (!row) return null;
      if (model === VpsOrder && change.$set?.paymentStatus === "paid" && failPaidOnce) { failPaidOnce = false; throw new Error("simulated process interruption after debit"); }
      if (model === VpsOrder && change.$set?.paymentStatus === "refunded" && failRefundedOnce) { failRefundedOnce = false; throw new Error("simulated process interruption after refund"); }
      update(row, change);
      return structuredClone(row);
    }));
    t.mock.method(model, "updateOne", (filter: Row, change: Row) => query(() => {
      const row = rows.find(row => matches(row, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      if (model === VpsOrder && change.$set?.paymentStatus === "paid" && failPaidOnce) { failPaidOnce = false; throw new Error("simulated process interruption after debit"); }
      if (model === VpsOrder && change.$set?.paymentStatus === "refunded" && failRefundedOnce) { failRefundedOnce = false; throw new Error("simulated process interruption after refund"); }
      update(row, change);
      return { matchedCount: 1, modifiedCount: 1 };
    }));
  }
  t.mock.method(PaymentSettlementClaim, "create", async (value: Row) => {
    if (claims.some(row => row._id === value._id)) throw Object.assign(new Error("duplicate"), { code: 11000 });
    claims.push(structuredClone(value)); return value;
  });
  t.mock.method(PaymentSettlementClaim, "findById", (id: string) => query(() => structuredClone(claims.find(row => row._id === id) ?? null)));
  t.mock.method(PaymentAmountReservation, "findOneAndUpdate", async () => ({}));
  t.mock.method(BalanceLog, "create", async (value: Row) => { audit.push(value); return value; });
  const addOrder = (overrides: Row = {}) => {
    const order = { _id: randomUUID(), tenantId: "platform", buyerId: "101", stage: "queued", paymentStatus: "unpaid", paymentMethod: null,
      dropletId: null, createAttemptedAt: null, paymentInvoiceLeaseUntil: null,
      snapshot: { price: 25_000, planName: "Basic" }, ...overrides };
    orders.push(order); return order as Row;
  };
  return { orders, users, claims, audit, addOrder, failPaid: () => { failPaidOnce = true; }, failRefunded: () => { failRefundedOnce = true; } };
}
const platform = <T>(fn: () => Promise<T>) => runWithTenant(platformContext(), fn);

test("concurrent balance callbacks debit once and an interrupted order update recovers without another debit", async t => {
  const db = database(t); const order = db.addOrder(); db.failPaid();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => platform(() => payVpsFromBalance(order._id, "101"))));
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(db.users[0]!.balance, 75_000);
  assert.equal(db.users[0]!.totalOrders, 1);
  assert.equal(order.paymentStatus, "paid");
  await platform(reconcileVpsPayments);
  await platform(() => payVpsFromBalance(order._id, "101"));
  assert.equal(db.users[0]!.balance, 75_000);
});

test("startup reconciliation finishes the durable balance intent after a crash and audit failure never reverses payment", async t => {
  const db = database(t); const order = db.addOrder(); db.failPaid();
  t.mock.method(BalanceLog, "create", async () => { throw new Error("offline audit database"); });
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => { warnings.push(values); });
  await assert.rejects(platform(() => payVpsFromBalance(order._id, "101")), /interruption/);
  assert.equal(order.paymentStatus, "paying");
  assert.equal(db.users[0]!.balance, 75_000);
  await platform(reconcileVpsPayments);
  assert.equal(order.paymentStatus, "paid");
  assert.equal(db.users[0]!.balance, 75_000);
  assert.equal(db.users[0]!.appliedVpsPaymentEffectIds.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes("offline audit database"), false);
});

test("every duplicate balance callback returns paid when another caller already finished its order transition", async t => {
  const db = database(t); const order = db.addOrder();
  const results = await Promise.all(Array.from({ length: 24 }, () => platform(() => payVpsFromBalance(order._id, "101"))));
  assert.ok(results.every(result => result.status === "paid"));
  assert.equal(db.users[0]!.balance, 75_000);
});

test("refund interruption and retries credit once; unsafe provisioning states cannot refund", async t => {
  const db = database(t); const order = db.addOrder();
  await platform(() => payVpsFromBalance(order._id, "101"));
  await assert.rejects(platform(() => refundVpsOrder(order._id, "cancelled_before_create")), /refund/i);
  order.stage = "failed"; order.createAttemptedAt = new Date();
  await assert.rejects(platform(() => refundVpsOrder(order._id, "create_rejected")), /refund/i);
  order.createAttemptedAt = null; order.dropletId = 100;
  await assert.rejects(platform(() => refundVpsOrder(order._id, "create_rejected")), /refund/i);
  order.dropletId = null; db.failRefunded();
  await assert.rejects(platform(() => refundVpsOrder(order._id, "create_rejected")), /interruption/);
  assert.equal(order.paymentStatus, "refunding");
  assert.equal(db.users[0]!.balance, 100_000);
  await Promise.all(Array.from({ length: 8 }, () => platform(() => refundVpsOrder(order._id, "create_rejected"))));
  assert.equal(db.users[0]!.balance, 100_000);
  assert.equal(order.paymentStatus, "refunded");
});

test("payment entry points enforce platform and buyer ownership before touching a wallet", async t => {
  const db = database(t); const order = db.addOrder();
  await assert.rejects(platform(() => payVpsFromBalance(order._id, "202")), /access|akses/i);
  await assert.rejects(runWithTenant({ tenantId: "rental-a", rentalId: "rental-a" }, () => payVpsFromBalance(order._id, "101")), /platform/i);
  await assert.rejects(platform(() => createVpsInvoice(order._id, "202")), /access|akses/i);
  await assert.rejects(platform(() => checkVpsPayment(order._id, "202")), /access|akses/i);
  assert.equal(db.users[0]!.balance, 100_000);
  assert.equal(order.paymentStatus, "unpaid");
});

test("insufficient balance keeps QRIS available; repeated invoice creation reuses a durable invoice containing no buyer credential", async t => {
  const db = database(t, 0); const order = db.addOrder();
  const before = await platform(() => payVpsFromBalance(order._id, "101"));
  assert.equal(before.status, "insufficient");
  assert.equal(order.paymentMethod, null);
  const saved = { ...process.env };
  Object.assign(process.env, { GOPAY_MERCHANT_ID: "vps-test-merchant", GOBIZ_EMAIL: "offline@example.invalid", GOBIZ_PASSWORD: "offline-only", QRIS_STATIC_PAYLOAD: "offline" });
  t.after(() => { for (const key of ["GOPAY_MERCHANT_ID", "GOBIZ_EMAIL", "GOBIZ_PASSWORD", "QRIS_STATIC_PAYLOAD"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  t.mock.method(QrisGenerator.prototype, "generate", async () => "data:image/png;base64,AA==");
  t.mock.method(QrisGenerator.prototype, "getDynamicPayload", async () => "mock-qris-payload");
  const first = await platform(() => createVpsInvoice(order._id, "101"));
  const second = await platform(() => createVpsInvoice(order._id, "101"));
  assert.equal(first.invoice.reference, second.invoice.reference);
  assert.equal(first.invoice.amount, 25_001);
  assert.deepEqual(Object.keys(order.paymentInvoice).sort(), ["amount", "createdAt", "expiresAt", "merchantId", "reference"]);
  await assert.rejects(platform(() => payVpsFromBalance(order._id, "101")), /QRIS|metode/);
  let reads = 0;
  t.mock.method(GopayMerchant.prototype, "getQrisSettlements", async () => {
    reads++;
    return [{ amount: first.invoice.amount, merchantId: first.invoice.merchantId, paidAt: new Date(first.invoice.createdAt).getTime() + 1,
      paymentType: "QRIS", status: "SETTLEMENT", transactionId: "vps-test-settlement" }];
  });
  db.failPaid();
  await assert.rejects(platform(() => checkVpsPayment(order._id, "101")), /interruption/);
  assert.equal(db.claims.length, 1);
  assert.equal(order.paymentStatus, "paying");
  await platform(() => checkVpsPayment(order._id, "101"));
  assert.equal(reads, 1, "durable claim recovers without querying the provider again");
  assert.equal(order.paymentStatus, "paid");
  assert.equal(db.users[0]!.balance, 0);
  order.stage = "failed";
  await Promise.all([platform(() => refundVpsOrder(order._id, "create_rejected")), platform(() => refundVpsOrder(order._id, "create_rejected"))]);
  assert.equal(db.users[0]!.balance, 25_001);
  const racedOrder = db.addOrder();
  const raced = await Promise.allSettled([
    platform(() => createVpsInvoice(racedOrder._id, "101")),
    platform(() => payVpsFromBalance(racedOrder._id, "101")),
  ]);
  assert.ok(raced.some(result => result.status === "fulfilled"));
  if (racedOrder.paymentMethod === "qris") {
    assert.equal(db.users[0]!.balance, 25_001);
    assert.ok(racedOrder.paymentInvoice);
  } else {
    assert.equal(db.users[0]!.balance, 1);
    assert.equal(racedOrder.paymentInvoice, undefined);
  }
  db.orders.splice(0, db.orders.length);
  const interruptedInvoice = db.addOrder({ paymentStatus: "paying", paymentMethod: "qris" });
  await platform(reconcileVpsPayments);
  assert.ok(interruptedInvoice.paymentInvoice, "startup resumes invoice creation from its durable method intent");
  assert.equal(interruptedInvoice.paymentStatus, "paying");
});

test("payment reconciliation bounds concurrency and shutdown aborts active provider reads without starting more", { timeout: 3000 }, async t => {
  const db = database(t); const now = new Date();
  for (let i = 0; i < 6; i++) {
    const order = db.addOrder({ paymentStatus: "paying", paymentMethod: "qris" });
    order.paymentInvoice = { reference: `vps-${order._id}`, merchantId: "vps-test-merchant", amount: 25_001,
      createdAt: now, expiresAt: new Date(now.getTime() + 60_000) };
  }
  let started = 0;
  let signalStarted!: () => void;
  const bothStarted = new Promise<void>(resolve => { signalStarted = resolve; });
  t.mock.method(GopayMerchant.prototype, "getQrisSettlements", async (_query: unknown, signal?: AbortSignal) => {
    started++;
    if (started === 2) signalStarted();
    return new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = platform(() => reconcileVpsPayments({ signal: controller.signal, concurrency: 2 }));
  await bothStarted;
  controller.abort();
  await pending;
  assert.equal(started, 2);
  assert.ok(db.orders.every(order => order.paymentStatus === "paying"));
});

test("GoBiz authentication and merchant reads pass shutdown cancellation to their HTTP requests", { timeout: 3000 }, async () => {
  for (const provider of ["auth", "merchant"]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl: typeof fetch = async (_input, options) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    const controller = new AbortController();
    const pending = provider === "auth"
      ? new GobizAuthService({ email: "offline@example.invalid", password: "offline-only", fetchImpl }).getAccessToken(controller.signal)
      : new GopayMerchant({ merchantId: "offline", accessToken: "offline-only", fetchImpl })
        .getQrisSettlements({ startTime: new Date(), endTime: new Date() }, controller.signal);
    await ready;
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  }
});
