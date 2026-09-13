import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { VpsAccount, VpsCredential } from "../models/VpsCredential.js";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { encryptSecret } from "../services/crypto.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { DigitalOceanClient, DigitalOceanError, type DoDroplet } from "./digitalOcean.js";
import { checkCredential, providerForCredential, reserveStoreCapacity } from "./credentials.js";

type Row = Record<string, any>;
function value(row: any, names: string[]): any {
  if (!names.length) return row;
  if (Array.isArray(row)) return row.flatMap(item => value(item, names));
  return value(row?.[names[0]!], names.slice(1));
}
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    if (path === "$or") return expected.some((item: Row) => matches(row, item));
    const actual = value(row, path.split("."));
    if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, target]: [string, any]) => {
        if (operator === "$ne") return Array.isArray(actual) ? !actual.includes(target) : actual !== target;
        if (operator === "$gt") return actual > target;
        if (operator === "$lt") return actual < target;
        if (operator === "$in") return target.includes(actual);
        throw new Error(`Unknown mock operator ${operator}`);
      });
    }
    return Array.isArray(actual) ? actual.includes(expected) : actual === expected || (expected === null && actual === undefined);
  });
}
function query<T>(read: () => T) {
  return { lean: () => query(read), select: () => query(read), sort: () => query(read),
    catch: <R>(reject: (error: unknown) => R) => Promise.resolve().then(read).catch(reject),
    then: <R>(resolve: (value: T) => R, reject?: (error: unknown) => R) => Promise.resolve().then(read).then(resolve, reject) };
}
function mockDatabase(t: TestContext) {
  const orders: Row[] = [], credentials: Row[] = [], accounts: Row[] = [];
  let failAttach = false;
  const mutate = (row: Row, change: Row, insert: boolean) => {
    if (insert) Object.assign(row, change.$setOnInsert);
    Object.assign(row, change.$set);
    if (change.$push?.reservations) {
      const ticket = change.$push.reservations;
      if (accounts.some(other => other !== row && other.reservations.some((r: Row) => r.orderId === ticket.orderId))) throw Object.assign(new Error("duplicate ticket"), { code: 11000 });
      row.reservations.push(structuredClone(ticket));
    }
  };
  for (const [model, rows] of [[VpsAccount, accounts], [VpsCredential, credentials], [VpsOrder, orders]] as const) {
    t.mock.method(model, "findOne", (filter: Row) => query(() => structuredClone(rows.find(row => matches(row, filter)) ?? null)));
    t.mock.method(model, "find", (filter: Row) => query(() => structuredClone(rows.filter(row => matches(row, filter)))));
    t.mock.method(model, "findOneAndUpdate", (filter: Row, change: Row) => query(() => {
      const row = rows.find(row => matches(row, filter));
      if (!row) return null;
      if (model === VpsOrder && failAttach) { failAttach = false; throw new Error("simulated interrupted order attachment"); }
      mutate(row, change, false); return structuredClone(row);
    }));
    t.mock.method(model, "updateOne", (filter: Row, change: Row, options?: Row) => query(() => {
      let row = rows.find(row => matches(row, filter));
      if (!row && options?.upsert) { row = { _id: filter._id, reservations: [] }; rows.push(row); mutate(row, change, true); return { matchedCount: 0, upsertedCount: 1 }; }
      if (!row) return { matchedCount: 0 };
      mutate(row, change, false); return { matchedCount: 1 };
    }));
  }
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"], previousAdmins = process.env["ADMIN_ID"];
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = "11".repeat(32); process.env["ADMIN_ID"] = "101";
  t.after(() => { if (previousKey === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"]; else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previousKey;
    if (previousAdmins === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = previousAdmins; });
  const addCredential = (accountId = "team:shared", enabled = true) => {
    const id = randomUUID(); const token = `offline-${id}`;
    const row = { _id: id, tenantId: "platform", enabled, priority: credentials.length, accountId, label: "Test credential",
      tokenEncrypted: encryptSecret(token, `platform:vps:credential:${id}`), health: "unknown", dropletLimit: null, used: null, reservations: null,
      accountStatus: "unknown", statusMessage: "", checkedAt: null, lastCreateAt: null, lastCreateResult: null };
    credentials.push(row); return row;
  };
  const addOrder = (worker = "worker") => {
    const id = randomUUID();
    const row = { _id: id, tenantId: "platform", createName: `vps-${id}`, paymentStatus: "paid", stage: "queued", createAttemptedAt: null,
      accountId: null, credentialId: null, dropletId: null, reservationActive: false, lockOwner: worker, lockUntil: new Date(Date.now() + 120_000) };
    orders.push(row); return row;
  };
  return { orders, credentials, accounts, addCredential, addOrder, failAttach: () => { failAttach = true; } };
}
const platform = <T>(fn: () => Promise<T>) => runWithTenant(platformContext(), fn);
const reserve = (order: Row, worker = "worker") => platform(() => reserveStoreCapacity(order as IVpsOrder, worker));
function mockProvider(t: TestContext, limit: number, droplets: DoDroplet[] = []) {
  t.mock.method(DigitalOceanClient.prototype, "account", async () => ({ identity: "team:shared", uuid: "member", teamUuid: "shared", status: "active", statusMessage: "", dropletLimit: limit }));
  t.mock.method(DigitalOceanClient.prototype, "listDroplets", async () => droplets);
}

test("same-team tokens share the last slot and duplicate order allocation reuses its ticket", async t => {
  const db = mockDatabase(t); db.addCredential(); db.addCredential(); mockProvider(t, 1);
  const first = db.addOrder("worker-a"), second = db.addOrder("worker-b");
  const results = await Promise.all([reserve(first, "worker-a"), reserve(second, "worker-b")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(db.accounts.length, 1);
  assert.equal(db.accounts[0]!.reservations.length, 1);
  const winner = results[0] ? first : second;
  const replay = await reserve(winner, winner.lockOwner);
  assert.equal(replay?.accountId, "team:shared");
  assert.equal(db.accounts[0]!.reservations.length, 1);
});

test("orphan ticket recovers on its original account and an expired order lease cannot attach it", async t => {
  const db = mockDatabase(t); const credential = db.addCredential(); db.addCredential("team:other"); mockProvider(t, 2);
  const order = db.addOrder();
  db.accounts.push({ _id: "team:shared", lockOwner: null, lockUntil: null, reservations: [{ orderId: order._id, createName: order.createName, credentialId: credential._id }] });
  order.lockUntil = new Date(Date.now() - 1);
  assert.equal(await reserve(order), null);
  assert.equal(order.accountId, null);
  order.lockUntil = new Date(Date.now() + 60_000);
  assert.deepEqual(await reserve(order), { accountId: "team:shared", credentialId: credential._id });
  assert.equal(db.accounts.length, 1);
});

test("a ticket followed by an attachment failure never falls through to another account", async t => {
  const db = mockDatabase(t); db.addCredential(); db.addCredential("team:other"); mockProvider(t, 2);
  const order = db.addOrder(); db.failAttach();
  assert.equal(await reserve(order), null);
  assert.equal(db.accounts.length, 1, "uncertain ticket writes must recover before trying any other account");
  assert.equal(db.accounts[0]!.reservations.length, 1);
  assert.ok(await reserve(order));
  assert.equal(db.accounts[0]!.reservations.length, 1);
});

test("observed droplets count once by ID even after a rename; admin counts orphan tickets too", async t => {
  const db = mockDatabase(t); const credential = db.addCredential();
  const existing = db.addOrder(); Object.assign(existing, { accountId: "team:shared", reservationActive: true, dropletId: 17 });
  db.accounts.push({ _id: "team:shared", lockOwner: null, lockUntil: null, reservations: [{ orderId: existing._id, createName: existing.createName, credentialId: credential._id }] });
  mockProvider(t, 2, [{ id: 17, name: "buyer-renamed", status: "active", locked: false, tags: [] }]);
  const order = db.addOrder(); assert.ok(await reserve(order));
  const orphanId = randomUUID();
  db.accounts[0]!.reservations.push({ orderId: orphanId, createName: `vps-${orphanId}`, credentialId: credential._id });
  const status = await platform(() => checkCredential("101", credential._id));
  assert.equal(status.used, 1);
  assert.equal(status.reserved, 2);
  assert.equal(status.available, 0);
});

test("a stale account lease cannot write a capacity ticket from an old provider snapshot", async t => {
  const db = mockDatabase(t); db.addCredential(); mockProvider(t, 1);
  t.mock.method(DigitalOceanClient.prototype, "listDroplets", async () => {
    db.accounts[0]!.lockOwner = "new-worker";
    db.accounts[0]!.lockUntil = new Date(Date.now() + 60_000);
    return [];
  });
  const order = db.addOrder();
  assert.equal(await reserve(order), null);
  assert.equal(db.accounts[0]!.reservations.length, 0);
  assert.equal(order.accountId, null);
  assert.equal(db.accounts[0]!.lockOwner, "new-worker");
});

test("permission failures retain unknown counts without claiming locked; disabled credentials still resolve an existing order", async t => {
  const db = mockDatabase(t); const credential = db.addCredential("team:shared", false); mockProvider(t, 3);
  t.mock.method(DigitalOceanClient.prototype, "listDroplets", async () => { throw new DigitalOceanError("permission"); });
  const status = await platform(() => checkCredential("101", credential._id));
  assert.equal(status.tokenStatus, "permission");
  assert.equal(status.accountStatus, "active");
  assert.equal(status.used, null); assert.equal(status.reserved, null); assert.equal(status.available, null);
  assert.ok(await platform(() => providerForCredential(credential._id, "team:shared")));
  assert.equal(await reserve(db.addOrder()), null);
});
