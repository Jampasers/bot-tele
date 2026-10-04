import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { VpsCatalog } from "../../src/models/VpsCatalog.js";
import { VpsPlan } from "../../src/models/VpsPlan.js";
import { VpsOrder } from "../../src/models/VpsOrder.js";
import { defaultVpsCatalog } from "../../src/vps/catalog.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";
import { vpsService } from "../../src/vps/service.js";
import { DigitalOceanClient } from "../../src/vps/digitalOcean.js";
import { disabledVpsSelection, saveVpsAvailabilityRule, updateVpsAvailabilityRule, assertVpsOrderAcceptsNewPayment, VpsSelectionDisabledError,
  type VpsAvailabilityRule, type VpsAvailabilityInput } from "../../src/vps/availability.js";

const platform = <T>(fn: () => Promise<T>) => runWithTenant(platformContext(), fn);
const size = "s-1vcpu-2gb", otherSize = "s-2vcpu-4gb", os = "windows2022", otherOs = "ubuntu24", region = "sgp1";
const rule = (input: Partial<VpsAvailabilityRule> = {}): VpsAvailabilityRule => ({ id: "a".repeat(24), kind: "region", target: region, size: null, os: null, message: "Region maintenance", enabled: true, ...input });
const query = <T>(value: T) => ({ lean: async () => structuredClone(value) });

test("each supported disable scope blocks only matching selections", () => {
  const cases: [VpsAvailabilityRule, { size: string; os: string; region: string }][] = [
    [rule({ kind: "size", target: size }), { size: otherSize, os, region }],
    [rule({ kind: "os", target: os }), { size, os: otherOs, region }],
    [rule({ kind: "os", target: os, size }), { size: otherSize, os, region }],
    [rule(), { size, os, region: "fra1" }],
    [rule({ os }), { size, os: otherOs, region }],
    [rule({ size }), { size: otherSize, os, region }],
    [rule({ size, os }), { size: otherSize, os, region }],
  ];
  for (const [entry, allowed] of cases) {
    assert.equal(disabledVpsSelection([entry], { size, os, region })?.id, entry.id);
    assert.equal(disabledVpsSelection([entry], allowed), undefined);
    assert.equal(disabledVpsSelection([{ ...entry, enabled: false }], { size, os, region }), undefined);
  }
  assert.ok(disabledVpsSelection([rule({ os })], { size: otherSize, os, region }));
  assert.ok(disabledVpsSelection([rule({ size })], { size, os: otherOs, region }));
  assert.equal(disabledVpsSelection([rule({ size, os })], { size, os: otherOs, region }), undefined);
  assert.equal(disabledVpsSelection([rule({ size, os })], { size, region }), undefined);
  assert.equal(disabledVpsSelection([rule()], { size, os, region: "external" }), undefined);
});

test("specific disable messages take priority and inactive rules cannot override global disable", () => {
  const global = rule(), specific = rule({ id: "b".repeat(24), size, os, message: "Windows 2022 2GB in SG unavailable" });
  assert.equal(disabledVpsSelection([global, specific], { size, os, region })?.message, specific.message);
  assert.equal(disabledVpsSelection([specific, global], { size, os, region })?.message, specific.message);
  assert.equal(disabledVpsSelection([global, { ...specific, enabled: false }], { size, os, region })?.message, global.message);
  assert.ok(disabledVpsSelection([rule({ kind: "os", target: os })], { size: "future-custom-spec", os, region }));
});

