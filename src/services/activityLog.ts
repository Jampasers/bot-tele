import { Api, InlineKeyboard } from "grammy";
import { BotConfig, IBotConfig } from "../models/BotConfig.js";
import { ITopupSession } from "../models/TopupSession.js";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export interface LogUserInfo {
  telegramId: string | number;
  firstName?: string | undefined;
  username?: string | undefined;
}

export interface UserRegisterLogData {
  user: LogUserInfo;
  registeredVia?: string | undefined;
  date?: Date | undefined;
}

export interface TopupCreatedLogData {
  session: ITopupSession;
  user?: LogUserInfo | undefined;
  date?: Date | undefined;
}

export interface TopupSettledLogData {
  session: ITopupSession;
  txId?: string | undefined;
  user?: LogUserInfo | undefined;
  newBalance?: number | undefined;
  date?: Date | undefined;
}

export interface TopupCancelledLogData {
  session: ITopupSession;
  reason?: string | undefined;
  user?: LogUserInfo | undefined;
  date?: Date | undefined;
}

export interface DigitalPurchaseLogData {
  orderId: string;
  productName: string;
  category?: string | undefined;
  quantity: number;
  totalPrice: number;
  method: "SALDO" | "QRIS" | string;
  buyer: LogUserInfo;
  remainingBalance?: number | undefined;
  date?: Date | undefined;
}

export interface OtpOrderLogData {
  activationId: string;
  serviceName: string;
  countryName?: string | undefined;
  phoneNumber: string;
  cost: number;
  buyer: LogUserInfo;
  date?: Date | undefined;
}

export interface OtpSuccessLogData {
  activationId: string;
  serviceName: string;
  countryName?: string | undefined;
  phoneNumber: string;
  code: string;
  buyer: LogUserInfo;
  date?: Date | undefined;
}

export interface OtpCancelledLogData {
  activationId: string;
  serviceName?: string | undefined;
  countryName?: string | undefined;
  phoneNumber?: string | undefined;
  reason: "user" | "timeout" | "provider_error" | string;
  cost?: number | undefined;
  buyer: LogUserInfo;
  date?: Date | undefined;
}

export interface DatabaseRollbackLogData {
  admin: LogUserInfo;
  collectionsRestored: { name: string; count: number }[];
  totalRestored: number;
  date?: Date | undefined;
}

export interface WarrantyClaimCreatedLogData {
  claimId: string;
  orderId: string;
  productName: string;
  user: LogUserInfo;
  reason: string;
  date?: Date | undefined;
}

export interface WarrantyClaimResolvedLogData {
  claimId: string;
  orderId: string;
  productName: string;
  user: LogUserInfo;
  admin: LogUserInfo;
  resolutionType: "REPLACE" | "REFUND" | "REJECT";
  note?: string | undefined;
  refundAmount?: number | undefined;
  date?: Date | undefined;
}

// ============================================================================
//  Cache & Helpers
// ============================================================================

let cachedConfig: IBotConfig | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

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
  return (
    new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date) + " WIB"
  );
}

function formatUserHtml(user: LogUserInfo): string {
  const rawName = user.firstName?.trim() || "User";
  const safeName = escapeHtml(rawName);
  const userHandle = user.username ? ` (@${escapeHtml(user.username)})` : "";
  const numericId = String(user.telegramId);

  return `<b>${safeName}</b>${userHandle} (<code>${numericId}</code>)`;
}

// ============================================================================
//  Activity Log Service Implementation
// ============================================================================

export class ActivityLogService {
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
   * Low-level dispatcher to send HTML message to configured log channel.
   */
  private static async sendToLogChannel(
    api: Api,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    try {
      const config = await this.getConfig();

      if (
        !config.logChannelEnabled ||
        !config.logChannel ||
        config.logChannel.trim() === ""
      ) {
        return false;
      }

      const targetChannel = config.logChannel.trim();

      await api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        ...(keyboard && { reply_markup: keyboard }),
        link_preview_options: { is_disabled: true },
      });

