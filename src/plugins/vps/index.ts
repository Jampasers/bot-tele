import { randomUUID } from "node:crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { vpsService } from "../../vps/service.js";
import type { VpsServiceType, VpsUiDependencies, VpsUiOrder, VpsUiPlan } from "./contracts.js";
import { clearVpsInput, setVpsInput } from "./input.js";
import { formatRegion, formatSize, isVpsPlatform, vpsDate, vpsPrice, vpsReply } from "./ui.js";

interface Draft {
  id: string;
  serviceType: VpsServiceType;
  expiresAt: number;
  plans: VpsUiPlan[];
  accountId?: string;
  plan?: VpsUiPlan;
  os?: string;
  region?: string;
  order?: VpsUiOrder;
  checkout?: Promise<VpsUiOrder>;
}
const homeKeyboard = (): InlineKeyboard => new InlineKeyboard()
  .text("🛒 Beli VPS", "vps_buy").text("🛠 Jasa setup/install", "vps_install").row()
  .text("🖥️ VPS Saya", "vps_my_0").text("📋 Riwayat pesanan", "vps_history_0").row()
  .text("🔙 Catalog", "menu_catalog");
const serviceLabel = (service: VpsServiceType): string => service === "install" ? "Jasa setup/install" : "Beli VPS";
const feeNotice = "Pembayaran ke toko hanya biaya jasa setup/install. Biaya DigitalOcean ditagihkan ke akun buyer dan menjadi tanggungan buyer.";

