import { Bot, Context, InlineKeyboard } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { isAdmin } from "../../core/admin.js";
import { vpsService } from "../../vps/service.js";
import { DIRECT_INSTALL_PLAN_ID, INSTALL_DO_GLOBAL_PRICE_ID, INSTALL_DIRECT_GLOBAL_PRICE_ID, planPrice } from "../../vps/catalogPlans.js";
import { VpsOrder } from "../../models/VpsOrder.js";
import type { VpsCredentialFilter, VpsUiCredential, VpsUiDependencies } from "../vps/contracts.js";
import { clearVpsInput, setVpsInput } from "../vps/input.js";
import { isVpsPlatform, vpsDate, vpsPrice, vpsReply } from "../vps/ui.js";
import { MAX_VPS_WALLPAPER_BYTES, getVpsWallpaperStatus, resetVpsWallpaper, setVpsWallpaperJpeg } from "../../vps/wallpaper.js";

const homeKeyboard = (): InlineKeyboard => new InlineKeyboard().text("🔑 Token & akun DO", "vpa_tokens_all_0").row()
  .text("➕ Tambah token", "vpa_addtoken").text("🔎 Cek semua token", "vpa_checkall").row()
  .text("💰 Harga VPS / DO Buyer", "vpa_plans_0").row()
  .text("💰 Global Jasa Install DO", `vpa_global_service_${INSTALL_DO_GLOBAL_PRICE_ID}`).row()
  .text("💰 Global Jasa Install VPS Buyer", `vpa_global_service_${INSTALL_DIRECT_GLOBAL_PRICE_ID}`).row()
  .text("🛠 Harga Install VPS Buyer", "vpa_plans_direct_0").row()
  .text("🧩 Katalog OS/region/spek", "vpa_catalog").row()
  .text("🖼 Wallpaper Windows", "vpa_wallpaper").row()
  .text("📋 Log Pesanan / Orders", "vpa_orders_all_0").row()
  .text("🔙 Admin", "adm_home");
const known = (value: string | number | null | undefined): string => value === null || value === undefined || value === "" ? "belum diketahui" : String(value).slice(0, 400);
export function vpsCredentialText(credential: VpsUiCredential): string {
  const readiness = credential.enabled && credential.accountStatus === "active" && credential.tokenStatus === "ok" && (credential.available ?? 0) > 0 ? "Siap dicoba" : "Periksa status dan kapasitas akun";
  return `🔑 ${credential.label}\n\nToken: ${credential.enabled ? "aktif" : "nonaktif"}\nPrioritas: ${credential.priority}\nAkun/team: ${known(credential.accountId)}\nStatus akun: ${known(credential.accountStatus)}\nKeterangan akun: ${known(credential.statusMessage)}\nPemeriksaan token: ${known(credential.tokenStatus)}\nLimit droplet: ${known(credential.dropletLimit)}\nTerpakai di seluruh akun: ${known(credential.used)}\nReservasi order: ${known(credential.reserved)}\nKapasitas setelah reservasi: ${known(credential.available)}\nDiperiksa: ${vpsDate(credential.checkedAt)}\nKesiapan: ${readiness}\nCreate terakhir: ${known(credential.lastCreateResult)}\nWaktu create: ${vpsDate(credential.lastCreateAt)}\n\nToken satu akun/team berbagi kapasitas. “Siap dicoba” berarti akun aktif dan slot terpantau tersedia; keberhasilan create baru diketahui dari hasil DigitalOcean.`;
}
function numeric(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value.trim())) throw new Error("Invalid number");
  const result = Number(value.trim());
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid number");
  return result;
}
function shortText(value: string, max = 80): string {
  const result = value.trim();
  if (!result || result.length > max || /[\r\n\x00-\x1f]/.test(result)) throw new Error("Invalid label");
  return result;
}

