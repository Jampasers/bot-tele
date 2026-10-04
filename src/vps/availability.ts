import { createHash } from "node:crypto";

export type VpsDisableService = "all" | "purchase" | "install-do" | "install-direct";
export interface VpsDisableRuleInput {
  service: VpsDisableService;
  target: "size" | "os" | "region";
  sizeSlug: string;
  os: string;
  region: string;
  message: string;
}
export interface VpsDisableRule extends VpsDisableRuleInput { id: string }
export interface VpsSelection {
  serviceType: "purchase" | "install";
  sourceMode?: "digitalocean" | "direct";
  sizeSlug: string;
  os?: string;
  region?: string;
}
export const DEFAULT_VPS_DISABLE_MESSAGE = "Pilihan ini sementara dinonaktifkan oleh admin. Silakan pilih opsi lain.";
export class VpsSelectionDisabledError extends Error {}

/** A stable key makes saving the same scope replace its message, without duplicates. */
export function vpsDisableRuleId(rule: VpsDisableRuleInput): string {
  return createHash("sha256").update(JSON.stringify([rule.service, rule.target, rule.sizeSlug, rule.os, rule.region])).digest("hex").slice(0, 24);
}

export function vpsSelectionDisabled(rules: readonly VpsDisableRule[], selection: VpsSelection): string | null {
  const service = selection.serviceType === "purchase" ? "purchase" : selection.sourceMode === "direct" ? "install-direct" : "install-do";
  const matches = rules.filter(rule => (rule.service === "all" || rule.service === service)
    && (rule.sizeSlug === "*" || rule.sizeSlug === selection.sizeSlug)
    && (rule.os === "*" || rule.os === selection.os)
    && (rule.region === "*" || rule.region === selection.region));
  // Every matching rule blocks. The most specific matching rule supplies the reason.
  const specificity = (rule: VpsDisableRule): number => [rule.sizeSlug, rule.os, rule.region].filter(value => value !== "*").length * 2 + Number(rule.service !== "all");
  matches.sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
  return matches[0]?.message ?? null;
}

export function validateVpsDisableRule(input: VpsDisableRuleInput, catalog: {
  sizes: { slug: string }[]; os: { key: string }[]; regions: { slug: string }[];
}): VpsDisableRule {
  if (!["all", "purchase", "install-do", "install-direct"].includes(input.service)
    || !["size", "os", "region"].includes(input.target)
    || (input.sizeSlug !== "*" && !catalog.sizes.some(size => size.slug === input.sizeSlug))
    || (input.os !== "*" && !catalog.os.some(os => os.key === input.os))
    || (input.region !== "*" && !catalog.regions.some(region => region.slug === input.region))
    || (input.target === "size" && (input.sizeSlug === "*" || input.os !== "*" || input.region !== "*"))
    || (input.target === "os" && (input.os === "*" || input.region !== "*"))
    || (input.target === "region" && (input.region === "*" || input.service === "install-direct"))) {
    throw new Error("Cakupan disable tidak valid. Pilih dari katalog VPS.");
  }
  const message = input.message.trim();
  if (!message || message.length > 200 || /[\x00-\x1f\x7f]/.test(message)) throw new Error("Pesan disable harus 1–200 karakter dalam satu baris.");
  const rule = { service: input.service, target: input.target, sizeSlug: input.sizeSlug, os: input.os, region: input.region, message };
  return { ...rule, id: vpsDisableRuleId(rule) };
}
