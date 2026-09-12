import { randomUUID } from "node:crypto";
import { VpsCredential, VpsAccount, type IVpsCredential } from "../models/VpsCredential.js";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { encryptSecret, decryptSecret } from "../services/crypto.js";
import { DigitalOceanClient } from "./digitalOcean.js";
import { assertVpsAdmin, assertVpsPlatform } from "./security.js";
import type { VpsUiCredential, VpsCredentialFilter } from "../plugins/vps/contracts.js";

type Credential = IVpsCredential;
export function credentialDto(c: Pick<Credential, "_id" | "label" | "priority" | "enabled" | "accountId" | "accountStatus" | "statusMessage" | "health" | "dropletLimit" | "used" | "reservations" | "checkedAt" | "lastCreateResult" | "lastCreateAt">): VpsUiCredential {
  return { id: c._id, label: c.label, priority: c.priority, enabled: c.enabled, accountId: c.accountId, accountStatus: c.accountStatus,
    statusMessage: c.statusMessage, tokenStatus: c.health, dropletLimit: c.dropletLimit ?? null, used: c.used ?? null, reserved: c.reservations ?? null,
    available: c.dropletLimit == null || c.used == null || c.reservations == null ? null : Math.max(0, c.dropletLimit - c.used - c.reservations),
    checkedAt: c.checkedAt ?? null, lastCreateResult: c.lastCreateResult ?? null, lastCreateAt: c.lastCreateAt ?? null };
}

export function unobservedReservations(droplets: { id: number; name: string }[], orders: { dropletId: number | null; createName: string }[]): number {
  const ids = new Set(droplets.map(d => d.id)); const names = new Set(droplets.map(d => d.name));
  return orders.filter(o => !(o.dropletId != null && ids.has(o.dropletId)) && !names.has(o.createName)).length;
}
function unionReservations(orders: { dropletId: number | null; createName: string }[], tickets: { createName: string }[]) {
  const pending = new Map(orders.map(order => [order.createName, { dropletId: order.dropletId, createName: order.createName }]));
  // Preserve a recorded droplet ID even when a user renamed it at the provider.
  // Tickets add orphan reservations, but must not erase an order's stronger evidence.
  for (const ticket of tickets) if (!pending.has(ticket.createName)) pending.set(ticket.createName, { dropletId: null, createName: ticket.createName });
  return [...pending.values()];
}
export async function providerForCredential(id: string, accountId: string): Promise<DigitalOceanClient> {
  assertVpsPlatform();
  // Disabling affects NEW allocations only; existing orders retain this reference.
  const c = await VpsCredential.findOne({ _id: id, tenantId: "platform", accountId }).select("+tokenEncrypted").lean();
  if (!c) throw new Error("Credential pesanan tidak tersedia.");
  return new DigitalOceanClient(decryptSecret(c.tokenEncrypted, `platform:vps:credential:${c._id}`));
}
export async function addCredential(actor: string, input: { label: string; token: string; priority: number }): Promise<VpsUiCredential> {
  assertVpsAdmin(actor);
  if (!input.label.trim() || input.label.length > 80 || !Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10000) throw new Error("Label atau prioritas tidak valid.");
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(input.token)) throw new Error("Format token tidak valid.");
  const account = await new DigitalOceanClient(input.token).account();
  const id = randomUUID();
  await VpsCredential.create({ _id: id, label: input.label.trim(), priority: input.priority,
    tokenEncrypted: encryptSecret(input.token, `platform:vps:credential:${id}`), accountId: account.identity,
    accountName: account.teamName ?? account.uuid, accountStatus: account.status, statusMessage: account.statusMessage,
    dropletLimit: account.dropletLimit ?? null });
  return checkCredential(actor, id);
}
export async function checkCredential(actor: string, id: string): Promise<VpsUiCredential> {
  assertVpsAdmin(actor);
  const c = await VpsCredential.findOne({ _id: id, tenantId: "platform" }).select("+tokenEncrypted");
  if (!c) throw new Error("Token tidak ditemukan.");
  const update: Record<string, unknown> = { checkedAt: new Date(), health: "unknown", used: null, reservations: null, dropletLimit: null, accountStatus: "unknown", statusMessage: "" };
  try {
    const client = new DigitalOceanClient(decryptSecret(c.tokenEncrypted, `platform:vps:credential:${id}`));
    const account = await client.account();
    if (account.identity !== c.accountId) throw new Error("account_changed");
    Object.assign(update, { accountStatus: account.status, statusMessage: account.statusMessage, dropletLimit: account.dropletLimit ?? null });
    const droplets = await client.listDroplets();
    const [reservations, accountTickets] = await Promise.all([
      VpsOrder.find({ tenantId: "platform", accountId: c.accountId, reservationActive: true }).select("dropletId createName").lean(),
      VpsAccount.findOne({ _id: c.accountId }).lean(),
    ]);
    Object.assign(update, { used: droplets.length, reservations: unobservedReservations(droplets, unionReservations(reservations, accountTickets?.reservations ?? [])), health: "ok" });
  } catch (error) {
    const kind = error && typeof error === "object" && "kind" in error ? String(error.kind) : "unknown";
    update.health = ["invalid_token", "permission", "rate_limit", "timeout", "api", "network"].includes(kind) ? kind : "unknown";
    // Account GET and droplet GET are separate evidence; missing counts remain unknown.
  }
  const changed = await VpsCredential.findOneAndUpdate({ _id: id, tenantId: "platform" }, { $set: update }, { returnDocument: "after" });
  if (!changed) throw new Error("Token tidak ditemukan.");
  return credentialDto(changed);
}
export async function listCredentials(actor: string, filter: VpsCredentialFilter, offset: number, limit: number): Promise<VpsUiCredential[]> {
  assertVpsAdmin(actor);
  const query: Record<string, unknown> = { tenantId: "platform" };
  if (["active", "warning", "locked"].includes(filter)) query.accountStatus = filter;
  if (filter === "problem") query.health = { $ne: "ok" };
  if (filter === "available") Object.assign(query, { enabled: true, accountStatus: "active", health: "ok", dropletLimit: { $ne: null }, used: { $ne: null }, reservations: { $ne: null }, $expr: { $gt: [{ $subtract: ["$dropletLimit", { $add: ["$used", "$reservations"] }] }, 0] } });
  return (await VpsCredential.find(query).sort({ priority: 1, _id: 1 }).skip(Math.max(0, offset)).limit(Math.min(20, Math.max(1, limit))).lean()).map(credentialDto);
}
export async function checkAllCredentials(actor: string): Promise<void> {
  assertVpsAdmin(actor);
  const cursor = VpsCredential.find({ tenantId: "platform" }).select("_id").lean().cursor();
  let batch: Promise<unknown>[] = [];
  for await (const c of cursor) { batch.push(checkCredential(actor, c._id)); if (batch.length === 3) { await Promise.allSettled(batch); batch = []; } }
  await Promise.allSettled(batch);
}

