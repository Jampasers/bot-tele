import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { DigitalProductService, ProductWithStock } from "../../services/digitalProduct.js";
import { WarrantyService } from "../../services/warranty.js";
import { DigitalOrder } from "../../models/DigitalOrder.js";
import { WarrantyUnit } from "../../models/DigitalProduct.js";
import { isAdmin } from "../../core/admin.js";

// ============================================================================
//  ADMIN PLUGIN — DIGITAL PRODUCTS & STOCK MANAGER
// ============================================================================

const ITEMS_PER_PAGE = 10;

interface AdminState {
  action:
    | "ADD_STOCK"
    | "EDIT_PRICE"
    | "EDIT_DESC"
    | "EDIT_DELIVERY_MSG"
    | "ADD_PRODUCT"
    | "EDIT_WARRANTY"
    | "EDIT_MAX_CLAIMS"
    | "REJECT_CLAIM"
    | "ADD_BULK_TIER";
  productId?: string;
  claimId?: string;
  page?: number;
}

const adminInputState = new Map<string, AdminState>();

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Parses flexible warranty duration and unit string.
 * Examples: "24h", "24 jam", "7d", "7 hari", "2w", "2 minggu", "1m", "1 bulan", "0", "none".
 */
function parseWarrantyInput(input: string): { duration: number; unit: WarrantyUnit } | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "0" || trimmed === "none" || trimmed === "tidak" || trimmed === "no" || trimmed === "-") {
    return { duration: 0, unit: "NONE" };
  }

  const match = trimmed.match(/^(\d+)\s*([a-z]*)$/i);
  if (!match) return null;

  const duration = parseInt(match[1]!, 10);
  if (isNaN(duration) || duration < 0) return null;
  if (duration === 0) return { duration: 0, unit: "NONE" };

  const unitRaw = match[2] || "d";
  if (["j", "jam", "h", "hour", "hours"].includes(unitRaw)) {
    return { duration, unit: "HOURS" };
  }
  if (["d", "day", "days", "hari", "hri"].includes(unitRaw)) {
    return { duration, unit: "DAYS" };
  }
  if (["w", "week", "weeks", "minggu", "mgg"].includes(unitRaw)) {
    return { duration, unit: "WEEKS" };
  }
  if (["m", "month", "months", "bulan", "bln"].includes(unitRaw)) {
    return { duration, unit: "MONTHS" };
  }

  return { duration, unit: "DAYS" };
}

// ── UI Builders ───────────────────────────────────────────────────────────────

async function buildDashboardText(): Promise<string> {
  const stats = await DigitalProductService.getPlatformStats();
  const pendingClaims = await WarrantyService.getPendingClaimsCount();
  const claimsBadge = pendingClaims > 0 ? ` ⚠️ (<b>${pendingClaims} PENDING</b>)` : "";

  return (
    `🛠 <b>Admin Panel — Produk Digital & Stok</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `📦 <b>Total Produk:</b>       ${stats.totalProducts} (${stats.activeProducts} aktif)\n` +
    `📂 <b>Total Kategori:</b>     ${stats.totalCategories}\n` +
    `📊 <b>Stok Tersedia:</b>      ${stats.totalStockAvailable} item\n` +
    `🛍️ <b>Total Stok Terjual:</b> ${stats.totalStockSold} item\n` +
    `💰 <b>Total Pendapatan:</b>   ${formatPrice(stats.totalRevenue)}\n` +
    `🛡️ <b>Tiket Garansi:</b>     ${pendingClaims} tiket${claimsBadge}\n\n` +
    `Pilih menu di bawah untuk mengelola produk, stok, atau klaim garansi:`
  );
}

function buildDashboardKeyboard(pendingClaims = 0): InlineKeyboard {
  const claimsLabel = pendingClaims > 0 ? `🛡️ Tiket Garansi (${pendingClaims} Baru)` : `🛡️ Kelola Garansi`;
  return new InlineKeyboard()
    .text("📋 Kelola Produk & Stok", "dga_list_0")
    .row()
    .text("➕ Tambah Produk Baru", "dga_add_prompt")
    .row()
    .text(claimsLabel, "dga_claims_0")
    .row()
    .text("📊 Statistik Penjualan", "dga_stats")
    .row()
    .text("🔙 Panel SMS Admin", "adm_home");
}

async function buildClaimsListPage(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const claims = await WarrantyService.getPendingClaims(50);
  const totalPages = Math.max(1, Math.ceil(claims.length / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = claims.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  if (chunk.length === 0) {
    kb.text("🔙 Kembali ke Dashboard", "dga_home");
    return {
      text:
        `🛡️ <b>Daftar Tiket Klaim Garansi</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `<i>Saat ini tidak ada tiket klaim garansi yang pending. Semua klaim telah terselesaikan! 🎉</i>`,
      keyboard: kb,
    };
  }

  for (const clm of chunk) {
    kb.text(`🎫 ${clm.productName.slice(0, 16)} | ${clm.claimId.slice(-8)}`, `clm_view_${clm.claimId}`).row();
  }

  // Pagination row
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `dga_claims_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `dga_claims_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali ke Dashboard", "dga_home");

  const text =
    `🛡️ <b>Tiket Klaim Garansi Pending</b> — Halaman ${safePage + 1}/${totalPages}\n` +
    `${"─".repeat(30)}\n\n` +
    `Ditemukan <b>${claims.length} tiket</b> klaim yang menunggu persetujuan admin.\n` +
    `Klik salah satu tiket di bawah untuk melihat rincian & menentukan solusi (Ganti Stok / Refund / Tolak):`;

  return { text, keyboard: kb };
}

