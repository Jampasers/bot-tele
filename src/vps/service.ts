import { isIP } from "node:net";
import { VpsOrder, type IVpsOrder } from "../models/VpsOrder.js";
import { VpsCredential } from "../models/VpsCredential.js";
import { VpsPlan } from "../models/VpsPlan.js";
import { VpsCatalog } from "../models/VpsCatalog.js";
import { encryptSecret, decryptSecret } from "../services/crypto.js";
import { DigitalOceanClient } from "./digitalOcean.js";
import { OS_CATALOG, getOs, generatePassword } from "./installer.js";
import { defaultVpsCatalog, getVpsCatalog } from "./catalog.js";
import { catalogPlans, mergeCatalogPrices, planPrice } from "./catalogPlans.js";
import { assertVpsAdmin, assertVpsEnabled, assertVpsPlatform, buyerTokens, vpsEnabled } from "./security.js";
import { addCredential, checkAllCredentials, checkCredential, credentialDto, listCredentials, providerForCredential, releaseCapacityTicket } from "./credentials.js";
import { payVpsFromBalance, createVpsInvoice, checkVpsPayment, refundVpsOrder } from "./payment.js";
import type { VpsUiDependencies, VpsUiOrder } from "../plugins/vps/contracts.js";

const validId = (id: string): boolean => /^[a-f0-9-]{36}$/.test(id);
export async function ownedOrder(actor: string, orderId: string, includeSecret = false): Promise<IVpsOrder | null> {
  assertVpsPlatform();
  if (!/^\d{1,20}$/.test(actor) || !validId(orderId)) throw new Error("Pesanan tidak ditemukan.");
  const q = VpsOrder.findOne({ _id: orderId, tenantId: "platform", buyerId: actor });
  if (includeSecret) q.select("+passwordEncrypted +sourcePasswordEncrypted");
  return q.lean();
}
export function orderDto(order: IVpsOrder): VpsUiOrder {
  return { _id: order._id, serviceType: order.service, sourceMode: order.service === "install" && order.sourceUsername ? "direct" : "digitalocean", paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, stage: order.stage,
    price: order.snapshot.price, planName: order.snapshot.planName, sizeSlug: order.snapshot.size, os: order.snapshot.os,
    region: order.snapshot.region, installChrome: order.snapshot.installChrome === true, ip: order.publicIp, dropletId: order.dropletId, needsToken: order.stage === "needs_token",
    evidence: order.evidence, createdAt: order.createdAt, vcpus: order.snapshot.vcpus, memory: order.snapshot.memory, disk: order.snapshot.disk,
    installerLogUrl: order.installerLogUrl };
}
export const vpsPlanPrice = planPrice;
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
  const catalog = await getVpsCatalog();
  const plan = await VpsPlan.findOne({ _id: input.planId, tenantId: "platform", serviceType: input.serviceType, enabled: true }).lean();
  const os = getOs(input.os);
  const price = plan ? vpsPlanPrice({ ...plan, osPrices: plan.osPrices.map(item => ({ ...item, price: item.price ?? null })) }, input.region, input.os) : undefined;
  if (!plan || !price || !plan.regions.includes(input.region) || !os) throw new Error("Paket, region, atau harga tidak tersedia.");
  if (plan.catalogManaged && (!catalog.sizes.some(size => size.slug === plan.sizeSlug)
    || !catalog.regions.some(region => region.slug === input.region) || !catalog.os.some(entry => entry.key === input.os))) throw new Error("Pilihan tidak ada dalam katalog.");
  if (input.installChrome === true && os.family !== "windows") throw new Error("Chrome hanya tersedia untuk Windows.");
  let accountId: string | null = null;
  let sourceUsername: string | null = null;
  let sourcePasswordEncrypted: string | null = null;
  let client: DigitalOceanClient | undefined;
  if (input.serviceType === "install" && input.direct) {
    if (getOs(input.os)?.family !== "windows" || !isIP(input.direct.ip) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(input.direct.username)
      || !input.direct.password || /[\r\n\0]/.test(input.direct.password) || input.direct.password.length > 256) throw new Error("Koneksi VPS atau OS Windows tidak valid.");
    sourceUsername = input.direct.username;
    sourcePasswordEncrypted = encryptSecret(input.direct.password, `platform:vps:source-password:${input.requestId}`);
  } else if (input.serviceType === "install") {
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
  if (input.serviceType === "purchase" && !client) throw new Error("Akun VPS belum tersedia.");
  const selected = client ? await client.validateSelection({ os: input.os, region: input.region, size: plan.sizeSlug }) : { os: { image: os.image }, size: { vcpus: 0, memory: 0, disk: 0 } };
  const password = generatePassword();
  try {
    const order = await VpsOrder.create({ _id: input.requestId, tenantId: "platform", buyerId: input.actorTelegramId, chatId: input.chatId,
      service: input.serviceType, accountId, sourceUsername, sourcePasswordEncrypted, publicIp: input.direct?.ip ?? null, createName: `bt-vps-${input.requestId}`,
      passwordEncrypted: encryptSecret(password, `platform:vps:password:${input.requestId}`),
      snapshot: { planId: plan._id, planName: plan.name, size: plan.sizeSlug, region: input.region, os: input.os, image: selected.os.image,
        price, vcpus: selected.size.vcpus, memory: selected.size.memory, disk: selected.size.disk, installChrome: input.installChrome === true },
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
  listOs: () => Object.values(OS_CATALOG).map(os => ({ id: os.key, label: os.name, family: os.family })),
  async listCatalog() {
    assertVpsPlatform();
    const catalog = await getVpsCatalog();
    return { regions: catalog.regions.map(region => ({ slug: region.slug, name: region.name, country: region.country })), sizes: catalog.sizes.map(size => ({ slug: size.slug, label: `${size.cpu} vCPU · ${size.ram} RAM (${size.disk})` })), os: catalog.os.map(os => ({ id: os.key, label: os.name, family: os.family as "linux" | "windows" })) };
  },
  async addCatalogEntry(actor, input) {
    assertVpsAdmin(actor);
    const catalog = await getVpsCatalog();
    if (input.value.some(value => !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value))) throw new Error("Entri katalog tidak valid.");
    if (input.kind === "region") {
      const [slug, name, country] = input.value;
      if (!slug || !name || !country || !/^[a-z][a-z0-9]{1,11}$/.test(slug) || /[\r\n\0]/.test(`${name}${country}`) || name.length > 80 || country.length > 80) throw new Error("Region tidak valid.");
      if (catalog.regions.some(item => item.slug === slug)) throw new Error("Region sudah terdaftar.");
      catalog.regions.push({ slug, name, country });
    } else if (input.kind === "size") {
      const [slug, cpuText, ram, disk, transfer, price] = input.value; const cpu = Number(cpuText);
      if (!slug || !ram || !disk || !transfer || !price || !Number.isInteger(cpu) || cpu < 1 || cpu > 128 || !/^[a-z0-9-]{1,80}$/.test(slug)) throw new Error("Spek tidak valid.");
      if (catalog.sizes.some(item => item.slug === slug)) throw new Error("Spek sudah terdaftar.");
      catalog.sizes.push({ slug, cpu, ram, disk, transfer, price });
    } else {
      const [key, name, slug, family, windowsImageName] = input.value;
      if (!key || !name || !slug || (family !== "linux" && family !== "windows") || !/^[a-z][a-z0-9_-]{1,31}$/.test(key) || !/^[a-z0-9-]{1,80}$/.test(slug) || (family === "windows" && !windowsImageName)) throw new Error("OS tidak valid.");
      if (catalog.os.some(item => item.key === key)) throw new Error("OS sudah terdaftar.");
      catalog.os.push({ key, name, slug, family, installerImage: family === "linux" ? slug : "ubuntu-24-04-x64", ...(family === "windows" ? { windowsImageName: windowsImageName! } : {}) });
    }
    const field = input.kind === "region" ? "regions" : input.kind === "size" ? "sizes" : "os";
    if (catalog[field].length > 60) throw new Error("Katalog mencapai batas 60 entri per jenis.");
    const entryKey = input.kind === "os" ? "key" : "slug";
    const entry = catalog[field].at(-1)!;
    await VpsCatalog.updateOne({ _id: "platform" }, { $setOnInsert: defaultVpsCatalog() }, { upsert: true, runValidators: true });
    const result = await VpsCatalog.updateOne({ _id: "platform", [`${field}.${entryKey}`]: { $ne: input.value[0] }, [`${field}.59`]: { $exists: false } },
      { $push: { [field]: entry } }, { runValidators: true });
    if (!result.modifiedCount) throw new Error("Entri sudah ada atau katalog berubah; buka ulang katalog.");
    await getVpsCatalog();
  },
  async listPlans(serviceType, includeDisabled = false) {
    assertVpsPlatform();
    const catalog = await getVpsCatalog();
    const saved = await VpsPlan.find({ tenantId: "platform", catalogManaged: true, ...(serviceType ? { serviceType } : {}) }).lean();
    return catalogPlans(catalog, serviceType).map(plan => mergeCatalogPrices(plan, saved.find(row => row._id === plan.id)))
      .filter(plan => includeDisabled || plan.enabled);
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
  async updatePlan(actor, id, input) {
    assertVpsAdmin(actor);
    if (input.price !== undefined && (!Number.isSafeInteger(input.price) || input.price < 1 || input.price > 100_000_000)) throw new Error("Harga tidak valid.");
    const plan = catalogPlans(await getVpsCatalog()).find(item => item.id === id);
    if (!plan || (input.price !== undefined && (!input.os || !input.region || !plan.regions.includes(input.region)
      || !plan.osPrices.some(os => os.os === input.os)))) throw new Error("Pilih spek, region, dan OS dari katalog.");
    const { id: planId, sizeLabel, regionLabels, providerPrice, transfer, ...fields } = plan;
    await VpsPlan.updateOne({ _id: planId, tenantId: "platform" }, { $setOnInsert: fields }, { upsert: true, runValidators: true });
    if (input.enabled !== undefined) await VpsPlan.updateOne({ _id: planId, tenantId: "platform" }, { $set: { enabled: input.enabled } });
    if (input.price !== undefined) {
      // Atomic replace-or-append prevents duplicate combination prices under concurrent admin edits.
      await VpsPlan.updateOne({ _id: planId, tenantId: "platform" }, [{ $set: {
        priceMatrix: { $concatArrays: [{ $filter: { input: { $ifNull: ["$priceMatrix", []] }, as: "entry",
          cond: { $not: [{ $and: [{ $eq: ["$$entry.region", input.region] }, { $eq: ["$$entry.os", input.os] }] }] } } },
          [{ region: input.region, os: input.os, price: input.price }]] },
        regions: { $literal: plan.regions }, osPrices: { $literal: plan.osPrices }, updatedAt: new Date(),
      } }], { updatePipeline: true });
    }
  },
};
