import assert from "node:assert/strict";
import test from "node:test";
import { disabledMessage, disableRuleId, assertSelectionEnabled, setDisableRule, removeDisableRule, type VpsDisableRule } from "../../src/vps/availability.js";
import { VpsCatalog } from "../../src/models/VpsCatalog.js";
import { defaultVpsCatalog } from "../../src/vps/catalog.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

const size = "s-1vcpu-2gb", os = "windows2022", region = "sgp1";
const selection = { size, os, region };
const rules: VpsDisableRule[] = [
  { kind: "size", size, message: "spek" },
  { kind: "os", os, message: "os global" },
  { kind: "os", os, size, message: "os satu spek" },
  { kind: "region", region, message: "region global" },
  { kind: "region", region, os, message: "region semua spek" },
  { kind: "region", region, size, message: "region semua os" },
  { kind: "region", region, size, os, message: "region satu kombinasi" },
];
for (const rule of rules) test(`scope: ${rule.message}`, () => {
  assert.equal(disabledMessage([rule], selection), rule.message);
  for (const dimension of ["size", "os", "region"] as const) {
    const changed = { ...selection, [dimension]: "other" };
    assert.equal(disabledMessage([rule], changed), rule[dimension] ? null : rule.message);
    const partial = { ...selection }; delete partial[dimension];
    assert.equal(disabledMessage([rule], partial), rule[dimension] ? null : rule.message);
  }
});
test("overlapping denies use the most specific message without overriding broader denies", () => {
  assert.equal(disabledMessage(rules, selection), "region satu kombinasi");
  assert.equal(disabledMessage(rules.filter(rule => rule.kind !== "region"), selection), "os satu spek");
  assert.equal(disabledMessage([], selection), null);
  assert.equal(disableRuleId(rules[0]!), disableRuleId({ ...rules[0]!, message: "changed" }));
});
test("persisted rules are checked fresh, writes are scoped and admin-only", async t => {
  const previous = process.env.ADMIN_ID; process.env.ADMIN_ID = "42";
  t.after(() => { if (previous === undefined) delete process.env.ADMIN_ID; else process.env.ADMIN_ID = previous; });
  const catalog = { ...defaultVpsCatalog(), disabledRules: {} as Record<string, VpsDisableRule> };
  t.mock.method(VpsCatalog, "findById", () => ({ lean: async () => structuredClone(catalog) }) as never);
  const writes: any[] = [];
  t.mock.method(VpsCatalog, "updateOne", async (filter: unknown, patch: any) => {
    writes.push({ filter, patch });
    for (const [path, rule] of Object.entries(patch.$set ?? {})) catalog.disabledRules[path.split(".")[1]!] = rule as VpsDisableRule;
    for (const path of Object.keys(patch.$unset ?? {})) delete catalog.disabledRules[path.split(".")[1]!];
    return {} as never;
  });
  await runWithTenant(platformContext(), async () => {
    await assert.rejects(setDisableRule("99", rules[0]!), /admin/);
    await assert.rejects(setDisableRule("42", { ...rules[0]!, size: "fake" }), /valid/);
    assert.equal(writes.length, 0);
    await assertSelectionEnabled(selection);
    await setDisableRule("42", rules[6]!);
    await assert.rejects(assertSelectionEnabled(selection), /region satu kombinasi/);
    await assertSelectionEnabled({ size, region });
    await assertSelectionEnabled({ size, os, region: "external" });
    await removeDisableRule("42", disableRuleId(rules[6]!));
    await assertSelectionEnabled(selection);
    assert.ok(writes.every(write => write.filter._id === "platform"));
  });
  await assert.rejects(runWithTenant({ tenantId: "rental-one", rentalId: "rental-one" }, () => setDisableRule("42", rules[0]!)), /main bot/);
});
