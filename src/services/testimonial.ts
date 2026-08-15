import { Api, InlineKeyboard, InputFile } from "grammy";
import { BotConfig, IBotConfig } from "../models/BotConfig.js";
import { ReceiptService } from "./receipt.js";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export interface BuyerInfo {
  telegramId: string | number;
  firstName?: string | undefined;
  username?: string | undefined;
}

export interface DigitalTestimonialData {
  orderId: string;
  productName: string;
  category?: string | undefined;
  quantity: number;
  totalPrice: number;
  buyer: BuyerInfo;
  method?: string | undefined;
  date?: Date | undefined;
}

export interface OtpTestimonialData {
  activationId: string;
  serviceName: string;
  countryName: string;
  phoneNumber: string;
  cost: number;
  buyer: BuyerInfo;
  date?: Date | undefined;
}

// ============================================================================
//  Cache & Helpers
// ============================================================================

let cachedConfig: IBotConfig | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

let cachedBotUsername: string | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatPrice(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDateWIB(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date) + " WIB";
}

/** Masks ID for buyer privacy (e.g. 59381234 -> 5938****) */
function maskId(id: string | number): string {
  const str = String(id).trim();
  if (str.length <= 4) return str.slice(0, 1) + "***";
  return str.slice(0, 4) + "*".repeat(Math.min(4, Math.max(2, str.length - 4)));
}

/** Masks phone number for privacy (e.g. +628123456789 -> +62812****789) */
function maskPhone(phone: string): string {
  const clean = phone.trim();
  if (clean.length <= 6) return clean.slice(0, 3) + "***";
  return clean.slice(0, 6) + "****" + clean.slice(-3);
}

function formatBuyerHtml(buyer: BuyerInfo): string {
  const rawName = buyer.firstName?.trim() || "Pelanggan";
  const safeName = escapeHtml(rawName);
  const userHandle = buyer.username ? ` (@${escapeHtml(buyer.username)})` : "";
  const maskedNumericId = maskId(buyer.telegramId);

  return `${safeName}${userHandle} (ID: <code>${maskedNumericId}</code>)`;
}

function formatBuyerPlain(buyer: BuyerInfo): string {
  const rawName = buyer.firstName?.trim() || "Pelanggan";
  const userHandle = buyer.username ? ` (@${buyer.username})` : "";
  const maskedNumericId = maskId(buyer.telegramId);

  return `${rawName}${userHandle} (${maskedNumericId})`;
}

// ============================================================================
//  Testimonial Service Implementation
// ============================================================================

export class TestimonialService {
  /**
   * Retrieves current bot configuration from cache or MongoDB.
   */
  static async getConfig(): Promise<IBotConfig> {
    const now = Date.now();
    if (cachedConfig && now - lastCacheTime < CACHE_TTL_MS) {
      return cachedConfig;
    }
    cachedConfig = await BotConfig.getOrCreate();
    lastCacheTime = now;
    return cachedConfig;
  }

  /**
   * Updates bot configuration in DB and refreshes cache.
   */
  static async updateConfig(updates: Partial<IBotConfig>): Promise<IBotConfig> {
    const config = await BotConfig.getOrCreate();
    Object.assign(config, updates);
    await config.save();
    cachedConfig = config;
    lastCacheTime = Date.now();
    return config;
  }

