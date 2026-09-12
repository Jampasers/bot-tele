import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { BuyerTokenVault, buyerTokens } from "./security.js";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { VpsPlan } from "../models/VpsPlan.js";
import { DigitalOceanClient } from "./digitalOcean.js";
import { getOs } from "./installer.js";
import { vpsService, requestVpsReboot } from "./service.js";
import { decryptSecret } from "../services/crypto.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { BACKUP_COLLECTIONS, executeRollback } from "../services/backup.js";

const platform = <T>(fn: () => Promise<T> | T) => runWithTenant(platformContext(), fn);
function fixture(overrides: Partial<IVpsOrder> = {}): IVpsOrder {
  const id = randomUUID();
  return new VpsOrder({ _id: id, tenantId: "platform", buyerId: "101", chatId: "101", service: "purchase", createName: `bt-vps-${id}`,
    snapshot: { planId: "plan", planName: "Basic", price: 25000, size: "s-1vcpu-2gb", os: "ubuntu24", image: "ubuntu-24-04-x64", region: "sgp1", vcpus: 1, memory: 2048, disk: 50 },
    passwordEncrypted: "unused-ciphertext", ...overrides }).toObject();
}
function query<T>(read: () => T) {
  const q = { lean: async () => structuredClone(read()), select: (_selection: string) => q };
  return q;
}
function env(t: TestContext): void {
  const before = { enabled: process.env.VPS_ENABLED, key: process.env.CREDENTIAL_ENCRYPTION_KEY };
  process.env.VPS_ENABLED = "true"; process.env.CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  t.after(() => { for (const [name, value] of [["VPS_ENABLED", before.enabled], ["CREDENTIAL_ENCRYPTION_KEY", before.key]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } buyerTokens.clear(); });
}

test("buyer token vault isolates buyer/order, expires absolutely, cannot serialize secrets, and clears at shutdown", async () => {
  let now = 1; const vault = new BuyerTokenVault(100, () => now);
  await platform(() => {
    vault.put("101", "order-one", "private-buyer-token-one", "team:one");
    vault.put("102", "order-two", "private-buyer-token-two", "team:two");
    assert.equal(vault.get("101", "order-two"), undefined);
    assert.equal(vault.get("102", "order-one"), undefined);
    assert.equal(vault.get("101", "order-one")?.accountId, "team:one");
    assert.equal(JSON.stringify(vault).includes("private-buyer-token"), false);
    now = 100; assert.ok(vault.get("101", "order-one"));
    now = 101; assert.equal(vault.get("101", "order-one"), undefined);
    vault.put("101", "order-one", "replacement-temporary-token", "team:one");
    vault.clear(); assert.equal(vault.get("101", "order-one"), undefined);
  });
  await assert.rejects(runWithTenant({ tenantId: "rental-one", rentalId: "rental-one" }, async () => vault.put("101", "order-one", "not-accepted-token", "team:one")), /main bot/);
});

test("token recovery rejects a different team or buyer and resumes the existing order without persisting the token", async t => {
  env(t);
  const order = fixture({ service: "install", stage: "needs_token", resumeStage: "creating", accountId: "team:expected", paymentStatus: "paid", createAttemptedAt: new Date() });
  const writes: unknown[] = [];
  t.mock.method(VpsOrder, "findOne", () => query(() => order));
  t.mock.method(VpsOrder, "updateOne", async (_filter: unknown, patch: { $set: Partial<IVpsOrder> }) => { writes.push(patch); Object.assign(order, patch.$set); return { matchedCount: 1 }; });
  let accountId = "team:wrong";
  t.mock.method(DigitalOceanClient.prototype, "account", async () => ({ identity: accountId, uuid: "user", status: "active", statusMessage: "", dropletLimit: 5 }));
  const token = "offline_buyer_secret_123456789";
  await platform(async () => {
    await assert.rejects(vpsService.acceptBuyerToken("999", order._id, token), /Pesanan/);
    await assert.rejects(vpsService.acceptBuyerToken("101", order._id, token), /sama/);
    assert.equal(buyerTokens.get("101", order._id), undefined);
    accountId = "team:expected";
    await vpsService.acceptBuyerToken("101", order._id, token);
    assert.equal(order.stage, "creating"); assert.equal(order._id.length, 36);
    assert.equal(buyerTokens.get("101", order._id)?.token, token);
    assert.equal(JSON.stringify(writes).includes(token), false);
  });
});

test("checkout stores immutable price/spec snapshot and encrypted per-VPS password, never buyer token", async t => {
  env(t);
  let saved: IVpsOrder | null = null;
  const id = randomUUID();
  const plan = { _id: randomUUID(), name: "Setup", serviceType: "install", enabled: true, sizeSlug: "s-1vcpu-2gb", regions: ["sgp1"], osPrices: [{ os: "ubuntu24", label: "Ubuntu", price: 25000 }] };
  t.mock.method(VpsOrder, "findOne", (filter: { _id: string; buyerId?: string }) => query(() => saved && saved._id === filter._id && (!filter.buyerId || saved.buyerId === filter.buyerId) ? saved : null));
  t.mock.method(VpsPlan, "findOne", () => query(() => plan));
  t.mock.method(VpsOrder, "create", async (input: Record<string, unknown>) => { saved = new VpsOrder(input).toObject(); return { toObject: () => saved }; });
  let validations = 0;
  t.mock.method(DigitalOceanClient.prototype, "account", async () => ({ identity: "team:buyer", uuid: "buyer", status: "active", statusMessage: "", dropletLimit: 2 }));
  t.mock.method(DigitalOceanClient.prototype, "validateSelection", async () => { validations++; return { os: getOs("ubuntu24")!, size: { slug: "s-1vcpu-2gb", available: true, memory: 2048, vcpus: 1, disk: 50, regions: ["sgp1"], priceMonthly: 0 }, region: { slug: "sgp1", name: "Singapore", available: true, sizes: [] }, image: { id: 1, slug: "ubuntu-24-04-x64", name: "Ubuntu", regions: ["sgp1"], minDiskSize: 1 } }; });
  await platform(async () => {
    buyerTokens.put("101", id, "offline_buyer_token_123456789", "team:buyer");
    const input = { actorTelegramId: "101", chatId: "101", requestId: id, serviceType: "install" as const, planId: plan._id, os: "ubuntu24", region: "sgp1", buyerSessionId: id };
    const first = await vpsService.checkout(input);
    assert.equal(first.price, 25000); assert.equal(first.memory, 2048);
    plan.osPrices[0]!.price = 99999;
    const again = await vpsService.checkout(input);
    assert.equal(again.price, 25000); assert.equal(validations, 1);
    assert.ok(saved);
    assert.equal(JSON.stringify(saved).includes("offline_buyer_token"), false);
    const password = decryptSecret(saved!.passwordEncrypted, `platform:vps:password:${id}`);
    assert.ok(password.length >= 16); assert.equal(JSON.stringify(first).includes(password), false);
    assert.throws(() => decryptSecret(saved!.passwordEncrypted, "platform:vps:password:another-order"));
  });
});

test("reboot derives ownership from server scope and queues only one action", async t => {
  env(t);
  const order = fixture({ stage: "ready", paymentStatus: "paid", dropletId: 123, accountId: "team:shop", credentialId: randomUUID() });
  let mutations = 0;
  t.mock.method(VpsOrder, "findOne", (filter: { _id: string; tenantId: string; buyerId: string }) => query(() => filter._id === order._id && filter.tenantId === "platform" && filter.buyerId === order.buyerId ? order : null));
  let lock: Promise<void> = Promise.resolve();
  t.mock.method(VpsOrder, "findOneAndUpdate", (filter: { buyerId: string; tenantId: string; rebootState: { $in: string[] } }, patch: { $set: Partial<IVpsOrder> }) => {
    // Simulate MongoDB atomicity: serialize concurrent findOneAndUpdate calls
    // so the second concurrent call sees the already-mutated rebootState.
    const ticket = lock.then(() => {
      assert.equal(filter.tenantId, "platform"); assert.equal(filter.buyerId, "101");
      if (!filter.rebootState.$in.includes(order.rebootState)) return null;
      mutations++; Object.assign(order, patch.$set); return structuredClone(order);
    });
    lock = ticket.then(() => {}, () => {});
    return ticket;
  });
  await platform(async () => {
    await assert.rejects(requestVpsReboot("999", order._id), /tidak dapat/);
    assert.equal(mutations, 0);
    await Promise.all([requestVpsReboot("101", order._id), requestVpsReboot("101", order._id)]);
    assert.equal(mutations, 1); assert.equal(order.rebootState, "requested");
    order.service = "install"; await assert.rejects(requestVpsReboot("101", order._id), /tidak dapat/);
  });
  await assert.rejects(runWithTenant({ tenantId: "rental-one", rentalId: "rental-one" }, () => requestVpsReboot("101", order._id)), /main bot/);
});

test("VPS schemas expose no buyer token persistence field; backup exports encrypted fields and blocks online provider rollback", async () => {
  const order = fixture();
  assert.throws(() => new VpsOrder({ ...order, buyerToken: "never-persist-this" }), /strict/);
  assert.equal(VpsOrder.schema.path("passwordEncrypted").options.select, false);
  assert.equal(VpsOrder.schema.path("snapshot").options.immutable, true);
  assert.equal(BACKUP_COLLECTIONS.find(c => c.name === "vpsorders")?.select, "+passwordEncrypted");
  assert.ok(BACKUP_COLLECTIONS.find(c => c.name === "users")?.select?.includes("appliedVpsPaymentEffectIds"));
  await platform(() => assert.rejects(executeRollback([{ name: "vpsorders", count: 1, docs: [order] }]), /offline/));
});