      return true;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[ActivityLog] ⚠️ Gagal mengirim log ke channel:`, errMsg);

      if (
        errMsg.includes("CHAT_ADMIN_REQUIRED") ||
        errMsg.includes("chat not found") ||
        errMsg.includes("bot was kicked") ||
        errMsg.includes("bot is not a member") ||
        errMsg.includes("have no rights to send a message")
      ) {
        console.error(
          `❌ [ActivityLog] PENTING: Pastikan bot telah ditambahkan sebagai ADMINISTRATOR di channel log (${cachedConfig?.logChannel}) dengan izin 'Post Messages'!`
        );
      }
      return false;
    }
  }

  // ── 1. User Registration Log ───────────────────────────────────────────────

  static async logUserRegistration(
    api: Api,
    data: UserRegisterLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const dateStr = formatDateWIB(data.date || new Date());
    const source = data.registeredVia || "/start (Main Menu)";

    const text =
      `🆕 <b>[AUDIT: USER REGISTER]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `🚪 <b>Sumber:</b> <code>${escapeHtml(source)}</code>\n` +
      `💰 <b>Saldo Awal:</b> Rp 0\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Pengguna baru berhasil terdaftar di database.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 2. Topup Invoice Created Log ──────────────────────────────────────────

  static async logTopupCreated(
    api: Api,
    data: TopupCreatedLogData
  ): Promise<boolean> {
    const { session, user } = data;
    const buyer: LogUserInfo = user || { telegramId: session.telegramId };
    const formattedUser = formatUserHtml(buyer);
    const dateStr = formatDateWIB(data.date || session.createdAt || new Date());

    let purpose = "💳 Topup Saldo Akun";
    if (session.pendingProductType === "DIGITAL") {
      purpose = `📦 Pembelian Digital (ID: ${session.pendingDigitalProductId || "-"})`;
    } else if (session.pendingProductType === "SMS") {
      purpose = `💬 Sewa OTP SMS (${session.pendingServiceCode || "-"})`;
    }

    const baseAmount = session.baseAmount ?? session.amountIDR;
    const uniqueCode = session.uniqueCode || (session.amountIDR - baseAmount);

    const text =
      `💳 <b>[AUDIT: TOP-UP INVOICE DIBUAT]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${session.telegramId}</code>\n` +
      `🧾 <b>Order ID:</b> <code>${escapeHtml(session.orderId)}</code>\n` +
      `💵 <b>Nominal Dasar:</b> ${formatPrice(baseAmount)}\n` +
      `🔢 <b>Kode Unik:</b> +${uniqueCode}\n` +
      `💰 <b>Total Tagihan QRIS:</b> <b>${formatPrice(session.amountIDR)}</b>\n` +
      `🎯 <b>Tujuan:</b> ${purpose}\n` +
      `📅 <b>Waktu Dibuat:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>⏳ Menunggu pembayaran dari user via QRIS…</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 3. Topup Settled Log ──────────────────────────────────────────────────

