import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { DigitalProductService, ProductWithStock } from "../../services/digitalProduct.js";

// ============================================================================
//  ADMIN PLUGIN — DIGITAL PRODUCTS & STOCK MANAGER
// ============================================================================

const ITEMS_PER_PAGE = 10;

interface AdminState {
  action: "ADD_STOCK" | "EDIT_PRICE" | "ADD_PRODUCT";
  productId?: string;
}

const adminInputState = new Map<string, AdminState>();

function isAdmin(ctx: Context): boolean {
  const adminId = process.env["ADMIN_ID"];
  if (!adminId) {
    console.warn("[digiadmin] ADMIN_ID env variable is not set — all admin commands are locked.");
    return false;
  }
  return String(ctx.from?.id) === adminId;
}

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

// ── UI Builders ───────────────────────────────────────────────────────────────

async function buildDashboardText(): Promise<string> {
  const stats = await DigitalProductService.getPlatformStats();
  return (
    `🛠 <b>Admin Panel — Produk Digital & Stok</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `📦 <b>Total Produk:</b>       ${stats.totalProducts} (${stats.activeProducts} aktif)\n` +
    `📂 <b>Total Kategori:</b>     ${stats.totalCategories}\n` +
    `📊 <b>Stok Tersedia:</b>      ${stats.totalStockAvailable} item\n` +
    `🛍️ <b>Total Stok Terjual:</b> ${stats.totalStockSold} item\n` +
    `💰 <b>Total Pendapatan:</b>   ${formatPrice(stats.totalRevenue)}\n\n` +
    `Pilih menu di bawah untuk mengelola produk dan stok:`
  );
}

function buildDashboardKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Kelola Produk & Stok", "dga_list_0")
    .row()
    .text("➕ Tambah Produk Baru", "dga_add_prompt")
    .row()
    .text("📊 Statistik Penjualan", "dga_stats")
    .row()
    .text("🔙 Panel SMS Admin", "adm_home");
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
  const desc = prod.description ? `\n📝 <b>Deskripsi:</b>\n${prod.description}\n` : "";

  const text =
    `📦 <b>Detail Produk: ${prod.name}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `🆔 <b>ID Produk:</b>  <code>${prod.id}</code>\n` +
    `📂 <b>Kategori:</b>   ${prod.category}\n` +
    `💰 <b>Harga Jual:</b>  <b>${formatPrice(prod.price)}</b>\n` +
    `⚙️ <b>Status:</b>      ${statusText}\n` +
    `📊 <b>Stok Sisa:</b>   <b>${prod.stockCount} item</b>\n` +
    `🛍️ <b>Terjual:</b>     ${prod.soldCount} item\n` +
    desc;

  const kb = new InlineKeyboard()
    .text("📥 ➕ Tambah Stok", `dga_stk_add_${prod.id}`)
    .text("📋 👀 Lihat Stok", `dga_stk_view_${prod.id}`)
    .row()
    .text("✏️ 💰 Ubah Harga", `dga_price_${prod.id}`)
    .text(prod.isActive ? "🔴 Nonaktifkan" : "🟢 Aktifkan", `dga_tgl_${prod.id}_${page}`)
    .row()
    .text("🧹 Kosongkan Stok", `dga_stk_clr_${prod.id}`)
    .text("🗑️ Hapus Produk", `dga_del_${prod.id}_${page}`)
    .row()
    .text("🔙 Kembali ke Daftar Produk", `dga_list_${page}`);

  return { text, keyboard: kb };
}

// ── Plugin Definition ─────────────────────────────────────────────────────────

const digiAdminPlugin: Plugin = {
  name: "digiadmin",
  version: "1.0.0",

  commands: [
    { command: "digiadmin", description: "[Admin] Buka panel manajemen produk digital & stok" },
    { command: "addproduct", description: "[Admin] Tambah produk: /addproduct <kategori> | <nama> | <harga> | <deskripsi>" },
    { command: "addstock", description: "[Admin] Tambah stok: /addstock <id_produk>" },
    { command: "listproducts", description: "[Admin] Lihat daftar semua produk digital" },
    { command: "delproduct", description: "[Admin] Hapus produk: /delproduct <id_produk>" },
    { command: "editprice", description: "[Admin] Ubah harga: /editprice <id_produk> <harga>" },
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
      await ctx.reply(await buildDashboardText(), {
        parse_mode: "HTML",
        reply_markup: buildDashboardKeyboard(),
      });
    });

    // ── dga_home ────────────────────────────────────────────────────────────
    bot.callbackQuery("dga_home", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      adminInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildDashboardText(), {
        parse_mode: "HTML",
        reply_markup: buildDashboardKeyboard(),
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
          const { added, lines } = await DigitalProductService.addStockBulk(state.productId, text);
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

      // ── Handle ADD_PRODUCT ─────────────────────────────────────────────────
      if (state.action === "ADD_PRODUCT") {
        adminInputState.delete(adminId);
        const parts = text.split("|").map((p) => p.trim());
        if (parts.length < 3) {
          await ctx.reply(
            `⚠️ Format salah. Gunakan:\n<code>Kategori | Nama Produk | Harga | Deskripsi</code>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const category = parts[0] || "Umum";
        const name = parts[1];
        const price = parseInt(parts[2]?.replace(/[^0-9]/g, "") || "", 10);
        const description = parts.slice(3).join(" | ").trim();

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
          });

          await ctx.reply(
            `🎉 <b>Produk Berhasil Ditambahkan!</b>\n\n` +
            `🆔 ID: <code>${newProd._id}</code>\n` +
            `📂 Kategori: <b>${newProd.category}</b>\n` +
            `📦 Nama: <b>${newProd.name}</b>\n` +
            `💰 Harga: <b>${formatPrice(newProd.price)}</b>\n` +
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

      return next();
    });

    // ── Command: /addproduct <cat> | <name> | <price> | <desc> ───────────────
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
          `<code>/addproduct Kategori | Nama Produk | Harga | Deskripsi</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/addproduct Streaming | Netflix Premium 1 Bulan | 25000 | Akun sharing garansi 30 hari</code>`,
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
      const description = parts.slice(3).join(" | ").trim();

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
        });

        await ctx.reply(
          `🎉 <b>Produk Digital Berhasil Dibuat!</b>\n\n` +
          `🆔 ID: <code>${newProd._id}</code>\n` +
          `📂 Kategori: <b>${newProd.category}</b>\n` +
          `📦 Nama: <b>${newProd.name}</b>\n` +
          `💰 Harga: <b>${formatPrice(newProd.price)}</b>\n\n` +
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
        const { added } = await DigitalProductService.addStockBulk(productId, stockPayload);
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

    console.log("   → /digiadmin, /addproduct, /addstock, /listproducts, /delproduct, /editprice, /viewstock, /clearstock");
  },
};

export default digiAdminPlugin;
