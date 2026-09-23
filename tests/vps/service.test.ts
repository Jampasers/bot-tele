import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { BuyerTokenVault, buyerTokens } from "../../src/vps/security.js";
import { VpsOrder, type IVpsOrder } from "../../src/models/VpsOrder.js";
import { VpsAccount, VpsCredential } from "../../src/models/VpsCredential.js";
import { VpsPlan } from "../../src/models/VpsPlan.js";
import { VpsCatalog } from "../../src/models/VpsCatalog.js";
import { defaultVpsCatalog } from "../../src/vps/catalog.js";
import { catalogPlans } from "../../src/vps/catalogPlans.js";
import { DigitalOceanClient } from "../../src/vps/digitalOcean.js";
import { getOs } from "../../src/vps/installer.js";
import { vpsService, requestVpsReboot } from "../../src/vps/service.js";
import { decryptSecret } from "../../src/services/crypto.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";
import { BACKUP_COLLECTIONS, executeRollback } from "../../src/services/backup.js";

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
  t.mock.method(VpsCatalog, "findById", () => query(() => defaultVpsCatalog()));
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
  const plan = { _id: randomUUID(), name: "Setup", serviceType: "install", enabled: true, sizeSlug: "s-1vcpu-2gb", regions: ["sgp1"], osPrices: [{ os: "windows2022", label: "Windows", price: 25000 }] };
  t.mock.method(VpsOrder, "findOne", (filter: { _id: string; buyerId?: string }) => query(() => saved && saved._id === filter._id && (!filter.buyerId || saved.buyerId === filter.buyerId) ? saved : null));
  t.mock.method(VpsPlan, "findOne", () => query(() => plan));
  t.mock.method(VpsOrder, "create", async (input: Record<string, unknown>) => { saved = new VpsOrder(input).toObject(); return { toObject: () => saved }; });
  let validations = 0;
  t.mock.method(DigitalOceanClient.prototype, "account", async () => ({ identity: "team:buyer", uuid: "buyer", status: "active", statusMessage: "", dropletLimit: 2 }));
  t.mock.method(DigitalOceanClient.prototype, "validateSelection", async () => { validations++; return { os: getOs("windows2022")!, size: { slug: "s-1vcpu-2gb", available: true, memory: 2048, vcpus: 1, disk: 50, regions: ["sgp1"], priceMonthly: 0 }, region: { slug: "sgp1", name: "Singapore", available: true, sizes: [] }, image: { id: 1, slug: "ubuntu-24-04-x64", name: "Ubuntu", regions: ["sgp1"], minDiskSize: 1 } }; });
  await platform(async () => {
    buyerTokens.put("101", id, "offline_buyer_token_123456789", "team:buyer");
    const input = { actorTelegramId: "101", chatId: "101", requestId: id, serviceType: "install" as const, planId: plan._id, os: "windows2022", region: "sgp1", installChrome: true, buyerSessionId: id };
    const first = await vpsService.checkout(input);
    assert.equal(first.price, 25000); assert.equal(first.memory, 2048); assert.equal(first.installChrome, true);
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

test("direct Windows checkout stores buyer VPS access encrypted and never calls DigitalOcean", async t => {
  env(t);
  let saved: IVpsOrder | null = null;
  const id = randomUUID();
  const plan = { _id: randomUUID(), name: "Install Windows", serviceType: "install", enabled: true, sizeSlug: "external-vps", regions: ["external"], osPrices: [{ os: "windows2022", label: "Windows", price: 15000 }] };
  t.mock.method(VpsOrder, "findOne", () => query(() => saved));
  t.mock.method(VpsPlan, "findOne", () => query(() => plan));
  t.mock.method(VpsOrder, "create", async (input: Record<string, unknown>) => { saved = new VpsOrder(input).toObject(); return { toObject: () => saved }; });
  let providerCalls = 0;
  t.mock.method(DigitalOceanClient.prototype, "account", async () => { providerCalls++; throw new Error("DO must not be called"); });
  t.mock.method(DigitalOceanClient.prototype, "validateSelection", async () => { providerCalls++; throw new Error("DO must not be called"); });

  await platform(async () => {
    const result = await vpsService.checkout({ actorTelegramId: "101", chatId: "101", requestId: id, serviceType: "install", planId: plan._id,
      os: "windows2022", region: "external", direct: { ip: "192.0.2.10", username: "ubuntu", password: "synthetic-source-password" } });
    assert.equal(providerCalls, 0);
    assert.equal(result.sourceMode, "direct");
    assert.equal(result.ip, "192.0.2.10");
    assert.equal(saved?.sourceUsername, "ubuntu");
    assert.equal(decryptSecret(saved!.sourcePasswordEncrypted!, `platform:vps:source-password:${id}`), "synthetic-source-password");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-source-password/);
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
  assert.equal(BACKUP_COLLECTIONS.find(c => c.name === "vpsorders")?.select, "+passwordEncrypted +sourcePasswordEncrypted");
  assert.deepEqual(BACKUP_COLLECTIONS.find(c => c.name === "vpscatalogs")?.filter, { _id: "platform" });
  assert.ok(BACKUP_COLLECTIONS.find(c => c.name === "users")?.select?.includes("appliedVpsPaymentEffectIds"));
  await platform(() => assert.rejects(executeRollback([{ name: "vpsorders", count: 1, docs: [order] }]), /offline/));
});

test("service menu derives all specs from catalog and discards arbitrary old named plans", async t => {
  env(t);
  t.mock.method(VpsPlan, "find", (filter: Record<string, unknown>) => {
    assert.equal(filter.catalogManaged, true);
    return query(() => [{ _id: "old-id", name: "Old custom package", enabled: true, priceMatrix: [] }]);
  });
  const plans = await platform(() => vpsService.listPlans("install"));
  assert.equal(plans.length, 7);
  assert.ok(plans.every(plan => plan.regions.length === 16 && plan.osPrices.length === 18));
  assert.ok(plans.every(plan => plan.name !== "Old custom package"));
});

test("catalog checkout without an exact configured price cannot create order or contact DigitalOcean", async t => {
  env(t);
  const plan = catalogPlans(defaultVpsCatalog(), "install")[0]!;
  t.mock.method(VpsOrder, "findOne", () => query(() => null));
  t.mock.method(VpsPlan, "findOne", () => query(() => ({ ...plan, _id: plan.id })));
  let writes = 0, provider = 0;
  t.mock.method(VpsOrder, "create", async () => { writes++; throw new Error("Unexpected order write"); });
  t.mock.method(DigitalOceanClient.prototype, "account", async () => { provider++; throw new Error("Unexpected provider call"); });
  await platform(() => assert.rejects(vpsService.checkout({ actorTelegramId: "101", chatId: "101", requestId: randomUUID(),
    serviceType: "install", planId: plan.id, os: "windows2022", region: "sgp1" }), /harga/));
  assert.equal(writes, 0); assert.equal(provider, 0);
});

test("admin combination price validates catalog membership before any write and targets an atomic matrix update", async t => {
  env(t);
  const old = process.env.ADMIN_ID; process.env.ADMIN_ID = "101";
  t.after(() => { if (old === undefined) delete process.env.ADMIN_ID; else process.env.ADMIN_ID = old; });
  const plan = catalogPlans(defaultVpsCatalog(), "install")[0]!;
  const writes: { filter: unknown; update: unknown; options: unknown }[] = [];
  t.mock.method(VpsPlan, "updateOne", async (filter, update, options) => { writes.push({ filter, update, options }); return { matchedCount: 1, modifiedCount: 1 }; });
  await platform(async () => {
    await assert.rejects(vpsService.updatePlan("999", plan.id, { region: "sgp1", os: "windows2022", price: 12345 }), /admin/);
    await assert.rejects(vpsService.updatePlan("101", plan.id, { region: "invalid", os: "windows2022", price: 12345 }), /katalog/);
    await assert.rejects(vpsService.updatePlan("101", plan.id, { region: "sgp1", os: "windows2022", price: 0 }), /Harga/);
    assert.equal(writes.length, 0);
    await vpsService.updatePlan("101", plan.id, { region: "sgp1", os: "windows2022", price: 12345 });
  });
  assert.equal(writes.length, 2);
  assert.ok(Array.isArray(writes[1]!.update));
  assert.deepEqual(writes[1]!.filter, { _id: plan.id, tenantId: "platform" });
  assert.deepEqual(writes[1]!.options, { updatePipeline: true });
});

test("admin token deletion requires disabled state and refuses active order references", async t => {
  env(t);
  const old = process.env.ADMIN_ID; process.env.ADMIN_ID = "101";
  t.after(() => { if (old === undefined) delete process.env.ADMIN_ID; else process.env.ADMIN_ID = old; });
  const credential = { _id: randomUUID(), accountId: "team:store", enabled: true };
  let activeOrder = false, reservation = false, deletes = 0, accountWrites = 0;
  t.mock.method(VpsCredential, "findOne", () => query(() => credential));
  t.mock.method(VpsCredential, "deleteOne", async (filter: { _id: string; tenantId: string; enabled: boolean }) => {
    assert.deepEqual(filter, { _id: credential._id, tenantId: "platform", enabled: false });
    deletes++; return { deletedCount: 1 } as never;
  });
  t.mock.method(VpsOrder, "exists", async () => activeOrder ? { _id: "active-order" } as never : null);
  t.mock.method(VpsAccount, "exists", async () => reservation ? { _id: credential.accountId } as never : null);
  t.mock.method(VpsAccount, "findOneAndUpdate", async () => ({ _id: credential.accountId } as never));
  t.mock.method(VpsAccount, "updateOne", async () => { accountWrites++; return { matchedCount: 1 } as never; });

  await platform(async () => {
    await assert.rejects(vpsService.deleteCredential("999", credential._id), /admin/);
    assert.deepEqual(await vpsService.deleteCredential("101", credential._id), { status: "enabled" });
    assert.equal(deletes, 0); assert.equal(accountWrites, 0);

    credential.enabled = false; activeOrder = true;
    assert.deepEqual(await vpsService.deleteCredential("101", credential._id), { status: "in_use" });
    assert.equal(deletes, 0);

    activeOrder = false; reservation = true;
    assert.deepEqual(await vpsService.deleteCredential("101", credential._id), { status: "in_use" });
    assert.equal(deletes, 0);

    reservation = false;
    assert.deepEqual(await vpsService.deleteCredential("101", credential._id), { status: "deleted" });
    assert.equal(deletes, 1);
    assert.equal(accountWrites, 6); // lease document + release for each disabled deletion attempt
  });
});
