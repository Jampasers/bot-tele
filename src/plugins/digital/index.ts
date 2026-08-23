import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User, IUser } from "../../models/User.js";
import { DigitalProduct } from "../../models/DigitalProduct.js";
import { TopupSession, ITopupSession } from "../../models/TopupSession.js";
import { DigitalProductService, ProductWithStock } from "../../services/digitalProduct.js";
import { TestimonialService } from "../../services/testimonial.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { generateQris, checkSessionSettlement, getUniquePaymentAmount } from "../../services/payment/index.js";
import { CB_CATALOG, buildCatalogText, buildCatalogKeyboard } from "../panel/index.js";
import { RestockAlert } from "../../models/RestockAlert.js";
import { validatePromo, applyPromo } from "../../services/promo.js";
import { awardCommission } from "../../services/affiliate.js";
import { WarrantyService } from "../../services/warranty.js";

// ============================================================================
//  CONSTANTS & TIMINGS
// ============================================================================

const QRIS_POLL_INTERVAL_MS = 10_000;      // 10 seconds
const QRIS_TIMEOUT_MS = 14 * 60 * 1_000;  // 14 minutes
const ITEMS_PER_PAGE = 8;

const activeDigitalQrisPolls = new Map<string, NodeJS.Timeout>();

interface ManualQtyState {
  productId: string;
  catIdx: number;
  page: number;
}
const userManualQtyState = new Map<string, ManualQtyState>();

// Promo code input state
interface PromoInputState {
  productId: string;
  qty: number;
  catIdx: number;
  page: number;
}
const userPromoState = new Map<string, PromoInputState>();

// Active promo codes per user (validated but not yet applied)
interface ActivePromo {
  code: string;
  discountAmount: number;
  discountedPrice: number;
}
const userActivePromo = new Map<string, ActivePromo>();

// Warranty claim input state
interface ClaimInputState {
  orderId: string;
}
const userClaimState = new Map<string, ClaimInputState>();

function clearDigitalQrisPoll(orderId: string): void {
  const handle = activeDigitalQrisPolls.get(orderId);
  if (handle) {
    clearInterval(handle);
    activeDigitalQrisPolls.delete(orderId);
  }
}

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Helper to edit text or send a fresh message if the previous one is photo/deleted */
async function safeEditOrReply(
  ctx: Context,
  text: string,
  extra?: {
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    reply_markup?: InlineKeyboard;
  }
): Promise<void> {
  const isMedia = ctx.msg && (!("text" in ctx.msg) || !ctx.msg.text);

  if (isMedia) {
    try { await ctx.deleteMessage(); } catch { /* non-critical */ }
    await ctx.reply(text, extra as Parameters<Context["reply"]>[1]);
    return;
  }

  try {
    await ctx.editMessageText(text, extra);
  } catch (err: any) {
    if (err?.description?.includes("message is not modified")) return;
    try { await ctx.deleteMessage(); } catch { /* non-critical */ }
    await ctx.reply(text, extra as Parameters<Context["reply"]>[1]);
  }
}

// ============================================================================
//  UI BUILDERS
// ============================================================================

/** Main Digital Categories / Catalog Landing */
async function buildCategoriesView(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const categories = await DigitalProductService.getActiveCategories();
  const allProducts = await DigitalProductService.getAllProducts({ onlyActive: true });
  const totalStock = allProducts.reduce((sum, p) => sum + p.stockCount, 0);

  const text =
    `📦 <b>Katalog Produk Digital</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `Pilih kategori produk di bawah untuk melihat pilihan akun, lisensi, voucher, atau produk digital lainnya.\n\n` +
    `📊 <b>Total Produk Aktif:</b> ${allProducts.length} produk\n` +
    `📦 <b>Total Stok Tersedia:</b> ${totalStock} item\n\n` +
    `<i>⚡ Pengiriman instan otomatis begitu transaksi berhasil!</i>`;

  const kb = new InlineKeyboard();

  if (categories.length === 0) {
    kb.text("🔙 Kembali ke Katalog", CB_CATALOG);
    return {
      text:
        `📦 <b>Katalog Produk Digital</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `<i>Saat ini belum ada produk digital yang tersedia. Silakan cek lagi nanti.</i>`,
      keyboard: kb,
    };
  }

  // List categories
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    const prodsInCat = allProducts.filter((p) => p.category === cat);
    const catStock = prodsInCat.reduce((sum, p) => sum + p.stockCount, 0);
    kb.text(`📂 ${cat} (${prodsInCat.length} produk | stok: ${catStock})`, `dg_cat_${i}`).row();
  }

  kb.text("📜 Riwayat Pesanan Saya", "dg_myorders").row();
  kb.text("🔙 Kembali ke Menu Utama", CB_CATALOG);

  return { text, keyboard: kb };
}

/** Product List View under a selected category */
async function buildProductsView(
  categoryName: string,
  categoryIndex: number,
  page: number = 0
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const products = await DigitalProductService.getAllProducts({
    onlyActive: true,
    category: categoryName,
  });

  const totalPages = Math.max(1, Math.ceil(products.length / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = products.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const text =
    `📂 <b>Kategori: ${categoryName}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `Pilih produk di bawah untuk melihat detail dan melakukan pembelian:\n\n` +
    `<i>Halaman ${safePage + 1} dari ${totalPages}</i>`;

  const kb = new InlineKeyboard();

  if (chunk.length === 0) {
    kb.text("🔙 Kembali ke Kategori", "product_digital");
    return {
      text:
        `📂 <b>Kategori: ${categoryName}</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `<i>Tidak ada produk aktif dalam kategori ini.</i>`,
      keyboard: kb,
    };
  }

  for (const prod of chunk) {
    const icon = prod.stockCount > 0 ? "🟢" : "🔴";
    const label = `${icon} ${prod.name} — ${formatPrice(prod.price)} [Stok: ${prod.stockCount}]`;
    kb.text(label, `dg_p_${prod.id}_${categoryIndex}_${safePage}`).row();
  }

  // Pagination row
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `dg_catpg_${categoryIndex}_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `dg_catpg_${categoryIndex}_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali ke Kategori", "product_digital");

  return { text, keyboard: kb };
}