  static async logTopupSettled(
    api: Api,
    data: TopupSettledLogData
  ): Promise<boolean> {
    const { session, user, txId, newBalance } = data;
    const buyer: LogUserInfo = user || { telegramId: session.telegramId };
    const formattedUser = formatUserHtml(buyer);
    const dateStr = formatDateWIB(data.date || new Date());

    const balanceLine =
      typeof newBalance === "number"
        ? `💰 <b>Saldo Akhir User:</b> <b>${formatPrice(newBalance)}</b>\n`
        : "";

    const txLine = txId ? `🔍 <b>ID Transaksi GoPay:</b> <code>${escapeHtml(txId)}</code>\n` : "";

    const text =
      `💰 <b>[AUDIT: TOP-UP LUNAS / SETTLED]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${session.telegramId}</code>\n` +
      `🧾 <b>Order ID:</b> <code>${escapeHtml(session.orderId)}</code>\n` +
      txLine +
      `💵 <b>Nominal Diterima:</b> <b>${formatPrice(session.amountIDR)}</b>\n` +
      balanceLine +
      `📅 <b>Waktu Lunas:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ✅ <b>SETTLEMENT (Verified)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Mutasi pembayaran QRIS terdeteksi & saldo otomatis dikreditkan.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 4. Topup Cancelled / Expired Log ───────────────────────────────────────

  static async logTopupCancelled(
    api: Api,
    data: TopupCancelledLogData
  ): Promise<boolean> {
    const { session, user, reason } = data;
    const buyer: LogUserInfo = user || { telegramId: session.telegramId };
    const formattedUser = formatUserHtml(buyer);
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `❌ <b>[AUDIT: TOP-UP BATAL / EXPIRED]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${session.telegramId}</code>\n` +
      `🧾 <b>Order ID:</b> <code>${escapeHtml(session.orderId)}</code>\n` +
      `💰 <b>Nominal Tagihan:</b> ${formatPrice(session.amountIDR)}\n` +
      `⚠️ <b>Alasan:</b> ${escapeHtml(reason || "Dibatalkan / Waktu Habis")}\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Tagihan QRIS telah ditutup.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 5. Digital Product Purchase Log ───────────────────────────────────────

  static async logDigitalPurchase(
    api: Api,
    data: DigitalPurchaseLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.buyer);
    const dateStr = formatDateWIB(data.date || new Date());
    const categoryLine = data.category
      ? `📂 <b>Kategori:</b> ${escapeHtml(data.category)}\n`
      : "";
    const remainingLine =
      typeof data.remainingBalance === "number"
        ? `💳 <b>Sisa Saldo Akun:</b> ${formatPrice(data.remainingBalance)}\n`
        : "";

    const text =
      `📦 <b>[AUDIT: PEMBELIAN PRODUK DIGITAL]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Pembeli:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.buyer.telegramId}</code>\n` +
      `🛍️ <b>Produk:</b> <b>${escapeHtml(data.productName)}</b>\n` +
      categoryLine +
      `🔢 <b>Jumlah:</b> ${data.quantity} item\n` +
      `💰 <b>Total Harga:</b> <b>${formatPrice(data.totalPrice)}</b>\n` +
      `💳 <b>Metode Pembayaran:</b> <code>${escapeHtml(data.method)}</code>\n` +
      remainingLine +
      `🆔 <b>Order ID:</b> <code>${escapeHtml(data.orderId)}</code>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ✅ <b>Sukses &amp; Terkirim Otomatis</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Stok produk digital berhasil dipotong dan dikirimkan ke user.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 6. OTP Rental Order Log ───────────────────────────────────────────────

  static async logOtpOrder(
    api: Api,
    data: OtpOrderLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.buyer);
    const dateStr = formatDateWIB(data.date || new Date());
    const countryLine = data.countryName
      ? `🌍 <b>Negara:</b> ${escapeHtml(data.countryName)}\n`
      : "";

    const text =
      `📱 <b>[AUDIT: SEWA NOMOR OTP SMS]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Penyewa:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.buyer.telegramId}</code>\n` +
      `💬 <b>Layanan:</b> <b>${escapeHtml(data.serviceName)}</b>\n` +
      countryLine +
      `📱 <b>Nomor Virtual:</b> <code>+${escapeHtml(data.phoneNumber)}</code>\n` +
      `💰 <b>Biaya Sewa:</b> <b>${formatPrice(data.cost)}</b>\n` +
      `🆔 <b>ID Aktivasi:</b> <code>${escapeHtml(data.activationId)}</code>\n` +
      `📅 <b>Waktu Sewa:</b> ${dateStr}\n` +
      `⏳ <b>Status:</b> Menunggu SMS masuk (Maks 10 Menit)…\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Nomor virtual aktif dan sedang dalam proses polling kode OTP.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 7. OTP Received / Success Log ─────────────────────────────────────────