export function createVpsAdminPlugin(overrides: Partial<VpsUiDependencies> = {}): Plugin {
  const deps: VpsUiDependencies = { ...vpsService, ...overrides };
  const wallpaperUploads = new Map<string, number>();
  const actorOf = (ctx: Context): string => String(ctx.from!.id);
  function authorized(handler: (ctx: Context) => Promise<void>): (ctx: Context) => Promise<void> {
    return async ctx => {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      if (!ctx.from || !isVpsPlatform() || !isAdmin(ctx) || ctx.chat?.type !== "private") {
        if (ctx.chat) await ctx.reply("Hanya admin melalui chat pribadi bot utama.");
        return;
      }
      try { await handler(ctx); }
      catch { await ctx.reply("Pengaturan VPS belum dapat diproses. Periksa input atau status akun dan coba kembali.", { reply_markup: homeKeyboard() }).catch(() => {}); }
    };
  }
  function input(actor: string, receive: (ctx: Context, value: string) => Promise<void>, secret = false): void {
    setVpsInput(actor, { secret, receive: async (ctx, value) => {
      if (!isVpsPlatform() || !isAdmin(ctx) || ctx.chat?.type !== "private") throw new Error("Unauthorized admin");
      await receive(ctx, value);
    } });
  }
  async function home(ctx: Context): Promise<void> {
    clearVpsInput(actorOf(ctx));
    wallpaperUploads.delete(actorOf(ctx));
    await vpsReply(ctx, `🖥️ Admin VPS DigitalOcean\n\nPemesanan baru: ${deps.enabled() ? "aktif" : "nonaktif (VPS_ENABLED)"}\n\nAtur token toko dan harga dari database. Token buyer hanya berada sementara di memori dan tidak ditampilkan pada admin.\n\nPemeriksaan akun menggunakan GET tanpa membuat droplet percobaan.`, homeKeyboard());
  }
  async function wallpaperMenu(ctx: Context): Promise<void> {
    const status = await getVpsWallpaperStatus();
    const source = status.custom ? "Custom dari admin" : "Default bawaan bot (Wallpaper.png)";
    const updated = status.custom && status.updatedAt ? `\nTerakhir diubah: ${vpsDate(status.updatedAt)}` : "";
    const size = status.custom ? `\nUkuran tersimpan: ${Math.max(1, Math.round(status.bytes / 1024))} KB` : "";
    const keyboard = new InlineKeyboard()
      .text("📤 Ganti wallpaper", "vpa_wallpaper_set").row();
    if (status.custom) keyboard.text("↩️ Pakai wallpaper default", "vpa_wallpaper_reset").row();
    keyboard.text("🔙 Admin VPS", "vpa_home");
    await vpsReply(ctx, `🖼 Wallpaper Windows\n\nAktif: ${source}${size}${updated}\n\nWallpaper ini dipakai untuk instalasi Windows berikutnya. Jika custom belum diatur, bot otomatis memakai Wallpaper.png bawaan repo.\n\nDisarankan kirim foto landscape 16:9, misalnya 1920×1080.`, keyboard);
  }

  async function beginWallpaperUpload(ctx: Context): Promise<void> {
    const actor = actorOf(ctx);
    wallpaperUploads.set(actor, Date.now() + 10 * 60_000);
    await vpsReply(ctx, `📤 Ganti Wallpaper Windows\n\nKirim gambar sebagai <b>Foto</b> ke chat ini dalam 10 menit. Telegram akan mengirim versi JPEG yang sudah dikompres.\n\nMaksimal ${Math.floor(MAX_VPS_WALLPAPER_BYTES / 1024 / 1024)} MB. Disarankan landscape 16:9.\n\nWallpaper baru hanya berlaku untuk proses install Windows yang dimulai setelah pengaturan disimpan.`, new InlineKeyboard().text("Batal", "vpa_wallpaper"));
  }

  async function saveWallpaperPhoto(ctx: Context): Promise<void> {
    const photos = ctx.message?.photo;
    const photo = photos?.[photos.length - 1];
    if (!photo) throw new Error("Wallpaper photo unavailable");
    if (photo.file_size && photo.file_size > MAX_VPS_WALLPAPER_BYTES) throw new Error("Wallpaper is too large");

    const telegramFile = await ctx.api.getFile(photo.file_id);
    if (!telegramFile.file_path) throw new Error("Telegram file path unavailable");
    const token = process.env.BOT_TOKEN?.trim();
    if (!token) throw new Error("BOT_TOKEN unavailable");

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${telegramFile.file_path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error("Telegram file download failed");
    const declaredSize = Number(response.headers.get("content-length") || "0");
    if (declaredSize > MAX_VPS_WALLPAPER_BYTES) throw new Error("Wallpaper is too large");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_VPS_WALLPAPER_BYTES) throw new Error("Wallpaper is too large");

    await setVpsWallpaperJpeg(buffer);
    await ctx.reply("✅ Wallpaper Windows custom tersimpan. Install Windows berikutnya akan memakai wallpaper ini.");
    await wallpaperMenu(ctx);
  }

  async function credentialDetail(ctx: Context, id: string): Promise<void> {
    const credential = await deps.getCredential(actorOf(ctx), id);
    if (!credential) throw new Error("Credential unavailable");
    await vpsReply(ctx, vpsCredentialText(credential), new InlineKeyboard().text("🔎 Cek token", `vpa_check_${id}`).row()
      .text(credential.enabled ? "Nonaktifkan" : "Aktifkan", `vpa_enable_${id}_${credential.enabled ? "0" : "1"}`).text("Prioritas", `vpa_priority_${id}`).row()
      .text("🗑 Hapus token", `vpa_delete_${id}`).row()
      .text("🔙 Token & akun", "vpa_tokens_all_0"));
  }

  async function deleteCredentialPrompt(ctx: Context, id: string): Promise<void> {
    const credential = await deps.getCredential(actorOf(ctx), id);
    if (!credential) {
      await vpsReply(ctx, "Token sudah tidak tersedia.", new InlineKeyboard().text("🔙 Token & akun", "vpa_tokens_all_0"));
      return;
    }
    if (credential.enabled) {
      await vpsReply(ctx, `⚠️ Hapus token DO\n\n${credential.label}\n\nNonaktifkan token terlebih dahulu agar tidak dipilih untuk order baru. Setelah itu buka kembali tombol hapus.`, new InlineKeyboard()
        .text("Nonaktifkan token", `vpa_enable_${id}_0`).row()
        .text("Batal", `vpa_credential_${id}`));
      return;
    }
    await vpsReply(ctx, `⚠️ Konfirmasi hapus token DO\n\nLabel: ${credential.label}\nAkun/team: ${known(credential.accountId)}\n\nToken terenkripsi akan dihapus permanen dari database. Penghapusan ditolak bila token masih dipakai proses order atau reservasi aktif. Pesanan yang sudah selesai tidak dapat memakai token ini lagi untuk aksi provider seperti reboot.`, new InlineKeyboard()
      .text("Ya, hapus permanen", `vpa_deleteconfirm_${id}`).row()
      .text("Batal", `vpa_credential_${id}`));
  }
  async function getPlan(id: string) {
    const plan = (await deps.listPlans(undefined, true)).find(item => item.id === id);
    if (!plan) throw new Error("Spec unavailable");
    return plan;
  }
  async function planDetail(ctx: Context, id: string): Promise<void> {
    const plan = await getPlan(id);
    const serviceGlobalId = plan.serviceType === "install" ? (plan.sourceMode === "direct" ? INSTALL_DIRECT_GLOBAL_PRICE_ID : INSTALL_DO_GLOBAL_PRICE_ID) : null;
    const displayedGlobal = serviceGlobalId ? plan.serviceGlobalPrice : plan.globalPrice;
    const keyboard = new InlineKeyboard()
      .text(`Harga global: ${displayedGlobal ? vpsPrice(displayedGlobal) : "Belum diatur"}`, serviceGlobalId ? `vpa_global_service_${serviceGlobalId}` : `vpa_global_${id}`).row();
    if (plan.id === DIRECT_INSTALL_PLAN_ID) {
      plan.osPrices.forEach((os, index) => {
        const price = planPrice(plan, "external", os.os);
        keyboard.text(`${os.label} · ${price ? vpsPrice(price) : "Belum diatur"}`, `vpa_set_${id}_0_${index}`).row();
      });
      keyboard.text(plan.enabled ? "Nonaktifkan layanan" : "Aktifkan layanan", `vpa_planenable_${id}_${plan.enabled ? "0" : "1"}`).row()
        .text("🔙 Admin VPS", "vpa_home");
      await vpsReply(ctx, "🛠 Harga Jasa Install · VPS Buyer\n\nHarga ditentukan per versi Windows saja. Spek, region, dan provider VPS tidak memengaruhi harga karena VPS sudah disediakan buyer.\n\nPilih OS untuk mengatur harga jasa.", keyboard);
      return;
    }
    plan.regions.forEach((region, index) => keyboard.text(plan.regionLabels?.[region] ?? region, `vpa_os_${id}_${index}_0`).row());
    keyboard.text(plan.enabled ? "Nonaktifkan spek" : "Aktifkan spek", `vpa_planenable_${id}_${plan.enabled ? "0" : "1"}`).row().text("🔙 Spek & layanan", plan.sourceMode === "direct" ? "vpa_plans_direct_0" : "vpa_plans_0");
    await vpsReply(ctx, `💰 ${plan.sourceMode === "direct" ? "Jasa install / VPS Buyer" : plan.serviceType === "install" ? "Jasa install · DO Buyer" : "VPS DO"}\n${plan.sizeLabel ?? plan.name}\n\n${serviceGlobalId ? "Harga global layanan berlaku untuk semua spek, region, dan OS." : "Harga global berlaku untuk semua region dan OS pada spek ini."} Harga khusus region/OS tetap diprioritaskan.`, keyboard);
  }
  async function osPrices(ctx: Context, id: string, regionIndex: number, offset: number): Promise<void> {
    const plan = await getPlan(id), region = plan.regions[regionIndex];
    if (!region) throw new Error("Region unavailable");
    const keyboard = new InlineKeyboard();
    plan.osPrices.slice(offset, offset + 10).forEach((os, index) => {
      const price = planPrice(plan, region, os.os);
      keyboard.text(`${os.label} · ${price ? vpsPrice(price) : "Belum diatur"}`, `vpa_set_${id}_${regionIndex}_${offset + index}`).row();
    });
    if (offset) keyboard.text("← Sebelumnya", `vpa_os_${id}_${regionIndex}_${Math.max(0, offset - 10)}`);
    if (offset + 10 < plan.osPrices.length) keyboard.text("Berikutnya →", `vpa_os_${id}_${regionIndex}_${offset + 10}`);
    if (plan.id === DIRECT_INSTALL_PLAN_ID) {
      keyboard.row().text("🔙 Harga Install VPS Buyer", `vpa_plan_${id}`);
      await vpsReply(ctx, "🛠 Harga Jasa Install · VPS Buyer\n\nPilih versi Windows untuk mengisi harga Rupiah. Harga berlaku untuk VPS buyer tanpa membedakan spek/region.", keyboard);
      return;
    }
    keyboard.row().text("🔙 Region", `vpa_plan_${id}`);
    await vpsReply(ctx, `💰 ${plan.sourceMode === "direct" ? "Jasa install / VPS Buyer" : plan.serviceType === "install" ? "Jasa install · DO Buyer" : "VPS DO"} · ${plan.sizeLabel ?? plan.name}\nRegion: ${plan.regionLabels?.[region] ?? region}\n\nPilih OS untuk mengisi harga Rupiah. Perubahan berlaku pada checkout baru.`, keyboard);
  }
  async function addToken(ctx: Context): Promise<void> {
    const actor = actorOf(ctx);
    clearVpsInput(actor);
    input(actor, async (labelCtx, value) => {
      const label = shortText(value);
      input(actor, async (priorityCtx, priorityValue) => {
        const priority = numeric(priorityValue, 0, 10_000);
        input(actor, async (tokenCtx, tokenValue) => {
          const credential = await deps.addCredential(actor, { label, priority, token: tokenValue.trim() });
          await tokenCtx.reply("Token telah divalidasi dan disimpan terenkripsi.");
          await credentialDetail(tokenCtx, credential.id);
        }, true);
        await priorityCtx.reply("(3/3) Kirim token DigitalOcean. Pesan harus berhasil dihapus sebelum token diproses. Ketik /batal untuk membatalkan.");
      });
      await labelCtx.reply("(2/3) Kirim angka prioritas 0–10000. Angka lebih kecil dipilih lebih dahulu.");
    });
    await vpsReply(ctx, "➕ Tambah token toko\n\n(1/3) Kirim label akun/token (maksimal 80 karakter). Ketik /batal untuk membatalkan.", new InlineKeyboard().text("Batal", "vpa_home"));
  }

  async function catalogHome(ctx: Context): Promise<void> {
    const catalog = await deps.listCatalog?.();
    if (!catalog) throw new Error("Katalog belum tersedia");
    await vpsReply(ctx, `🧩 Katalog VPS\n\nRegion: ${catalog.regions.length}\nSpek: ${catalog.sizes.length}\nOS: ${catalog.os.length}\n\nEntri baru langsung tersedia di menu pembeli. Atur harga kombinasinya melalui menu harga.`, new InlineKeyboard()
      .text("➕ Region", "vpa_addregion").text("➕ Spek", "vpa_addsize").row().text("➕ OS", "vpa_addos").row().text("🔙 Admin VPS", "vpa_home"));
  }
  async function addCatalog(ctx: Context, kind: "region" | "size" | "os"): Promise<void> {
    if (!deps.addCatalogEntry) throw new Error("Catalog unavailable");
    const actor = actorOf(ctx), values: string[] = [];
    const fields = kind === "region" ? ["slug region, contoh sgp1", "nama region, contoh Singapore", "negara, contoh Singapore"]
      : kind === "size" ? ["slug DigitalOcean, contoh s-2vcpu-4gb", "jumlah CPU, contoh 2", "RAM, contoh 4 GB", "disk, contoh 80 GB", "transfer, contoh 4 TB", "label biaya DigitalOcean, contoh $24/month"]
      : ["key OS, contoh ubuntu24", "nama OS", "slug image DigitalOcean (Windows: ubuntu-24-04-x64)", "family OS: linux atau windows", "nama image Windows installer, contoh Windows Server 2022 ServerStandard"];
    async function prompt(target: Context, index: number): Promise<void> {
      input(actor, async (replyCtx, value) => {
        values.push(shortText(value, 100));
        if (index + 1 < fields.length && !(kind === "os" && index === 3 && value.trim() === "linux")) {
          await prompt(replyCtx, index + 1); return;
        }
        await deps.addCatalogEntry!(actor, { kind, value: values });
        await replyCtx.reply("Entri katalog tersimpan. Atur harga kombinasinya melalui menu harga.");
        await catalogHome(replyCtx);
      });
      await vpsReply(target, `➕ Tambah ${kind}\n\nKirim ${fields[index]}.\nKetik /batal untuk membatalkan.`, new InlineKeyboard().text("Batal", "vpa_catalog"));
    }
    await prompt(ctx, 0);
  }

  type VpsOrderFilter = "all" | "paid" | "ready" | "review" | "unpaid";

  async function ordersList(ctx: Context, filter: VpsOrderFilter, offset: number): Promise<void> {
    const query: Record<string, any> = { tenantId: "platform" };
    if (filter === "paid") {
      query.paymentStatus = "paid";
      query.stage = { $ne: "ready" };
    } else if (filter === "ready") {
      query.stage = "ready";
    } else if (filter === "review") {
      query.$or = [{ stage: { $in: ["review", "failed", "needs_token"] } }, { paymentStatus: { $in: ["refunded", "cancelled"] } }];
    } else if (filter === "unpaid") {
      query.paymentStatus = { $in: ["unpaid", "paying"] };
    }

    const limit = 8;
    const total = await VpsOrder.countDocuments(query);
    const orders = await VpsOrder.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    const keyboard = new InlineKeyboard()
      .text(filter === "all" ? "• Semua •" : "Semua", "vpa_orders_all_0")
      .text(filter === "paid" ? "• Proses •" : "Proses", "vpa_orders_paid_0")
      .text(filter === "ready" ? "• Ready •" : "Ready", "vpa_orders_ready_0")
      .row()
      .text(filter === "review" ? "• Masalah •" : "Masalah", "vpa_orders_review_0")
      .text(filter === "unpaid" ? "• Belum Bayar •" : "Belum Bayar", "vpa_orders_unpaid_0")
      .row();

    orders.forEach((o) => {
      const icon = o.service === "install" ? "🛠️" : "🖥️";
      const statusIcon = o.stage === "ready" ? "✅" : o.paymentStatus === "paid" ? "⏳" : o.paymentStatus === "unpaid" ? "⚪" : "❌";
      const label = `${icon} ${o.snapshot?.planName || o._id.slice(0, 8)} · ${statusIcon} ${o.stage}`;
      keyboard.text(label, `vpa_orderdetail_${o._id}`).row();
    });

    if (offset > 0) {
      keyboard.text("← Sebelumnya", `vpa_orders_${filter}_${Math.max(0, offset - limit)}`);
    }
    if (offset + limit < total) {
      keyboard.text("Berikutnya →", `vpa_orders_${filter}_${offset + limit}`);
    }
    keyboard.row().text("🔙 Admin VPS", "vpa_home");

    const filterNames: Record<VpsOrderFilter, string> = {
      all: "Semua Pesanan",
      paid: "Lunas / Dalam Proses",
      ready: "Selesai (Ready)",
      review: "Perlu Review / Masalah / Refund",
      unpaid: "Belum Bayar",
    };

    const text =
      `📋 Log Pesanan VPS & Jasa Install\n` +
      `Filter: ${filterNames[filter]} (Total: ${total})\n\n` +
      (orders.length > 0
        ? "Pilih salah satu pesanan untuk melihat detail:"
        : "Belum ada pesanan pada kategori filter ini.");

    await vpsReply(ctx, text, keyboard);
  }

  async function orderDetail(ctx: Context, orderId: string): Promise<void> {
    const order = await VpsOrder.findOne({ _id: orderId, tenantId: "platform" }).lean();
    if (!order) throw new Error("Order unavailable");

    const isDirect = order.service === "install" && Boolean(order.sourceUsername);
    const serviceLabel =
      order.service === "install"
        ? isDirect
          ? "🛠️ Jasa Install Windows (VPS Buyer Direct SSH)"
          : "🛠️ Jasa Install OS (Akun DO Buyer)"
        : "🖥️ VPS DigitalOcean (Akun Toko)";

    const invoiceAmount = order.paymentInvoice?.amount;
    const priceDisplay = invoiceAmount ? `${vpsPrice(invoiceAmount)} (QRIS)` : vpsPrice(order.snapshot.price);

    const sourceDetail = isDirect
      ? `Target: VPS milik buyer (Direct SSH)\n` +
        `SSH User: ${order.sourceUsername}\n` +
        `OS: ${order.snapshot.os}${order.snapshot.installChrome ? " (+ Chrome)" : ""}\n`
      : `Paket Spek: ${order.snapshot.planName} (${order.snapshot.size})\n` +
        `Spek: ${order.snapshot.vcpus} vCPU · ${order.snapshot.memory} MB · ${order.snapshot.disk} GB\n` +
        `Region: ${order.snapshot.region}\n` +
        `OS: ${order.snapshot.os}${order.snapshot.installChrome ? " (+ Chrome)" : ""}\n`;

    const text =
      `📋 Rincian Pesanan VPS\n\n` +
      `Order ID: ${order._id}\n` +
      `Buyer ID: ${order.buyerId} (Chat: ${order.chatId})\n` +
      `Layanan: ${serviceLabel}\n` +
      sourceDetail +
      `Harga: ${priceDisplay}\n` +
      `Pembayaran: ${order.paymentStatus} (${order.paymentMethod || "belum pilih"})\n` +
      (order.paymentPaidAt ? `Waktu bayar: ${vpsDate(order.paymentPaidAt)}\n` : "") +
      (order.paymentInvoice?.matchedTransactionId ? `ID Tx GoPay: ${order.paymentInvoice.matchedTransactionId}\n` : "") +
      `Tahap Proses: ${order.stage}\n` +
      `IP Publik: ${order.publicIp || "belum tersedia"}\n` +
      (order.dropletId ? `Droplet ID: ${order.dropletId}\n` : "") +
      (order.lastError ? `Last Error: ${order.lastError}\n` : "") +
      `Evidence: ${order.evidence || "Belum ada catatan."}\n` +
      (order.refundReason ? `Alasan refund: ${order.refundReason}\n` : "") +
      `Waktu order: ${vpsDate(order.createdAt)}\n` +
      `Pembaruan: ${vpsDate(order.updatedAt)}`;

    const keyboard = new InlineKeyboard();
    if (["review", "needs_token", "queued", "creating", "droplet", "ssh", "installing", "rebooting", "monitoring"].includes(order.stage)) {
      keyboard.text("🛑 Batalkan & Refund Order", `vpa_ordercancel_${order._id}`).row();
      keyboard.text("✅ Tandai Selesai (Ready)", `vpa_orderready_${order._id}`).row();
    }
    keyboard.text("🔄 Perbarui Info", `vpa_orderdetail_${order._id}`).row()
      .text("🔙 Daftar Pesanan", "vpa_orders_all_0")
      .text("🔙 Admin VPS", "vpa_home");

    await vpsReply(ctx, text, keyboard);
  }

  return {
    name: "vpsadmin", version: "1.0.0", internalOnly: true,
    commands: [
      { command: "vpsadmin", description: "[Admin] Token DigitalOcean dan harga VPS" },
      { command: "vpswallpaper", description: "[Admin] Wallpaper instalasi Windows" },
    ],
    register(bot: Bot<Context>): void {
      bot.command("vpsadmin", authorized(home));
      bot.command("vpswallpaper", authorized(async ctx => {
        const action = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase();
        if (action === "reset" || action === "default") {
          wallpaperUploads.delete(actorOf(ctx));
          await resetVpsWallpaper();
          await ctx.reply("✅ Wallpaper Windows dikembalikan ke default bawaan bot.");
          await wallpaperMenu(ctx);
          return;
        }
        if (action === "set" || action === "ganti") {
          await beginWallpaperUpload(ctx);
          return;
        }
        await wallpaperMenu(ctx);
      }));
      bot.on("message:photo", async (ctx, next) => {
        if (!ctx.from) return next();
        const actor = String(ctx.from.id);
        const expiresAt = wallpaperUploads.get(actor);
        if (!expiresAt) return next();
        if (!isVpsPlatform() || !isAdmin(ctx) || ctx.chat?.type !== "private") {
          wallpaperUploads.delete(actor);
          return next();
        }
        if (expiresAt <= Date.now()) {
          wallpaperUploads.delete(actor);
          await ctx.reply("Waktu upload wallpaper habis. Buka /vpswallpaper lalu pilih Ganti wallpaper lagi.");
          return;
        }
        wallpaperUploads.delete(actor);
        try {
          await saveWallpaperPhoto(ctx);
        } catch {
          await ctx.reply("Wallpaper gagal disimpan. Kirim sebagai Foto JPEG/Telegram photo dengan ukuran maksimal 4 MB, lalu coba lagi.", { reply_markup: new InlineKeyboard().text("Coba lagi", "vpa_wallpaper_set").text("Kembali", "vpa_wallpaper") });
        }
      });
      bot.callbackQuery(/^vpa_/, authorized(async ctx => {
        const data = ctx.callbackQuery!.data!;
        const actor = actorOf(ctx);
        clearVpsInput(actor);
        wallpaperUploads.delete(actor);
        if (data === "vpa_home") { await home(ctx); return; }
        if (data === "vpa_wallpaper") { await wallpaperMenu(ctx); return; }
        if (data === "vpa_wallpaper_set") { await beginWallpaperUpload(ctx); return; }
        if (data === "vpa_wallpaper_reset") {
          await resetVpsWallpaper();
          await ctx.reply("✅ Wallpaper Windows dikembalikan ke default bawaan bot.");
          await wallpaperMenu(ctx);
          return;
        }
        if (data === "vpa_catalog") { await catalogHome(ctx); return; }
        if (data === "vpa_addregion" || data === "vpa_addsize" || data === "vpa_addos") { await addCatalog(ctx, data === "vpa_addregion" ? "region" : data === "vpa_addsize" ? "size" : "os"); return; }
        if (data === "vpa_addtoken") { await addToken(ctx); return; }
        if (data === "vpa_checkall") {
          await ctx.reply("Pemeriksaan seluruh token dimulai dengan concurrency terbatas. Buka daftar token untuk melihat waktu dan hasil pemeriksaan.");
          await deps.checkAllCredentials(actor);
          await ctx.reply("Pemeriksaan seluruh token selesai.", { reply_markup: homeKeyboard() });
          return;
        }
        if (data === "vpa_addplan" || data.startsWith("vpa_new")) { await catalogHome(ctx); return; }
        const orderAction = /^vpa_order(cancel|ready)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (orderAction) {
          const action = orderAction[1];
          const orderId = orderAction[2]!;
          const order = await VpsOrder.findOne({ _id: orderId, tenantId: "platform" }).lean();
          if (!order) { await vpsReply(ctx, "Pesanan tidak ditemukan.", new InlineKeyboard().text("🔙 Admin VPS", "vpa_home")); return; }
          if (action === "cancel") {
            await vpsReply(ctx, `⚠️ Batalkan Pesanan #${order._id.slice(0, 8)}\n\nLayanan: ${order.service}\nBuyer: ${order.buyerId}\nStatus Bayar: ${order.paymentStatus}\nTahap: ${order.stage}\n\nPembatalan akan menghentikan pesanan, melepas reservasi kapasitas, dan me-refund saldo pembeli (jika sudah lunas).`, new InlineKeyboard()
              .text("Ya, Batalkan & Refund", `vpa_confirmcancel_${order._id}`).row()
              .text("Batal", `vpa_orderdetail_${order._id}`));
          } else {
            await vpsReply(ctx, `⚠️ Tandai Pesanan Selesai (Ready)\n\nPesanan #${order._id.slice(0, 8)} akan ditandai selesai (Ready). Gunakan jika VPS sudah aktif atau diselesaikan manual di DigitalOcean.`, new InlineKeyboard()
              .text("Ya, Tandai Selesai", `vpa_confirmready_${order._id}`).row()
              .text("Batal", `vpa_orderdetail_${order._id}`));
          }
          return;
        }
        const confirmOrderAction = /^vpa_confirm(cancel|ready)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (confirmOrderAction) {
          const action = confirmOrderAction[1];
          const orderId = confirmOrderAction[2]!;
          if (action === "cancel") {
            const res = await deps.adminCancelOrder?.(actor, orderId);
            await vpsReply(ctx, `✅ Pesanan #${orderId.slice(0, 8)} berhasil dibatalkan${res?.status === "refunded" ? " dan saldo pembeli telah di-refund" : ""}.\n\nToken DO dan reservasi kapasitas telah dilepaskan.`, new InlineKeyboard()
              .text("🔎 Lihat Detail Order", `vpa_orderdetail_${orderId}`).row()
              .text("🔙 Daftar Pesanan", "vpa_orders_all_0").text("🔙 Token & Akun", "vpa_tokens_all_0"));
          } else {
            await deps.adminResolveOrder?.(actor, orderId, "ready");
            await vpsReply(ctx, `✅ Pesanan #${orderId.slice(0, 8)} telah ditandai Selesai (Ready).\n\nToken DO kini bebas dari pesanan aktif.`, new InlineKeyboard()
              .text("🔎 Lihat Detail Order", `vpa_orderdetail_${orderId}`).row()
              .text("🔙 Daftar Pesanan", "vpa_orders_all_0").text("🔙 Token & Akun", "vpa_tokens_all_0"));
          }
          return;
        }
        const orderListMatch = /^vpa_orders_(all|paid|ready|review|unpaid)_(\d{1,6})$/.exec(data);
        if (orderListMatch) {
          await ordersList(ctx, orderListMatch[1] as VpsOrderFilter, Number(orderListMatch[2]));
          return;
        }
        const orderDetailMatch = /^vpa_orderdetail_([a-f0-9-]{36})$/.exec(data);
        if (orderDetailMatch) {
          await orderDetail(ctx, orderDetailMatch[1]!);
          return;
        }
        const list = /^vpa_tokens_(all|active|warning|locked|available|problem)_(\d{1,6})$/.exec(data);
        if (list) {
          const filter = list[1] as VpsCredentialFilter;
          const offset = Number(list[2]);
          const credentials = await deps.listCredentials(actor, filter, offset, 8);
          const keyboard = new InlineKeyboard().text("Semua", "vpa_tokens_all_0").text("Active", "vpa_tokens_active_0").text("Warning", "vpa_tokens_warning_0").row()
            .text("Locked", "vpa_tokens_locked_0").text("Slot tersedia", "vpa_tokens_available_0").text("Token bermasalah", "vpa_tokens_problem_0").row();
          credentials.forEach(credential => keyboard.text(`${credential.enabled ? "🟢" : "⚪"} ${credential.label} · ${known(credential.tokenStatus)}`, `vpa_credential_${credential.id}`).row());
          if (offset) keyboard.text("← Sebelumnya", `vpa_tokens_${filter}_${Math.max(0, offset - 8)}`);
          if (credentials.length === 8) keyboard.text("Berikutnya →", `vpa_tokens_${filter}_${offset + 8}`);
          keyboard.row().text("🔙 Admin VPS", "vpa_home");
          await vpsReply(ctx, `🔑 Token & akun DO · ${filter}\n\n${credentials.length ? credentials.map(c => `${c.label}: ${known(c.accountStatus)} · slot ${known(c.available)}\nDiperiksa: ${vpsDate(c.checkedAt)}`).join("\n\n") : "Belum ada token pada filter/halaman ini."}`, keyboard);
          return;
        }
        const plans = /^vpa_plans_(direct_)?(\d{1,6})$/.exec(data);
        if (plans) {
          const offset = Number(plans[2]);
          const direct = Boolean(plans[1]);
          const prefix = direct ? "vpa_plans_direct_" : "vpa_plans_";
          const allPlans = (await deps.listPlans(undefined, true)).filter(plan => plan.id !== DIRECT_INSTALL_PLAN_ID && (direct ? plan.sourceMode === "direct" : plan.sourceMode !== "direct"));
          const page = allPlans.slice(offset, offset + 10);
          const keyboard = new InlineKeyboard();
          page.forEach(plan => keyboard.text(`${plan.enabled ? "🟢" : "⚪"} ${plan.sourceMode === "direct" ? "Jasa install / VPS Buyer" : plan.serviceType === "install" ? "Install" : "VPS DO"} · ${plan.sizeLabel ?? plan.name}`, `vpa_plan_${plan.id}`).row());
          if (offset) keyboard.text("← Sebelumnya", `${prefix}${Math.max(0, offset - 10)}`);
          if (offset + 10 < allPlans.length) keyboard.text("Berikutnya →", `${prefix}${offset + 10}`);
          keyboard.row().text("🧩 Katalog", "vpa_catalog").text("🔙 Admin VPS", "vpa_home");
          await vpsReply(ctx, `${direct ? "Harga Jasa Install VPS Buyer" : "Harga VPS & Jasa Install DO Buyer"}\n\nPilih layanan/spek untuk mengatur harga global atau harga khusus region/OS.`, keyboard);
          return;
        }
        const deletion = /^vpa_(delete|deleteconfirm)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (deletion) {
          const id = deletion[2]!;
          if (deletion[1] === "delete") { await deleteCredentialPrompt(ctx, id); return; }
          const result = await deps.deleteCredential(actor, id);
          if (result.status === "deleted") {
            await vpsReply(ctx, "✅ Token DigitalOcean telah dihapus permanen.", new InlineKeyboard().text("🔙 Token & akun", "vpa_tokens_all_0"));
          } else if (result.status === "enabled") {
            await vpsReply(ctx, "Token kembali aktif atau belum dinonaktifkan, sehingga tidak dihapus.", new InlineKeyboard().text("Buka detail token", `vpa_credential_${id}`).row().text("🔙 Token & akun", "vpa_tokens_all_0"));
          } else if (result.status === "in_use") {
            const detailText = result.orderId
              ? `Token masih dipakai oleh pesanan aktif #${result.orderId.slice(0, 8)} (${result.stage || "sedang berjalan"}).`
              : (result.reason || "Token masih dipakai oleh proses order, reboot, atau reservasi aktif.");
            const keyboard = new InlineKeyboard();
            if (result.orderId) {
              keyboard.text(`🔎 Lihat Order #${result.orderId.slice(0, 8)}`, `vpa_orderdetail_${result.orderId}`).row();
            }
            keyboard.text("Buka detail token", `vpa_credential_${id}`).row().text("🔙 Token & akun", "vpa_tokens_all_0");
            await vpsReply(ctx, `⚠️ ${detailText}\n\nSelesaikan atau batalkan pesanan tersebut lalu coba lagi.`, keyboard);
          } else {
            await vpsReply(ctx, "Token sudah tidak tersedia; tidak ada data rahasia yang dihapus lagi.", new InlineKeyboard().text("🔙 Token & akun", "vpa_tokens_all_0"));
          }
          return;
        }
        const item = /^vpa_(credential|check|priority|plan)_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (item) {
          const id = item[2]!;
          if (item[1] === "plan") await planDetail(ctx, id);
          else if (item[1] === "credential") await credentialDetail(ctx, id);
          else if (item[1] === "check") { await deps.checkCredential(actor, id); await credentialDetail(ctx, id); }
          else {
            if (!await deps.getCredential(actor, id)) throw new Error("Credential unavailable");
            input(actor, async (priorityCtx, value) => { await deps.updateCredential(actor, id, { priority: numeric(value, 0, 10_000) }); await credentialDetail(priorityCtx, id); });
            await vpsReply(ctx, "Kirim prioritas baru (0–10000). Angka lebih kecil dipilih lebih dahulu.", new InlineKeyboard().text("Batal", "vpa_home"));
          }
          return;
        }
        const toggle = /^vpa_(enable|planenable)_([A-Za-z0-9-]{1,40})_([01])$/.exec(data);
        if (toggle) {
          const id = toggle[2]!;
          const enabled = toggle[3] === "1";
          if (toggle[1] === "enable") { await deps.updateCredential(actor, id, { enabled }); await credentialDetail(ctx, id); }
          else { await deps.updatePlan(actor, id, { enabled }); await planDetail(ctx, id); }
          return;
        }
        const global = /^vpa_global_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (global) {
          const plan = await getPlan(global[1]!);
          input(actor, async (priceCtx, value) => {
            await deps.updatePlan(actor, plan.id, { globalPrice: numeric(value, 1, 100_000_000) });
            await priceCtx.reply("Harga global per spek tersimpan. Harga khusus tetap berlaku.");
            await planDetail(priceCtx, plan.id);
          });
          await vpsReply(ctx, `Kirim harga global Rupiah untuk ${plan.sizeLabel ?? plan.name}. Berlaku untuk semua region dan OS. Angka bulat 1-100000000.`, new InlineKeyboard().text("Batal", `vpa_plan_${plan.id}`));
          return;
        }
        const globalService = /^vpa_global_service_([A-Za-z0-9-]{1,40})$/.exec(data);
        if (globalService) {
          const id = globalService[1]!;
          if (id !== INSTALL_DO_GLOBAL_PRICE_ID && id !== INSTALL_DIRECT_GLOBAL_PRICE_ID) throw new Error("Invalid service price");
          input(actor, async (priceCtx, value) => {
            await deps.updatePlan(actor, id, { globalPrice: numeric(value, 1, 100_000_000) });
            await priceCtx.reply("Harga global jasa install tersimpan untuk semua spek, region, dan OS.");
            await home(priceCtx);
          });
          await vpsReply(ctx, `Kirim harga global ${id === INSTALL_DO_GLOBAL_PRICE_ID ? "Jasa Install DO Buyer" : "Jasa Install VPS Buyer"}. Harga ini berlaku untuk semua spek, region, dan OS.`, new InlineKeyboard().text("Batal", "vpa_home"));
          return;
        }
        const pricePage = /^vpa_os_([A-Za-z0-9-]{1,40})_(\d{1,3})_(\d{1,3})$/.exec(data);
        if (pricePage) { await osPrices(ctx, pricePage[1]!, Number(pricePage[2]), Number(pricePage[3])); return; }
        const price = /^vpa_set_([A-Za-z0-9-]{1,40})_(\d{1,3})_(\d{1,3})$/.exec(data);
        if (price) {
          const plan = await getPlan(price[1]!), region = plan.regions[Number(price[2])], os = plan.osPrices[Number(price[3])];
          if (!region || !os) throw new Error("Combination unavailable");
          input(actor, async (priceCtx, value) => {
            await deps.updatePlan(actor, plan.id, { region, os: os.os, price: value.trim() === "0" ? null : numeric(value, 1, 100_000_000) });
            await priceCtx.reply("Harga khusus tersimpan. Input 0 mengikuti harga global.");
            await osPrices(priceCtx, plan.id, Number(price[2]), Math.floor(Number(price[3]) / 10) * 10);
          });
          await vpsReply(ctx, plan.id === DIRECT_INSTALL_PLAN_ID
            ? `Kirim harga Rupiah untuk Jasa Install VPS Buyer\nOS: ${os.label}\n\nHarga ini tidak bergantung pada spek/region VPS. Angka bulat 1-100000000, atau 0 untuk mengikuti harga global. Order sebelumnya tetap memakai harga checkout.`
            : `Kirim harga Rupiah untuk ${plan.sourceMode === "direct" ? "Jasa install / VPS Buyer" : plan.serviceType === "install" ? "Jasa install · DO Buyer" : "VPS DO"}\n${plan.sizeLabel ?? plan.name}\nRegion: ${region}\nOS: ${os.label}\n\nAngka bulat 1-100000000, atau 0 untuk mengikuti harga global. Order sebelumnya tetap memakai harga checkout.`,
            new InlineKeyboard().text("Batal", `vpa_plan_${plan.id}`));
          return;
        }
        await home(ctx);
      }));
    },
  };
}
export default createVpsAdminPlugin();