test("rule persistence enforces admin/platform, catalog membership, message limits and atomic scope replacement", async t => {
  const previous = process.env.ADMIN_ID;
  process.env.ADMIN_ID = "101";
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_ID; else process.env.ADMIN_ID = previous; });
  t.mock.method(VpsCatalog, "findById", () => query(defaultVpsCatalog()));
  const writes: { filter: Record<string, unknown>; patch: unknown; options: Record<string, unknown> }[] = [];
  t.mock.method(VpsCatalog, "updateOne", async (filter, patch, options) => { writes.push({ filter, patch, options }); return { matchedCount: 1 }; });
  const input: VpsAvailabilityInput = { kind: "region", target: region, size, os, message: "  Maintenance\nCoba besok  " };
  await platform(async () => {
    await assert.rejects(saveVpsAvailabilityRule("999", input), /admin/);
    for (const invalid of [{ ...input, target: "unknown-region" }, { ...input, size: "unknown-size" }, { ...input, os: "unknown-os" },
      { ...input, kind: "size" as const, target: size }, { ...input, kind: "os" as const, target: os }, { ...input, message: " " }, { ...input, message: "x".repeat(501) }]) {
      await assert.rejects(saveVpsAvailabilityRule("101", invalid));
    }
    assert.equal(writes.length, 0);
    const saved = await saveVpsAvailabilityRule("101", input);
    const repeated = await saveVpsAvailabilityRule("101", { ...input, message: "New reason" });
    assert.equal(saved.id, repeated.id);
    assert.equal(saved.message, "Maintenance\nCoba besok");
    assert.equal(saved.enabled, true);
    const pipeline = writes[1]!.patch as Record<string, any>[];
    assert.equal(writes[1]!.options.updatePipeline, true);
    assert.deepEqual(pipeline[0]!.$set.availabilityRules.$concatArrays[0].$filter.cond, { $ne: ["$$rule.id", saved.id] });
    assert.deepEqual(pipeline[0]!.$set.availabilityRules.$concatArrays[1].$literal, [saved]);
    await updateVpsAvailabilityRule("101", saved.id, { enabled: false, message: "Edited reason" });
    assert.deepEqual(writes.at(-1)!.patch, { $set: { "availabilityRules.$.enabled": false, "availabilityRules.$.message": "Edited reason" } });
  });
  await assert.rejects(runWithTenant({ tenantId: "rental", rentalId: "rental" }, () => saveVpsAvailabilityRule("101", input)), /main bot/);
});

test("old or forged checkout cannot bypass disable or call provider/create an order", async t => {
  const previous = process.env.VPS_ENABLED;
  process.env.VPS_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.VPS_ENABLED; else process.env.VPS_ENABLED = previous; });
  t.mock.method(VpsCatalog, "findById", () => query({ ...defaultVpsCatalog(), availabilityRules: [rule({ size, os, message: "Temporarily unavailable" })] }));
  t.mock.method(VpsOrder, "findOne", () => query(null));
  t.mock.method(VpsPlan, "findOne", () => query({ _id: "test-plan", enabled: true, sizeSlug: size }));
  let writes = 0, provider = 0;
  t.mock.method(VpsOrder, "create", async () => { writes++; throw new Error("Unexpected write"); });
  t.mock.method(DigitalOceanClient.prototype, "account", async () => { provider++; throw new Error("Unexpected provider"); });
  await platform(() => assert.rejects(vpsService.checkout({ actorTelegramId: "101", chatId: "101", requestId: randomUUID(),
    serviceType: "purchase", planId: "test-plan", os, region }), error => error instanceof VpsSelectionDisabledError && error.message === "Temporarily unavailable"));
  assert.equal(writes, 0); assert.equal(provider, 0);
});

test("disable blocks new payments while existing QRIS, balance intents and paid orders remain recoverable", async t => {
  t.mock.method(VpsCatalog, "findById", () => query({ ...defaultVpsCatalog(), availabilityRules: [rule()] }));
  t.mock.method(VpsPlan, "findOne", () => { throw new Error("Rule must block before plan read"); });
  const order = new VpsOrder({ _id: randomUUID(), tenantId: "platform", buyerId: "101", chatId: "101", service: "purchase", createName: "test",
    passwordEncrypted: "unused", snapshot: { planId: "test-plan", planName: "Test", size, os, region, image: "ubuntu-24-04-x64", price: 25000, vcpus: 1, memory: 2048, disk: 50 } }).toObject();
  await platform(async () => {
    await assert.rejects(assertVpsOrderAcceptsNewPayment(order), VpsSelectionDisabledError);
    await assert.rejects(assertVpsOrderAcceptsNewPayment({ ...order, paymentStatus: "paying", paymentMethod: "qris" }), VpsSelectionDisabledError);
    await assertVpsOrderAcceptsNewPayment({ ...order, paymentStatus: "paid" });
    await assertVpsOrderAcceptsNewPayment({ ...order, paymentStatus: "paying", paymentMethod: "balance" });
    await assertVpsOrderAcceptsNewPayment({ ...order, paymentStatus: "paying", paymentMethod: "qris", paymentInvoice: {
      reference: "existing", merchantId: "test", amount: 25000, createdAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    } });
  });
});