/** Product Detail View */
async function buildProductDetailView(
  productId: string,
  userBalance: number,
  categoryIndex: number,
  page: number
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const prod = await DigitalProductService.getProductWithStock(productId);
  if (!prod) return null;

  const stockStatus = prod.stockCount > 0 ? `🟢 <b>${prod.stockCount} item</b> (Tersedia)` : `🔴 <b>Habis</b>`;
  const warrantyText = WarrantyService.formatWarrantyText(prod.warrantyDuration, prod.warrantyUnit, prod.maxClaims);
  const desc = prod.description ? `\n📝 <b>Deskripsi:</b>\n${prod.description}\n` : "";

  let bulkSection = "";
  if (prod.bulkDiscounts && prod.bulkDiscounts.length > 0) {
    bulkSection = `\n🏷️ <b>Diskon Grosir / Beli Banyak:</b>\n`;
    for (const tier of prod.bulkDiscounts) {
      const discPct = prod.price > 0 ? Math.round(((prod.price - tier.pricePerUnit) / prod.price) * 100) : 0;
      const pctText = discPct > 0 ? ` <i>(Hemat ${discPct}%)</i>` : "";
      bulkSection += `• Beli ≥ <b>${tier.minQty} item</b>: <b>${formatPrice(tier.pricePerUnit)}</b>/item${pctText}\n`;
    }
  }

  const text =
    `📦 <b>${prod.name}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `📂 <b>Kategori:</b> ${prod.category}\n` +
    `💰 <b>Harga:</b>    <b>${formatPrice(prod.price)}</b>\n` +
    `🛡️ <b>Garansi:</b>  <b>${warrantyText}</b>\n` +
    `📊 <b>Stok:</b>     ${stockStatus}\n` +
    `🪙 <b>Saldo Anda:</b> ${formatPrice(userBalance)}\n` +
    bulkSection +
    desc +
    `\n<i>⚡ Data item akan langsung dikirim ke chat ini setelah dibeli.</i>`;

  const kb = new InlineKeyboard();

  if (prod.stockCount > 0 && prod.isActive) {
    kb.text(`🛒 Beli Produk (${formatPrice(prod.price)})`, `dg_qty_${prod.id}_1_${categoryIndex}_${page}`).row();
  } else {
    kb.text("❌ Stok Sedang Habis", "dg_noop").row();
    kb.text("🔔 Ingatkan Saat Restock", `dg_restock_${prod.id}`).row();
  }

  kb.text("🔙 Kembali ke Daftar", `dg_catpg_${categoryIndex}_${page}`);

  return { text, keyboard: kb };
}

/** Quantity Selector View */
async function buildQuantitySelectorView(
  productId: string,
  userBalance: number,
  quantity: number,
  categoryIndex: number,
  page: number
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const prod = await DigitalProductService.getProductWithStock(productId);
  if (!prod || !prod.isActive) return null;

  if (prod.stockCount <= 0) {
    const kb = new InlineKeyboard().text("🔙 Kembali", `dg_catpg_${categoryIndex}_${page}`);
    return {
      text:
        `📦 <b>${prod.name}</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `❌ <i>Maaf, stok produk ini baru saja habis.</i>`,
      keyboard: kb,
    };
  }

  // Safe quantity clamp: strictly positive integer between 1 and available stock
  const safeQty = Math.max(1, Math.min(prod.stockCount, Math.floor(quantity)));
  const pricing = DigitalProductService.calculatePricing(prod, safeQty);
  const totalPrice = pricing.totalPrice;
  const shortage = Math.max(0, totalPrice - userBalance);

  let unitPriceText = `💰 <b>Harga Satuan:</b>   <b>${formatPrice(prod.price)}</b>\n`;
  let discountLine = "";
  if (pricing.appliedTier) {
    unitPriceText = `💰 <b>Harga Satuan:</b>   <b>${formatPrice(pricing.unitPrice)}</b> (🎉 <i>Grosir min. ${pricing.appliedTier.minQty}x</i>)\n`;
    discountLine = `✨ <b>Diskon Grosir:</b>  <b>-${formatPrice(pricing.discountAmount)}</b> (${pricing.discountPercent}% OFF)\n`;
  }

  let nextTierHint = "";
  if (pricing.nextTier && pricing.nextTier.neededQty <= (prod.stockCount - safeQty)) {
    nextTierHint = `💡 <i>Beli ${pricing.nextTier.neededQty} item lagi untuk dapat harga grosir <b>${formatPrice(pricing.nextTier.pricePerUnit)}/item</b> (-${pricing.nextTier.discountPercent}%)!</i>\n\n`;
  }

  let text =
    `📦 <b>Beli Produk: ${prod.name}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `📂 <b>Kategori:</b>       ${prod.category}\n` +
    unitPriceText +
    `📊 <b>Stok Tersedia:</b>  <b>${prod.stockCount} item</b>\n` +
    `🪙 <b>Saldo Anda:</b>     <b>${formatPrice(userBalance)}</b>\n` +
    `${"─".repeat(30)}\n` +
    `🔢 <b>Jumlah Beli:</b>    <b>${safeQty} item</b>\n` +
    discountLine +
    `💵 <b>Total Bayar:</b>    <b>${formatPrice(totalPrice)}</b>\n` +
    `${"─".repeat(30)}\n\n` +
    nextTierHint;

  if (userBalance >= totalPrice) {
    text += `✅ <i>Saldo Anda mencukupi untuk pembayaran instan.</i>`;
  } else {
    text += `⚠️ <i>Saldo kurang ${formatPrice(shortage)}. Kekurangan akan dibayar via QRIS GoPay.</i>`;
  }

  const kb = new InlineKeyboard();

  // Row 1: Stepper (-5, -1, [Qty], +1, +5)
  const qMinus5 = Math.max(1, safeQty - 5);
  const qMinus1 = Math.max(1, safeQty - 1);
  const qPlus1 = Math.min(prod.stockCount, safeQty + 1);
  const qPlus5 = Math.min(prod.stockCount, safeQty + 5);

  kb.text("➖ 5", `dg_qset_${prod.id}_${qMinus5}_${categoryIndex}_${page}`)
    .text("➖ 1", `dg_qset_${prod.id}_${qMinus1}_${categoryIndex}_${page}`)
    .text(`🔢 ${safeQty}`, "dg_noop")
    .text("➕ 1", `dg_qset_${prod.id}_${qPlus1}_${categoryIndex}_${page}`)
    .text("➕ 5", `dg_qset_${prod.id}_${qPlus5}_${categoryIndex}_${page}`)
    .row();

  // Row 2: Quick Presets (1x, bulk tiers, Maks)
  const presetSet = new Set<number>([1]);
  if (prod.stockCount >= 2) presetSet.add(2);
  if (prod.stockCount >= 5) presetSet.add(5);
  if (prod.stockCount >= 10) presetSet.add(10);
  if (prod.bulkDiscounts && prod.bulkDiscounts.length > 0) {
    for (const t of prod.bulkDiscounts) {
      if (t.minQty <= prod.stockCount) {
        presetSet.add(t.minQty);
      }
    }
  }

  // Pick up to 4 presets + Max
  const sortedPresets = Array.from(presetSet).sort((a, b) => a - b).filter((q) => q < prod.stockCount);
  const selectedPresets = sortedPresets.slice(0, 4);

  for (const q of selectedPresets) {
    const isTier = (prod.bulkDiscounts || []).some((t) => t.minQty === q);
    const label = isTier ? `🏷️ ${q}x` : `${q}x`;
    kb.text(label, `dg_qset_${prod.id}_${q}_${categoryIndex}_${page}`);
  }
  kb.text(`🌟 Maks (${prod.stockCount})`, `dg_qset_${prod.id}_${prod.stockCount}_${categoryIndex}_${page}`);
  kb.row();

  // Row 3: Manual Input Button
  kb.text("✏️ Ketik Jumlah Manual", `dg_qmanual_${prod.id}_${categoryIndex}_${page}`).row();

  // Row 4: Promo Voucher
  kb.text("🎟️ Pakai Voucher / Kode Promo", `dg_promo_${prod.id}_${safeQty}_${categoryIndex}_${page}`).row();

  // Row 5: Confirm Purchase Button
  const confirmLabel = pricing.discountAmount > 0
    ? `🛒 Beli (${safeQty} item — ${formatPrice(totalPrice)} | -${pricing.discountPercent}%)`
    : `🛒 Konfirmasi Beli (${safeQty} item — ${formatPrice(totalPrice)})`;

  kb.text(confirmLabel, `dg_confirmbuy_${prod.id}_${safeQty}_${categoryIndex}_${page}`).row();

  // Row 6: Back to Product Detail
  kb.text("🔙 Kembali ke Detail Produk", `dg_p_${prod.id}_${categoryIndex}_${page}`);

  return { text, keyboard: kb };
}

// ============================================================================
//  BACKGROUND QRIS POLLING FOR DIGITAL PURCHASES
// ============================================================================

function startDigitalQrisPolling(
  bot: Bot<Context>,
  sessionId: string,
  orderId: string,
  telegramId: string,
  chatId: number,
  messageId: number,
  amountIDR: number,
  productId: string,
  productName: string,
  quantity: number = 1
): void {
  const startedAt = Date.now();

  const handle = setInterval(async () => {
    try {
      // ── 1. Timeout Check ──────────────────────────────────────────────────
      if (Date.now() - startedAt >= QRIS_TIMEOUT_MS) {
        clearDigitalQrisPoll(orderId);
        const expiredSession = await TopupSession.findByIdAndUpdate(sessionId, { status: "EXPIRED" }, { new: true });
        if (expiredSession) {
          ActivityLogService.logTopupCancelled(bot.api, {
            session: expiredSession,
            reason: "Waktu Pembayaran QRIS Habis (14 Menit)",
            user: { telegramId },
          }).catch((err) => console.error("[digital] ActivityLog topup expired error:", err));
        }

        const expiredText =
          `⌛ <b>QRIS Kedaluwarsa</b>\n\n` +
          `QR code untuk pembayaran <b>${formatPrice(amountIDR)}</b> (${productName}) sudah tidak berlaku.\n\n` +
          `<i>Silakan coba lagi dari menu katalog jika ingin melakukan pembelian.</i>`;

        try {
          await bot.api.editMessageCaption(chatId, messageId, {
            caption: expiredText,
            parse_mode: "HTML",
          });
        } catch {
          await bot.api.editMessageText(chatId, messageId, expiredText, {
            parse_mode: "HTML",
          }).catch(() => {});
        }
        return;
      }

      // ── 2. Check Session & Settlement ─────────────────────────────────────
      const session = await TopupSession.findById(sessionId);
      if (!session || session.status !== "PENDING") {
        clearDigitalQrisPoll(orderId);
        return;
      }

      const matchedTx = await checkSessionSettlement(session);

      if (matchedTx) {
        clearDigitalQrisPoll(orderId);

        // Credit user balance
        const updatedUser = await User.findOneAndUpdate(
          { telegramId },
          { $inc: { balance: amountIDR } },
          { new: true }
        ).lean();

        const settledSession = await TopupSession.findByIdAndUpdate(sessionId, {
          status: "SETTLED",
          matchedTransactionId: matchedTx.transactionId,
        }, { new: true });

        if (settledSession) {
          ActivityLogService.logTopupSettled(bot.api, {
            session: settledSession,
            txId: matchedTx.transactionId,
            user: {
              telegramId,
              firstName: updatedUser?.firstName,
              username: updatedUser?.username,
            },
            newBalance: updatedUser?.balance,
          }).catch((err) => console.error("[digital] ActivityLog topup settled error:", err));
        }

        // Notify payment received
        try {
          await bot.api.editMessageCaption(chatId, messageId, {
            caption:
              `✅ <b>Pembayaran Diterima!</b>\n\n` +
              `💰 <b>${formatPrice(amountIDR)}</b> telah ditambahkan ke saldo akun kamu.\n\n` +
              `⏳ Memproses pengiriman <b>${productName}</b> (${quantity} item) secara otomatis…`,
            parse_mode: "HTML",
          });
        } catch {
          await bot.api.editMessageText(
            chatId,
            messageId,
            `✅ <b>Pembayaran Diterima!</b>\n\n` +
            `💰 <b>${formatPrice(amountIDR)}</b> telah ditambahkan ke saldo akun kamu.\n\n` +
            `⏳ Memproses pengiriman <b>${productName}</b> (${quantity} item) secara otomatis…`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }

        // Execute digital product purchase with quantity
        const result = await DigitalProductService.purchaseProduct(productId, telegramId, quantity);

        if (result.success) {
          const qtyText = result.quantity > 1 ? ` (${result.quantity} item)` : "";
          const delivNote = result.deliveryMessage
            ? `💬 <b>Catatan Pengiriman:</b>\n${result.deliveryMessage}\n\n`
            : "";
          const successCaption =
            `🎉 <b>Pembelian Berhasil & Lunas!</b>\n` +
            `${"─".repeat(30)}\n\n` +
            `📦 <b>Produk:</b> ${result.productName}${qtyText}\n` +
            `🔢 <b>Jumlah:</b> ${result.quantity} item\n` +
            `🆔 <b>Order ID:</b> <code>${result.order.orderId}</code>\n` +
            `💰 <b>Total Harga:</b> ${formatPrice(result.price)}\n` +
            `📅 <b>Waktu:</b> ${formatDate(result.order.createdAt)}\n\n` +
            `🔑 <b>DATA PRODUK / AKUN (${result.quantity} item):</b>\n` +
            `<code>${result.itemContent}</code>\n\n` +
            delivNote +
            `⚠️ <i>Harap simpan data di atas. Kamu juga bisa melihatnya kapan saja di menu Riwayat Pesanan.</i>`;

          const hasWarranty = Boolean(
            result.order.warrantyDuration &&
            result.order.warrantyDuration > 0 &&
            result.order.warrantyExpiresAt &&
            new Date() < result.order.warrantyExpiresAt
          );

          const kb = new InlineKeyboard();
          if (hasWarranty) {
            kb.text("🛡️ Klaim Garansi", `dg_claim_${result.order.orderId}`).row();
          }
          kb.text("📜 Riwayat Pesanan", "dg_myorders")
            .row()
            .text("🛍️ Belanja Lagi", "product_digital");

          await bot.api.sendMessage(chatId, successCaption, {
            parse_mode: "HTML",
            reply_markup: kb,
          });

          // Broadcast testimonial to channel
          const user = await User.findOne({ telegramId }).lean();
          const prod = await DigitalProduct.findById(productId).lean();
          TestimonialService.sendDigitalPurchaseTestimonial(bot.api, {
            orderId: result.order.orderId,
            productName: result.productName,
            category: prod?.category,
            quantity: result.quantity,
            totalPrice: result.price,
            method: "QRIS OTOMATIS",
            buyer: {
              telegramId,
              firstName: user?.firstName,
              username: user?.username,
            },
            date: result.order.createdAt,
          }).catch((err) => console.error("[digital] Testimonial broadcast error:", err));

          // Broadcast audit log to dedicated channel
          ActivityLogService.logDigitalPurchase(bot.api, {
            orderId: result.order.orderId,
            productName: result.productName,
            category: prod?.category,
            quantity: result.quantity,
            totalPrice: result.price,
            method: "QRIS INSTAN",
            buyer: {
              telegramId,
              firstName: user?.firstName,
              username: user?.username,
            },
            remainingBalance: user?.balance,
            date: result.order.createdAt,
          }).catch((err) => console.error("[digital] ActivityLog digital purchase error:", err));
        } else {
          // If stock ran out while paying, user's balance is safely credited!
          const outOfStockMsg =
            `⚠️ <b>Stok Habis Saat Transaksi Selesai</b>\n\n` +
            `Saldo kamu sebesar <b>${formatPrice(amountIDR)}</b> sudah berhasil masuk dan aman di akun kamu.\n` +
            `Namun stok untuk <b>${productName}</b> baru saja habis.\n\n` +
            `<i>Kamu dapat menggunakan saldo tersebut untuk produk lain atau menunggu admin restock.</i>`;

          const kb = new InlineKeyboard().text("📦 Lihat Produk Lain", "product_digital");
          await bot.api.sendMessage(chatId, outOfStockMsg, {
            parse_mode: "HTML",
            reply_markup: kb,
          });
        }
      }
    } catch (err) {
      console.error(`[digital] QRIS poll error for ${orderId}:`, err);
    }
  }, QRIS_POLL_INTERVAL_MS);

  activeDigitalQrisPolls.set(orderId, handle);
}

// ============================================================================
//  PLUGIN DEFINITION
// ============================================================================

const digitalPlugin: Plugin = {
  name: "digital-products",
  version: "1.1.0",

  commands: [
    { command: "produk", description: "Buka katalog produk digital & akun" },
    { command: "pesananku", description: "Lihat riwayat pembelian produk digital" },
  ],

  register(bot: Bot<Context>): void {

    // ── /produk command ─────────────────────────────────────────────────────
    bot.command("produk", async (ctx) => {
      try {
        const from = ctx.from;
        if (from) userManualQtyState.delete(String(from.id));
        const { text, keyboard } = await buildCategoriesView();
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch (err) {
        console.error("[digital] /produk error:", err);
        await ctx.reply("❌ Gagal membuka katalog produk digital. Silakan coba lagi.");
      }
    });

    // ── /pesananku command ──────────────────────────────────────────────────
    bot.command("pesananku", async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      userManualQtyState.delete(String(from.id));
      try {
        const orders = await DigitalProductService.getUserOrders(String(from.id), 10);
        if (orders.length === 0) {
          await ctx.reply(
            `📜 <b>Riwayat Pembelian Produk Digital</b>\n` +
            `${"─".repeat(30)}\n\n` +
            `<i>Kamu belum memiliki riwayat pembelian produk digital.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🛍️ Beli Produk", "product_digital"),
            }
          );
          return;
        }

        let msg =
          `📜 <b>Riwayat Pembelian Produk Digital (${orders.length} terakhir)</b>\n` +
          `${"─".repeat(30)}\n\n`;

        for (const ord of orders) {
          const qtyText = ord.quantity && ord.quantity > 1 ? ` (x${ord.quantity})` : "";
          const delivNote = ord.deliveryMessage
            ? `💬 <i>Catatan: ${ord.deliveryMessage}</i>\n`
            : "";
          msg +=
            `📦 <b>${ord.productName}</b>${qtyText}\n` +
            `🆔 <code>${ord.orderId}</code> | ${formatPrice(ord.price)}\n` +
            `📅 ${formatDate(ord.createdAt)}\n` +
            `🔑 <code>${ord.itemContent}</code>\n` +
            delivNote +
            `\n`;
        }

        await ctx.reply(msg, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🛍️ Beli Produk Lain", "product_digital"),
        });
      } catch (err) {
        console.error("[digital] /pesananku error:", err);
        await ctx.reply("❌ Gagal memuat riwayat pesanan.");
      }
    });

    // ── product_digital — Landing page for digital products ─────────────────
    bot.callbackQuery("product_digital", async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (from) userManualQtyState.delete(String(from.id));
      try {
        const { text, keyboard } = await buildCategoriesView();
        await safeEditOrReply(ctx, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (err) {
        console.error("[digital] product_digital error:", err);
      }
    });

    // ── dg_cat_<index> — Select category ────────────────────────────────────
    bot.callbackQuery(/^dg_cat_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (from) userManualQtyState.delete(String(from.id));
      const catIdx = parseInt(ctx.match[1]!, 10);

      const categories = await DigitalProductService.getActiveCategories();
      const catName = categories[catIdx];
      if (!catName) {
        await ctx.answerCallbackQuery({ text: "⚠️ Kategori tidak ditemukan.", show_alert: true });
        return;
      }

      const { text, keyboard } = await buildProductsView(catName, catIdx, 0);
      await safeEditOrReply(ctx, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    });

    // ── dg_catpg_<catIdx>_<page> — Category pagination ──────────────────────
    bot.callbackQuery(/^dg_catpg_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (from) userManualQtyState.delete(String(from.id));
      const catIdx = parseInt(ctx.match[1]!, 10);
      const page = parseInt(ctx.match[2]!, 10);

      const categories = await DigitalProductService.getActiveCategories();
      const catName = categories[catIdx];
      if (!catName) {
        await ctx.answerCallbackQuery({ text: "⚠️ Kategori tidak ditemukan.", show_alert: true });
        return;
      }

      const { text, keyboard } = await buildProductsView(catName, catIdx, page);
      await safeEditOrReply(ctx, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    });

    // ── dg_p_<productId>_<catIdx>_<page> — View Product Detail ─────────────
    bot.callbackQuery(/^dg_p_([a-f0-9]+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      userManualQtyState.delete(String(from.id));

      const productId = ctx.match[1]!;
      const catIdx = parseInt(ctx.match[2]!, 10);
      const page = parseInt(ctx.match[3]!, 10);

      const user = await User.findOne({ telegramId: String(from.id) }).lean();
      const balance = user?.balance ?? 0;

      const detail = await buildProductDetailView(productId, balance, catIdx, page);
      if (!detail) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      await safeEditOrReply(ctx, detail.text, {
        parse_mode: "HTML",
        reply_markup: detail.keyboard,
      });
    });

    // ── dg_qty_<productId>_<qty>_<catIdx>_<page> & dg_qset_... — Quantity Selector
    bot.callbackQuery(/^dg_(?:qty|qset)_([a-f0-9]+)_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      userManualQtyState.delete(String(from.id));

      const productId = ctx.match[1]!;
      const qty = parseInt(ctx.match[2]!, 10);
      const catIdx = parseInt(ctx.match[3]!, 10);
      const page = parseInt(ctx.match[4]!, 10);

      const user = await User.findOne({ telegramId: String(from.id) }).lean();
      const balance = user?.balance ?? 0;

      const view = await buildQuantitySelectorView(productId, balance, qty, catIdx, page);
      if (!view) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      await safeEditOrReply(ctx, view.text, {
        parse_mode: "HTML",
        reply_markup: view.keyboard,
      });
    });

    // ── dg_qmanual_<productId>_<catIdx>_<page> — Prompt Manual Quantity Input
    bot.callbackQuery(/^dg_qmanual_([a-f0-9]+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);

      const productId = ctx.match[1]!;
      const catIdx = parseInt(ctx.match[2]!, 10);
      const page = parseInt(ctx.match[3]!, 10);

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod || !prod.isActive) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak tersedia.", show_alert: true });
        return;
      }

      userManualQtyState.set(telegramId, {
        productId,
        catIdx,
        page,
      });

      const kb = new InlineKeyboard().text("❌ Batal", `dg_qty_${productId}_1_${catIdx}_${page}`);

      const text =
        `🔢 <b>Ketik Jumlah Pembelian</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `📦 <b>Produk:</b> ${prod.name}\n` +
        `💰 <b>Harga Satuan:</b> ${formatPrice(prod.price)}\n` +
        `📊 <b>Stok Tersedia:</b> <b>${prod.stockCount} item</b>\n\n` +
        `Silakan ketik angka jumlah yang ingin kamu beli (antara <b>1</b> s/d <b>${prod.stockCount}</b>):\n\n` +
        `<i>Ketik /batal atau klik tombol di bawah untuk membatalkan.</i>`;

      await safeEditOrReply(ctx, text, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    });

    // ── dg_buy_... (Compatibility shortcut to quantity selector) ────────────
    bot.callbackQuery(/^dg_buy_([a-f0-9]+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      userManualQtyState.delete(String(from.id));

      const productId = ctx.match[1]!;
      const catIdx = parseInt(ctx.match[2]!, 10);
      const page = parseInt(ctx.match[3]!, 10);

      const user = await User.findOne({ telegramId: String(from.id) }).lean();
      const balance = user?.balance ?? 0;

      const view = await buildQuantitySelectorView(productId, balance, 1, catIdx, page);
      if (!view) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      await safeEditOrReply(ctx, view.text, {
        parse_mode: "HTML",
        reply_markup: view.keyboard,
      });
    });

    // ── dg_confirmbuy_<productId>_<qty>_<catIdx>_<page> — Confirm Purchase ──
    bot.callbackQuery(/^dg_confirmbuy_([a-f0-9]+)_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);
      const chatId = ctx.chat?.id ?? from.id;
      userManualQtyState.delete(telegramId);

      const productId = ctx.match[1]!;
      const rawQty = parseInt(ctx.match[2]!, 10);
      const catIdx = parseInt(ctx.match[3]!, 10);
      const page = parseInt(ctx.match[4]!, 10);

      // Strict backend validation against abuse
      if (isNaN(rawQty) || !Number.isInteger(rawQty) || rawQty <= 0) {
        await ctx.answerCallbackQuery({
          text: "⛔ Jumlah pembelian tidak valid! Minimal 1 item.",
          show_alert: true,
        });
        return;
      }

      const user = await User.findOne({ telegramId });
      const currentBalance = user?.balance ?? 0;

      const product = await DigitalProductService.getProductWithStock(productId);
      if (!product || !product.isActive) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak tersedia.", show_alert: true });
        return;
      }

      if (product.stockCount <= 0) {
        await ctx.answerCallbackQuery({ text: "❌ Maaf, stok produk ini baru saja habis!", show_alert: true });
        const detail = await buildProductDetailView(productId, currentBalance, catIdx, page);
        if (detail) {
          await safeEditOrReply(ctx, detail.text, { parse_mode: "HTML", reply_markup: detail.keyboard });
        }
        return;
      }

      if (rawQty > product.stockCount) {
        await ctx.answerCallbackQuery({
          text: `❌ Stok tidak mencukupi! Tersisa hanya ${product.stockCount} item.`,
          show_alert: true,
        });
        const view = await buildQuantitySelectorView(productId, currentBalance, product.stockCount, catIdx, page);
        if (view) {
          await safeEditOrReply(ctx, view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
        }
        return;
      }

      const pricing = DigitalProductService.calculatePricing(product, rawQty);
      const totalPrice = pricing.totalPrice;

      // ── Scenario A: Sufficient Balance → Instant Purchase ──────────────────
      if (currentBalance >= totalPrice) {
        // Check for active promo
        const activePromo = userActivePromo.get(telegramId);
        let effectiveTotalPrice = totalPrice;
        let promoApplied: ActivePromo | null = null;

        if (activePromo) {
          // Re-validate promo at purchase time
          const validation = await validatePromo(activePromo.code, telegramId, totalPrice);
          if (validation.valid) {
            effectiveTotalPrice = validation.discountedPrice;
            promoApplied = {
              code: activePromo.code,
              discountAmount: validation.discountAmount,
              discountedPrice: validation.discountedPrice,
            };
          } else {
            userActivePromo.delete(telegramId);
          }
        }

        if (currentBalance >= effectiveTotalPrice) {
        await safeEditOrReply(
          ctx,
          `⏳ <b>Memproses pesanan…</b>\n\n` +
          `📦 Produk: <b>${product.name}</b>\n` +
          `🔢 Jumlah: <b>${rawQty} item</b>\n` +
          `💰 Total: <b>${formatPrice(totalPrice)}</b>\n\n` +
          `<i>Sedang mengambil data item dari sistem…</i>`,
          { parse_mode: "HTML" }
        );

        const result = await DigitalProductService.purchaseProduct(productId, telegramId, rawQty);

          if (result.success) {
            // Apply promo (mark as used) if applicable
            if (promoApplied) {
              await applyPromo(promoApplied.code, telegramId);
              userActivePromo.delete(telegramId);
            }

            const qtyText = result.quantity > 1 ? ` (${result.quantity} item)` : "";
            const bulkDiscountLine = pricing.discountAmount > 0
              ? `🏷️ <b>Diskon Grosir:</b> -${formatPrice(pricing.discountAmount)} (${pricing.discountPercent}% OFF)\n`
              : "";
            const promoLine = promoApplied
              ? `🎟️ <b>Diskon Promo:</b> -${formatPrice(promoApplied.discountAmount)} (<code>${promoApplied.code}</code>)\n`
              : "";
            const delivNote = result.deliveryMessage
              ? `💬 <b>Catatan Pengiriman:</b>\n${result.deliveryMessage}\n\n`
              : "";
            const successMsg =
              `🎉 <b>Pembelian Berhasil!</b>\n` +
              `${"─".repeat(30)}\n\n` +
              `📦 <b>Produk:</b> ${result.productName}${qtyText}\n` +
              `🔢 <b>Jumlah:</b> ${result.quantity} item\n` +
              `🆔 <b>Order ID:</b> <code>${result.order.orderId}</code>\n` +
              bulkDiscountLine +
              promoLine +
              `💰 <b>Total Bayar:</b> ${formatPrice(result.price)}\n` +
              `📅 <b>Waktu:</b> ${formatDate(result.order.createdAt)}\n\n` +
              `🔑 <b>DATA PRODUK / AKUN (${result.quantity} item):</b>\n` +
              `<code>${result.itemContent}</code>\n\n` +
              delivNote +
              `⚠️ <i>Harap simpan data di atas. Data pesanan juga dapat diakses melalui tombol di bawah.</i>`;

            const hasWarranty = Boolean(
              result.order.warrantyDuration &&
              result.order.warrantyDuration > 0 &&
              result.order.warrantyExpiresAt &&
              new Date() < result.order.warrantyExpiresAt
            );

            const kb = new InlineKeyboard();
            if (hasWarranty) {
              kb.text("🛡️ Klaim Garansi", `dg_claim_${result.order.orderId}`).row();
            }
            kb.text("📜 Riwayat Pesanan", "dg_myorders")
              .row()
              .text("🛍️ Belanja Lagi", `dg_catpg_${catIdx}_${page}`);

            await safeEditOrReply(ctx, successMsg, {
              parse_mode: "HTML",
              reply_markup: kb,
            });

            // Affiliate commission
            awardCommission(telegramId, result.price, "DIGITAL_PURCHASE", result.order.orderId)
              .catch((err) => console.error("[digital] affiliate commission error:", err));

            // Broadcast testimonial to channel
            TestimonialService.sendDigitalPurchaseTestimonial(ctx.api, {
              orderId: result.order.orderId,
              productName: result.productName,
              category: product.category,
              quantity: result.quantity,
              totalPrice: result.price,
              method: "SALDO AKUN",
              buyer: {
                telegramId,
                firstName: ctx.from?.first_name,
                username: ctx.from?.username,
              },
              date: result.order.createdAt,
            }).catch((err) => console.error("[digital] Testimonial broadcast error:", err));

            // Broadcast audit log to dedicated channel
            ActivityLogService.logDigitalPurchase(ctx.api, {
              orderId: result.order.orderId,
              productName: result.productName,
              category: product.category,
              quantity: result.quantity,
              totalPrice: result.price,
              method: "SALDO AKUN",
              buyer: {
                telegramId,
                firstName: ctx.from?.first_name,
                username: ctx.from?.username,
              },
              remainingBalance: Math.max(0, currentBalance - result.price),
              date: result.order.createdAt,
            }).catch((err) => console.error("[digital] ActivityLog digital purchase error:", err));
          } else {
            await safeEditOrReply(
              ctx,
              `❌ <b>Gagal Menyelesaikan Pembelian</b>\n\n` +
              `<i>${result.message}</i>`,
              {
                parse_mode: "HTML",
                reply_markup: new InlineKeyboard().text("🔙 Kembali", `dg_catpg_${catIdx}_${page}`),
              }
            );
          }
          return;
        }
      }

      // ── Scenario B: Insufficient Balance → Generate QRIS GoPay ─────────────
      const shortage = totalPrice - currentBalance;

      await safeEditOrReply(
        ctx,
        `💳 <b>Menyiapkan QRIS GoPay…</b>\n\n` +
        `<i>Sedang men-generate QRIS dinamis + kode unik pembayaran…</i>`,
        { parse_mode: "HTML" }
      );

      try {
        const { baseAmount, uniqueCode, totalAmount } = await getUniquePaymentAmount(shortage);
        const orderId = `topup-digi-${telegramId}-${Date.now()}`;
        const qrisResult = await generateQris(totalAmount);

        const session = await TopupSession.create({
          telegramId,
          chatId,
          messageId: ctx.msgId ?? 0,
          orderId,
          baseAmount,
          uniqueCode,
          amountIDR: totalAmount,
          pendingProductType: "DIGITAL",
          pendingDigitalProductId: productId,
          pendingQuantity: rawQty,
          status: "PENDING",
        });

        // Broadcast audit log: Topup created
        ActivityLogService.logTopupCreated(ctx.api, {
          session,
          user: {
            telegramId,
            firstName: ctx.from?.first_name,
            username: ctx.from?.username,
          },
        }).catch((err) => console.error("[digital] ActivityLog topup created error:", err));

        const bulkDiscountLine = pricing.discountAmount > 0
          ? `🏷️ <b>Total Normal:</b>       <s>${formatPrice(pricing.normalTotalPrice)}</s>\n` +
            `✨ <b>Diskon Grosir:</b>      -${formatPrice(pricing.discountAmount)} (${pricing.discountPercent}% OFF)\n`
          : "";

        const caption =
          `💳 <b>Pembayaran QRIS — GoPay</b>\n` +
          `${"─".repeat(30)}\n\n` +
          `Saldo kamu kurang! Silakan scan QRIS di atas untuk menyelesaikan pembelian:\n` +
          `📦 <b>${product.name}</b> (<b>${rawQty} item</b>)\n\n` +
          `💰 <b>Saldo kamu saat ini:</b> ${formatPrice(currentBalance)}\n` +
          bulkDiscountLine +
          `🏷️ <b>Total harga (${rawQty}x):</b>   ${formatPrice(totalPrice)}\n` +
          `📉 <b>Kekurangan saldo:</b>    ${formatPrice(baseAmount)}\n` +
          `🔢 <b>Kode Unik:</b>           +${formatPrice(uniqueCode)}\n` +
          `${"─".repeat(30)}\n` +
          `💳 <b>TOTAL TRANSFER: <code>${formatPrice(totalAmount)}</code></b>\n` +
          `${"─".repeat(30)}\n\n` +
          `⚠️ <b>PENTING:</b>\n` +
          `Transfer dengan nominal <b>TEPAT ${formatPrice(totalAmount)}</b> agar otomatis terdeteksi.\n` +
          `<i>*Kelebihan kode unik (+${formatPrice(uniqueCode)}) otomatis masuk ke saldo akun kamu!</i>\n\n` +
          `<i>⏱ QR berlaku 15 menit. Begitu terbayar, ${rawQty} item produk digital langsung otomatis dikirim ke sini!</i>`;

        const checkBtn = new InlineKeyboard()
          .text("✅ Saya Sudah Bayar", `dg_chk_${session._id}`)
          .row()
          .text("❌ Batal", `dg_cncl_${session._id}`);

        const sentQrisMsg = await ctx.replyWithPhoto(
          new InputFile(qrisResult.buffer, "qris.png"),
          { caption, parse_mode: "HTML", reply_markup: checkBtn }
        );

        await TopupSession.findByIdAndUpdate(session._id, {
          messageId: sentQrisMsg.message_id,
        });

        try { await ctx.deleteMessage(); } catch { /* ignore */ }

        startDigitalQrisPolling(
          bot,
          String(session._id),
          orderId,
          telegramId,
          chatId,
          sentQrisMsg.message_id,
          totalAmount,
          productId,
          product.name,
          rawQty
        );
      } catch (err) {
        console.error("[digital] QRIS generation error:", err);
        await safeEditOrReply(
          ctx,
          `❌ <b>Gagal membuat QRIS.</b>\n\n` +
          `<i>${err instanceof Error ? err.message : "Terjadi gangguan sistem."}</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali", `dg_catpg_${catIdx}_${page}`),
          }
        );
      }
    });

    // ── dg_restock_<productId> — Subscribe to restock alert ──────────────────
    bot.callbackQuery(/^dg_restock_([a-f0-9]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);
      const chatId = String(ctx.chat?.id ?? from.id);
      const productId = ctx.match[1]!;

      try {
        const prod = await DigitalProductService.getProductWithStock(productId);
        if (!prod) {
          await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
          return;
        }

        // Upsert: won't throw if already exists (unique index)
        try {
          await RestockAlert.create({ productId, userId: telegramId, chatId });
          await ctx.reply(
            `🔔 <b>Notifikasi Restock Diaktifkan!</b>\n\n` +
            `Kamu akan diberitahu segera ketika <b>${prod.name}</b> kembali tersedia.`,
            { parse_mode: "HTML" }
          );
        } catch (err: any) {
          if (err?.code === 11000) {
            // Already subscribed (duplicate key)
            await ctx.reply(
              `ℹ️ Kamu sudah terdaftar untuk notifikasi restock produk <b>${prod.name}</b>.`,
              { parse_mode: "HTML" }
            );
          } else {
            throw err;
          }
        }
      } catch (err) {
        console.error("[digital] dg_restock error:", err);
        await ctx.reply("❌ Gagal mendaftar notifikasi restock. Coba lagi.");
      }
    });

    // ── dg_promo_<productId>_<qty>_<catIdx>_<page> — Prompt promo code input ─
    bot.callbackQuery(/^dg_promo_([a-f0-9]+)_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);

      const productId = ctx.match[1]!;
      const qty = parseInt(ctx.match[2]!, 10);
      const catIdx = parseInt(ctx.match[3]!, 10);
      const page = parseInt(ctx.match[4]!, 10);

      const prod = await DigitalProductService.getProductWithStock(productId);
      if (!prod) {
        await ctx.answerCallbackQuery({ text: "⚠️ Produk tidak ditemukan.", show_alert: true });
        return;
      }

      userPromoState.set(telegramId, { productId, qty, catIdx, page });
      userManualQtyState.delete(telegramId);

      const pricing = DigitalProductService.calculatePricing(prod, qty);
      const totalPrice = pricing.totalPrice;
      const kb = new InlineKeyboard().text("❌ Batal", `dg_qty_${productId}_${qty}_${catIdx}_${page}`);

      await safeEditOrReply(ctx, 
        `🎟️ <b>Masukkan Kode Promo / Voucher</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `📦 <b>Produk:</b> ${prod.name} (${qty}x)\n` +
        `💰 <b>Total Sebelum Diskon:</b> ${formatPrice(totalPrice)}\n\n` +
        `Ketik kode promo kamu di bawah ini:\n\n` +
        `<i>Contoh: <code>HEMAT50</code> atau <code>DISKON10</code></i>\n` +
        `<i>Ketik /batal untuk membatalkan.</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── dg_chk_<sessionId> — Manual payment check ──────────────────────────
    bot.callbackQuery(/^(?:dg_chk_|dg_chkpay_)(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "🔄 Mengecek mutasi pembayaran GoPay…" });
      const idParam = ctx.match[1]!;
      const from = ctx.from;
      if (!from) return;

      const telegramId = String(from.id);
      const chatId = ctx.chat?.id ?? from.id;

      try {
        const session =
          (await TopupSession.findById(idParam).catch(() => null)) ??
          (await TopupSession.findOne({ orderId: idParam }));

        if (!session) {
          await ctx.reply("⚠️ Sesi pembayaran tidak ditemukan atau sudah kedaluwarsa.");
          return;
        }

        if (session.status === "SETTLED") {
          await ctx.reply("✅ Pembayaran ini sudah berhasil diproses.");
          return;
        }

        const matchedTx = await checkSessionSettlement(session);
        if (!matchedTx) {
          await ctx.answerCallbackQuery({
            text: "⏳ Pembayaran belum terdeteksi di mutasi GoPay. Tunggu 10-30 detik lalu cek lagi.",
            show_alert: true,
          });
          return;
        }

        // Settled manually
        clearDigitalQrisPoll(session.orderId);

        const updatedUser = await User.findOneAndUpdate(
          { telegramId },
          { $inc: { balance: session.amountIDR } },
          { new: true }
        ).lean();

        const settledSession = await TopupSession.findByIdAndUpdate(session._id, {
          status: "SETTLED",
          matchedTransactionId: matchedTx.transactionId,
        }, { new: true });

        if (settledSession) {
          ActivityLogService.logTopupSettled(ctx.api, {
            session: settledSession,
            txId: matchedTx.transactionId,
            user: {
              telegramId,
              firstName: updatedUser?.firstName || ctx.from?.first_name,
              username: updatedUser?.username || ctx.from?.username,
            },
            newBalance: updatedUser?.balance,
          }).catch((err) => console.error("[digital] ActivityLog topup settled error:", err));
        }

        const productId = session.pendingDigitalProductId;
        const quantity = session.pendingQuantity || 1;
        if (productId) {
          const result = await DigitalProductService.purchaseProduct(productId, telegramId, quantity);
          if (result.success) {
            const qtyText = result.quantity > 1 ? ` (${result.quantity} item)` : "";
            const delivNote = result.deliveryMessage
              ? `💬 <b>Catatan Pengiriman:</b>\n${result.deliveryMessage}\n\n`
              : "";
            const successCaption =
              `🎉 <b>Pembelian Berhasil & Lunas!</b>\n` +
              `${"─".repeat(30)}\n\n` +
              `📦 <b>Produk:</b> ${result.productName}${qtyText}\n` +
              `🔢 <b>Jumlah:</b> ${result.quantity} item\n` +
              `🆔 <b>Order ID:</b> <code>${result.order.orderId}</code>\n` +
              `💰 <b>Total Bayar:</b> ${formatPrice(result.price)}\n` +
              `📅 <b>Waktu:</b> ${formatDate(result.order.createdAt)}\n\n` +
              `🔑 <b>DATA PRODUK / AKUN (${result.quantity} item):</b>\n` +
              `<code>${result.itemContent}</code>\n\n` +
              delivNote +
              `⚠️ <i>Harap simpan data di atas.</i>`;

            const hasWarranty = Boolean(
              result.order.warrantyDuration &&
              result.order.warrantyDuration > 0 &&
              result.order.warrantyExpiresAt &&
              new Date() < result.order.warrantyExpiresAt
            );

            const kb = new InlineKeyboard();
            if (hasWarranty) {
              kb.text("🛡️ Klaim Garansi", `dg_claim_${result.order.orderId}`).row();
            }
            kb.text("📜 Riwayat Pesanan", "dg_myorders")
              .row()
              .text("🛍️ Belanja Lagi", "product_digital");

            await ctx.reply(successCaption, {
              parse_mode: "HTML",
              reply_markup: kb,
            });

            // Broadcast testimonial to channel
            const user = await User.findOne({ telegramId }).lean();
            const prod = await DigitalProduct.findById(productId).lean();
            TestimonialService.sendDigitalPurchaseTestimonial(ctx.api, {
              orderId: result.order.orderId,
              productName: result.productName,
              category: prod?.category,
              quantity: result.quantity,
              totalPrice: result.price,
              method: "QRIS INSTAN",
              buyer: {
                telegramId,
                firstName: user?.firstName || ctx.from?.first_name,
                username: user?.username || ctx.from?.username,
              },
              date: result.order.createdAt,
            }).catch((err) => console.error("[digital] Testimonial broadcast error:", err));

            // Broadcast audit log to dedicated channel
            ActivityLogService.logDigitalPurchase(ctx.api, {
              orderId: result.order.orderId,
              productName: result.productName,
              category: prod?.category,
              quantity: result.quantity,
              totalPrice: result.price,
              method: "QRIS INSTAN (Manual Check)",
              buyer: {
                telegramId,
                firstName: user?.firstName || ctx.from?.first_name,
                username: user?.username || ctx.from?.username,
              },
              remainingBalance: user?.balance,
              date: result.order.createdAt,
            }).catch((err) => console.error("[digital] ActivityLog digital purchase error:", err));

            return;
          }
        }

        await ctx.reply(
          `✅ <b>Pembayaran Berhasil!</b>\n\n` +
          `💰 Saldo <b>${formatPrice(session.amountIDR)}</b> telah ditambahkan ke akun kamu.`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.error("[digital] chkpay error:", err);
      }
    });

    // ── dg_cncl_<sessionId> — Cancel pending QRIS ───────────────────────────
    bot.callbackQuery(/^(?:dg_cncl_|dg_cncltopup_)(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Pembayaran dibatalkan." });
      const rawParam = ctx.match[1]!;
      const parts = rawParam.split("_");
      const idParam = parts[0]!;

      try {
        const session =
          (await TopupSession.findById(idParam).catch(() => null)) ??
          (await TopupSession.findOne({ orderId: idParam }));

        if (session) {
          clearDigitalQrisPoll(session.orderId);
          const cancelledSession = await TopupSession.findByIdAndUpdate(session._id, { status: "CANCELLED" }, { new: true });
          if (cancelledSession) {
            ActivityLogService.logTopupCancelled(ctx.api, {
              session: cancelledSession,
              reason: "Dibatalkan oleh Pengguna",
              user: {
                telegramId: String(ctx.from?.id),
                firstName: ctx.from?.first_name,
                username: ctx.from?.username,
              },
            }).catch((err) => console.error("[digital] ActivityLog topup cancel error:", err));
          }
        }

        try { await ctx.deleteMessage(); } catch { /* ignore */ }

        const from = ctx.from;
        const user = from ? await User.findOne({ telegramId: String(from.id) }).lean() : null;
        const balance = user?.balance ?? 0;

        const productId = session?.pendingDigitalProductId ?? (parts.length >= 2 ? parts[1] : undefined);
        if (productId) {
          const prod = await DigitalProductService.getProductWithStock(productId);
          const categories = await DigitalProductService.getActiveCategories();
          const catIdx = prod ? Math.max(0, categories.indexOf(prod.category)) : 0;
          const page = parts.length >= 4 ? parseInt(parts[3]!, 10) || 0 : 0;
          const detail = await buildProductDetailView(productId, balance, catIdx, page);
          if (detail) {
            await ctx.reply(detail.text, { parse_mode: "HTML", reply_markup: detail.keyboard });
            return;
          }
        }

        const { text, keyboard } = await buildCategoriesView();
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch (err) {
        console.error("[digital] cancel error:", err);
      }
    });

    // ── dg_myorders — Order history callback ────────────────────────────────
    bot.callbackQuery("dg_myorders", async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      userManualQtyState.delete(String(from.id));

      try {
        const orders = await DigitalProductService.getUserOrders(String(from.id), 10);
        if (orders.length === 0) {
          await safeEditOrReply(
            ctx,
            `📜 <b>Riwayat Pembelian Produk Digital</b>\n` +
            `${"─".repeat(30)}\n\n` +
            `<i>Kamu belum memiliki riwayat pembelian produk digital.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🛍️ Beli Produk", "product_digital"),
            }
          );
          return;
        }

        let msg =
          `📜 <b>Riwayat Pembelian Produk Digital (${orders.length} terakhir)</b>\n` +
          `${"─".repeat(30)}\n\n`;

        const kb = new InlineKeyboard();
        const claimableOrders: string[] = [];

        for (const ord of orders) {
          const qtyText = ord.quantity && ord.quantity > 1 ? ` (x${ord.quantity})` : "";
          const delivNote = ord.deliveryMessage
            ? `💬 <i>Catatan: ${ord.deliveryMessage}</i>\n`
            : "";

          const wStatus = WarrantyService.checkOrderWarrantyStatus(ord);
          let warrantyLine = "";
          if (wStatus.hasWarranty) {
            if (wStatus.isExpired) {
              warrantyLine = `🛡️ <b>Garansi:</b> <s>Expired (${wStatus.expiresAt ? formatDate(wStatus.expiresAt) : "—"})</s>\n`;
            } else if (wStatus.claimsCount >= wStatus.maxClaims) {
              warrantyLine = `🛡️ <b>Garansi:</b> Habis (${wStatus.claimsCount}/${wStatus.maxClaims}x klaim)\n`;
            } else {
              warrantyLine = `🛡️ <b>Garansi:</b> Aktif s/d ${wStatus.expiresAt ? formatDate(wStatus.expiresAt) : "—"} (${wStatus.claimsCount}/${wStatus.maxClaims}x klaim)\n`;
              if (!claimableOrders.includes(ord.orderId)) {
                claimableOrders.push(ord.orderId);
                kb.text(`🛡️ Klaim: ${ord.productName.slice(0, 18)} (${ord.orderId.slice(-6)})`, `dg_claim_${ord.orderId}`).row();
              }
            }
          }

          msg +=
            `📦 <b>${ord.productName}</b>${qtyText}\n` +
            `🆔 <code>${ord.orderId}</code> | ${formatPrice(ord.price)}\n` +
            `📅 ${formatDate(ord.createdAt)}\n` +
            warrantyLine +
            `🔑 <code>${ord.itemContent}</code>\n` +
            delivNote +
            `\n`;
        }

        kb.text("🛍️ Beli Produk", "product_digital")
          .row()
          .text("🔙 Kembali", CB_CATALOG);

        await safeEditOrReply(ctx, msg, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
      } catch (err) {
        console.error("[digital] dg_myorders error:", err);
      }
    });

    // ── dg_claim_* — User initiates warranty claim ───────────────────────────
    bot.callbackQuery(/^dg_claim_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;

      const orderId = ctx.match[1];
      if (!orderId) return;
      const check = await WarrantyService.validateClaimEligibility(orderId, String(from.id));
      if (!check.eligible || !check.order) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Tidak Dapat Mengajukan Klaim</b>\n` +
          `${"─".repeat(30)}\n\n` +
          `${check.reason || "Pesanan ini tidak memenuhi syarat garansi."}`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📜 Kembali ke Riwayat", "dg_myorders"),
          }
        );
        return;
      }

      const ord = check.order;
      userClaimState.set(String(from.id), { orderId: ord.orderId });

      const expDate = ord.warrantyExpiresAt ? formatDate(ord.warrantyExpiresAt) : "—";
      const claimIdx = (ord.claimsCount || 0) + 1;
      const maxClm = ord.maxClaims ?? 1;

      await safeEditOrReply(
        ctx,
        `🛡️ <b>Formulir Pengajuan Klaim Garansi</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `📦 <b>Produk:</b> <b>${ord.productName}</b>\n` +
        `🆔 <b>Order ID:</b> <code>${ord.orderId}</code>\n` +
        `📅 <b>Garansi Berlaku S/d:</b> ${expDate}\n` +
        `🔢 <b>Pengajuan Klaim ke:</b> ${claimIdx} dari maks. ${maxClm}x\n\n` +
        `💬 <b>Petunjuk:</b>\n` +
        `Silakan <b>ketikkan deskripsi / keluhan kendala</b> yang kamu alami pada chat ini sekarang.\n\n` +
        `<i>(Ketik /batal atau klik tombol di bawah untuk membatalkan)</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("❌ Batal Klaim", "dg_claim_cancel"),
        }
      );
    });

    // ── dg_claim_cancel — Cancel claim filing ────────────────────────────────
    bot.callbackQuery("dg_claim_cancel", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userClaimState.delete(String(ctx.from.id));
      await safeEditOrReply(ctx, "❌ Pengajuan klaim garansi dibatalkan.", {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("📜 Riwayat Pesanan", "dg_myorders"),
      });
    });

    // ── dg_noop ─────────────────────────────────────────────────────────────
    bot.callbackQuery("dg_noop", async (ctx) => {
      await ctx.answerCallbackQuery();
    });

    // ── Text message handler for interactive inputs (Claim, Promo, Manual Qty) ─
    bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (!from) return next();

      const telegramId = String(from.id);
      const rawText = ctx.message.text.trim();

      // ── Warranty Claim Input Handler ──────────────────────────────────────
      const claimState = userClaimState.get(telegramId);
      if (claimState) {
        if (rawText === "/batal" || rawText === "/cancel" || rawText.toLowerCase() === "batal") {
          userClaimState.delete(telegramId);
          await ctx.reply("❌ Pengajuan klaim garansi dibatalkan.", {
            reply_markup: new InlineKeyboard().text("📜 Riwayat Pesanan", "dg_myorders"),
          });
          return;
        }

        if (rawText.startsWith("/")) {
          userClaimState.delete(telegramId);
          return next();
        }

        userClaimState.delete(telegramId);
        const claimRes = await WarrantyService.createClaim({
          orderId: claimState.orderId,
          userId: telegramId,
          userHandle: from.username || from.first_name,
          reason: rawText,
          api: ctx.api,
        });

        if (!claimRes.success || !claimRes.claim) {
          await ctx.reply(`❌ <b>Gagal Mengajukan Klaim:</b>\n${claimRes.message}`, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📜 Riwayat Pesanan", "dg_myorders"),
          });
          return;
        }

        await ctx.reply(
          `✅ <b>Tiket Klaim Garansi Berhasil Diajukan!</b>\n` +
          `${"─".repeat(30)}\n\n` +
          `🎫 <b>ID Tiket:</b> <code>${claimRes.claim.claimId}</code>\n` +
          `📦 <b>Order ID:</b> <code>${claimRes.claim.orderId}</code>\n` +
          `🏷️ <b>Produk:</b> <b>${claimRes.claim.productName}</b>\n\n` +
          `📝 <b>Keluhan Kamu:</b>\n<i>${claimRes.claim.reason}</i>\n\n` +
          `<i>Tiket kamu telah diteruskan ke admin untuk ditinjau. Kamu akan menerima notifikasi otomatis di chat ini segera setelah admin memberikan keputusan (Ganti Stok / Refund).</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("📜 Riwayat Pesanan", "dg_myorders")
              .row()
              .text("🛍️ Menu Utama", "product_digital"),
          }
        );
        return;
      }

      // ── Promo code input ─────────────────────────────────────────────────
      const promoState = userPromoState.get(telegramId);
      if (promoState) {
        // Handle cancel
        if (rawText === "/batal" || rawText === "/cancel" || rawText.toLowerCase() === "batal") {
          userPromoState.delete(telegramId);
          const user = await User.findOne({ telegramId }).lean();
          const balance = user?.balance ?? 0;
          const view = await buildQuantitySelectorView(promoState.productId, balance, promoState.qty, promoState.catIdx, promoState.page);
          await ctx.reply("❌ Input promo dibatalkan.");
          if (view) await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
          return;
        }

        if (rawText.startsWith("/")) {
          userPromoState.delete(telegramId);
          return next();
        }

        const prod = await DigitalProductService.getProductWithStock(promoState.productId);
        if (!prod) {
          userPromoState.delete(telegramId);
          await ctx.reply("⚠️ Produk sudah tidak tersedia.");
          return;
        }

        const pricing = DigitalProductService.calculatePricing(prod, promoState.qty);
        const totalPrice = pricing.totalPrice;
        const validation = await validatePromo(rawText, telegramId, totalPrice);

        if (!validation.valid) {
          await ctx.reply(
            `${validation.message}\n\n<i>Ketik kode lain atau /batal untuk membatalkan.</i>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        // Valid promo — save it and show updated quantity selector
        userActivePromo.set(telegramId, {
          code: rawText.trim().toUpperCase(),
          discountAmount: validation.discountAmount,
          discountedPrice: validation.discountedPrice,
        });
        userPromoState.delete(telegramId);

        const user = await User.findOne({ telegramId }).lean();
        const balance = user?.balance ?? 0;
        const view = await buildQuantitySelectorView(promoState.productId, balance, promoState.qty, promoState.catIdx, promoState.page);

        await ctx.reply(
          `${validation.message}\n` +
          `💵 <b>Harga Setelah Diskon:</b> ${formatPrice(validation.discountedPrice)}\n\n` +
          `<i>Diskon otomatis diterapkan saat konfirmasi pembelian.</i>`,
          { parse_mode: "HTML" }
        );
        if (view) await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
        return;
      }

      // ── Manual qty input ─────────────────────────────────────────────────
      const state = userManualQtyState.get(telegramId);
      if (!state) return next();

      // Handle cancel command
      if (
        rawText === "/batal" ||
        rawText === "/cancel" ||
        rawText.toLowerCase() === "batal" ||
        rawText.toLowerCase() === "cancel"
      ) {
        userManualQtyState.delete(telegramId);
        const user = await User.findOne({ telegramId }).lean();
        const balance = user?.balance ?? 0;
        const view = await buildQuantitySelectorView(state.productId, balance, 1, state.catIdx, state.page);
        await ctx.reply("❌ Input manual dibatalkan.");
        if (view) {
          await ctx.reply(view.text, {
            parse_mode: "HTML",
            reply_markup: view.keyboard,
          });
        }
        return;
      }

      // If user typed another slash command, cancel state and pass to next handler
      if (rawText.startsWith("/")) {
        userManualQtyState.delete(telegramId);
        return next();
      }

      // STRICT ABUSE VALIDATION: Must be strictly numeric digits (no negative, float, scientific notation)
      if (!/^\d+$/.test(rawText)) {
        await ctx.reply(
          `❌ <b>Input Tidak Valid!</b>\n\n` +
          `Harap masukkan angka bulat positif (contoh: <code>1</code>, <code>2</code>, <code>5</code>).\n` +
          `Angka tidak boleh mengandung koma, desimal, huruf, atau tanda minus.\n\n` +
          `<i>Ketik /batal untuk membatalkan.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const parsedQty = parseInt(rawText, 10);

      // Prevent <= 0, NaN, non-integer, or infinite
      if (isNaN(parsedQty) || !Number.isInteger(parsedQty) || parsedQty <= 0) {
        await ctx.reply(
          `❌ <b>Jumlah Tidak Valid!</b>\n\n` +
          `Jumlah pembelian minimal <b>1 item</b> (tidak boleh 0 atau bernilai negatif).\n\n` +
          `<i>Ketik /batal untuk membatalkan.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const prod = await DigitalProductService.getProductWithStock(state.productId);
      if (!prod || !prod.isActive) {
        userManualQtyState.delete(telegramId);
        await ctx.reply("⚠️ Produk sudah tidak tersedia lagi.");
        return;
      }

      if (parsedQty > prod.stockCount) {
        await ctx.reply(
          `⚠️ <b>Jumlah Melebihi Stok!</b>\n\n` +
          `Stok yang tersedia untuk <b>${prod.name}</b> saat ini hanya <b>${prod.stockCount} item</b>.\n` +
          `Silakan masukkan angka antara <b>1</b> s/d <b>${prod.stockCount}</b>:\n\n` +
          `<i>Ketik /batal untuk membatalkan.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Valid quantity entered! Clear state and show updated quantity selector
      userManualQtyState.delete(telegramId);
      const user = await User.findOne({ telegramId }).lean();
      const balance = user?.balance ?? 0;

      const view = await buildQuantitySelectorView(state.productId, balance, parsedQty, state.catIdx, state.page);
      if (view) {
        await ctx.reply(view.text, {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        });
      }
    });

    console.log("   → /produk, /pesananku, callbackQuery: product_digital, dg_*");
  },
};

export default digitalPlugin;