  static async logOtpSuccess(
    api: Api,
    data: OtpSuccessLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.buyer);
    const dateStr = formatDateWIB(data.date || new Date());
    const countryLine = data.countryName
      ? `🌍 <b>Negara:</b> ${escapeHtml(data.countryName)}\n`
      : "";

    const text =
      `🔑 <b>[AUDIT: KODE OTP BERHASIL DITERIMA]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Penyewa:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.buyer.telegramId}</code>\n` +
      `💬 <b>Layanan:</b> <b>${escapeHtml(data.serviceName)}</b>\n` +
      countryLine +
      `📱 <b>Nomor Virtual:</b> <code>+${escapeHtml(data.phoneNumber)}</code>\n` +
      `📬 <b>Kode OTP Masuk:</b> <code>${escapeHtml(data.code)}</code>\n` +
      `🆔 <b>ID Aktivasi:</b> <code>${escapeHtml(data.activationId)}</code>\n` +
      `📅 <b>Waktu Diterima:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ✅ <b>COMPLETED (Sukses)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Verifikasi SMS OTP selesai berhasil.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 8. OTP Cancelled / Timeout / Refund Log ────────────────────────────────

  static async logOtpCancelled(
    api: Api,
    data: OtpCancelledLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.buyer);
    const dateStr = formatDateWIB(data.date || new Date());

    let reasonText = "Dibatalkan oleh Pengguna";
    if (data.reason === "timeout") {
      reasonText = "Timeout (Tidak ada SMS masuk dalam 10 menit)";
    } else if (data.reason === "provider_error") {
      reasonText = "Stok Kosong / Gangguan Provider SMS";
    } else if (data.reason) {
      reasonText = data.reason;
    }

    const serviceLine = data.serviceName
      ? `💬 <b>Layanan:</b> ${escapeHtml(data.serviceName)}\n`
      : "";
    const phoneLine = data.phoneNumber
      ? `📱 <b>Nomor:</b> <code>+${escapeHtml(data.phoneNumber)}</code>\n`
      : "";
    const refundLine =
      typeof data.cost === "number" && data.cost > 0
        ? `💰 <b>Refund Saldo:</b> <b>${formatPrice(data.cost)}</b> (Dikembalikan ke akun)\n`
        : "";

    const text =
      `🚫 <b>[AUDIT: OTP DIBATALKAN &amp; REFUND]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Penyewa:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.buyer.telegramId}</code>\n` +
      serviceLine +
      phoneLine +
      refundLine +
      `⚠️ <b>Alasan:</b> ${escapeHtml(reasonText)}\n` +
      `🆔 <b>ID Aktivasi:</b> <code>${escapeHtml(data.activationId)}</code>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ❌ <b>CANCELED / REFUNDED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Transaksi OTP dibatalkan dan saldo user aman.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 9. Database Rollback Audit Log ───────────────────────────────────────

  static async logDatabaseRollback(
    api: Api,
    data: DatabaseRollbackLogData
  ): Promise<boolean> {
    const formattedAdmin = formatUserHtml(data.admin);
    const dateStr = formatDateWIB(data.date || new Date());

    const collectionsList = data.collectionsRestored
      .map((c) => `• <b>${escapeHtml(c.name)}:</b> ${c.count} dokumen`)
      .join("\n");

    const text =
      `♻️ <b>[AUDIT: ROLLBACK / RESTORE DATABASE]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Admin Eksekutor:</b> ${formattedAdmin}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.admin.telegramId}</code>\n` +
      `📦 <b>Total Dokumen Dipulihkan:</b> <b>${data.totalRestored}</b>\n` +
      `📅 <b>Waktu Eksekusi:</b> ${dateStr}\n\n` +
      `📊 <b>Rincian Koleksi:</b>\n` +
      `${collectionsList}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>⚠️ Data database telah dipulihkan dari arsip backup. Safety backup tersimpan.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 10. Test Log Dispatcher ────────────────────────────────────────────────

  static async sendTestLog(
    api: Api
  ): Promise<{ success: boolean; channel?: string; error?: string }> {
    const config = await this.getConfig();

    if (!config.logChannel || config.logChannel.trim() === "") {
      return {
        success: false,
        error: "Channel log belum diatur. Silakan atur username atau ID channel terlebih dahulu.",
      };
    }

    const targetChannel = config.logChannel.trim();
    const formattedDate = formatDateWIB(new Date());

    const text =
      `🧪 <b>[UJI COBA CHANNEL LOG AKTIVITAS]</b> 🧪\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 <b>Target Channel:</b> <code>${escapeHtml(targetChannel)}</code>\n` +
      `📅 <b>Waktu Tes:</b> ${formattedDate}\n` +
      `🤖 <b>Status Koneksi:</b> ✅ <b>Normal &amp; Terhubung</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Ini adalah pesan tes konfigurasi Channel Log dari Admin Panel bot.</i>`;

    try {
      await api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return { success: true, channel: targetChannel };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      return { success: false, channel: targetChannel, error: errMsg };
    }
  }

  // ── 11. Warranty Claim Created Log ──────────────────────────────────────────

  static async logWarrantyClaimCreated(
    api: Api,
    data: WarrantyClaimCreatedLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `🛡️ <b>[AUDIT: KLAIM GARANSI DIAJUKAN]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `🎫 <b>ID Tiket:</b> <code>${escapeHtml(data.claimId)}</code>\n` +
      `📦 <b>Order ID:</b> <code>${escapeHtml(data.orderId)}</code>\n` +
      `🏷️ <b>Produk:</b> <b>${escapeHtml(data.productName)}</b>\n` +
      `📝 <b>Keluhan / Kendala:</b>\n<i>${escapeHtml(data.reason)}</i>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>⏳ Menunggu penanganan / persetujuan dari admin.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 12. Warranty Claim Resolved Log ─────────────────────────────────────────

  static async logWarrantyClaimResolved(
    api: Api,
    data: WarrantyClaimResolvedLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const formattedAdmin = formatUserHtml(data.admin);
    const dateStr = formatDateWIB(data.date || new Date());

    let resolutionLabel = "—";
    let extraInfo = "";
    if (data.resolutionType === "REPLACE") {
      resolutionLabel = "🔄 <b>Ganti Stok Baru (Replaced)</b>";
      extraInfo = `<i>🔑 Stok baru otomatis dikirimkan ke chat pembeli.</i>\n`;
    } else if (data.resolutionType === "REFUND") {
      resolutionLabel = "💰 <b>Refund Saldo (Refunded)</b>";
      extraInfo = `💵 <b>Nominal Refund:</b> Rp ${(data.refundAmount || 0).toLocaleString("id-ID")}\n`;
    } else if (data.resolutionType === "REJECT") {
      resolutionLabel = "❌ <b>Klaim Ditolak (Rejected)</b>";
      extraInfo = `💬 <b>Alasan Penolakan:</b> <i>${escapeHtml(data.note || "Tidak ada")}</i>\n`;
    }

    const text =
      `🛡️ <b>[AUDIT: KLAIM GARANSI SELESAI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎫 <b>ID Tiket:</b> <code>${escapeHtml(data.claimId)}</code>\n` +
      `📦 <b>Order ID:</b> <code>${escapeHtml(data.orderId)}</code>\n` +
      `🏷️ <b>Produk:</b> <b>${escapeHtml(data.productName)}</b>\n` +
      `👤 <b>Pembeli:</b> ${formattedUser}\n` +
      `👮 <b>Admin Resolusi:</b> ${formattedAdmin}\n` +
      `⚖️ <b>Hasil Resolusi:</b> ${resolutionLabel}\n` +
      extraInfo +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✅ Tiket klaim garansi telah berhasil ditindaklanjuti.</i>`;

    return this.sendToLogChannel(api, text);
  }
}
