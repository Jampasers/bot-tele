import { randomBytes, randomUUID } from "node:crypto";
import { VpsInstallInvite, type IVpsInstallInvite } from "../models/VpsInstallInvite.js";
import { assertVpsAdmin, assertVpsEnabled, assertVpsPlatform } from "./security.js";
import type { VpsUiInstallInvite } from "../plugins/vps/contracts.js";

export class VpsInstallInviteError extends Error {}
const unavailable = (): VpsInstallInviteError => new VpsInstallInviteError("Undangan tidak tersedia, sudah digunakan, kedaluwarsa, dicabut, atau untuk user lain.");
function scope(id: string, actor?: string) {
  assertVpsPlatform();
  if (!/^[a-f0-9]{32}$/.test(id) || (actor !== undefined && !/^[1-9]\d{0,19}$/.test(actor))) throw unavailable();
  return { _id: id, tenantId: "platform" as const };
}
function dto(invite: IVpsInstallInvite): VpsUiInstallInvite {
  return { id: invite._id, recipientId: invite.recipientId, sourceMode: invite.sourceMode, orderId: invite.orderId,
    claimedBy: invite.claimedBy, redeemedAt: invite.redeemedAt, revokedAt: invite.revokedAt, expiresAt: invite.expiresAt };
}
export async function createInstallInvite(actor: string, input: { recipientId?: string; sourceMode: IVpsInstallInvite["sourceMode"]; days: number | null }): Promise<VpsUiInstallInvite> {
  assertVpsAdmin(actor);
  if ((input.recipientId !== undefined && !/^[1-9]\d{0,19}$/.test(input.recipientId))
    || !["any", "digitalocean", "direct"].includes(input.sourceMode) || (input.days !== null && ![1, 7, 30].includes(input.days))) {
    throw new VpsInstallInviteError("Telegram ID, sumber VPS, atau masa berlaku undangan tidak valid.");
  }
  const invite = await VpsInstallInvite.create({ _id: randomBytes(16).toString("hex"), tenantId: "platform", createdBy: actor,
    recipientId: input.recipientId ?? null, sourceMode: input.sourceMode, orderId: randomUUID(), expiresAt: input.days === null ? null : new Date(Date.now() + input.days * 86400_000) });
  return dto(invite.toObject());
}
export async function listInstallInvites(actor: string, offset: number): Promise<VpsUiInstallInvite[]> {
  assertVpsAdmin(actor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw unavailable();
  return (await VpsInstallInvite.find({ tenantId: "platform" }).sort({ createdAt: -1, _id: 1 }).skip(offset).limit(10).lean()).map(dto);
}
export async function getInstallInvite(actor: string, id: string): Promise<VpsUiInstallInvite | null> {
  assertVpsAdmin(actor);
  const invite = await VpsInstallInvite.findOne(scope(id)).lean();
  return invite ? dto(invite) : null;
}
export async function revokeInstallInvite(actor: string, id: string): Promise<void> {
  assertVpsAdmin(actor);
  const result = await VpsInstallInvite.updateOne({ ...scope(id), redeemedAt: null, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!result.modifiedCount) throw new VpsInstallInviteError("Undangan sudah digunakan, dicabut, atau tidak ditemukan.");
}
/** The first eligible buyer owns this one preassigned order ID, even after a restart. */
export async function claimInstallInvite(actor: string, id: string): Promise<VpsUiInstallInvite> {
  assertVpsEnabled();
  const invite = await VpsInstallInvite.findOneAndUpdate({ ...scope(id, actor), revokedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    $and: [{ $or: [{ recipientId: null }, { recipientId: actor }] }, { $or: [{ claimedBy: null }, { claimedBy: actor }] }],
  }, { $set: { claimedBy: actor } }, { returnDocument: "after" }).lean();
  if (!invite) throw unavailable();
  return dto(invite);
}
/** Recover an unused claimed invitation independently of the in-memory wizard. */
export async function findClaimedInstallInvite(actor: string, sourceMode?: "digitalocean" | "direct"): Promise<VpsUiInstallInvite | null> {
  assertVpsPlatform();
  if (!/^[1-9]\d{0,19}$/.test(actor)) throw unavailable();
  const invite = await VpsInstallInvite.findOne({ tenantId: "platform", claimedBy: actor, redeemedAt: null, revokedAt: null,
    ...(sourceMode ? { sourceMode: { $in: ["any", sourceMode] } } : {}),
    $and: [{ $or: [{ recipientId: null }, { recipientId: actor }] }, { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }],
  }).sort({ createdAt: 1, _id: 1 }).lean();
  return invite ? dto(invite) : null;
}
export async function requireInstallInvite(actor: string, id: string, orderId: string, sourceMode: "digitalocean" | "direct"): Promise<IVpsInstallInvite> {
  const invite = await VpsInstallInvite.findOne({ ...scope(id, actor), claimedBy: actor, orderId }).lean();
  if (!invite || (invite.sourceMode !== "any" && invite.sourceMode !== sourceMode)
    || (invite.recipientId !== null && invite.recipientId !== actor)
    || (!invite.redeemedAt && (invite.revokedAt || (invite.expiresAt && invite.expiresAt.getTime() <= Date.now())))) throw unavailable();
  return invite;
}
/** Consuming the invite is atomic; its durable receipt lets the same order recover. */
export async function consumeInstallInvite(actor: string, id: string, orderId: string, sourceMode: "digitalocean" | "direct"): Promise<IVpsInstallInvite> {
  let invite = await requireInstallInvite(actor, id, orderId, sourceMode);
  if (invite.redeemedAt) return invite;
  const consumed = await VpsInstallInvite.findOneAndUpdate({ ...scope(id, actor), claimedBy: actor, orderId,
    redeemedAt: null, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  }, { $set: { redeemedAt: new Date() } }, { returnDocument: "after" }).lean();
  if (consumed) return consumed;
  invite = await requireInstallInvite(actor, id, orderId, sourceMode);
  if (!invite.redeemedAt) throw unavailable();
  return invite;
}