function validInstallerLogUrl(order: VpsUiOrder): string | null {
  if (!order.installerLogUrl || !order.ip) return null;
  try {
    const url = new URL(order.installerLogUrl);
    return ["http:", "https:"].includes(url.protocol) && url.hostname === order.ip && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function vpsOrderText(order: VpsUiOrder): string {
  return `🖥️ ${serviceLabel(order.serviceType)}\n\nOrder: ${order._id}\nPaket: ${order.planName}\nSpek: ${order.sizeSlug}\nOS: ${order.os}\nRegion: ${order.region}\nHarga checkout: ${vpsPrice(order.price)}\nPembayaran: ${order.paymentStatus}\nProses: ${order.stage}\nIP publik: ${order.ip || "belum tersedia"}`
    + (order.vcpus !== undefined && order.memory !== undefined && order.disk !== undefined ? `\nCPU: ${order.vcpus} vCPU · RAM: ${order.memory} MB · Disk: ${order.disk} GB` : "")
    + (order.evidence ? `\nHasil pemeriksaan: ${order.evidence}` : "")
    + (order.needsToken || order.stage === "needs_token" ? "\n\nToken sementara tidak tersedia. Kirim ulang token akun/team yang sama untuk melanjutkan order ini." : "")
    + (order.serviceType === "install" ? `\n\n${feeNotice}` : "");
}

export function createVpsPlugin(overrides: Partial<VpsUiDependencies> = {}): Plugin {
  const deps: VpsUiDependencies = { ...vpsService, ...overrides };
  const drafts = new Map<string, Draft>();
  const actorOf = (ctx: Context): string => String(ctx.from!.id);

  function dropDraft(actor: string): void {
    const draft = drafts.get(actor);
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
      catch { await ctx.reply("Permintaan VPS belum dapat diproses. Pilihan mungkin kedaluwarsa atau layanan sedang sibuk. Buka detail pesanan untuk melihat status terakhir.", { reply_markup: homeKeyboard() }).catch(() => {}); }
    };
  }
  async function showHome(ctx: Context): Promise<void> {
    clearVpsInput(actorOf(ctx));
    dropDraft(actorOf(ctx));
    await vpsReply(ctx, `🖥️ VPS DigitalOcean\n\nBeli VPS memakai akun toko atau gunakan jasa setup/install pada akun DigitalOcean milikmu.\n\n${feeNotice}${deps.enabled() ? "" : "\n\nPemesanan baru sementara dinonaktifkan."}`, homeKeyboard());
  }
  async function choosePlan(ctx: Context, draft: Draft, offset = 0): Promise<void> {
    const keyboard = new InlineKeyboard();
    draft.plans.slice(offset, offset + 10).forEach((plan, index) => keyboard.text(`${plan.name} · ${formatSize(plan.sizeSlug)}`, `vps_plan_${draft.id}_${index + offset}`).row());
    if (offset) keyboard.text("← Sebelumnya", `vps_page_${draft.id}_${Math.max(0, offset - 10)}`);
    if (offset + 10 < draft.plans.length) keyboard.text("Berikutnya →", `vps_page_${draft.id}_${offset + 10}`);
    keyboard.row();
    keyboard.text("🔙 VPS", "vps_home");
    await vpsReply(ctx, `${serviceLabel(draft.serviceType)}\n\n${draft.accountId ? `Akun/team: ${draft.accountId}\n\n` : ""}${draft.plans.length ? "(Langkah 1/3) Pilih paket spek VPS:" : "Belum ada paket aktif. Hubungi admin."}${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
  }
  async function start(ctx: Context, serviceType: VpsServiceType): Promise<void> {
    if (!deps.enabled()) { await ctx.reply("Pemesanan VPS belum diaktifkan oleh admin.", { reply_markup: homeKeyboard() }); return; }
    const actor = actorOf(ctx);
    clearVpsInput(actor);
    dropDraft(actor);
    for (const [owner, draft] of drafts) if (draft.expiresAt <= Date.now()) dropDraft(owner);
    const draft: Draft = { id: randomUUID(), serviceType, expiresAt: Date.now() + 15 * 60_000, plans: await deps.listPlans(serviceType) };
    drafts.set(actor, draft);
    if (serviceType === "purchase") { await choosePlan(ctx, draft); return; }
    setVpsInput(actor, {
      secret: true,
      cancel: () => dropDraft(actor),
      receive: async (inputCtx, token) => {
        const current = currentDraft(actor, draft.id);
        current.accountId = (await deps.acceptBuyerToken(actor, current.id, token.trim())).accountId;
        if (drafts.get(actor) !== current) { deps.clearBuyerToken(actor, current.id); return; }
        await choosePlan(inputCtx, current);
      },
    });
    await vpsReply(ctx, `🛠 Jasa setup/install\n\n${feeNotice}\n\nKirim token DigitalOcean di chat pribadi ini. Pesan harus berhasil dihapus sebelum token divalidasi. Token hanya disimpan sementara di memori; jika sesi habis atau bot restart, kirim ulang token akun/team yang sama.\n\nKetik /batal untuk membatalkan.`, new InlineKeyboard().text("Batal", "vps_home"));
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
    if (order.serviceType === "install" && !["ready", "failed", "cancelled"].includes(order.stage)) keyboard.text("🔑 Kirim ulang token", `vps_token_${order._id}`).row();
    if (order.ip && order.dropletId) keyboard.text("🔐 Lihat akses VPS", `vps_access_${order._id}`).row();
    const installerLogUrl = validInstallerLogUrl(order);
    if (installerLogUrl) keyboard.url("📄 Log installer", installerLogUrl).row();
    if (order.serviceType === "purchase" && order.dropletId && order.paymentStatus === "paid" && ["ready", "review"].includes(order.stage)) keyboard.text("🔄 Reboot/Restart", `vps_reboot_${order._id}`).row();
    keyboard.text("📋 Riwayat", "vps_history_0").text("🔙 VPS", "vps_home");
    await vpsReply(ctx, vpsOrderText(order), keyboard);
  }
  async function checkout(ctx: Context, draft: Draft): Promise<void> {
    if (!draft.plan || !draft.os || !draft.region) throw new Error("Incomplete selection");
    const actor = actorOf(ctx);
    if (!draft.order) {
      draft.checkout ??= deps.checkout({ actorTelegramId: actor, chatId: String(ctx.chat!.id), requestId: draft.id, serviceType: draft.serviceType, planId: draft.plan.id, os: draft.os, region: draft.region, ...(draft.serviceType === "install" ? { buyerSessionId: draft.id } : {}) });
      try { draft.order = await draft.checkout; }
      finally { delete draft.checkout; }
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
        if (data === "vps_buy" || data === "vps_install") { await start(ctx, data === "vps_buy" ? "purchase" : "install"); return; }
        const page = /^vps_page_([a-f0-9-]{36})_(\d{1,3})$/.exec(data);
        if (page) { await choosePlan(ctx, currentDraft(actor, page[1]!), Number(page[2])); return; }
        const backRegion = /^vps_backregion_([a-f0-9-]{36})$/.exec(data);
        if (backRegion) {
          const draft = currentDraft(actor, backRegion[1]!);
          if (!draft.plan) throw new Error("Unknown plan");
          delete draft.region; delete draft.os;
          const keyboard = new InlineKeyboard();
          draft.plan.regions.forEach((region, i) => keyboard.text(formatRegion(region), `vps_region_${draft.id}_${i}`).row());
          keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
          await vpsReply(ctx, `🖥️ ${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\n\n(Langkah 2/3) Pilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
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
            const keyboard = new InlineKeyboard();
            plan.regions.forEach((region, i) => keyboard.text(formatRegion(region), `vps_region_${draft.id}_${i}`).row());
            keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
            await vpsReply(ctx, `🖥️ ${plan.name} · ${formatSize(plan.sizeSlug)}\n\n(Langkah 2/3) Pilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
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
            draft.plan.osPrices.forEach((os, i) => keyboard.text(`${os.label} · ${vpsPrice(os.price)}`, `vps_os_${draft.id}_${i}`).row());
            keyboard.row().text("🔙 Ganti Region", `vps_backregion_${draft.id}`).text("Batal", "vps_home");
            await vpsReply(ctx, `🖥️ ${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\n📍 Lokasi: ${formatRegion(region)}\n\n(Langkah 3/3) Pilih Sistem Operasi (OS):${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
          } else {
            const os = draft.plan?.osPrices[index];
            if (!os || !draft.plan) throw new Error("Unknown OS");
            draft.os = os.os;
            if (!draft.region) {
              const keyboard = new InlineKeyboard();
              draft.plan.regions.forEach((region, i) => keyboard.text(formatRegion(region), `vps_region_${draft.id}_${i}`).row());
              keyboard.row().text("🔙 Ganti Spek", `vps_page_${draft.id}_0`).text("Batal", "vps_home");
              await vpsReply(ctx, `${draft.plan.name} · ${formatSize(draft.plan.sizeSlug)}\nOS: ${os.label}\n\nPilih lokasi/region VPS:${draft.serviceType === "install" ? `\n\n${feeNotice}` : ""}`, keyboard);
              return;
            }
            await checkout(ctx, draft);
          }
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
          await ctx.reply(result.status === "paid" ? "Pembayaran saldo terkonfirmasi. Pesanan diproses di background." : result.status === "insufficient"
            ? result.methodLocked === false ? "Saldo belum cukup. Top up saldo atau pilih QRIS pada order ini." : "Saldo belum cukup. Top up saldo lalu bayar kembali pada order ini. Metode pembayaran yang sudah dipilih tetap digunakan agar pembayaran tidak ganda."
            : "Status pembayaran belum final. Periksa detail pesanan.");
        } else if (action[1] === "qris") {
          const invoice = await deps.createInvoice(actor, orderId);
          await ctx.replyWithPhoto(new InputFile(invoice.buffer, "vps-qris.png"), { caption: `Pembayaran VPS\nOrder: ${orderId}\nTotal: ${vpsPrice(invoice.amount)}\nBerlaku sampai: ${vpsDate(invoice.expiresAt)}\n\nBayar tepat sesuai nominal. Pembayaran diperiksa otomatis.`, reply_markup: new InlineKeyboard().text("Cek pembayaran", `vps_check_${orderId}`).row().text("Detail pesanan", `vps_order_${orderId}`) });
          return;
        } else if (action[1] === "check") {
          const result = await deps.checkPayment(actor, orderId);
          await ctx.reply(result.status === "paid" ? "Pembayaran terkonfirmasi. Pesanan diproses di background." : result.status === "expired" ? "Invoice kedaluwarsa. Periksa status order sebelum membuat pembayaran baru." : "Pembayaran belum terkonfirmasi; pemeriksaan otomatis tetap berjalan.");
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
          await ctx.reply(`🔐 Akses VPS\nIP: ${access.ip}\nUsername: ${access.username}\nPassword: ${access.password}\n\n${access.evidence}`, { protect_content: true });
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
