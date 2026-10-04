import { createHash } from "node:crypto";
import { VpsCatalog } from "../models/VpsCatalog.js";
import { defaultVpsCatalog, getVpsCatalog } from "./catalog.js";
import { assertVpsAdmin, assertVpsPlatform } from "./security.js";

export interface VpsSelection { size?: string; os?: string; region?: string }
export interface VpsDisableRule extends VpsSelection { kind: "size" | "os" | "region"; message: string }
export class VpsDisabledError extends Error {}

export function disableRuleId(rule: VpsDisableRule): string {
  return createHash("sha256").update(JSON.stringify([rule.kind, rule.size ?? null, rule.os ?? null, rule.region ?? null])).digest("hex").slice(0, 24);
}

/** Unknown dimensions never match a scoped rule. All matching rules deny access. */
export function disabledMessage(rules: VpsDisableRule[], selection: VpsSelection): string | null {
  const matches = rules.filter(rule => (["size", "os", "region"] as const).every(key => !rule[key] || rule[key] === selection[key]));
  const specificity = (rule: VpsDisableRule) => Number(Boolean(rule.size)) + Number(Boolean(rule.os)) + Number(Boolean(rule.region));
  matches.sort((a, b) => specificity(b) - specificity(a) || disableRuleId(a).localeCompare(disableRuleId(b)));
  return matches[0]?.message ?? null;
}

export async function listDisableRules(actor: string): Promise<(VpsDisableRule & { id: string })[]> {
  assertVpsAdmin(actor);
  return Object.entries((await getVpsCatalog()).disabledRules ?? {}).map(([id, rule]) => ({ ...rule, id }));
}

export async function setDisableRule(actor: string, rule: VpsDisableRule): Promise<void> {
  assertVpsAdmin(actor);
  const catalog = await getVpsCatalog();
  if (!["size", "os", "region"].includes(rule.kind) || !rule[rule.kind]
    || (rule.kind === "size" && (rule.os || rule.region)) || (rule.kind === "os" && rule.region)
    || (rule.size !== undefined && !catalog.sizes.some(item => item.slug === rule.size))
    || (rule.os !== undefined && !catalog.os.some(item => item.key === rule.os))
    || (rule.region !== undefined && !catalog.regions.some(item => item.slug === rule.region))
    || !rule.message.trim() || rule.message.trim().length > 500 || /[\x00-\x08\x0b-\x1f\x7f]/.test(rule.message)) {
    throw new Error("Aturan disable atau pesan tidak valid.");
  }
  await VpsCatalog.updateOne({ _id: "platform" }, { $setOnInsert: defaultVpsCatalog() }, { upsert: true, runValidators: true });
  await VpsCatalog.updateOne({ _id: "platform" }, { $set: { [`disabledRules.${disableRuleId(rule)}`]: { ...rule, message: rule.message.trim() } } }, { runValidators: true });
}

export async function removeDisableRule(actor: string, id: string): Promise<void> {
  assertVpsAdmin(actor);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Aturan tidak valid.");
  await VpsCatalog.updateOne({ _id: "platform" }, { $unset: { [`disabledRules.${id}`]: 1 } });
}

export async function assertSelectionEnabled(selection: VpsSelection): Promise<void> {
  assertVpsPlatform();
  const message = disabledMessage(Object.values((await getVpsCatalog()).disabledRules ?? {}), selection);
  if (message) throw new VpsDisabledError(message);
}