async function buildClaimDetailCard(claimId: string): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const claim = await WarrantyService.getClaimById(claimId);
  if (!claim) return null;

  const order = await DigitalOrder.findOne({ orderId: claim.orderId }).lean();
  const buyerUser = claim.userHandle ? `@${claim.userHandle}` : "—";
  const statusBadge =
    claim.status === "PENDING"
      ? "⏳ <b>PENDING (Menunggu Keputusan Admin)</b>"
      : claim.status === "APPROVED_REPLACE"
      ? "🔄 <b>DISETUJUI (Ganti Stok)</b>"
      : claim.status === "APPROVED_REFUND"
      ? "💰 <b>DISETUJUI (Refund Saldo)</b>"
      : "❌ <b>DITOLAK</b>";

  let extraDetails = "";
  if (claim.status === "APPROVED_REPLACE" && claim.replacementContent) {
    extraDetails = `\n🔑 <b>Stok Pengganti:</b>\n<code>${claim.replacementContent}</code>\n`;
  } else if (claim.status === "APPROVED_REFUND" && claim.refundAmount) {
    extraDetails = `\n💵 <b>Jumlah Refund:</b> Rp ${claim.refundAmount.toLocaleString("id-ID")}\n`;
  } else if (claim.status === "REJECTED" && claim.adminNote) {
    extraDetails = `\n💬 <b>Alasan Tolak:</b> <i>${claim.adminNote}</i>\n`;
  }

  const text =
    `🛡️ <b>Detail Tiket Klaim Garansi</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `🎫 <b>ID Tiket:</b>    <code>${claim.claimId}</code>\n` +
    `📦 <b>Order ID:</b>    <code>${claim.orderId}</code>\n` +
    `🏷️ <b>Produk:</b>      <b>${claim.productName}</b>\n` +
    `💰 <b>Harga Order:</b> Rp ${(order?.price ?? 0).toLocaleString("id-ID")}\n` +
    `👤 <b>Pembeli:</b>     <code>${claim.userId}</code> (${buyerUser})\n` +
    `📅 <b>Waktu Klaim:</b> ${claim.createdAt.toLocaleString("id-ID")}\n` +
    `⚙️ <b>Status:</b>      ${statusBadge}\n` +
    extraDetails +
    `\n🔑 <b>Data Akun Original:</b>\n<code>${claim.itemContentSnapshot}</code>\n\n` +
    `📝 <b>Keluhan Pembeli:</b>\n<i>${claim.reason}</i>\n`;

  const kb = new InlineKeyboard();

  if (claim.status === "PENDING") {
    kb.text("🔄 Ganti Stok (Replace)", `clm_rep_${claim.claimId}`)
      .row()
      .text("💰 Refund Saldo", `clm_ref_${claim.claimId}`)
      .row()
      .text("❌ Tolak Klaim", `clm_rej_${claim.claimId}`)
      .row();
  }

  kb.text("🔙 Daftar Tiket Garansi", "dga_claims_0");

  return { text, keyboard: kb };
}

async function buildProductListPage(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const allProducts = await DigitalProductService.getAllProducts({ onlyActive: false });
  const totalPages = Math.max(1, Math.ceil(allProducts.length / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = allProducts.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const kb = new InlineKeyboard();

  if (chunk.length === 0) {
    kb.text("➕ Tambah Produk Baru", "dga_add_prompt").row();
    kb.text("🔙 Kembali ke Dashboard", "dga_home");
    return {
      text:
        `📋 <b>Daftar Produk Digital</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `<i>Belum ada produk digital yang dibuat. Klik tombol di bawah untuk menambahkan produk pertama!</i>`,
      keyboard: kb,
    };
  }

  for (const prod of chunk) {
    const statusIcon = prod.isActive ? "🟢" : "🔴";
    const label = `${statusIcon} ${prod.name} | ${formatPrice(prod.price)} (Stok: ${prod.stockCount})`;
    kb.text(label, `dga_p_${prod.id}_${safePage}`).row();
  }

  // Pagination row
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `dga_list_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `dga_list_${safePage + 1}`);
    kb.row();
  }

  kb.text("➕ Tambah Produk", "dga_add_prompt").text("🔙 Dashboard", "dga_home");

  const text =
    `📋 <b>Kelola Produk Digital</b> — Halaman ${safePage + 1}/${totalPages}\n` +
    `${"─".repeat(30)}\n` +
    `🟢 = Aktif  |  🔴 = Nonaktif\n` +
    `Klik salah satu produk untuk menambah/melihat stok, mengubah harga, atau mengedit status.\n\n` +
    `<i>Total ${allProducts.length} produk terdaftar.</i>`;

  return { text, keyboard: kb };
}

async function buildProductDetailCard(productId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const prod = await DigitalProductService.getProductWithStock(productId);
  if (!prod) return null;

  const statusText = prod.isActive ? "🟢 <b>Aktif</b> (Tampil di katalog)" : "🔴 <b>Nonaktif</b> (Disembunyikan)";
  const warrantyText = WarrantyService.formatWarrantyText(prod.warrantyDuration, prod.warrantyUnit, prod.maxClaims);
  const desc = prod.description ? `\n📝 <b>Deskripsi:</b>\n${prod.description}\n` : "";
  const delivMsg = prod.deliveryMessage
    ? `\n💬 <b>Pesan Pengiriman:</b>\n<i>${prod.deliveryMessage}</i>\n`
    : `\n💬 <b>Pesan Pengiriman:</b> <i>(Belum disetel)</i>\n`;

  let bulkSummary = " <i>(Belum disetel)</i>\n";
  if (prod.bulkDiscounts && prod.bulkDiscounts.length > 0) {
    bulkSummary = "\n" + prod.bulkDiscounts.map((t) => {
      const discPct = prod.price > 0 ? Math.round(((prod.price - t.pricePerUnit) / prod.price) * 100) : 0;
      return `  • Beli ≥ ${t.minQty} item ➔ <b>${formatPrice(t.pricePerUnit)}</b>/item <i>(${discPct}% OFF)</i>`;
    }).join("\n") + "\n";
  }

  const text =
    `📦 <b>Detail Produk: ${prod.name}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `🆔 <b>ID Produk:</b>  <code>${prod.id}</code>\n` +
    `📂 <b>Kategori:</b>   ${prod.category}\n` +
    `💰 <b>Harga Normal:</b> <b>${formatPrice(prod.price)}</b>\n` +
    `🏷️ <b>Diskon Grosir:</b>${bulkSummary}` +
    `🛡️ <b>Garansi:</b>     <b>${warrantyText}</b>\n` +
    `⚙️ <b>Status:</b>      ${statusText}\n` +
    `📊 <b>Stok Sisa:</b>   <b>${prod.stockCount} item</b>\n` +
    `🛍️ <b>Terjual:</b>     ${prod.soldCount} item\n` +
    desc +
    delivMsg;

  const kb = new InlineKeyboard()
    .text("📥 ➕ Tambah Stok", `dga_stk_add_${prod.id}`)
    .text("📋 👀 Lihat Stok", `dga_stk_view_${prod.id}`)
    .row()
    .text("✏️ 💰 Ubah Harga", `dga_price_${prod.id}`)
    .text("🏷️ Atur Diskon Grosir", `dga_bulk_${prod.id}_${page}`)
    .row()
    .text("✏️ 📝 Ubah Deskripsi", `dga_desc_${prod.id}`)
    .text("✏️ 💬 Pesan Pengiriman", `dga_delivmsg_${prod.id}`)
    .row()
    .text("🛡️ Ubah Garansi", `dga_warr_${prod.id}_${page}`)
    .text("🔢 Ubah Max Klaim", `dga_mclm_${prod.id}_${page}`)
    .row()
    .text(prod.isActive ? "🔴 Nonaktifkan" : "🟢 Aktifkan", `dga_tgl_${prod.id}_${page}`)
    .text("🧹 Kosongkan Stok", `dga_stk_clr_${prod.id}`)
    .row()
    .text("🗑️ Hapus Produk", `dga_del_${prod.id}_${page}`)
    .row()
    .text("🔙 Kembali ke Daftar Produk", `dga_list_${page}`);

  return { text, keyboard: kb };
}

