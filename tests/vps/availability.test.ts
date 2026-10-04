import assert from "node:assert/strict";
import test from "node:test";
import { defaultVpsCatalog } from "../../src/vps/catalog.js";
import { validateVpsDisableRule, vpsDisableRuleId, vpsSelectionDisabled, type VpsDisableRuleInput, type VpsSelection } from "../../src/vps/availability.js";

const size = "s-1vcpu-2gb";
const selected: VpsSelection = { serviceType: "purchase", sizeSlug: size, os: "ubuntu24", region: "sgp1" };
function rule(changes: Partial<VpsDisableRuleInput> = {}) {
  return validateVpsDisableRule({ service: "all", target: "region", sizeSlug: "*", os: "*", region: "sgp1", message: "Maintenance", ...changes }, defaultVpsCatalog());
}

test("spec and OS rules cover globals and a single spec without blocking unrelated choices", () => {
  const spec = rule({ target: "size", sizeSlug: size, region: "*" });
  assert.equal(vpsSelectionDisabled([spec], selected), "Maintenance");
  assert.equal(vpsSelectionDisabled([spec], { ...selected, os: "windows2022", region: "fra1" }), "Maintenance");
  assert.equal(vpsSelectionDisabled([spec], { ...selected, sizeSlug: "s-2vcpu-4gb" }), null);
  const globalOs = rule({ target: "os", os: "ubuntu24", region: "*" });
  const specificOs = rule({ target: "os", os: "ubuntu24", sizeSlug: size, region: "*" });
  for (const osRule of [globalOs, specificOs]) {
    assert.equal(vpsSelectionDisabled([osRule], selected), "Maintenance");
    assert.equal(vpsSelectionDisabled([osRule], { ...selected, os: "windows2022" }), null);
    assert.equal(vpsSelectionDisabled([osRule], { serviceType: "purchase", sizeSlug: size }), null);
  }
  assert.equal(vpsSelectionDisabled([globalOs], { ...selected, sizeSlug: "s-2vcpu-4gb" }), "Maintenance");
  assert.equal(vpsSelectionDisabled([specificOs], { ...selected, sizeSlug: "s-2vcpu-4gb" }), null);
});

test("all four region scopes match only the chosen combination", () => {
  for (const sizeSlug of ["*", size]) for (const os of ["*", "ubuntu24"]) {
    const disabled = rule({ sizeSlug, os });
    assert.equal(vpsSelectionDisabled([disabled], selected), "Maintenance");
    assert.equal(vpsSelectionDisabled([disabled], { ...selected, region: "fra1" }), null);
    assert.equal(vpsSelectionDisabled([disabled], { ...selected, sizeSlug: "s-2vcpu-4gb" }), sizeSlug === "*" ? "Maintenance" : null);
    assert.equal(vpsSelectionDisabled([disabled], { ...selected, os: "windows2022" }), os === "*" ? "Maintenance" : null);
    assert.equal(vpsSelectionDisabled([disabled], { serviceType: "purchase", sizeSlug: size, region: "sgp1" }), os === "*" ? "Maintenance" : null);
  }
});

test("rules isolate services, including direct SSH, and the most specific reason wins independently of order", () => {
  const broad = rule({ target: "os", os: "ubuntu24", region: "*", message: "Global OS" });
  const specific = rule({ sizeSlug: size, os: "ubuntu24", service: "purchase", message: "Specific maintenance" });
  for (const rules of [[broad, specific], [specific, broad]]) assert.equal(vpsSelectionDisabled(rules, selected), "Specific maintenance");
  assert.equal(vpsSelectionDisabled([specific], { ...selected, serviceType: "install" }), null);
  const install = rule({ service: "install-do" });
  assert.equal(vpsSelectionDisabled([install], { ...selected, serviceType: "install" }), "Maintenance");
  assert.equal(vpsSelectionDisabled([install], { ...selected, serviceType: "install", sourceMode: "direct", region: "external" }), null);
  const direct = rule({ service: "install-direct", target: "os", os: "windows2022", region: "*" });
  assert.equal(vpsSelectionDisabled([direct], { ...selected, serviceType: "install", sourceMode: "direct", os: "windows2022", region: "external" }), "Maintenance");
  assert.equal(vpsSelectionDisabled([direct], { ...selected, os: "windows2022" }), null);
  assert.equal(vpsSelectionDisabled([], selected), null);
});

test("rule validation rejects unknown entries, invalid scopes and messages; the ID excludes message text", () => {
  const first = rule();
  assert.equal(first.id, vpsDisableRuleId({ ...first, message: "A different message" }));
  assert.equal(rule({ message: "  Maintenance  " }).message, "Maintenance");
  for (const invalid of [
    { sizeSlug: "not-in-catalog" }, { os: "not-in-catalog" }, { region: "not-in-catalog" },
    { target: "size", sizeSlug: "*", region: "*" }, { target: "os", os: "*", region: "*" },
    { target: "os", os: "ubuntu24", region: "sgp1" }, { region: "*" }, { service: "install-direct" },
    { message: " " }, { message: "x".repeat(201) }, { message: "line\nbreak" },
  ] as Partial<VpsDisableRuleInput>[]) assert.throws(() => rule(invalid));
  assert.equal(rule({ message: "$malformed <tag> & plain text" }).message, "$malformed <tag> & plain text");
});