  /**
   * Helper to retrieve bot username for CTA buttons.
   */
  static async getBotUsername(api: Api): Promise<string | undefined> {
    if (cachedBotUsername) return cachedBotUsername;
    try {
      const me = await api.getMe();
      if (me.username) {
        cachedBotUsername = me.username;
        return me.username;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  /**
   * Sends testimonial message with modern receipt image for a completed digital product purchase.
   */
  static async sendDigitalPurchaseTestimonial(
    api: Api,
    data: DigitalTestimonialData
  ): Promise<boolean> {
    try {
      const config = await this.getConfig();

      if (!config.testimonialEnabled || !config.testimonialChannel || config.testimonialChannel.trim() === "") {
        return false;
      }

      const targetChannel = config.testimonialChannel.trim();
      const botUsername = await this.getBotUsername(api);

      const qtyText = data.quantity > 1 ? ` (${data.quantity}x)` : "";
      const categoryLine = data.category ? `📂 <b>Kategori:</b> ${escapeHtml(data.category)}\n` : "";
      const formattedBuyer = formatBuyerHtml(data.buyer);
      const formattedDate = formatDateWIB(data.date || new Date());
      const safeProductName = escapeHtml(data.productName);

      const text =
        `🌟 <b>TESTIMONI PEMBELIAN BERHASIL</b> 🌟\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Pembeli:</b> ${formattedBuyer}\n` +
        `📦 <b>Produk:</b> <b>${safeProductName}${qtyText}</b>\n` +
        categoryLine +
        `🔢 <b>Jumlah:</b> ${data.quantity} item\n` +
        `💰 <b>Total Transaksi:</b> <b>${formatPrice(data.totalPrice)}</b>\n` +
        `🆔 <b>Order ID:</b> <code>${escapeHtml(data.orderId)}</code>\n` +
        `📅 <b>Waktu:</b> ${formattedDate}\n` +
        `⚡ <b>Status:</b> ✅ <b>Lunas &amp; Terkirim Otomatis</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>✨ Pesanan diproses instan 24/7 oleh sistem bot. Terima kasih telah berbelanja! 🙏</i>`;

      const keyboard = new InlineKeyboard();
      if (botUsername) {
        keyboard.url("🛒 Beli di Bot Sekarang", `https://t.me/${botUsername}?start=katalog`);
      }

      // ── Generate Struk Receipt Image ───────────────────────────────────────
      let receiptBuffer: Buffer | null = null;
      try {
        receiptBuffer = await ReceiptService.generateReceiptBuffer({
          orderId: data.orderId,
          method: data.method || "Saldo / QRIS",
          product: `${data.productName}${qtyText}`,
          category: data.category,
          date: formattedDate,
          totalIdr: data.totalPrice,
          status: "PAID",
          buyerName: formatBuyerPlain(data.buyer),
          brandTitle: botUsername ? `@${botUsername}` : undefined,
        });
      } catch (genErr) {
        console.warn(`[Testimonial] Gagal render gambar struk:`, genErr);
      }

      // ── Send to Channel (Photo with Caption or Text Fallback) ──────────────
      if (receiptBuffer) {
        try {
          await api.sendPhoto(targetChannel, new InputFile(receiptBuffer, `struk-${data.orderId}.png`), {
            caption: text,
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
          console.log(`[Testimonial] ✅ Testimoni + Struk digital terkirim ke channel ${targetChannel} (Order: ${data.orderId})`);
          return true;
        } catch (photoErr) {
          console.warn(`[Testimonial] sendPhoto gagal, mencoba fallback ke sendMessage:`, photoErr);
        }
      }

      // Fallback text message if photo could not be generated or sent
      await api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      console.log(`[Testimonial] ✅ Testimoni teks digital terkirim ke channel ${targetChannel} (Order: ${data.orderId})`);
      return true;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[Testimonial] ⚠️ Gagal mengirim testimoni ke channel:`, errMsg);

      if (
        errMsg.includes("CHAT_ADMIN_REQUIRED") ||
        errMsg.includes("chat not found") ||
        errMsg.includes("bot was kicked") ||
        errMsg.includes("bot is not a member") ||
        errMsg.includes("have no rights to send a message")
      ) {
        console.error(
          `❌ [Testimonial] PENTING: Pastikan bot telah ditambahkan sebagai ADMINISTRATOR di channel testimoni dengan izin 'Post Messages'!`
        );
      }
      return false;
    }
  }

  /**
   * Sends testimonial message with receipt image for a completed OTP SMS order.
   */
  static async sendOtpPurchaseTestimonial(
    api: Api,
    data: OtpTestimonialData
  ): Promise<boolean> {
    try {
      const config = await this.getConfig();

      if (!config.testimonialEnabled || !config.testimonialChannel || config.testimonialChannel.trim() === "") {
        return false;
      }

      const targetChannel = config.testimonialChannel.trim();
      const botUsername = await this.getBotUsername(api);

      const formattedBuyer = formatBuyerHtml(data.buyer);
      const formattedDate = formatDateWIB(data.date || new Date());
      const safeServiceName = escapeHtml(data.serviceName);
      const safeCountryName = escapeHtml(data.countryName);
      const maskedPhoneNumber = maskPhone(data.phoneNumber);

      const text =
        `🌟 <b>TESTIMONI OTP SMS BERHASIL</b> 🌟\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Pembeli:</b> ${formattedBuyer}\n` +
        `💬 <b>Layanan:</b> <b>${safeServiceName}</b>\n` +
        `🌍 <b>Negara:</b> ${safeCountryName}\n` +
        `📱 <b>Nomor:</b> <code>${maskedPhoneNumber}</code>\n` +
        `💰 <b>Biaya:</b> <b>${formatPrice(data.cost)}</b>\n` +
        `🆔 <b>ID Transaksi:</b> <code>${escapeHtml(data.activationId)}</code>\n` +
        `📅 <b>Waktu:</b> ${formattedDate}\n` +
        `⚡ <b>Status:</b> ✅ <b>Kode OTP Sukses Diterima</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>✨ Verifikasi OTP selesai otomatis 24/7. Terima kasih telah menggunakan layanan kami! 🙏</i>`;

      const keyboard = new InlineKeyboard();
      if (botUsername) {
        keyboard.url("💬 Sewa OTP di Bot", `https://t.me/${botUsername}?start=otp`);
      }

      // ── Generate Struk Receipt Image ───────────────────────────────────────
      let receiptBuffer: Buffer | null = null;
      try {
        receiptBuffer = await ReceiptService.generateReceiptBuffer({
          orderId: data.activationId,
          method: "OTP SMS (Virtual Number)",
          product: `${data.serviceName} (${data.countryName})`,
          date: formattedDate,
          totalIdr: data.cost,
          status: "SUCCESS",
          buyerName: formatBuyerPlain(data.buyer),
          brandTitle: botUsername ? `@${botUsername}` : undefined,
        });
      } catch (genErr) {
        console.warn(`[Testimonial] Gagal render gambar struk OTP:`, genErr);
      }

      if (receiptBuffer) {
        try {
          await api.sendPhoto(targetChannel, new InputFile(receiptBuffer, `struk-${data.activationId}.png`), {
            caption: text,
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
          console.log(`[Testimonial] ✅ Testimoni + Struk OTP terkirim ke channel ${targetChannel} (Activation: ${data.activationId})`);
          return true;
        } catch (photoErr) {
          console.warn(`[Testimonial] sendPhoto OTP gagal, mencoba fallback:`, photoErr);
        }
      }

      await api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      console.log(`[Testimonial] ✅ Testimoni teks OTP berhasil dikirim ke channel ${targetChannel} (Activation: ${data.activationId})`);
      return true;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[Testimonial] ⚠️ Gagal mengirim testimoni OTP:`, errMsg);
      return false;
    }
  }

  /**
   * Sends a test testimonial message and receipt image to verify channel permissions and formatting.
   */
  static async sendTestTestimonial(
    api: Api
  ): Promise<{ success: boolean; channel?: string; error?: string }> {
    const config = await this.getConfig();

    if (!config.testimonialChannel || config.testimonialChannel.trim() === "") {
      return {
        success: false,
        error: "Channel testimoni belum diatur. Silakan atur username atau ID channel terlebih dahulu.",
      };
    }

    const targetChannel = config.testimonialChannel.trim();
    const botUsername = await this.getBotUsername(api);
    const formattedDate = formatDateWIB(new Date());
    const testOrderId = `TEST-${Date.now()}`;

    const text =
      `🧪 <b>UJI COBA TESTIMONI TRANSAKSI</b> 🧪\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Pembeli:</b> Pelanggan Uji Coba (ID: <code>1234****</code>)\n` +
      `📦 <b>Produk:</b> <b>Netflix Premium UHD (1 Bulan)</b>\n` +
      `📂 <b>Kategori:</b> Streaming &amp; Hiburan\n` +
      `🔢 <b>Jumlah:</b> 1 item\n` +
      `💰 <b>Total Transaksi:</b> <b>Rp 25.000</b>\n` +
      `🆔 <b>Order ID:</b> <code>${testOrderId}</code>\n` +
      `📅 <b>Waktu:</b> ${formattedDate}\n` +
      `⚡ <b>Status:</b> ✅ <b>Lunas &amp; Terkirim Otomatis</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Ini adalah pesan tes struk & konfigurasi dari Admin Panel bot.</i>`;

    const keyboard = new InlineKeyboard();
    if (botUsername) {
      keyboard.url("🛒 Kunjungi Bot", `https://t.me/${botUsername}`);
    }

    try {
      let receiptBuffer: Buffer | null = null;
      try {
        receiptBuffer = await ReceiptService.generateReceiptBuffer({
          orderId: testOrderId,
          method: "QRIS / Saldo",
          product: "Netflix Premium UHD (1 Bulan) (x1)",
          category: "Streaming & Hiburan",
          date: formattedDate,
          totalIdr: 25000,
          status: "PAID",
          buyerName: "Pelanggan Uji Coba (1234****)",
          brandTitle: botUsername ? `@${botUsername}` : undefined,
        });
      } catch (genErr) {
        console.warn(`[Testimonial] Gagal membuat struk tes:`, genErr);
      }

      if (receiptBuffer) {
        await api.sendPhoto(targetChannel, new InputFile(receiptBuffer, "struk-test.png"), {
          caption: text,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } else {
        await api.sendMessage(targetChannel, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      }

      return { success: true, channel: targetChannel };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      return { success: false, channel: targetChannel, error: errMsg };
    }
  }
}