async function buildBulkDiscountsCard(productId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const prod = await DigitalProductService.getProductWithStock(productId);
  if (!prod) return null;

  const tiers = prod.bulkDiscounts || [];

  let text =
    `🏷️ <b>Kelola Diskon Grosir / Bulk Order: ${prod.name}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `💰 <b>Harga Normal Satuan:</b> <b>${formatPrice(prod.price)}</b>\n\n`;

  if (tiers.length === 0) {
    text += `<i>Belum ada tingkatan diskon grosir untuk produk ini.</i>\n\n`;
  } else {
    text += `<b>Daftar Tingkatan Grosir Aktif (${tiers.length} tier):</b>\n`;
    tiers.forEach((t, idx) => {
      const discAmount = Math.max(0, prod.price - t.pricePerUnit);
      const discPct = prod.price > 0 ? Math.round((discAmount / prod.price) * 100) : 0;
      text += `<b>${idx + 1}.</b> Beli ≥ <b>${t.minQty} item</b> ➔ <b>${formatPrice(t.pricePerUnit)}</b>/item <i>(Hemat ${formatPrice(discAmount)} | ${discPct}% OFF)</i>\n`;
    });
    text += `\n`;
  }

  text += `<i>Klik tombol di bawah untuk menambah tier grosir baru atau menghapus tier yang sudah ada.</i>`;

  const kb = new InlineKeyboard();

  // Individual delete buttons
  for (const t of tiers) {
    kb.text(`🗑️ Hapus Tier (≥${t.minQty}x @ ${formatPrice(t.pricePerUnit)})`, `dga_bulk_del_${prod.id}_${t.minQty}_${page}`).row();
  }

  kb.text("➕ Tambah Tier Grosir", `dga_bulk_add_${prod.id}_${page}`).row();

  if (tiers.length > 0) {
    kb.text("🧹 Hapus Semua Tier", `dga_bulk_clr_${prod.id}_${page}`).row();
  }

  kb.text("🔙 Kembali ke Detail Produk", `dga_p_${prod.id}_${page}`);

  return { text, keyboard: kb };
}

// ── Plugin Definition ─────────────────────────────────────────────────────────

const digiAdminPlugin: Plugin = {
  name: "digiadmin",
  version: "1.0.0",

  commands: [
    { command: "digiadmin", description: "[Admin] Buka panel manajemen produk digital & stok" },
    { command: "garansi", description: "[Admin] Kelola tiket klaim garansi pending" },
    { command: "claims", description: "[Admin] Alias perintah /garansi" },
    { command: "setwarranty", description: "[Admin] Ubah garansi: /setwarranty <id_produk> <durasi>" },
    { command: "setmaxclaims", description: "[Admin] Ubah batas klaim: /setmaxclaims <id_produk> <jumlah>" },
    { command: "addproduct", description: "[Admin] Tambah produk: /addproduct <kategori> | <nama> | <harga> | <deskripsi> | <garansi> | <maxKlaim>" },
    { command: "addstock", description: "[Admin] Tambah stok: /addstock <id_produk>" },
    { command: "listproducts", description: "[Admin] Lihat daftar semua produk digital" },
    { command: "delproduct", description: "[Admin] Hapus produk: /delproduct <id_produk>" },
    { command: "editprice", description: "[Admin] Ubah harga: /editprice <id_produk> <harga>" },
    { command: "editdesc", description: "[Admin] Ubah deskripsi: /editdesc <id_produk> <deskripsi>" },
    { command: "editpesan", description: "[Admin] Ubah pesan pengiriman: /editpesan <id_produk> <pesan>" },
    { command: "setbulk", description: "[Admin] Atur tier diskon grosir: /setbulk <id_produk> <min_qty> <harga_atau_persen>" },
    { command: "delbulk", description: "[Admin] Hapus tier grosir: /delbulk <id_produk> [min_qty/all]" },
    { command: "bulklist", description: "[Admin] Lihat daftar tier grosir: /bulklist <id_produk>" },
    { command: "viewstock", description: "[Admin] Lihat stok belum terjual: /viewstock <id_produk>" },
    { command: "clearstock", description: "[Admin] Kosongkan stok belum terjual: /clearstock <id_produk>" },
  ],

  register(bot: Bot<Context>): void {

    // ── /digiadmin — Main Dashboard ──────────────────────────────────────────
    bot.command("digiadmin", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      adminInputState.delete(String(ctx.from?.id));
      const pendingClaims = await WarrantyService.getPendingClaimsCount();
      await ctx.reply(await buildDashboardText(), {
        parse_mode: "HTML",
        reply_markup: buildDashboardKeyboard(pendingClaims),
      });
    });

    // ── dga_home ────────────────────────────────────────────────────────────
    bot.callbackQuery("dga_home", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));
      const pendingClaims = await WarrantyService.getPendingClaimsCount();
      await ctx.editMessageText(await buildDashboardText(), {
        parse_mode: "HTML",
        reply_markup: buildDashboardKeyboard(pendingClaims),
      });
    });

    // ── dga_list_<page> ─────────────────────────────────────────────────────
    bot.callbackQuery(/^dga_list_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));

      const page = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildProductListPage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch { /* ignore unchanged */ }
    });

    // ── dga_stats ───────────────────────────────────────────────────────────
    bot.callbackQuery("dga_stats", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const stats = await DigitalProductService.getPlatformStats();
      const text =
        `📊 <b>Statistik Penjualan Produk Digital</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `📦 <b>Total Produk Terdaftar:</b> ${stats.totalProducts}\n` +
        `🟢 <b>Produk Aktif di Katalog:</b> ${stats.activeProducts}\n` +
        `📂 <b>Jumlah Kategori:</b>        ${stats.totalCategories}\n\n` +
        `📊 <b>Stok Tersedia Saat Ini:</b> ${stats.totalStockAvailable} item\n` +
        `🛍️ <b>Total Stok Terjual:</b>     ${stats.totalStockSold} item\n` +
        `💰 <b>Total Omset Penjualan:</b>  <b>${formatPrice(stats.totalRevenue)}</b>`;

      const kb = new InlineKeyboard()
        .text("📊 Statistik Bot Lengkap", "adm_stats_overview")
        .row()
        .text("🔙 Kembali ke Dashboard", "dga_home");
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    });

    // ── dga_p_<id>_<page> — View single product details ─────────────────────
    bot.callbackQuery(/^dga_p_([a-f0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));

      const productId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);

      const card = await buildProductDetailCard(productId, page);
      if (!card) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
    });

    // ── dga_tgl_<id>_<page> — Toggle active/inactive ────────────────────────
    bot.callbackQuery(/^dga_tgl_([a-f0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      await DigitalProductService.updateProduct(productId, { isActive: !prod.isActive });

      const card = await buildProductDetailCard(productId, page);
      if (card) {
        try {
          await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
        } catch { /* ignore */ }
      }
    });

    // ── dga_del_<id>_<page> — Delete product ────────────────────────────────
    bot.callbackQuery(/^dga_del_([a-f0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      const kb = new InlineKeyboard()
        .text("⚠️ Ya, Hapus Produk Ini", `dga_delconf_${productId}_${page}`)
        .row()
        .text("❌ Batal", `dga_p_${productId}_${page}`);

      await ctx.editMessageText(
        `⚠️ <b>Konfirmasi Hapus Produk</b>\n\n` +
        `Apakah kamu yakin ingin menghapus produk <b>${prod.name}</b>?\n` +
        `<i>Semua stok yang belum terjual (${prod.stockCount} item) juga akan ikut dihapus.</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_delconf_<id>_<page> — Confirm delete product ────────────────────
    bot.callbackQuery(/^dga_delconf_([a-f0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Produk berhasil dihapus." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);

      await DigitalProductService.deleteProduct(productId);

      const { text, keyboard } = await buildProductListPage(page);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── dga_stk_add_<id> — Prompt to add stock ──────────────────────────────
    bot.callbackQuery(/^dga_stk_add_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "ADD_STOCK",
        productId,
      });

      const kb = new InlineKeyboard().text("❌ Batal Tambah Stok", `dga_p_${productId}_0`);

      await ctx.reply(
        `📥 <b>Tambah Stok: ${prod.name}</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `Kirimkan data stok yang ingin ditambahkan.\n` +
        `Bisa mengirim banyak stok sekaligus (<b>1 baris = 1 item stok</b>).\n\n` +
        `<b>Contoh format:</b>\n` +
        `<code>akun1@gmail.com:password123\nakun2@gmail.com:password456\nakun3@gmail.com:password789</code>\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_stk_view_<id> — View unsold stock ────────────────────────────────
    bot.callbackQuery(/^dga_stk_view_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      const stockItems = await DigitalProductService.getUnsoldStock(productId, 30);

      if (stockItems.length === 0) {
        await ctx.reply(
          `📋 <b>Stok Produk: ${prod.name}</b>\n\n` +
          `<i>Tidak ada stok yang tersedia saat ini.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let text =
        `📋 <b>Daftar Stok Belum Terjual: ${prod.name} (${stockItems.length} item)</b>\n` +
        `${"─".repeat(30)}\n\n`;

      stockItems.forEach((stk, idx) => {
        text += `${idx + 1}. <code>${stk.content}</code>\n`;
      });

      await ctx.reply(text, { parse_mode: "HTML" });
    });

    // ── dga_stk_clr_<id> — Clear unsold stock confirmation ───────────────────
    bot.callbackQuery(/^dga_stk_clr_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      const kb = new InlineKeyboard()
        .text("🧹 Ya, Kosongkan Semua Stok", `dga_stk_clrconf_${productId}`)
        .row()
        .text("❌ Batal", `dga_p_${productId}_0`);

      await ctx.editMessageText(
        `⚠️ <b>Konfirmasi Kosongkan Stok</b>\n\n` +
        `Apakah kamu yakin ingin menghapus SEMUA stok belum terjual (${prod.stockCount} item) untuk produk <b>${prod.name}</b>?`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_stk_clrconf_<id> — Execute clear stock ──────────────────────────
    bot.callbackQuery(/^dga_stk_clrconf_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Stok berhasil dikosongkan." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const deletedCount = await DigitalProductService.clearUnsoldStock(productId);

      await ctx.reply(`✅ <b>${deletedCount} item stok berhasil dikosongkan.</b>`, { parse_mode: "HTML" });

      const card = await buildProductDetailCard(productId, 0);
      if (card) {
        await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── dga_price_<id> — Edit price prompt ──────────────────────────────────
    bot.callbackQuery(/^dga_price_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "EDIT_PRICE",
        productId,
      });

      const kb = new InlineKeyboard().text("❌ Batal", `dga_p_${productId}_0`);

      await ctx.reply(
        `✏️ <b>Ubah Harga Produk: ${prod.name}</b>\n` +
        `Harga saat ini: <b>${formatPrice(prod.price)}</b>\n\n` +
        `Kirimkan nominal harga baru (hanya angka, misal: <code>25000</code>):`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_desc_<id> — Edit description prompt ─────────────────────────────
    bot.callbackQuery(/^dga_desc_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "EDIT_DESC",
        productId,
      });

      const kb = new InlineKeyboard()
        .text("🗑️ Kosongkan Deskripsi", `dga_desc_clear_${productId}`)
        .row()
        .text("❌ Batal", `dga_p_${productId}_0`);

      const currentDesc = prod.description ? `\n<i>${prod.description}</i>\n` : " <i>(Belum ada deskripsi)</i>\n";

      await ctx.reply(
        `✏️ <b>Ubah Deskripsi Produk: ${prod.name}</b>\n\n` +
        `📝 <b>Deskripsi Saat Ini:</b>${currentDesc}\n` +
        `Kirimkan teks deskripsi baru untuk produk ini melalui chat, atau klik tombol di bawah untuk mengosongkan deskripsi:`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_desc_clear_<id> — Clear description ──────────────────────────────
    bot.callbackQuery(/^dga_desc_clear_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Deskripsi dikosongkan." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      adminInputState.delete(String(ctx.from?.id));

      const updated = await DigitalProductService.updateProduct(productId, { description: "" });
      await ctx.reply(`✅ <b>Deskripsi untuk produk ${updated?.name ?? "—"} berhasil dikosongkan!</b>`, { parse_mode: "HTML" });

      const card = await buildProductDetailCard(productId, 0);
      if (card) {
        await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── dga_delivmsg_<id> — Edit delivery message prompt ────────────────────
    bot.callbackQuery(/^dga_delivmsg_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "EDIT_DELIVERY_MSG",
        productId,
      });

      const kb = new InlineKeyboard()
        .text("🗑️ Hapus Pesan Kirim", `dga_delivmsg_clear_${productId}`)
        .row()
        .text("❌ Batal", `dga_p_${productId}_0`);

      const currentMsg = prod.deliveryMessage
        ? `\n<i>${prod.deliveryMessage}</i>\n`
        : " <i>(Belum ada pesan pengiriman)</i>\n";

      await ctx.reply(
        `✏️ <b>Ubah Pesan Pengiriman Produk: ${prod.name}</b>\n\n` +
        `💬 <b>Pesan Pengiriman Saat Ini:</b>${currentMsg}\n` +
        `Pesan ini akan otomatis dikirimkan ke pembeli bersama dengan item produk yang dibeli.\n\n` +
        `Kirimkan teks pesan pengiriman baru melalui chat (atau ketik <code>-</code> / klik tombol di bawah untuk mengosongkan):`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_delivmsg_clear_<id> — Clear delivery message ────────────────────
    bot.callbackQuery(/^dga_delivmsg_clear_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Pesan pengiriman dikosongkan." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      adminInputState.delete(String(ctx.from?.id));

      const updated = await DigitalProductService.updateProduct(productId, { deliveryMessage: "" });
      await ctx.reply(`✅ <b>Pesan pengiriman untuk produk ${updated?.name ?? "—"} berhasil dikosongkan!</b>`, { parse_mode: "HTML" });

      const card = await buildProductDetailCard(productId, 0);
      if (card) {
        await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── dga_warr_<id>_<page> — Edit warranty prompt ─────────────────────────
    bot.callbackQuery(/^dga_warr_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "EDIT_WARRANTY",
        productId,
        page,
      });

      const currentWarr = WarrantyService.formatWarrantyText(prod.warrantyDuration, prod.warrantyUnit, prod.maxClaims);
      const kb = new InlineKeyboard()
        .text("🚫 Hapus / Tanpa Garansi", `dga_warr_clear_${productId}_${page}`)
        .row()
        .text("❌ Batal", `dga_p_${productId}_${page}`);

      await ctx.reply(
        `🛡️ <b>Ubah Durasi Garansi: ${prod.name}</b>\n\n` +
        `Garansi Saat Ini: <b>${currentWarr}</b>\n\n` +
        `Ketikkan durasi garansi baru ke chat ini.\n` +
        `<b>Contoh Format:</b>\n` +
        `• <code>24 jam</code> / <code>24h</code>\n` +
        `• <code>7 hari</code> / <code>7d</code>\n` +
        `• <code>2 minggu</code> / <code>2w</code>\n` +
        `• <code>1 bulan</code> / <code>1m</code>\n` +
        `• <code>0</code> (Tanpa garansi)`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_warr_clear_<id>_<page> — Clear warranty ──────────────────────────
    bot.callbackQuery(/^dga_warr_clear_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Garansi dinonaktifkan." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;
      adminInputState.delete(String(ctx.from?.id));

      await DigitalProductService.updateProduct(productId, {
        warrantyDuration: 0,
        warrantyUnit: "NONE",
      });

      await ctx.reply(`✅ <b>Garansi untuk produk ini telah dinonaktifkan (Tanpa Garansi).</b>`, { parse_mode: "HTML" });

      const card = await buildProductDetailCard(productId, page);
      if (card) {
        await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── dga_mclm_<id>_<page> — Edit max claims prompt ───────────────────────
    bot.callbackQuery(/^dga_mclm_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "EDIT_MAX_CLAIMS",
        productId,
        page,
      });

      const kb = new InlineKeyboard().text("❌ Batal", `dga_p_${productId}_${page}`);

      await ctx.reply(
        `🔢 <b>Ubah Batas Maksimal Klaim: ${prod.name}</b>\n\n` +
        `Batas Saat Ini: <b>${prod.maxClaims ?? 1}x klaim</b> per order.\n\n` +
        `Kirimkan angka batas klaim baru (misal: <code>1</code>, <code>2</code>, <code>3</code>):`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_bulk_<id>_<page> — View and manage bulk discounts ───────────────
    bot.callbackQuery(/^dga_bulk_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;

      const card = await buildBulkDiscountsCard(productId, page);
      if (!card) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
    });

    // ── dga_bulk_add_<id>_<page> — Prompt to add wholesale tier ─────────────
    bot.callbackQuery(/^dga_bulk_add_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "ADD_BULK_TIER",
        productId,
        page,
      });

      const kb = new InlineKeyboard().text("❌ Batal", `dga_bulk_${productId}_${page}`);

      await ctx.reply(
        `🏷️ <b>Tambah Tier Diskon Grosir: ${prod.name}</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `💰 <b>Harga Normal:</b> ${formatPrice(prod.price)}\n\n` +
        `Kirimkan data tier dengan format:\n` +
        `<code>&lt;min_jumlah&gt; &lt;harga_satuan_atau_persen&gt;</code>\n\n` +
        `<b>Contoh Input:</b>\n` +
        `• <code>5 8000</code> <i>(Beli ≥5 item, harga Rp 8.000/item)</i>\n` +
        `• <code>10 20%</code> <i>(Beli ≥10 item, diskon 20% dari harga normal)</i>\n` +
        `• <code>25 6000</code> <i>(Beli ≥25 item, harga Rp 6.000/item)</i>\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_bulk_del_<id>_<minQty>_<page> — Delete specific tier ────────────
    bot.callbackQuery(/^dga_bulk_del_([a-f0-9]+)_(\d+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Tier grosir dihapus." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const minQty = parseInt(ctx.match[2]!, 10);
      const page = ctx.match[3] ? parseInt(ctx.match[3], 10) : 0;

      await DigitalProductService.removeBulkDiscountTier(productId, minQty);

      const card = await buildBulkDiscountsCard(productId, page);
      if (card) {
        try {
          await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
        } catch { /* ignore unchanged */ }
      }
    });

    // ── dga_bulk_clr_<id>_<page> — Confirmation to clear all tiers ──────────
    bot.callbackQuery(/^dga_bulk_clr_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;
      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) return;

      const kb = new InlineKeyboard()
        .text("🧹 Ya, Hapus Semua Tier", `dga_bulk_clrconf_${productId}_${page}`)
        .row()
        .text("❌ Batal", `dga_bulk_${productId}_${page}`);

      await ctx.editMessageText(
        `⚠️ <b>Konfirmasi Hapus Semua Tier Grosir</b>\n\n` +
        `Apakah kamu yakin ingin menghapus SEMUA tier diskon grosir untuk produk <b>${prod.name}</b>?`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dga_bulk_clrconf_<id>_<page> — Execute clear all tiers ──────────────
    bot.callbackQuery(/^dga_bulk_clrconf_([a-f0-9]+)(?:_(\d+))?$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Semua tier grosir berhasil dihapus." });
      if (!isAdmin(ctx)) return;

      const productId = ctx.match[1]!;
      const page = ctx.match[2] ? parseInt(ctx.match[2], 10) : 0;

      await DigitalProductService.clearBulkDiscounts(productId);

      const card = await buildBulkDiscountsCard(productId, page);
      if (card) {
        await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── dga_claims_<page> — List pending claims ──────────────────────────────
    bot.callbackQuery(/^dga_claims_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));

      const page = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildClaimsListPage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    });

    // ── clm_view_<claimId> — View single claim details ──────────────────────
    bot.callbackQuery(/^clm_view_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const claimId = ctx.match[1]!;
      const card = await buildClaimDetailCard(claimId);
      if (!card) {
        await ctx.reply("❌ Tiket klaim tidak ditemukan.");
        return;
      }

      try {
        await ctx.editMessageText(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      } catch {
        await ctx.reply(card.text, { parse_mode: "HTML", reply_markup: card.keyboard });
      }
    });

    // ── clm_rep_<claimId> — Admin approve claim via replace stock ───────────
    bot.callbackQuery(/^clm_rep_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const claimId = ctx.match[1]!;
      const adminId = String(ctx.from?.id);
      const res = await WarrantyService.resolveReplace({ claimId, adminId, api: ctx.api });

      if (!res.success) {
        await ctx.reply(`⚠️ ${res.message}`);
        return;
      }

      await ctx.reply(res.message, {
        reply_markup: new InlineKeyboard().text("🔙 Daftar Tiket Garansi", "dga_claims_0"),
      });
    });

    // ── clm_ref_<claimId> — Admin approve claim via refund ──────────────────
    bot.callbackQuery(/^clm_ref_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const claimId = ctx.match[1]!;
      const adminId = String(ctx.from?.id);
      const res = await WarrantyService.resolveRefund({ claimId, adminId, api: ctx.api });

      if (!res.success) {
        await ctx.reply(`⚠️ ${res.message}`);
        return;
      }

      await ctx.reply(res.message, {
        reply_markup: new InlineKeyboard().text("🔙 Daftar Tiket Garansi", "dga_claims_0"),
      });
    });

    // ── clm_rej_<claimId> — Admin prompt for reject reason ──────────────────
    bot.callbackQuery(/^clm_rej_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const claimId = ctx.match[1]!;
      adminInputState.set(String(ctx.from?.id), {
        action: "REJECT_CLAIM",
        claimId,
      });

      const kb = new InlineKeyboard()
        .text("❌ Tolak Tanpa Alasan Khusus", `clm_rej_default_${claimId}`)
        .row()
        .text("🔙 Batal", `clm_view_${claimId}`);

      await ctx.reply(
        `❌ <b>Tolak Klaim Garansi #${claimId}</b>\n\n` +
        `Ketikkan alasan penolakan melalui chat sekarang (alasan ini akan dikirimkan kepada pembeli):\n\n` +
        `<i>Atau klik tombol di bawah untuk menolak dengan alasan standar.</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── clm_rej_default_<claimId> — Admin reject with default note ──────────
    bot.callbackQuery(/^clm_rej_default_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const claimId = ctx.match[1]!;
      const adminId = String(ctx.from?.id);
      adminInputState.delete(adminId);

      const res = await WarrantyService.resolveReject({
        claimId,
        adminId,
        rejectReason: "Klaim tidak memenuhi syarat & ketentuan garansi.",
        api: ctx.api,
      });

      await ctx.reply(res.message, {
        reply_markup: new InlineKeyboard().text("🔙 Daftar Tiket Garansi", "dga_claims_0"),
      });
    });

    // ── dga_add_prompt — Add product prompt ─────────────────────────────────
    bot.callbackQuery("dga_add_prompt", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      adminInputState.set(String(ctx.from?.id), {
        action: "ADD_PRODUCT",
      });

      const kb = new InlineKeyboard().text("❌ Batal", "dga_home");

      await ctx.reply(
        `➕ <b>Tambah Produk Digital Baru</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `Kirimkan data produk dengan format:\n` +
        `<code>Kategori | Nama Produk | Harga | Deskripsi</code>\n\n` +
        `<b>Contoh:</b>\n` +
        `<code>Streaming | Netflix Premium 1 Bulan | 25000 | Akun sharing 1 profile, garansi 30 hari</code>\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── Text message handler for interactive admin input ────────────────────
    bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (!from || !isAdmin(ctx)) return next();

      const adminId = String(from.id);
      const state = adminInputState.get(adminId);
      if (!state) return next();

      const text = ctx.message.text.trim();

      // If user typed a command instead, cancel state and pass through
      if (text.startsWith("/")) {
        adminInputState.delete(adminId);
        return next();
      }

      // ── Handle ADD_STOCK ───────────────────────────────────────────────────
      if (state.action === "ADD_STOCK" && state.productId) {
        adminInputState.delete(adminId);
        try {
          const { added, lines } = await DigitalProductService.addStockBulk(state.productId, text, ctx.api);
          const prod = await DigitalProductService.getProductWithStock(state.productId);

          await ctx.reply(
            `✅ <b>Berhasil Menambahkan ${added} Item Stok!</b>\n\n` +
            `📦 Produk: <b>${prod?.name ?? "—"}</b>\n` +
            `📊 Total Stok Sekarang: <b>${prod?.stockCount ?? added} item</b>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_0`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal menambah stok: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle EDIT_PRICE ──────────────────────────────────────────────────
      if (state.action === "EDIT_PRICE" && state.productId) {
        adminInputState.delete(adminId);
        const price = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (isNaN(price) || price < 0) {
          await ctx.reply("⚠️ Format harga tidak valid. Masukkan angka positif (misal: <code>25000</code>).", { parse_mode: "HTML" });
          return;
        }

        try {
          const updated = await DigitalProductService.updateProduct(state.productId, { price });
          await ctx.reply(
            `✅ <b>Harga Berhasil Diperbarui!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? "—"}</b>\n` +
            `💰 Harga Baru: <b>${formatPrice(price)}</b>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_0`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal mengubah harga: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle EDIT_DESC ───────────────────────────────────────────────────
      if (state.action === "EDIT_DESC" && state.productId) {
        adminInputState.delete(adminId);
        const newDesc = text === "-" ? "" : text;

        try {
          const updated = await DigitalProductService.updateProduct(state.productId, { description: newDesc });
          await ctx.reply(
            `✅ <b>Deskripsi Produk Berhasil Diperbarui!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? "—"}</b>\n` +
            `📝 Deskripsi Baru:\n${newDesc ? newDesc : "<i>(Kosong)</i>"}`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_0`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal mengubah deskripsi: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle EDIT_DELIVERY_MSG ───────────────────────────────────────────
      if (state.action === "EDIT_DELIVERY_MSG" && state.productId) {
        adminInputState.delete(adminId);
        const newMsg = text === "-" ? "" : text;

        try {
          const updated = await DigitalProductService.updateProduct(state.productId, { deliveryMessage: newMsg });
          await ctx.reply(
            `✅ <b>Pesan Pengiriman Berhasil Diperbarui!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? "—"}</b>\n` +
            `💬 Pesan Pengiriman:\n${newMsg ? newMsg : "<i>(Kosong)</i>"}\n\n` +
            `<i>Pesan ini akan otomatis dikirimkan kepada pembeli saat transaksi produk ini berhasil.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_0`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal mengubah pesan pengiriman: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle EDIT_WARRANTY ──────────────────────────────────────────────
      if (state.action === "EDIT_WARRANTY" && state.productId) {
        adminInputState.delete(adminId);
        const parsed = parseWarrantyInput(text);
        if (!parsed) {
          await ctx.reply(
            `⚠️ Format garansi tidak dikenali.\n\n` +
            `Gunakan format angka + satuan, contoh:\n` +
            `• <code>24 jam</code> / <code>24h</code>\n` +
            `• <code>7 hari</code> / <code>7d</code>\n` +
            `• <code>2 minggu</code> / <code>2w</code>\n` +
            `• <code>1 bulan</code> / <code>1m</code>\n` +
            `• <code>0</code> (Tanpa garansi)`,
            { parse_mode: "HTML" }
          );
          return;
        }

        try {
          const updated = await DigitalProductService.updateProduct(state.productId, {
            warrantyDuration: parsed.duration,
            warrantyUnit: parsed.unit,
          });

          const wText = WarrantyService.formatWarrantyText(parsed.duration, parsed.unit, updated?.maxClaims);
          await ctx.reply(
            `✅ <b>Garansi Produk Berhasil Diperbarui!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? "—"}</b>\n` +
            `🛡️ Garansi Baru: <b>${wText}</b>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_${state.page ?? 0}`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal mengubah garansi: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle EDIT_MAX_CLAIMS ────────────────────────────────────────────
      if (state.action === "EDIT_MAX_CLAIMS" && state.productId) {
        adminInputState.delete(adminId);
        const maxClaims = parseInt(text.replace(/[^0-9]/g, ""), 10);
        if (isNaN(maxClaims) || maxClaims <= 0) {
          await ctx.reply("⚠️ Batas maksimal klaim harus angka positif minimal 1 (contoh: <code>1</code>, <code>2</code>).", { parse_mode: "HTML" });
          return;
        }

        try {
          const updated = await DigitalProductService.updateProduct(state.productId, { maxClaims });
          await ctx.reply(
            `✅ <b>Batas Maksimal Klaim Berhasil Diperbarui!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? "—"}</b>\n` +
            `🔢 Batas Klaim Baru: <b>${maxClaims}x klaim</b> per order`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Buka Produk", `dga_p_${state.productId}_${state.page ?? 0}`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal mengubah batas klaim: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle REJECT_CLAIM ────────────────────────────────────────────────
      if (state.action === "REJECT_CLAIM" && state.claimId) {
        adminInputState.delete(adminId);
        const res = await WarrantyService.resolveReject({
          claimId: state.claimId,
          adminId,
          rejectReason: text,
          api: ctx.api,
        });

        await ctx.reply(res.message, {
          reply_markup: new InlineKeyboard().text("🔙 Daftar Tiket Garansi", "dga_claims_0"),
        });
        return;
      }

      // ── Handle ADD_PRODUCT ─────────────────────────────────────────────────
      if (state.action === "ADD_PRODUCT") {
        adminInputState.delete(adminId);
        const parts = text.split("|").map((p) => p.trim());
        if (parts.length < 3) {
          await ctx.reply(
            `⚠️ Format salah. Gunakan:\n<code>Kategori | Nama Produk | Harga | Deskripsi | Garansi (opsional) | MaxKlaim (opsional)</code>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const category = parts[0] || "Umum";
        const name = parts[1];
        const price = parseInt(parts[2]?.replace(/[^0-9]/g, "") || "", 10);
        const description = parts[3] || "";

        let warrantyDuration = 0;
        let warrantyUnit: WarrantyUnit = "NONE";
        let maxClaims = 1;

        if (parts.length >= 5 && parts[4]) {
          const parsed = parseWarrantyInput(parts[4]);
          if (parsed) {
            warrantyDuration = parsed.duration;
            warrantyUnit = parsed.unit;
          }
        }

        if (parts.length >= 6 && parts[5]) {
          const parsedClm = parseInt(parts[5].replace(/[^0-9]/g, ""), 10);
          if (!isNaN(parsedClm) && parsedClm > 0) {
            maxClaims = parsedClm;
          }
        }

        if (!name || isNaN(price) || price < 0) {
          await ctx.reply("⚠️ Nama produk atau harga tidak valid.");
          return;
        }

        try {
          const newProd = await DigitalProductService.createProduct({
            name,
            category,
            price,
            description,
            warrantyDuration,
            warrantyUnit,
            maxClaims,
          });

          const wText = WarrantyService.formatWarrantyText(warrantyDuration, warrantyUnit, maxClaims);

          await ctx.reply(
            `🎉 <b>Produk Berhasil Ditambahkan!</b>\n\n` +
            `🆔 ID: <code>${newProd._id}</code>\n` +
            `📂 Kategori: <b>${newProd.category}</b>\n` +
            `📦 Nama: <b>${newProd.name}</b>\n` +
            `💰 Harga: <b>${formatPrice(newProd.price)}</b>\n` +
            `🛡️ Garansi: <b>${wText}</b>\n` +
            `📝 Deskripsi: ${newProd.description || "—"}\n\n` +
            `<i>Jangan lupa menambahkan stok agar produk bisa dibeli!</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("📥 ➕ Tambah Stok Sekarang", `dga_stk_add_${newProd._id}`)
                .row()
                .text("🔙 Buka Produk", `dga_p_${newProd._id}_0`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal membuat produk: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      // ── Handle ADD_BULK_TIER ───────────────────────────────────────────────
      if (state.action === "ADD_BULK_TIER" && state.productId) {
        adminInputState.delete(adminId);
        const prod = await DigitalProductService.getProductWithStock(state.productId);
        if (!prod) {
          await ctx.reply("❌ Produk tidak ditemukan.");
          return;
        }

        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          await ctx.reply(
            `⚠️ Format salah! Gunakan: <code>&lt;min_jumlah&gt; &lt;harga_atau_persen&gt;</code>\n\n` +
            `Contoh:\n• <code>5 8000</code>\n• <code>10 20%</code>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const minQty = parseInt(parts[0]!.replace(/[^0-9]/g, ""), 10);
        if (isNaN(minQty) || minQty < 2) {
          await ctx.reply("⚠️ Minimal jumlah beli grosir harus minimal 2 item (contoh: <code>5</code>).", { parse_mode: "HTML" });
          return;
        }

        const valStr = parts[1]!.trim();
        let pricePerUnit = 0;

        if (valStr.includes("%")) {
          const pct = parseFloat(valStr.replace(/[^0-9.]/g, ""));
          if (isNaN(pct) || pct <= 0 || pct >= 100) {
            await ctx.reply("⚠️ Persentase diskon harus antara 1% s/d 99%.", { parse_mode: "HTML" });
            return;
          }
          pricePerUnit = Math.round(prod.price * (1 - pct / 100));
        } else {
          pricePerUnit = parseInt(valStr.replace(/[^0-9]/g, ""), 10);
        }

        if (isNaN(pricePerUnit) || pricePerUnit < 0 || pricePerUnit >= prod.price) {
          await ctx.reply(
            `⚠️ Harga grosir satuan harus lebih murah dari harga normal (${formatPrice(prod.price)}) dan tidak boleh bernilai negatif.\n` +
            `Nilai yang kamu masukkan: <b>${formatPrice(pricePerUnit)}</b>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        try {
          const updated = await DigitalProductService.addBulkDiscountTier(state.productId, minQty, pricePerUnit);
          const discPct = prod.price > 0 ? Math.round(((prod.price - pricePerUnit) / prod.price) * 100) : 0;
          await ctx.reply(
            `✅ <b>Tier Grosir Berhasil Ditambahkan!</b>\n\n` +
            `📦 Produk: <b>${updated?.name ?? prod.name}</b>\n` +
            `🏷️ Tier: Beli ≥ <b>${minQty} item</b> ➔ <b>${formatPrice(pricePerUnit)}</b>/item <i>(-${discPct}% OFF)</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Lihat Kelola Grosir", `dga_bulk_${state.productId}_${state.page ?? 0}`),
            }
          );
        } catch (err: any) {
          await ctx.reply(`❌ Gagal menambah tier grosir: ${err?.message || "Kesalahan internal."}`);
        }
        return;
      }

      return next();
    });

    // ── Command: /addproduct <cat> | <name> | <price> | <desc> | <garansi> | <maxKlaim>
    bot.command("addproduct", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/addproduct(?:@\S+)?\s*/i, "").trim();

      if (!content) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/addproduct Kategori | Nama Produk | Harga | Deskripsi | Garansi (opsional) | MaxKlaim (opsional)</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/addproduct Streaming | Netflix Premium 1 Bulan | 25000 | Akun sharing | 30 hari | 1</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const parts = content.split("|").map((p) => p.trim());
      if (parts.length < 3) {
        await ctx.reply("⚠️ Format harus menyertakan minimal: Kategori | Nama | Harga");
        return;
      }

      const category = parts[0] || "Umum";
      const name = parts[1];
      const price = parseInt(parts[2]?.replace(/[^0-9]/g, "") || "", 10);
      const description = parts[3] || "";

      let warrantyDuration = 0;
      let warrantyUnit: WarrantyUnit = "NONE";
      let maxClaims = 1;

      if (parts.length >= 5 && parts[4]) {
        const parsed = parseWarrantyInput(parts[4]);
        if (parsed) {
          warrantyDuration = parsed.duration;
          warrantyUnit = parsed.unit;
        }
      }

      if (parts.length >= 6 && parts[5]) {
        const parsedClm = parseInt(parts[5].replace(/[^0-9]/g, ""), 10);
        if (!isNaN(parsedClm) && parsedClm > 0) {
          maxClaims = parsedClm;
        }
      }

      if (!name || isNaN(price) || price < 0) {
        await ctx.reply("⚠️ Nama produk atau nominal harga tidak valid.");
        return;
      }

      try {
        const newProd = await DigitalProductService.createProduct({
          name,
          category,
          price,
          description,
          warrantyDuration,
          warrantyUnit,
          maxClaims,
        });

        const wText = WarrantyService.formatWarrantyText(warrantyDuration, warrantyUnit, maxClaims);

        await ctx.reply(
          `🎉 <b>Produk Digital Berhasil Dibuat!</b>\n\n` +
          `🆔 ID: <code>${newProd._id}</code>\n` +
          `📂 Kategori: <b>${newProd.category}</b>\n` +
          `📦 Nama: <b>${newProd.name}</b>\n` +
          `💰 Harga: <b>${formatPrice(newProd.price)}</b>\n` +
          `🛡️ Garansi: <b>${wText}</b>\n\n` +
          `<i>Gunakan <code>/addstock ${newProd._id}</code> atau tombol di bawah untuk mengisi stok.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📥 ➕ Tambah Stok", `dga_stk_add_${newProd._id}`),
          }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /garansi & /claims ──────────────────────────────────────────
    bot.command(["garansi", "claims"], async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const { text, keyboard } = await buildClaimsListPage(0);
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── Command: /setwarranty <id> <durasi> ──────────────────────────────────
    bot.command("setwarranty", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/setwarranty(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/);
      const productId = parts[0];
      const durationInput = parts.slice(1).join(" ").trim();

      if (!productId || !durationInput) {
        await ctx.reply(
          `⚠️ <b>Format:</b> <code>/setwarranty &lt;id_produk&gt; &lt;durasi&gt;</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `• <code>/setwarranty 66abc 30hari</code>\n` +
          `• <code>/setwarranty 66abc 24jam</code>\n` +
          `• <code>/setwarranty 66abc 2minggu</code>\n` +
          `• <code>/setwarranty 66abc 0</code> (Nonaktifkan garansi)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const parsed = parseWarrantyInput(durationInput);
      if (!parsed) {
        await ctx.reply("⚠️ Format durasi garansi tidak valid. Contoh: <code>30hari</code>, <code>24jam</code>, <code>1bulan</code>, <code>0</code>.", { parse_mode: "HTML" });
        return;
      }

      try {
        const updated = await DigitalProductService.updateProduct(productId, {
          warrantyDuration: parsed.duration,
          warrantyUnit: parsed.unit,
        });

        if (!updated) {
          await ctx.reply("❌ Produk tidak ditemukan.");
          return;
        }

        const wText = WarrantyService.formatWarrantyText(parsed.duration, parsed.unit, updated.maxClaims);
        await ctx.reply(`✅ <b>Garansi untuk ${updated.name} berhasil diubah menjadi: ${wText}!</b>`, { parse_mode: "HTML" });
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /setmaxclaims <id> <jumlah> ─────────────────────────────────
    bot.command("setmaxclaims", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/setmaxclaims(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/);
      const productId = parts[0];
      const maxClaims = parseInt(parts[1]?.replace(/[^0-9]/g, "") || "", 10);

      if (!productId || isNaN(maxClaims) || maxClaims <= 0) {
        await ctx.reply(
          `⚠️ <b>Format:</b> <code>/setmaxclaims &lt;id_produk&gt; &lt;jumlah_maksimal&gt;</code>\n\n` +
          `<b>Contoh:</b> <code>/setmaxclaims 66abc 2</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const updated = await DigitalProductService.updateProduct(productId, { maxClaims });
        if (!updated) {
          await ctx.reply("❌ Produk tidak ditemukan.");
          return;
        }

        await ctx.reply(`✅ <b>Batas klaim untuk ${updated.name} berhasil diubah menjadi maks. ${maxClaims}x klaim!</b>`, { parse_mode: "HTML" });
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /addstock <id_produk> [data_stok] ───────────────────────────
    bot.command("addstock", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/addstock(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/);
      const productId = parts[0];
      const stockPayload = content.substring(productId?.length ?? 0).trim();

      if (!productId) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/addstock &lt;id_produk&gt;</code> (akan muncul prompt)\n` +
          `atau\n` +
          `<code>/addstock &lt;id_produk&gt; &lt;item_stok_baris&gt;</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk dengan ID tersebut tidak ditemukan.");
        return;
      }

      if (!stockPayload) {
        // Prompt interactive
        adminInputState.set(String(ctx.from?.id), { action: "ADD_STOCK", productId });
        await ctx.reply(
          `📥 <b>Tambah Stok: ${prod.name}</b>\n\n` +
          `Kirimkan data stok (1 baris = 1 item) ke chat ini sekarang:`,
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const { added } = await DigitalProductService.addStockBulk(productId, stockPayload, ctx.api);
        const updated = await DigitalProductService.getProductWithStock(productId);
        await ctx.reply(
          `✅ <b>Berhasil menambahkan ${added} item stok untuk ${prod.name}!</b>\n` +
          `📊 Total stok sekarang: <b>${updated?.stockCount ?? added} item</b>`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /listproducts ───────────────────────────────────────────────
    bot.command("listproducts", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const products = await DigitalProductService.getAllProducts();
      if (products.length === 0) {
        await ctx.reply("ℹ️ Belum ada produk digital terdaftar.");
        return;
      }

      let msg =
        `📋 <b>Daftar Semua Produk Digital (${products.length} produk)</b>\n` +
        `${"─".repeat(30)}\n\n`;

      for (const p of products) {
        const status = p.isActive ? "🟢" : "🔴";
        msg +=
          `${status} <b>${p.name}</b> [${p.category}]\n` +
          `🆔 <code>${p.id}</code>\n` +
          `💰 ${formatPrice(p.price)} | 📊 Stok: <b>${p.stockCount}</b> | 🛍️ Terjual: <b>${p.soldCount}</b>\n\n`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    });

    // ── Command: /editprice <id> <price> ─────────────────────────────────────
    bot.command("editprice", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/editprice(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const productId = content[0];
      const priceVal = parseInt(content[1]?.replace(/[^0-9]/g, "") || "", 10);

      if (!productId || isNaN(priceVal) || priceVal < 0) {
        await ctx.reply("⚠️ Format: <code>/editprice &lt;id_produk&gt; &lt;harga_baru&gt;</code>", { parse_mode: "HTML" });
        return;
      }

      try {
        const updated = await DigitalProductService.updateProduct(productId, { price: priceVal });
        if (!updated) {
          await ctx.reply("❌ Produk tidak ditemukan.");
          return;
        }
        await ctx.reply(
          `✅ <b>Harga ${updated.name} berhasil diubah menjadi ${formatPrice(priceVal)}!</b>`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /editdesc <id> <desc> ───────────────────────────────────────
    bot.command("editdesc", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/editdesc(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/);
      const productId = parts[0];
      const newDesc = content.substring(productId?.length ?? 0).trim();

      if (!productId) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/editdesc &lt;id_produk&gt; &lt;deskripsi_baru&gt;</code>\n` +
          `atau\n` +
          `<code>/editdesc &lt;id_produk&gt;</code> (akan muncul prompt interaktif)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      if (!newDesc) {
        adminInputState.set(String(ctx.from?.id), { action: "EDIT_DESC", productId });
        const kb = new InlineKeyboard()
          .text("🗑️ Kosongkan Deskripsi", `dga_desc_clear_${productId}`)
          .row()
          .text("❌ Batal", `dga_p_${productId}_0`);

        const currentDesc = prod.description ? `\n<i>${prod.description}</i>\n` : " <i>(Belum ada deskripsi)</i>\n";

        await ctx.reply(
          `✏️ <b>Ubah Deskripsi Produk: ${prod.name}</b>\n\n` +
          `📝 <b>Deskripsi Saat Ini:</b>${currentDesc}\n` +
          `Kirimkan teks deskripsi baru untuk produk ini:`,
          { parse_mode: "HTML", reply_markup: kb }
        );
        return;
      }

      try {
        const descToSave = newDesc === "-" ? "" : newDesc;
        const updated = await DigitalProductService.updateProduct(productId, { description: descToSave });
        await ctx.reply(
          `✅ <b>Deskripsi ${updated?.name} berhasil diperbarui!</b>\n\n📝 Deskripsi Baru:\n${descToSave ? descToSave : "<i>(Kosong)</i>"}`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /editpesan <id> <pesan> ─────────────────────────────────────
    bot.command("editpesan", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/editpesan(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/);
      const productId = parts[0];
      const newMsg = content.substring(productId?.length ?? 0).trim();

      if (!productId) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/editpesan &lt;id_produk&gt; &lt;pesan_pengiriman&gt;</code>\n` +
          `atau\n` +
          `<code>/editpesan &lt;id_produk&gt;</code> (akan muncul prompt interaktif)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      if (!newMsg) {
        adminInputState.set(String(ctx.from?.id), { action: "EDIT_DELIVERY_MSG", productId });
        const kb = new InlineKeyboard()
          .text("🗑️ Hapus Pesan Kirim", `dga_delivmsg_clear_${productId}`)
          .row()
          .text("❌ Batal", `dga_p_${productId}_0`);

        const currentMsg = prod.deliveryMessage
          ? `\n<i>${prod.deliveryMessage}</i>\n`
          : " <i>(Belum ada pesan pengiriman)</i>\n";

        await ctx.reply(
          `✏️ <b>Ubah Pesan Pengiriman Produk: ${prod.name}</b>\n\n` +
          `💬 <b>Pesan Pengiriman Saat Ini:</b>${currentMsg}\n` +
          `Kirimkan teks pesan pengiriman baru untuk produk ini:`,
          { parse_mode: "HTML", reply_markup: kb }
        );
        return;
      }

      try {
        const msgToSave = newMsg === "-" ? "" : newMsg;
        const updated = await DigitalProductService.updateProduct(productId, { deliveryMessage: msgToSave });
        await ctx.reply(
          `✅ <b>Pesan pengiriman ${updated?.name} berhasil diperbarui!</b>\n\n💬 Pesan Pengiriman:\n${msgToSave ? msgToSave : "<i>(Kosong)</i>"}`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /delproduct <id> ────────────────────────────────────────────
    bot.command("delproduct", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const productId = raw.replace(/^\/delproduct(?:@\S+)?\s*/i, "").trim();

      if (!productId) {
        await ctx.reply("⚠️ Format: <code>/delproduct &lt;id_produk&gt;</code>", { parse_mode: "HTML" });
        return;
      }

      const res = await DigitalProductService.deleteProduct(productId);
      if (res.deleted) {
        await ctx.reply(`✅ Produk berhasil dihapus beserta ${res.stockDeleted} item stok yang belum terjual.`);
      } else {
        await ctx.reply("❌ Produk tidak ditemukan.");
      }
    });

    // ── Command: /viewstock <id> ─────────────────────────────────────────────
    bot.command("viewstock", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const productId = raw.replace(/^\/viewstock(?:@\S+)?\s*/i, "").trim();

      if (!productId) {
        await ctx.reply("⚠️ Format: <code>/viewstock &lt;id_produk&gt;</code>", { parse_mode: "HTML" });
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      const stocks = await DigitalProductService.getUnsoldStock(productId, 50);
      if (stocks.length === 0) {
        await ctx.reply(`ℹ️ Tidak ada stok tersisa untuk <b>${prod.name}</b>.`, { parse_mode: "HTML" });
        return;
      }

      let msg = `📋 <b>Stok Belum Terjual (${stocks.length} item): ${prod.name}</b>\n\n`;
      stocks.forEach((s, idx) => {
        msg += `${idx + 1}. <code>${s.content}</code>\n`;
      });

      await ctx.reply(msg, { parse_mode: "HTML" });
    });

    // ── Command: /clearstock <id> ────────────────────────────────────────────
    bot.command("clearstock", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const productId = raw.replace(/^\/clearstock(?:@\S+)?\s*/i, "").trim();

      if (!productId) {
        await ctx.reply("⚠️ Format: <code>/clearstock &lt;id_produk&gt;</code>", { parse_mode: "HTML" });
        return;
      }

      const deleted = await DigitalProductService.clearUnsoldStock(productId);
      await ctx.reply(`🧹 Berhasil menghapus <b>${deleted}</b> item stok belum terjual.`, { parse_mode: "HTML" });
    });

    // ── Command: /setbulk <id> <minQty> <harga_atau_persen> ─────────────────
    bot.command("setbulk", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/setbulk(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/).filter(Boolean);

      if (parts.length < 3) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/setbulk &lt;id_produk&gt; &lt;min_qty&gt; &lt;harga_atau_persen&gt;</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `• <code>/setbulk 66abc 5 8000</code> (Beli ≥5 item: Rp 8.000/item)\n` +
          `• <code>/setbulk 66abc 10 20%</code> (Beli ≥10 item: diskon 20%)\n` +
          `• <code>/setbulk 66abc 50 5000</code> (Beli ≥50 item: Rp 5.000/item)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const productId = parts[0]!;
      const minQty = parseInt(parts[1]!.replace(/[^0-9]/g, ""), 10);
      const valStr = parts[2]!.trim();

      if (isNaN(minQty) || minQty < 2) {
        await ctx.reply("⚠️ Minimal jumlah beli (minQty) harus minimal 2 item.");
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      let pricePerUnit = 0;
      if (valStr.includes("%")) {
        const pct = parseFloat(valStr.replace(/[^0-9.]/g, ""));
        if (isNaN(pct) || pct <= 0 || pct >= 100) {
          await ctx.reply("⚠️ Persentase diskon harus antara 1% s/d 99%.");
          return;
        }
        pricePerUnit = Math.round(prod.price * (1 - pct / 100));
      } else {
        pricePerUnit = parseInt(valStr.replace(/[^0-9]/g, ""), 10);
      }

      if (isNaN(pricePerUnit) || pricePerUnit < 0 || pricePerUnit >= prod.price) {
        await ctx.reply(
          `⚠️ Harga grosir satuan harus lebih murah dari harga normal (${formatPrice(prod.price)}) dan tidak boleh bernilai negatif.`
        );
        return;
      }

      try {
        const updated = await DigitalProductService.addBulkDiscountTier(productId, minQty, pricePerUnit);
        const discPct = prod.price > 0 ? Math.round(((prod.price - pricePerUnit) / prod.price) * 100) : 0;
        await ctx.reply(
          `✅ <b>Tier Grosir Berhasil Disetel!</b>\n\n` +
          `📦 Produk: <b>${updated?.name ?? prod.name}</b>\n` +
          `🏷️ Tier: Beli ≥ <b>${minQty} item</b> ➔ <b>${formatPrice(pricePerUnit)}</b>/item <i>(-${discPct}% OFF)</i>`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        await ctx.reply(`❌ Gagal: ${err?.message}`);
      }
    });

    // ── Command: /delbulk <id> [minQty/all] ──────────────────────────────────
    bot.command("delbulk", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const content = raw.replace(/^\/delbulk(?:@\S+)?\s*/i, "").trim();
      const parts = content.split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `• <code>/delbulk &lt;id_produk&gt; &lt;min_qty&gt;</code> (Hapus tier tertentu)\n` +
          `• <code>/delbulk &lt;id_produk&gt; all</code> (Hapus semua tier grosir)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const productId = parts[0]!;
      const target = parts[1];

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      if (!target || target.toLowerCase() === "all" || target.toLowerCase() === "semua") {
        await DigitalProductService.clearBulkDiscounts(productId);
        await ctx.reply(`🧹 Semua tier diskon grosir untuk <b>${prod.name}</b> berhasil dihapus.`, { parse_mode: "HTML" });
        return;
      }

      const minQty = parseInt(target.replace(/[^0-9]/g, ""), 10);
      if (isNaN(minQty)) {
        await ctx.reply("⚠️ Minimal jumlah beli (minQty) tidak valid.");
        return;
      }

      await DigitalProductService.removeBulkDiscountTier(productId, minQty);
      await ctx.reply(`✅ Tier grosir (≥${minQty} item) untuk <b>${prod.name}</b> berhasil dihapus.`, { parse_mode: "HTML" });
    });

    // ── Command: /bulklist <id> ──────────────────────────────────────────────
    bot.command("bulklist", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const productId = raw.replace(/^\/bulklist(?:@\S+)?\s*/i, "").trim();

      if (!productId) {
        await ctx.reply("⚠️ Format: <code>/bulklist &lt;id_produk&gt;</code>", { parse_mode: "HTML" });
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.reply("❌ Produk tidak ditemukan.");
        return;
      }

      const tiers = prod.bulkDiscounts || [];
      if (tiers.length === 0) {
        await ctx.reply(
          `🏷️ <b>Diskon Grosir: ${prod.name}</b>\n\n` +
          `💰 Harga Normal: ${formatPrice(prod.price)}\n` +
          `<i>Belum ada tingkatan diskon grosir untuk produk ini.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let msg =
        `🏷️ <b>Daftar Diskon Grosir: ${prod.name}</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `💰 <b>Harga Normal:</b> ${formatPrice(prod.price)}\n\n`;

      tiers.forEach((t, idx) => {
        const discAmount = Math.max(0, prod.price - t.pricePerUnit);
        const discPct = prod.price > 0 ? Math.round((discAmount / prod.price) * 100) : 0;
        msg += `<b>${idx + 1}.</b> Beli ≥ <b>${t.minQty} item</b> ➔ <b>${formatPrice(t.pricePerUnit)}</b>/item <i>(Hemat ${formatPrice(discAmount)} | ${discPct}% OFF)</i>\n`;
      });

      await ctx.reply(msg, { parse_mode: "HTML" });
    });

    console.log("   → /digiadmin, /garansi, /claims, /setwarranty, /setmaxclaims, /addproduct, /addstock, /listproducts, /delproduct, /editprice, /editdesc, /editpesan, /setbulk, /delbulk, /bulklist, /viewstock, /clearstock");
  },
};

export default digiAdminPlugin;
