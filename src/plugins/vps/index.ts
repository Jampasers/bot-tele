import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { vpsService } from "../../vps/service.js";
import type { AvailabilityMap, VpsServiceType, VpsUiDependencies, VpsUiOrder, VpsUiPlan } from "./contracts.js";
import { clearVpsInput, setVpsInput } from "./input.js";
import { getOs } from "../../vps/installer.js";
import { DIRECT_INSTALL_PLAN_ID, planPrice } from "../../vps/catalogPlans.js";
import { formatRegion, formatSize, isVpsPlatform, vpsDate, vpsPrice, vpsReply } from "./ui.js";
import { DigitalOceanError } from "../../vps/digitalOcean.js";

interface Draft {
  id: string;
  serviceType: VpsServiceType;
  expiresAt: number;
  plans: VpsUiPlan[];
  accountId?: string;
  plan?: VpsUiPlan;
  os?: string;
  installChrome?: boolean;
  region?: string;
  order?: VpsUiOrder;
  checkout?: Promise<VpsUiOrder>;
  direct?: { ip: string; username: string; password: string };
  directMode?: boolean;
  availability?: AvailabilityMap;
}

function filterRegions(regions: string[], sizeSlug: string, availability?: AvailabilityMap): string[] {
  if (!availability) return regions;
  const supported = availability.get(sizeSlug);
  if (!supported) return [];
  return regions.filter(r => supported.has(r));
}

const baseHomeKeyboard = (): InlineKeyboard => new InlineKeyboard()
  .text("🛒 VPS DO", "vps_buy").text("🛠 Jasa install", "vps_install").row()
  .text("🖥️ VPS Saya", "vps_my_0").text("📋 Riwayat pesanan", "vps_history_0").row()
  .text("🔙 Catalog", "menu_catalog");
const homeKeyboard = (): InlineKeyboard => baseHomeKeyboard();
const serviceLabel = (service: VpsServiceType): string => service === "install" ? "Jasa install" : "VPS DO";
const feeNotice = "Pembayaran ke toko hanya biaya jasa install. Biaya DigitalOcean ditagihkan ke akun buyer dan menjadi tanggungan buyer.";
function pricedOs(plan: VpsUiPlan, region?: string, windowsOnly = false): VpsUiPlan["osPrices"] {
  return plan.osPrices.filter(os => !windowsOnly || (os.family ?? getOs(os.os)?.family) === "windows")
    .map(os => ({ ...os, price: region ? planPrice(plan, region, os.os) ?? null : os.price }));
}
const priceLabel = (price: number | null): string => price === null ? "Harga belum diatur" : vpsPrice(price);
const regionLabel = (plan: VpsUiPlan, region: string): string => plan.regionLabels?.[region] ?? formatRegion(region);
const sizeLabel = (plan: VpsUiPlan): string => plan.sizeLabel ?? `${plan.name} · ${formatSize(plan.sizeSlug)}`;

