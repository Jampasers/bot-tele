import { createHash } from "node:crypto";
import { VpsCatalog } from "../models/VpsCatalog.js";
import { VpsPlan } from "../models/VpsPlan.js";
import type { IVpsOrder } from "../models/VpsOrder.js";
import { defaultVpsCatalog, getVpsCatalog } from "./catalog.js";
import { assertVpsAdmin, assertVpsPlatform } from "./security.js";

export interface VpsAvailabilityRule {
  id: string;
  kind: "size" | "os" | "region";
  target: string;
  size: string | null;
  os: string | null;
  message: string;
  /** True means this disable rule is enforced. */
  enabled: boolean;
}
export type VpsAvailabilityInput = Pick<VpsAvailabilityRule, "kind" | "target" | "size" | "os" | "message">;
export interface VpsSelection { size?: string; os?: string; region?: string }
export const DEFAULT_DISABLED_MESSAGE = "Pilihan ini sementara dinonaktifkan oleh admin. Silakan pilih opsi lain.";
export class VpsSelectionDisabledError extends Error {
  constructor(message = DEFAULT_DISABLED_MESSAGE) { super(message); this.name = "VpsSelectionDisabledError"; }
}

/** Unknown dimensions do not match scoped rules until the buyer chooses them. */
export function disabledVpsSelection(rules: readonly VpsAvailabilityRule[], selection: VpsSelection): VpsAvailabilityRule | undefined {
  const matches = rules.filter(rule => rule.enabled
    && rule.target === selection[rule.kind === "size" ? "size" : rule.kind]
    && (!rule.size || rule.size === selection.size)
    && (!rule.os || rule.os === selection.os));
  // A specific message takes precedence; no active rule can be overridden by enabling another.
  return matches.sort((a, b) => Number(!!b.size) + Number(!!b.os) - Number(!!a.size) - Number(!!a.os)
    || a.id.localeCompare(b.id))[0];
}

export async function listVpsAvailabilityRules(): Promise<VpsAvailabilityRule[]> {
  assertVpsPlatform();
  return (await getVpsCatalog()).availabilityRules ?? [];
}

function validateMessage(message: string): string {
  const value = message.trim();
  if (!value || value.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Pesan wajib diisi, maksimal 500 karakter.");
  return value;
}

export async function saveVpsAvailabilityRule(actor: string, input: VpsAvailabilityInput): Promise<VpsAvailabilityRule> {
  assertVpsAdmin(actor);
  const catalog = await getVpsCatalog();
  if (!["size", "os", "region"].includes(input.kind)
    || (input.kind === "size" && (input.size || input.os)) || (input.kind === "os" && input.os)
    || (input.size && !catalog.sizes.some(size => size.slug === input.size))
    || (input.os && !catalog.os.some(os => os.key === input.os))) throw new Error("Cakupan disable tidak valid.");
  const targets = input.kind === "size" ? catalog.sizes.map(size => size.slug)
    : input.kind === "os" ? catalog.os.map(os => os.key) : catalog.regions.map(region => region.slug);
  if (!targets.includes(input.target)) throw new Error("Pilihan tidak ada dalam katalog.");
  const id = createHash("sha256").update(JSON.stringify([input.kind, input.target, input.size, input.os])).digest("hex").slice(0, 24);
  const rule: VpsAvailabilityRule = { ...input, id, message: validateMessage(input.message), enabled: true };
  await VpsCatalog.updateOne({ _id: "platform" }, { $setOnInsert: defaultVpsCatalog() }, { upsert: true, runValidators: true });
  // Replace the same scope atomically so concurrent admins cannot add duplicate rules.
  const updated = await VpsCatalog.updateOne({ _id: "platform", $or: [{ "availabilityRules.id": id }, { "availabilityRules.199": { $exists: false } }] }, [{ $set: {
    availabilityRules: { $concatArrays: [{ $filter: { input: { $ifNull: ["$availabilityRules", []] }, as: "rule", cond: { $ne: ["$$rule.id", id] } } }, { $literal: [rule] }] },
    updatedAt: new Date(),
  } }], { updatePipeline: true });
  if (!updated.matchedCount) throw new Error("Maksimal 200 aturan disable.");
  return rule;
}

export async function updateVpsAvailabilityRule(actor: string, id: string, input: { enabled?: boolean; message?: string }): Promise<void> {
  assertVpsAdmin(actor);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Aturan tidak ditemukan.");
  const fields: Record<string, unknown> = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("Status aturan tidak valid.");
    fields["availabilityRules.$.enabled"] = input.enabled;
  }
  if (input.message !== undefined) fields["availabilityRules.$.message"] = validateMessage(input.message);
  if (!Object.keys(fields).length) throw new Error("Perubahan belum diisi.");
  const updated = await VpsCatalog.updateOne({ _id: "platform", "availabilityRules.id": id }, { $set: fields }, { runValidators: true });
  if (!updated.matchedCount) throw new Error("Aturan tidak ditemukan.");
}

export function assertVpsSelectionAvailable(rules: readonly VpsAvailabilityRule[], selection: VpsSelection): void {
  const rule = disabledVpsSelection(rules, selection);
  if (rule) throw new VpsSelectionDisabledError(rule.message);
}

/** Existing payment intents and paid orders finish normally; only new payments are blocked. */
export async function assertVpsOrderAcceptsNewPayment(order: IVpsOrder): Promise<void> {
  if (order.paymentStatus !== "unpaid" && !(order.paymentStatus === "paying" && order.paymentMethod === "qris" && !order.paymentInvoice)) return;
  assertVpsSelectionAvailable(await listVpsAvailabilityRules(), { size: order.snapshot.size, os: order.snapshot.os, region: order.snapshot.region });
  const plan = await VpsPlan.findOne({ _id: order.snapshot.planId, tenantId: "platform" }).lean();
  if (plan?.enabled === false) throw new VpsSelectionDisabledError();
}
