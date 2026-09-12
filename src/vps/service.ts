import { randomUUID } from "node:crypto";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { VpsCredential } from "../models/VpsCredential.js";
import { VpsPlan, type IVpsPlan } from "../models/VpsPlan.js";
import { encryptSecret, decryptSecret } from "../services/crypto.js";
import { DigitalOceanClient } from "./digitalOcean.js";
import { OS_CATALOG, getOs, generatePassword } from "./installer.js";
import { assertVpsAdmin, assertVpsEnabled, assertVpsPlatform, buyerTokens, vpsEnabled } from "./security.js";
import { addCredential, checkAllCredentials, checkCredential, credentialDto, listCredentials, providerForCredential, releaseCapacityTicket } from "./credentials.js";
import { payVpsFromBalance, createVpsInvoice, checkVpsPayment, refundVpsOrder } from "./payment.js";
import type { VpsUiDependencies, VpsUiOrder, VpsUiPlan } from "../plugins/vps/contracts.js";

const validId = (id: string): boolean => /^[a-f0-9-]{36}$/.test(id);
export async function ownedOrder(actor: string, orderId: string, includeSecret = false): Promise<IVpsOrder | null> {
  assertVpsPlatform();
  if (!/^\d{1,20}$/.test(actor) || !validId(orderId)) throw new Error("Pesanan tidak ditemukan.");
  const q = VpsOrder.findOne({ _id: orderId, tenantId: "platform", buyerId: actor });
  if (includeSecret) q.select("+passwordEncrypted");
  return q.lean();
}
export function orderDto(order: IVpsOrder): VpsUiOrder {
  return { _id: order._id, serviceType: order.service, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, stage: order.stage,
    price: order.snapshot.price, planName: order.snapshot.planName, sizeSlug: order.snapshot.size, os: order.snapshot.os,
    region: order.snapshot.region, ip: order.publicIp, dropletId: order.dropletId, needsToken: order.stage === "needs_token",
    evidence: order.evidence, createdAt: order.createdAt, vcpus: order.snapshot.vcpus, memory: order.snapshot.memory, disk: order.snapshot.disk,
    installerLogUrl: order.installerLogUrl };
}
type Plan = IVpsPlan;
function planDto(p: Pick<Plan, "_id" | "name" | "serviceType" | "sizeSlug" | "regions" | "osPrices" | "enabled">): VpsUiPlan {
  return { id: p._id, name: p.name, serviceType: p.serviceType as "purchase" | "install", sizeSlug: p.sizeSlug,
    regions: [...p.regions], osPrices: p.osPrices.map(o => ({ os: o.os, label: o.label, price: o.price })), enabled: p.enabled };
}
async function acceptBuyerToken(actor: string, orderId: string, token: string): Promise<{ accountId: string }> {
  assertVpsEnabled();
  if (!validId(orderId) || !/^\d{1,20}$/.test(actor) || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error("Input token tidak valid.");
  const order = await VpsOrder.findOne({ _id: orderId, tenantId: "platform" }).lean();
  if (order && (order.buyerId !== actor || order.service !== "install" || ["failed", "cancelled", "ready"].includes(order.stage))) throw new Error("Pesanan tidak dapat menerima token.");
  const account = await new DigitalOceanClient(token).account();
  if (order?.accountId && order.accountId !== account.identity) throw new Error("Token harus berasal dari akun/team yang sama.");
  buyerTokens.put(actor, orderId, token, account.identity);
  if (order?.stage === "needs_token") await VpsOrder.updateOne({ _id: orderId, buyerId: actor, tenantId: "platform", stage: "needs_token" }, { $set: {
    stage: order.resumeStage ?? "queued", resumeStage: null, lastError: null, nextRunAt: new Date(),
  } });
  return { accountId: account.identity };
}
async function checkout(input: Parameters<VpsUiDependencies["checkout"]>[0]): Promise<VpsUiOrder> {
  assertVpsEnabled();
  if (!validId(input.requestId) || !/^\d{1,20}$/.test(input.actorTelegramId) || input.chatId !== input.actorTelegramId) throw new Error("Checkout hanya melalui chat pribadi.");
  const existing = await ownedOrder(input.actorTelegramId, input.requestId);
  if (existing) return orderDto(existing);
  const plan = await VpsPlan.findOne({ _id: input.planId, tenantId: "platform", serviceType: input.serviceType, enabled: true }).lean();
  const price = plan?.osPrices.find(o => o.os === input.os)?.price;
  if (!plan || !price || !plan.regions.includes(input.region) || !getOs(input.os)) throw new Error("Paket atau harga tidak tersedia.");
  let accountId: string | null = null;
  let client: DigitalOceanClient | undefined;
  if (input.serviceType === "install") {
    const token = buyerTokens.get(input.actorTelegramId, input.buyerSessionId ?? input.requestId);
    if (!token) throw new Error("Kirim ulang token buyer sebelum checkout.");
    client = new DigitalOceanClient(token.token);
    const account = await client.account();
    if (account.identity !== token.accountId || account.status !== "active") throw new Error("Akun belum siap untuk checkout.");
    accountId = account.identity;
  } else {
    const credentials = await VpsCredential.find({ tenantId: "platform", enabled: true }).sort({ priority: 1 }).lean();
    for (const c of credentials) {
      try {
        const candidate = await providerForCredential(c._id, c.accountId);
        const account = await candidate.account();
        if (account.identity === c.accountId && account.status === "active") { client = candidate; break; }
      } catch { /* No secrets or raw provider errors in checkout diagnostics. */ }
    }
  }
  if (!client) throw new Error("Akun VPS belum tersedia.");
  const selected = await client.validateSelection({ os: input.os, region: input.region, size: plan.sizeSlug });
  const password = generatePassword();
  try {
    const order = await VpsOrder.create({ _id: input.requestId, tenantId: "platform", buyerId: input.actorTelegramId, chatId: input.chatId,
      service: input.serviceType, accountId, createName: `bt-vps-${input.requestId}`,
      passwordEncrypted: encryptSecret(password, `platform:vps:password:${input.requestId}`),
      snapshot: { planId: plan._id, planName: plan.name, size: plan.sizeSlug, region: input.region, os: input.os, image: selected.os.image,
        price, vcpus: selected.size.vcpus, memory: selected.size.memory, disk: selected.size.disk },
    });
    if (input.serviceType === "install" && input.buyerSessionId && input.buyerSessionId !== input.requestId) {
      const token = buyerTokens.get(input.actorTelegramId, input.buyerSessionId);
      if (token) { buyerTokens.put(input.actorTelegramId, input.requestId, token.token, token.accountId); buyerTokens.delete(input.actorTelegramId, input.buyerSessionId); }
    }
    return orderDto(order.toObject());
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    const replay = await ownedOrder(input.actorTelegramId, input.requestId);
    if (!replay) throw new Error("Pesanan duplikat tidak dapat diakses.");
    return orderDto(replay);
  }
}
export async function requestVpsReboot(actor: string, orderId: string): Promise<{ status: string }> {
  assertVpsEnabled();
  const order = await ownedOrder(actor, orderId);
  if (!order || order.service !== "purchase" || !order.dropletId || order.paymentStatus !== "paid" || !["ready", "review"].includes(order.stage)) throw new Error("VPS tidak dapat direboot.");
  const changed = await VpsOrder.findOneAndUpdate({ _id: orderId, tenantId: "platform", buyerId: actor, service: "purchase", paymentStatus: "paid",
    rebootState: { $in: ["idle", "completed", "errored"] },
    $or: [{ rebootRequestedAt: null }, { rebootRequestedAt: { $lt: new Date(Date.now() - 60_000) } }],
  }, { $set: { rebootState: "requested", rebootActionId: null, rebootRequestedAt: new Date(), nextRunAt: new Date() } }, { returnDocument: "after" });
  return { status: changed ? "requested" : order.rebootState };
}
async function cancel(actor: string, orderId: string): Promise<void> {
  const order = await ownedOrder(actor, orderId);
  if (!order) throw new Error("Pesanan tidak ditemukan.");
  if (["cancelled", "refunded"].includes(order.paymentStatus)) { buyerTokens.delete(actor, orderId); return; }
  const cancelled = await VpsOrder.findOneAndUpdate({ _id: orderId, tenantId: "platform", buyerId: actor, paymentStatus: { $in: ["unpaid", "paid"] },
    createAttemptedAt: null, dropletId: null, stage: { $in: ["queued", "needs_token", "failed"] },
    $or: [{ lockUntil: null }, { lockUntil: { $lt: new Date() } }],
  }, { $set: { stage: "cancelled", ...(order.paymentStatus === "unpaid" ? { paymentStatus: "cancelled" } : {}), reservationActive: false } }, { returnDocument: "after" });
  if (!cancelled) throw new Error("Pembayaran/proses sudah berjalan; pembatalan belum dapat dilakukan.");
  buyerTokens.delete(actor, orderId);
  await releaseCapacityTicket(orderId);
  if (cancelled.paymentStatus === "paid") await refundVpsOrder(orderId, "cancelled_before_create");
}

export const vpsService: VpsUiDependencies = {
  enabled: vpsEnabled,
  listOs: () => Object.values(OS_CATALOG).map(os => ({ id: os.key, label: os.name })),
  async listPlans(serviceType, includeDisabled = false) {
    assertVpsPlatform();
    return (await VpsPlan.find({ tenantId: "platform", ...(serviceType ? { serviceType } : {}), ...(includeDisabled ? {} : { enabled: true }) }).sort({ name: 1, _id: 1 }).limit(200).lean()).map(planDto);
  },
  acceptBuyerToken,
  clearBuyerToken: (actor, orderId) => buyerTokens.delete(actor, orderId),
  checkout,
  async listOwned(actor, options) {
    assertVpsPlatform();
    return (await VpsOrder.find({ tenantId: "platform", buyerId: actor, ...(options.purchaseOnly ? { service: "purchase", dropletId: { $ne: null } } : {}) })
      .sort({ createdAt: -1, _id: 1 }).skip(Math.max(0, options.offset)).limit(Math.min(20, Math.max(1, options.limit))).lean()).map(orderDto);
  },
  async getOwned(actor, orderId) { const order = await ownedOrder(actor, orderId); return order ? orderDto(order) : null; },
  async credentials(actor, orderId) {
    const order = await ownedOrder(actor, orderId, true);
    if (!order?.publicIp || order.paymentStatus !== "paid") throw new Error("Akses VPS belum tersedia.");
    return { ip: order.publicIp, username: getOs(order.snapshot.os)?.family === "windows" ? "administrator" : "root",
      password: decryptSecret(order.passwordEncrypted, `platform:vps:password:${orderId}`), evidence: order.evidence };
  },
  async payBalance(actor, orderId) { assertVpsEnabled(); return payVpsFromBalance(orderId, actor); },
  async createInvoice(actor, orderId) {
    assertVpsEnabled();
    const result = await createVpsInvoice(orderId, actor);
    return { buffer: result.qris.buffer, amount: result.invoice.amount, expiresAt: result.invoice.expiresAt };
  },
  async checkPayment(actor, orderId) { return checkVpsPayment(orderId, actor); },
  cancel, reboot: requestVpsReboot,
  listCredentials, checkCredential, checkAllCredentials, addCredential,
  async getCredential(actor, id) { assertVpsAdmin(actor); const c = await VpsCredential.findOne({ _id: id, tenantId: "platform" }).lean(); return c ? credentialDto(c) : null; },
  async updateCredential(actor, id, input) {
    assertVpsAdmin(actor);
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10000)) throw new Error("Prioritas tidak valid.");
    await VpsCredential.updateOne({ _id: id, tenantId: "platform" }, { $set: { ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(input.priority === undefined ? {} : { priority: input.priority }) } });
  },
  async savePlan(actor, input) {
    assertVpsAdmin(actor);
    if (!input.name.trim() || input.name.length > 80 || !["purchase", "install"].includes(input.serviceType) || !/^[a-z0-9-]{1,80}$/.test(input.sizeSlug)
      || !input.regions.length || input.regions.length > 30 || input.regions.some(r => !/^[a-z0-9]{2,12}$/.test(r)) || !input.osPrices.length || input.osPrices.length > 24
      || new Set(input.osPrices.map(p => p.os)).size !== input.osPrices.length || input.osPrices.some(p => !getOs(p.os) || !Number.isSafeInteger(p.price) || p.price < 1 || p.price > 100_000_000)) throw new Error("Paket tidak valid.");
    const p = await VpsPlan.create({ _id: randomUUID(), tenantId: "platform", name: input.name.trim(), serviceType: input.serviceType, sizeSlug: input.sizeSlug,
      regions: [...new Set(input.regions)], enabled: input.enabled, osPrices: input.osPrices.map(p => ({ os: p.os, label: getOs(p.os)!.name, price: p.price })) });
    return planDto(p);
  },
  async updatePlan(actor, id, input) {
    assertVpsAdmin(actor);
    if (input.price !== undefined && (!Number.isSafeInteger(input.price) || input.price < 1 || input.price > 100_000_000)) throw new Error("Harga tidak valid.");
    const plan = await VpsPlan.findOne({ _id: id, tenantId: "platform" });
    if (!plan) throw new Error("Paket tidak ditemukan.");
    if (input.enabled !== undefined) plan.enabled = input.enabled;
    if (input.price !== undefined) for (const os of plan.osPrices) if (!input.os || input.os === os.os) os.price = input.price;
    await plan.save();
  },
};