function validInstallerLogUrl(order: VpsUiOrder): string | null {
  if (!order.installerLogUrl || !order.ip) return null;
  try {
    const url = new URL(order.installerLogUrl);
    return ["http:", "https:"].includes(url.protocol) && url.hostname === order.ip && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function vpsOrderText(order: VpsUiOrder): string {
  const direct = order.serviceType === "install" && order.sourceMode === "direct";
  const chrome = order.installChrome ? "\nChrome: + Chrome (gratis)" : "";
  if (direct) {
    return `🛠️ Jasa Install Windows\n\nOrder: ${order._id}\nSumber: VPS milik buyer (Direct SSH)\nOS: ${order.os}${chrome}\nHarga jasa: ${vpsPrice(order.price)}\nPembayaran: ${order.paymentStatus}\nProses: ${order.stage}\nIP VPS: ${order.ip || "belum tersedia"}`
      + (order.evidence ? `\nHasil pemeriksaan: ${order.evidence}` : "");
  }
  return `🖥️ ${serviceLabel(order.serviceType)}\n\nOrder: ${order._id}\nPaket: ${order.planName}\nSpek: ${order.sizeSlug}\nOS: ${order.os}\nRegion: ${order.region}\n${order.serviceType === "install" ? "Harga jasa" : "Harga checkout"}: ${vpsPrice(order.price)}\nPembayaran: ${order.paymentStatus}\nProses: ${order.stage}\nIP publik: ${order.ip || "belum tersedia"}`
    + (order.vcpus !== undefined && order.memory !== undefined && order.disk !== undefined ? `\nCPU: ${order.vcpus} vCPU · RAM: ${order.memory} MB · Disk: ${order.disk} GB` : "")
    + (order.evidence ? `\nHasil pemeriksaan: ${order.evidence}` : "")
    + chrome
    + (order.needsToken || order.stage === "needs_token" ? "\n\nToken sementara tidak tersedia. Kirim ulang token akun/team yang sama untuk melanjutkan order ini." : "")
    + (order.serviceType === "install" ? `\n\n${feeNotice}` : "");
}

export function createVpsPlugin(overrides: Partial<VpsUiDependencies> = {}): Plugin {
  const deps: VpsUiDependencies = { ...vpsService, ...overrides };
  const drafts = new Map<string, Draft>();
  const actorOf = (ctx: Context): string => String(ctx.from!.id);

  function dropDraft(actor: string): void {
    const draft = drafts.get(actor);
    if (draft?.direct) draft.direct.password = "";
    if (draft && !draft.order && !draft.checkout) deps.clearBuyerToken(actor, draft.id);
    drafts.delete(actor);
  }
  function currentDraft(actor: string, id: string): Draft {
    const draft = drafts.get(actor);
    if (!draft || draft.id !== id || draft.expiresAt <= Date.now()) {
      if (draft?.expiresAt && draft.expiresAt <= Date.now()) dropDraft(actor);
      throw new Error("Expired VPS selection");
    }
    return draft;
  }
  function authorized(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
    return async ctx => {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      if (!ctx.from || !isVpsPlatform() || ctx.chat?.type !== "private") {
        if (ctx.chat) await ctx.reply("VPS hanya tersedia melalui chat pribadi bot utama.");
        return;
      }
      try { await handler(ctx); }
      catch (err) {
        const ref = randomUUID();
        if (err instanceof Error && err.message === "Expired VPS selection") {
          console.warn("[VPS_SESSION_EXPIRED]", ref);
          await ctx.reply(
            `Sesi VPS sudah kedaluwarsa atau pilihan tidak ditemukan. Buka /vps untuk memulai ulang.\n\nReferensi: ${ref} [VPS_SESSION_EXPIRED]`,
            { reply_markup: homeKeyboard() },
          ).catch(() => {});
        } else if (err instanceof DigitalOceanError) {
          const kindMap: Record<string, string> = {
            invalid_token: "Token DigitalOcean tidak valid atau sudah kedaluwarsa.",
            permission: "Izin token DigitalOcean tidak mencukupi untuk operasi ini.",
            rate_limit: "Batas request DigitalOcean tercapai. Coba beberapa saat lagi.",
            timeout: "Request ke DigitalOcean melewati batas waktu. Coba lagi.",
            network: "Koneksi ke DigitalOcean terputus. Periksa jaringan dan coba lagi.",
            api: "Respons API DigitalOcean tidak dapat dibaca. Coba lagi.",
            validation: "Spek atau region yang dipilih tidak tersedia di DigitalOcean. Coba pilih region atau spek VPS yang berbeda.",
            cancelled: "Pemeriksaan DigitalOcean dihentikan.",
          };
          const code = `VPS_DO_${err.kind.toUpperCase()}`;
          console.warn(`[${code}]`, ref, err.kind);
          const doKeyboard = err.kind === "validation"
            ? new InlineKeyboard().text("🛒 Coba VPS DO lain", "vps_buy").text("🛠 Jasa install", "vps_install").row().text("🔙 Menu VPS", "vps_home")
            : homeKeyboard();
          await ctx.reply(
            `${kindMap[err.kind] ?? "Layanan DigitalOcean tidak dapat diakses."}\n\nReferensi: ${ref} [${code}]`,
            { reply_markup: doKeyboard },
          ).catch(() => {});
        } else if (err instanceof Error && /^(Paket|Region|OS|Pilihan|Harga|Akun|Chrome|Koneksi|Input|Checkout|Token|Kirim ulang|Pemesanan VPS|VPS tidak)/.test(err.message)) {
          // Safe, user-facing error messages thrown explicitly from service/checkout logic.
          console.warn("[VPS_USER_ERROR]", ref, err.message);
          await ctx.reply(
            `${err.message}\n\nReferensi: ${ref}`,
            { reply_markup: homeKeyboard() },
          ).catch(() => {});
        } else {
          console.warn("[VPS_INTERNAL]", ref, err);
          await ctx.reply(
            `Permintaan VPS tidak dapat diproses saat ini. Buka detail pesanan untuk melihat status terakhir.\n\nReferensi: ${ref} [VPS_INTERNAL]`,
            { reply_markup: homeKeyboard() },
          ).catch(() => {});
        }
      }
    };
  }
  async function showHome(ctx: Context): Promise<void> {
    clearVpsInput(actorOf(ctx));
    dropDraft(actorOf(ctx));
    await vpsReply(ctx, `🖥️ VPS & Jasa Install\n\n• VPS DO: beli VPS dari akun toko.\n• Jasa Install: buat VPS dari akun DigitalOcean kamu atau install Windows ke VPS yang sudah kamu punya.\n\n${deps.enabled() ? "" : "Pemesanan baru sementara dinonaktifkan."}`, homeKeyboard());
  }
  async function choosePlan(ctx: Context, draft: Draft, offset = 0): Promise<void> {
    const keyboard = new InlineKeyboard();
    draft.plans.slice(offset, offset + 10).forEach((plan, index) => keyboard.text(sizeLabel(plan), `vps_plan_${draft.id}_${index + offset}`).row());
    if (offset) keyboard.text("← Sebelumnya", `vps_page_${draft.id}_${Math.max(0, offset - 10)}`);
    if (offset + 10 < draft.plans.length) keyboard.text("Berikutnya →", `vps_page_${draft.id}_${offset + 10}`);
    keyboard.row();
    keyboard.text("🔙 VPS", "vps_home");
    const notice = draft.directMode
      ? "Pembayaran ke toko hanya biaya instalasi Windows. VPS disediakan oleh buyer."
      : draft.serviceType === "install" ? feeNotice : "";
    const stepLabel = draft.directMode ? "Pilih spek VPS milik kamu (minimal 1 core, RAM 2 GB, storage 50 GB):" : draft.serviceType === "install" ? "(Langkah 2/5) Pilih spek VPS yang akan dibuat:" : "(Langkah 1/3) Pilih paket spek VPS:";
    await vpsReply(ctx, `${serviceLabel(draft.serviceType)}\n\n${draft.accountId ? `Akun/team: ${draft.accountId}\n\n` : ""}${draft.plans.length ? stepLabel : "Belum ada paket aktif. Hubungi admin."}${notice ? `\n\n${notice}` : ""}`, keyboard);
  }
  async function showInstallSources(ctx: Context): Promise<void> {
    clearVpsInput(actorOf(ctx));
    dropDraft(actorOf(ctx));
    await vpsReply(ctx, "🛠 Jasa Install\n\nPilih kondisi VPS kamu:\n\n🌊 DigitalOcean saya\nBot membuat VPS baru di akun/team DigitalOcean kamu. Biaya DigitalOcean tetap ditagihkan oleh DO ke akun kamu.\n\n🖥 VPS saya sudah ada\nInstall Windows langsung ke VPS milik kamu via SSH. Pilih spek sesuai VPS kamu; Windows memerlukan minimal 1 core, RAM 2 GB, dan storage 50 GB.", new InlineKeyboard()
      .text("🌊 Buat VPS di akun DO saya", "vps_install_do").row()
      .text("🖥 Install Windows di VPS saya", "vps_install_direct").row()
      .text("🔙 Kembali", "vps_home"));
  }
  async function showDirectOs(ctx: Context, draft: Draft, notice?: string): Promise<void> {
    if (!draft.plan) throw new Error("Paket install belum tersedia.");
    const options = pricedOs(draft.plan, "external", true);
    const keyboard = new InlineKeyboard();
    options.forEach((os, index) => keyboard.text(`${os.label} · ${os.price === null ? "Belum tersedia" : vpsPrice(os.price)}`, `vps_os_${draft.id}_${index}`).row());
    keyboard.text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
    await vpsReply(ctx, `🛠 Install Windows di VPS Buyer\n\n${notice ? `${notice}\n\n` : ""}(Langkah 2/6) Pilih Windows yang mau di-install.\nSpek: ${sizeLabel(draft.plan)}\nHarga di bawah adalah biaya jasa install saja. Pastikan spek VPS sesuai pilihan dan storage minimal 50 GB.`, keyboard);
  }

  async function beginDirectCredentials(ctx: Context, draft: Draft): Promise<void> {
    if (!draft.plan || !draft.os || !draft.directMode) throw new Error("Pilihan install belum lengkap.");
    const actor = actorOf(ctx);
    if (draft.direct) draft.direct.password = "";
    delete draft.direct;
    setVpsInput(actor, { secret: false, cancel: () => {}, receive: async (ipCtx, ip) => {
      const current = currentDraft(actor, draft.id);
      current.direct = { ip: ip.trim(), username: "", password: "" };
      setVpsInput(actor, { secret: false, cancel: () => {}, receive: async (usernameCtx, username) => {
        const active = currentDraft(actor, draft.id);
        if (!active.direct) throw new Error("Koneksi VPS belum tersedia.");
        active.direct.username = username.trim();
        setVpsInput(actor, { secret: true, cancel: () => {}, receive: async (passwordCtx, password) => {
          const ready = currentDraft(actor, draft.id);
          if (!ready.direct || !ready.plan || !ready.os) throw new Error("Koneksi VPS belum lengkap.");
          ready.direct.password = password;
          const selectedOs = pricedOs(ready.plan, "external", true).find(item => item.os === ready.os);
          if (!selectedOs) throw new Error("OS tidak tersedia.");
          await vpsReply(passwordCtx, `🛠 Install Windows di VPS Buyer\n\nOS: ${selectedOs.label}\nIP: ${ready.direct.ip}\nUsername SSH: ${ready.direct.username}\nHarga jasa: ${priceLabel(selectedOs.price)}\n\n(Langkah 6/6) Tambahkan Google Chrome? Gratis dan hanya dipasang jika dipilih.`, new InlineKeyboard()
            .text("Lanjut tanpa Chrome", `vps_chrome_${ready.id}_no`).row()
            .text("+ Chrome (Gratis)", `vps_chrome_${ready.id}_yes`).row()
            .text("🔙 Ganti OS", `vps_backos_${ready.id}`).text("Batal", "vps_home"));
        } });
        await usernameCtx.reply("(Langkah 5/6) Kirim password SSH VPS. Pesan akan dihapus otomatis.\n\nKetik /batal untuk membatalkan.");
      } });
      await ipCtx.reply("(Langkah 4/6) Kirim username SSH VPS, contoh: root atau ubuntu.\n\nKetik /batal untuk membatalkan.");
    } });
    await vpsReply(ctx, "🖥 Akses VPS Buyer\n\n(Langkah 3/6) Kirim IP VPS. VPS harus sedang online dan bisa diakses via SSH.\n\nCredential hanya dipakai untuk proses instalasi; pesan password akan dihapus otomatis.", new InlineKeyboard()
      .text("🔙 Ganti OS", `vps_backos_${draft.id}`).text("Batal", "vps_home"));
  }

  async function start(ctx: Context, serviceType: VpsServiceType, direct = false): Promise<void> {
    if (!deps.enabled()) { await ctx.reply("Pemesanan VPS belum diaktifkan oleh admin.", { reply_markup: homeKeyboard() }); return; }
    const actor = actorOf(ctx);
    clearVpsInput(actor);
    dropDraft(actor);
    for (const [owner, draft] of drafts) if (draft.expiresAt <= Date.now()) dropDraft(owner);
    const listedPlans = await deps.listPlans(serviceType);
    const plans = serviceType === "install"
      ? listedPlans.filter(plan => direct ? plan.sourceMode === "direct" : plan.sourceMode !== "direct" && plan.id !== DIRECT_INSTALL_PLAN_ID)
      : listedPlans;
    const draft: Draft = { id: randomUUID(), serviceType, expiresAt: Date.now() + 15 * 60_000, plans, ...(direct ? { directMode: true } : {}) };
    drafts.set(actor, draft);

    if (direct) {
      const plan = plans[0];
      if (!plan) {
        await vpsReply(ctx, "Jasa install Windows untuk VPS buyer belum tersedia. Hubungi admin.", new InlineKeyboard().text("🔙 Jasa Install", "vps_install").text("🔙 VPS", "vps_home"));
        return;
      }
      await choosePlan(ctx, draft);
      return;
    }

    if (serviceType === "purchase") {
      const avail = await deps.fetchPlatformAvailability?.().catch(() => null);
      if (avail) draft.availability = avail;
      await choosePlan(ctx, draft);
      return;
    }

    setVpsInput(actor, {
      secret: true,
      cancel: () => dropDraft(actor),
      receive: async (inputCtx, token) => {
        const current = currentDraft(actor, draft.id);
        current.accountId = (await deps.acceptBuyerToken(actor, current.id, token.trim())).accountId;
        if (drafts.get(actor) !== current) { deps.clearBuyerToken(actor, current.id); return; }
        const avail = await deps.fetchBuyerAvailability?.(actor, current.id).catch(() => null);
        if (avail) current.availability = avail;
        await choosePlan(inputCtx, current);
      },
    });
    await vpsReply(ctx, `🛠 Jasa Install · DigitalOcean Buyer\n\n${feeNotice}\n\n(Langkah 1/5) Kirim token DigitalOcean di chat pribadi ini. Pesan harus berhasil dihapus sebelum token divalidasi. Token hanya disimpan sementara di memori; jika sesi habis atau bot restart, kirim ulang token akun/team yang sama.\n\nKetik /batal untuk membatalkan.`, new InlineKeyboard().text("Batal", "vps_home"));
  }
  async function showOrder(ctx: Context, orderId: string): Promise<void> {
    const order = await deps.getOwned(actorOf(ctx), orderId);
    if (!order) { await ctx.reply("Pesanan tidak ditemukan.", { reply_markup: homeKeyboard() }); return; }
    const keyboard = new InlineKeyboard().text("🔄 Perbarui status", `vps_order_${order._id}`).row();
    if (["unpaid", "paying"].includes(order.paymentStatus)) {
      if (order.paymentMethod !== "qris") keyboard.text("💳 Bayar saldo", `vps_balance_${order._id}`);
      if (order.paymentMethod !== "balance") keyboard.text("📱 Bayar QRIS", `vps_qris_${order._id}`);
      keyboard.row();
      if (order.paymentStatus === "paying") keyboard.text("🔎 Cek pembayaran", `vps_check_${order._id}`).row();
    }
    if (order.paymentStatus === "unpaid" || (order.paymentStatus === "paid" && !order.dropletId && ["queued", "needs_token", "failed"].includes(order.stage))) keyboard.text("Batalkan pesanan", `vps_cancel_${order._id}`).row();
    if (order.serviceType === "install" && order.sourceMode !== "direct" && !["ready", "failed", "cancelled"].includes(order.stage)) keyboard.text("🔑 Kirim ulang token", `vps_token_${order._id}`).row();
    if (order.paymentStatus === "paid" && order.ip && (order.dropletId || order.sourceMode === "direct")) keyboard.text("🔐 Lihat akses VPS", `vps_access_${order._id}`).row();
    const installerLogUrl = validInstallerLogUrl(order);
    if (installerLogUrl) keyboard.url("📄 Log installer", installerLogUrl).row();
    if (order.serviceType === "purchase" && order.dropletId && order.paymentStatus === "paid" && ["ready", "review"].includes(order.stage)) keyboard.text("🔄 Reboot/Restart", `vps_reboot_${order._id}`).row();
    keyboard.text("📋 Riwayat", "vps_history_0").text("🔙 VPS", "vps_home");
    await vpsReply(ctx, vpsOrderText(order), keyboard);
  }
  async function checkout(ctx: Context, draft: Draft): Promise<void> {
    if (!draft.plan || !draft.os || !draft.region) throw new Error("Incomplete selection");
    if (!planPrice(draft.plan, draft.region, draft.os)) {
      await vpsReply(ctx, draft.directMode
        ? "Harga jasa untuk OS ini belum diatur admin. Belum ada tagihan yang dibuat."
        : "Harga untuk kombinasi spek, region, dan OS ini belum diatur admin. Belum ada tagihan yang dibuat.",
        new InlineKeyboard().text("Ganti OS", `vps_backos_${draft.id}`).text("Kembali", "vps_home"));
      return;
    }
    const actor = actorOf(ctx);
    if (!draft.order) {
      draft.checkout ??= deps.checkout({ actorTelegramId: actor, chatId: String(ctx.chat!.id), requestId: draft.id, serviceType: draft.serviceType, planId: draft.plan.id, os: draft.os, region: draft.region, installChrome: draft.installChrome === true, ...(draft.serviceType === "install" && !draft.directMode ? { buyerSessionId: draft.id } : {}), ...(draft.direct ? { direct: { ...draft.direct } } : {}) });
      try {
        draft.order = await draft.checkout;
        // Only clear password after a confirmed successful checkout, so retries still work.
        if (draft.direct) draft.direct.password = "";
      } catch (err) {
        delete draft.checkout;
        if (err instanceof DigitalOceanError && err.kind === "validation") {
          // Surface region/size incompatibility with actionable buttons to fix selection.
          const planName = draft.plan.sizeLabel ?? draft.plan.name;
          const regionName = draft.plan.regionLabels?.[draft.region] ?? formatRegion(draft.region);
          await vpsReply(ctx,
            `❌ Spek atau region tidak tersedia di DigitalOcean.\n\n📦 Spek: ${planName}\n📍 Region: ${regionName}\n\nKombinasi ini tidak didukung oleh DigitalOcean. Silakan pilih region atau spek yang berbeda.`,
            new InlineKeyboard()
              .text("🗺 Ganti Region", `vps_backregion_${draft.id}`).row()
              .text("📦 Ganti Spek", `vps_page_${draft.id}_0`).row()
              .text("🔙 Menu VPS", "vps_home"),
          );
          return;
        }
        throw err;
      }
    }
    await showOrder(ctx, draft.order._id);
  }

  return {
    name: "vps", version: "1.0.0", internalOnly: true,
    commands: [{ command: "vps", description: "VPS DigitalOcean, setup dan pesanan saya" }],
    register(bot: Bot<Context>): void {
      bot.command("vps", authorized(showHome));
      bot.callbackQuery(/^vps_/, authorized(async ctx => {
        const data = ctx.callbackQuery!.data!;
        const actor = actorOf(ctx);
        clearVpsInput(actor);
        if (data === "vps_home") { await showHome(ctx); return; }
        if (data === "vps_buy") { await start(ctx, "purchase"); return; }
        if (data === "vps_install") { await showInstallSources(ctx); return; }
        if (data === "vps_install_do") { await start(ctx, "install"); return; }
        if (data === "vps_install_direct") { await start(ctx, "install", true); return; }
        const page = /^vps_page_([a-f0-9-]{36})_(\d{1,3})$/.exec(data);
        if (page) { await choosePlan(ctx, currentDraft(actor, page[1]!), Number(page[2])); return; }
        const backRegion = /^vps_backregion_([a-f0-9-]{36})$/.exec(data);
        if (backRegion) {
          const draft = currentDraft(actor, backRegion[1]!);
          if (!draft.plan) throw new Error("Unknown plan");
          delete draft.region; delete draft.os;
          const regions = filterRegions(draft.plan.regions, draft.plan.sizeSlug, draft.availability);
          if (!regions.length) {
            await vpsReply(ctx, `❌ Spek ${sizeLabel(draft.plan)} tidak tersedia di region mana pun untuk akun Anda.\n\nSilakan pilih spek lain.`,
              new InlineKeyboard().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home"));
            return;
          }
          const keyboard = new InlineKeyboard();
          draft.plan.regions.forEach((region, i) => {
            if (regions.includes(region)) {
              keyboard.text(regionLabel(draft.plan!, region), `vps_region_${draft.id}_${i}`).row();
            }
          });
          keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
          await vpsReply(ctx, `🖥️ ${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\n\n${draft.serviceType === "install" ? "(Langkah 3/5)" : "(Langkah 2/3)"} Pilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
          return;
        }
        const selection = /^vps_(plan|os|region)_([a-f0-9-]{36})_(\d{1,3})$/.exec(data);
        if (selection) {
          const draft = currentDraft(actor, selection[2]!);
          const index = Number(selection[3]);
          if (selection[1] === "plan") {
            const plan = draft.plans[index];
            if (!plan) throw new Error("Unknown plan");
            draft.plan = plan;
            delete draft.region; delete draft.os;
            if (draft.directMode) {
              draft.region = "external";
              await showDirectOs(ctx, draft);
              return;
            }
            const regions = filterRegions(plan.regions, plan.sizeSlug, draft.availability);
            if (!regions.length) {
              await vpsReply(ctx, `❌ Spek ${sizeLabel(plan)} tidak tersedia di region mana pun untuk akun Anda.\n\nSilakan pilih spek lain.`,
                new InlineKeyboard().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home"));
              return;
            }
            const keyboard = new InlineKeyboard();
            plan.regions.forEach((region, i) => {
              if (regions.includes(region)) {
                keyboard.text(regionLabel(plan, region), `vps_region_${draft.id}_${i}`).row();
              }
            });
            keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
            await vpsReply(ctx, `🖥️ ${sizeLabel(plan)}${plan.transfer ? `\nTransfer: ${plan.transfer}` : ""}${plan.providerPrice ? `\nBiaya dasar DigitalOcean: ${plan.providerPrice}` : ""}\n\n${draft.serviceType === "install" ? "(Langkah 3/5)" : "(Langkah 2/3)"} Pilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
          } else if (selection[1] === "region") {
            const region = draft.plan?.regions[index];
            if (!region || !draft.plan) throw new Error("Unknown region");
            draft.region = region;
            if (draft.os) {
              await checkout(ctx, draft);
              return;
            }
            delete draft.os;
            const keyboard = new InlineKeyboard();
            pricedOs(draft.plan, region, Boolean(draft.directMode)).forEach((os, i) => keyboard.text(`${os.label} · ${priceLabel(os.price)}`, `vps_os_${draft.id}_${i}`).row());
            keyboard.row().text("🔙 Ganti Region", `vps_backregion_${draft.id}`).text("Batal", "vps_home");
            await vpsReply(ctx, `🖥️ ${sizeLabel(draft.plan)}\n📍 Lokasi: ${regionLabel(draft.plan, region)}\n\n${draft.serviceType === "install" ? "(Langkah 4/5)" : "(Langkah 3/3)"} Pilih Sistem Operasi (OS):${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
          } else {
            const os = draft.plan ? pricedOs(draft.plan, draft.region, Boolean(draft.directMode))[index] : undefined;
            if (!os || !draft.plan) throw new Error("Unknown OS");
            if (os.price === null) {
              if (draft.directMode) {
                await showDirectOs(ctx, draft, `❌ ${os.label} belum tersedia karena harga jasa belum diatur.`);
              } else {
                await vpsReply(ctx, `❌ ${os.label} belum tersedia karena harga belum diatur untuk pilihan ini.\n\nPilih OS lain.`,
                  new InlineKeyboard().text("🔙 Pilih OS lain", `vps_backos_${draft.id}`).text("Batal", "vps_home"));
              }
              return;
            }
            draft.os = os.os;
            if (draft.directMode) {
              await beginDirectCredentials(ctx, draft);
              return;
            }
            if (!draft.region) {
              const regions = filterRegions(draft.plan.regions, draft.plan.sizeSlug, draft.availability);
              const keyboard = new InlineKeyboard();
              draft.plan.regions.forEach((region, i) => {
                if (regions.includes(region)) {
                  keyboard.text(regionLabel(draft.plan!, region), `vps_region_${draft.id}_${i}`).row();
                }
              });
              keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
              await vpsReply(ctx, `${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\nOS: ${os.label}\n\nPilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
              return;
            }
            if ((os.family ?? getOs(os.os)?.family) === "windows") {
              const keyboard = new InlineKeyboard()
                .text("Lanjut tanpa Chrome", `vps_chrome_${draft.id}_no`).row()
                .text("+ Chrome (Gratis)", `vps_chrome_${draft.id}_yes`).row()
                .text("🔙 Ganti OS", `vps_backos_${draft.id}`).text("Batal", "vps_home");
              await vpsReply(ctx, `${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\nOS: ${os.label}\n📍 Lokasi: ${formatRegion(draft.region)}\n\n${draft.serviceType === "install" ? "(Langkah 5/5) " : ""}Tambahkan Google Chrome? Gratis dan hanya dipasang jika dipilih.`, keyboard);
            } else {
              draft.installChrome = false;
              await checkout(ctx, draft);
            }
          }
          return;
        }
        const backOs = /^vps_backos_([a-f0-9-]{36})$/.exec(data);
        if (backOs) {
          const draft = currentDraft(actor, backOs[1]!);
          if (!draft.plan || !draft.region) throw new Error("Unknown selection");
          if (draft.direct) draft.direct.password = "";
          delete draft.direct; delete draft.os; delete draft.installChrome;
          if (draft.directMode) {
            await showDirectOs(ctx, draft);
            return;
          }
          const keyboard = new InlineKeyboard();
          pricedOs(draft.plan, draft.region, false).forEach((os, i) => keyboard.text(`${os.label} · ${priceLabel(os.price)}`, `vps_os_${draft.id}_${i}`).row());
          keyboard.row().text("🔙 Ganti Region", `vps_backregion_${draft.id}`).text("Batal", "vps_home");
          await vpsReply(ctx, `${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\n📍 Lokasi: ${formatRegion(draft.region)}\n\nPilih Sistem Operasi (OS):`, keyboard);
          return;
        }
        const chrome = /^vps_chrome_([a-f0-9-]{36})_(yes|no)$/.exec(data);
        if (chrome) {
          const draft = currentDraft(actor, chrome[1]!);
          if (!draft.plan || !draft.os || !draft.region || (draft.plan.osPrices.find(os => os.os === draft.os)?.family ?? getOs(draft.os)?.family) !== "windows") throw new Error("Invalid Chrome selection");
          draft.installChrome = chrome[2] === "yes";
          await checkout(ctx, draft);
          return;
        }
        const list = /^vps_(my|history)_(\d{1,6})$/.exec(data);
        if (list) {
          const offset = Number(list[2]);
          const purchaseOnly = list[1] === "my";
          const orders = await deps.listOwned(actor, { purchaseOnly, offset, limit: 10 });
          const keyboard = new InlineKeyboard();
          orders.forEach(order => keyboard.text(`${order.planName} · ${order.stage}`, `vps_order_${order._id}`).row());
          if (offset > 0) keyboard.text("← Sebelumnya", `vps_${list[1]}_${Math.max(0, offset - 10)}`);
          if (orders.length === 10) keyboard.text("Berikutnya →", `vps_${list[1]}_${offset + 10}`);
          keyboard.row().text("🔙 VPS", "vps_home");
          await vpsReply(ctx, `${purchaseOnly ? "🖥️ VPS Saya · token toko" : "📋 Riwayat pembelian & jasa install"}\n\n${orders.length ? "Pilih pesanan untuk melihat detail dan status." : "Belum ada pesanan pada halaman ini."}`, keyboard);
          return;
        }
        const action = /^vps_(order|balance|qris|check|cancel|canceldo|token|access|reboot|restart)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (!action) { await showHome(ctx); return; }
        const orderId = action[2]!;
        if (action[1] === "order") { await showOrder(ctx, orderId); return; }
        if (action[1] === "balance") {
          const result = await deps.payBalance(actor, orderId);
          const message = await ctx.reply(result.status === "paid" ? "Pembayaran saldo terkonfirmasi. Pesanan diproses di background." : result.status === "insufficient"
            ? result.methodLocked === false ? "Saldo belum cukup. Top up saldo atau pilih QRIS pada order ini." : "Saldo belum cukup. Top up saldo lalu bayar kembali pada order ini. Metode pembayaran yang sudah dipilih tetap digunakan agar pembayaran tidak ganda."
            : "Status pembayaran belum final. Periksa detail pesanan.");
          if (result.status === "paid") await deps.setStatusMessage?.(actor, orderId, message.message_id);
        } else if (action[1] === "qris") {
          const invoice = await deps.createInvoice(actor, orderId);
          await ctx.replyWithPhoto(new InputFile(invoice.buffer, "vps-qris.png"), { caption: `Pembayaran VPS\nOrder: ${orderId}\nTotal: ${vpsPrice(invoice.amount)}\nBerlaku sampai: ${vpsDate(invoice.expiresAt)}\n\nBayar tepat sesuai nominal. Pembayaran diperiksa otomatis.`, reply_markup: new InlineKeyboard().text("Cek pembayaran", `vps_check_${orderId}`).row().text("Detail pesanan", `vps_order_${orderId}`) });
          return;
        } else if (action[1] === "check") {
          const result = await deps.checkPayment(actor, orderId);
          const message = await ctx.reply(result.status === "paid" ? "Pembayaran terkonfirmasi. Pesanan diproses di background." : result.status === "expired" ? "Invoice kedaluwarsa. Periksa status order sebelum membuat pembayaran baru." : "Pembayaran belum terkonfirmasi; pemeriksaan otomatis tetap berjalan.");
          if (result.status === "paid") await deps.setStatusMessage?.(actor, orderId, message.message_id);
        } else if (action[1] === "cancel") {
          const order = await deps.getOwned(actor, orderId);
          if (!order) throw new Error("Order unavailable");
          await vpsReply(ctx, `Batalkan pesanan ${orderId}?\n\n${order.paymentStatus === "paid" ? "Pembatalan dan refund hanya dapat diproses jika droplet belum dibuat dan pesanan memenuhi syarat pembatalan." : "Pesanan yang belum dibayar akan dibatalkan."}`, new InlineKeyboard().text("Ya, batalkan", `vps_canceldo_${orderId}`).row().text("Kembali", `vps_order_${orderId}`));
          return;
        } else if (action[1] === "canceldo") {
          await deps.cancel(actor, orderId);
          deps.clearBuyerToken(actor, orderId);
          await ctx.reply("Pembatalan diproses. Lihat status pembayaran/refund pada detail pesanan.");
        } else if (action[1] === "token") {
          const order = await deps.getOwned(actor, orderId);
          if (!order || order.serviceType !== "install") throw new Error("Order unavailable");
          setVpsInput(actor, { secret: true, receive: async (inputCtx, token) => {
            await deps.acceptBuyerToken(actor, orderId, token.trim());
            await inputCtx.reply("Token akun/team sesuai. Pemrosesan dilanjutkan pada order dan droplet yang sama.");
            await showOrder(inputCtx, orderId);
          } });
          await vpsReply(ctx, `Kirim ulang token DigitalOcean untuk order ${orderId}. Gunakan akun/team yang sama. Pesan dihapus sebelum token divalidasi.\n\nKetik /batal untuk membatalkan input.`, new InlineKeyboard().text("Kembali", `vps_order_${orderId}`));
          return;
        } else if (action[1] === "access") {
          const access = await deps.credentials(actor, orderId);
          await ctx.reply(`🔐 Akses VPS\nIP: ${access.ip}\nUsername: ${access.username}\nPassword: ${access.password}\n\n${access.evidence}`);
          return;
        } else if (action[1] === "reboot") {
          const order = await deps.getOwned(actor, orderId);
          if (!order || order.serviceType !== "purchase" || !order.dropletId || !["ready", "review"].includes(order.stage)) throw new Error("Order unavailable");
          await vpsReply(ctx, `🔄 Konfirmasi Reboot/Restart\n\n${order.planName}\nIP: ${order.ip || "belum tersedia"}\nOS: ${order.os}\n\nKoneksi VPS akan terputus sementara. Jalankan reboot?`, new InlineKeyboard().text("Ya, reboot", `vps_restart_${orderId}`).row().text("Batal", `vps_order_${orderId}`));
          return;
        } else if (action[1] === "restart") {
          await deps.reboot(actor, orderId);
          await ctx.reply("Permintaan reboot dicatat. Status aksi DigitalOcean dipantau di background; buka detail pesanan untuk hasilnya.");
        }
        await showOrder(ctx, orderId);
      }));
    },
  };
}
export default createVpsPlugin();