/** Serialize provider snapshots and reservations across processes and same-team tokens. */
export async function reserveStoreCapacity(order: IVpsOrder, workerId: string, signal?: AbortSignal): Promise<{ credentialId: string; accountId: string } | null> {
  assertVpsPlatform();
  if (signal?.aborted) return null;
  const ownedOrder = { _id: order._id, tenantId: "platform", lockOwner: workerId, lockUntil: { $gt: new Date() }, stage: "queued" as const, paymentStatus: "paid" as const, createAttemptedAt: null };
  if (!await VpsOrder.findOne(ownedOrder).select("_id").lean()) return null;
  // A crash between recording the account ticket and attaching it to the order is recoverable.
  const previous = await VpsAccount.findOne({ "reservations.orderId": order._id }).lean();
  const ticket = previous?.reservations.find(r => r.orderId === order._id);
  if (previous && ticket) {
    const attached = await VpsOrder.updateOne({ ...ownedOrder, lockUntil: { $gt: new Date() } }, { $set: { credentialId: ticket.credentialId, accountId: previous._id, reservationActive: true } });
    return attached.matchedCount ? { credentialId: ticket.credentialId, accountId: previous._id } : null;
  }
  const credentials = await VpsCredential.find({ tenantId: "platform", enabled: true }).sort({ priority: 1, _id: 1 }).lean();
  for (const c of credentials) {
    if (signal?.aborted) return null;
    const leaseId = randomUUID();
    await VpsAccount.updateOne({ _id: c.accountId }, { $setOnInsert: { lockUntil: null, lockOwner: null } }, { upsert: true }).catch(error => { if (error?.code !== 11000) throw error; });
    const lease = await VpsAccount.findOneAndUpdate({ _id: c.accountId, $or: [{ lockUntil: null }, { lockUntil: { $lt: new Date() } }] }, { $set: { lockOwner: leaseId, lockUntil: new Date(Date.now() + 120_000) } }, { returnDocument: "after" });
    if (!lease) continue;
    let ticketWriteAttempted = false;
    try {
      const client = await providerForCredential(c._id, c.accountId);
      const account = await client.account(signal);
      if (account.identity !== c.accountId || account.status !== "active" || account.dropletLimit === undefined) continue;
      const droplets = await client.listDroplets(signal);
      const pending = await VpsOrder.find({ tenantId: "platform", accountId: c.accountId, reservationActive: true }).select("dropletId createName").lean();
      if (account.dropletLimit - droplets.length - unobservedReservations(droplets, unionReservations(pending, lease.reservations)) <= 0) continue;
      if (signal?.aborted || !await VpsOrder.findOne({ ...ownedOrder, lockUntil: { $gt: new Date() } }).select("_id").lean()) return null;
      // Capacity ticket and lease fence are one atomic write. A delayed worker cannot
      // reserve from an old snapshot after a new worker has taken the account lease.
      ticketWriteAttempted = true;
      const capacityTicket = await VpsAccount.updateOne({ _id: c.accountId, lockOwner: leaseId, lockUntil: { $gt: new Date() }, "reservations.orderId": { $ne: order._id } }, {
        $push: { reservations: { orderId: order._id, createName: order.createName, credentialId: c._id } },
      });
      if (!capacityTicket.matchedCount) { ticketWriteAttempted = false; continue; }
      const reserved = await VpsOrder.findOneAndUpdate({ _id: order._id, tenantId: "platform", lockOwner: workerId, lockUntil: { $gt: new Date() }, stage: "queued" as const, paymentStatus: "paid" as const, createAttemptedAt: null }, {
        $set: { credentialId: c._id, accountId: c.accountId, reservationActive: true },
      }, { returnDocument: "after" });
      if (reserved) return { credentialId: c._id, accountId: c.accountId };
      return null;
    } catch {
      // A failed acknowledgement can hide an already-persisted ticket. Reconcile
      // that order on the next pass before ever trying another provider account.
      if (ticketWriteAttempted) return null;
      // Endpoint/token failures before writing may try another same-team token.
    }
    finally { await VpsAccount.updateOne({ _id: c.accountId, lockOwner: leaseId }, { $set: { lockOwner: null, lockUntil: null } }); }
  }
  return null;
}

export async function releaseCapacityTicket(orderId: string): Promise<void> {
  assertVpsPlatform();
  await VpsAccount.updateMany({ "reservations.orderId": orderId }, { $pull: { reservations: { orderId } } });
}
