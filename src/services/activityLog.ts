import { TenantMap } from "../tenant/TenantMap.js";
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
  referredBy?: string | undefined;
  referrerUser?: LogUserInfo | undefined;
  date?: Date | undefined;
}

export interface BalanceAdjustLogData {
  user: LogUserInfo;
  admin?: LogUserInfo | undefined;
  type: "CREDIT" | "DEBIT" | "PURCHASE" | "REFUND" | "TOPUP" | "COMMISSION" | string;
  amount: number;
  balanceBefore?: number | undefined;
  balanceAfter: number;
  reason?: string | undefined;
  date?: Date | undefined;
}

export interface UserBanLogData {
  user: LogUserInfo;
  admin?: LogUserInfo | undefined;
  reason?: string | undefined;
  date?: Date | undefined;
}

export interface UserUnbanLogData {
  user: LogUserInfo;
  admin?: LogUserInfo | undefined;
  date?: Date | undefined;
}

export interface UserUnflagLogData {
  user: LogUserInfo;
  admin?: LogUserInfo | undefined;
  date?: Date | undefined;
}

export interface ProductCreatedLogData {
  admin?: LogUserInfo | undefined;
  productId: string;
  name: string;
  category: string;
  price: number;
  warrantyHours?: number | undefined;
  date?: Date | undefined;
}

export interface ProductUpdatedLogData {
  admin?: LogUserInfo | undefined;
  productId: string;
  name: string;
  changes: string;
  date?: Date | undefined;
}

export interface ProductDeletedLogData {
  admin?: LogUserInfo | undefined;
  productId: string;
  name: string;
  category?: string | undefined;
  date?: Date | undefined;
}

export interface StockAddedLogData {
  admin?: LogUserInfo | undefined;
  productId: string;
  productName: string;
  addedCount: number;
  totalUnsoldStock?: number | undefined;
  date?: Date | undefined;
}

export interface StockRemovedLogData {
  admin?: LogUserInfo | undefined;
  productId: string;
  productName: string;
  removedCount: number;
  action: "CLEAR_ALL" | "DELETE_SINGLE" | "TAKE_MANUAL" | string;
  date?: Date | undefined;
}

export interface PromoCreatedLogData {
  admin?: LogUserInfo | undefined;
  code: string;
  discountType: "FIXED" | "PERCENTAGE";
  discountValue: number;
  quota: number;
  minSpend: number;
  expiresAt: Date;
  date?: Date | undefined;
}

export interface PromoUsedLogData {
  user: LogUserInfo;
  code: string;
  discountAmount: number;
  totalAfterDiscount: number;
  orderId?: string | undefined;
  date?: Date | undefined;
}

export interface BroadcastLogData {
  admin?: LogUserInfo | undefined;
  filterLabel: string;
  totalTarget: number;
  sent: number;
  failed: number;
  blocked: number;
  date?: Date | undefined;
}

export interface DatabaseBackupLogData {
  triggeredBy: "ADMIN" | "CRON_AUTO";
  admin?: LogUserInfo | undefined;
  fileName?: string | undefined;
  totalCollections: number;
  recipientsCount: number;
  date?: Date | undefined;
}

export interface CloudflareRuleCreatedLogData {
  admin?: LogUserInfo | undefined;
  email: string;
  destinationEmail: string;
  domain: string;
  ruleId?: string | undefined;
  date?: Date | undefined;
}

export interface CloudflareRuleDeletedLogData {
  admin?: LogUserInfo | undefined;
  ruleId: string;
  zoneId?: string | undefined;
  date?: Date | undefined;
}

export interface ConfigUpdatedLogData {
  admin?: LogUserInfo | undefined;
  moduleName: string;
  changeDescription: string;
  date?: Date | undefined;
}

export interface AffiliateCommissionLogData {
  referrer: LogUserInfo;
  referredUser: LogUserInfo;
  sourceType: string;
  sourceOrderId: string;
  purchaseAmount: number;
  commissionAmount: number;
  newAffiliateBalance?: number | undefined;
  date?: Date | undefined;
}

export interface AffiliateWithdrawalLogData {
  user: LogUserInfo;
  amount: number;
  newMainBalance?: number | undefined;
  date?: Date | undefined;
}

export interface EmailOtpForwardedLogData {
  provider: "PAYPAL" | "NETFLIX" | "DISCORD" | "GENERIC" | string;
  subject?: string | undefined;
  senderEmail: string;
  recipientEmail?: string | undefined;
  recipientName?: string | undefined;
  otpCode?: string | undefined;
  targetChannel?: string | undefined;
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

const configCache = new TenantMap<string, { config: IBotConfig; cachedAt: number }>();

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
  private static defaultApi: Api | null = null;

  /**
   * Sets the global default grammY Api instance for the ActivityLogService.
   */
  static setDefaultApi(api: Api): void {
    this.defaultApi = api;
  }

  /**
   * Retrieves the default grammY Api instance or creates a fallback if BOT_TOKEN is present.
   */
  static getDefaultApi(): Api | null {
    if (this.defaultApi) return this.defaultApi;
    const token = process.env["BOT_TOKEN"];
    if (token && token.trim() !== "") {
      try {
        this.defaultApi = new Api(token.trim());
        return this.defaultApi;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Retrieves current bot configuration from cache or MongoDB.
   */
  static async getConfig(): Promise<IBotConfig> {
    const now = Date.now();
    const cached = configCache.get("config");
    if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
      return cached.config;
    }
    const config = await BotConfig.getOrCreate();
    configCache.set("config", { config, cachedAt: now });
    return config;
  }

  /**
   * Updates bot configuration in DB and refreshes cache.
   */
  static async updateConfig(updates: Partial<IBotConfig>): Promise<IBotConfig> {
    const config = await BotConfig.getOrCreate();
    Object.assign(config, updates);
    await config.save();
    configCache.set("config", { config, cachedAt: Date.now() });

    return config;
  }

  /**
   * Directly sets the in-memory cached configuration (useful for testing and instant cache updates).
   */
  static setCachedConfig(config: IBotConfig | null): void {
    if (config) {
      configCache.set("config", { config, cachedAt: Date.now() });
    } else {
      configCache.delete("config");
    }
  }

  /**
   * Low-level dispatcher to send HTML message to configured log channel.
   */
  private static async sendToLogChannel(
    api?: Api | null,
    text?: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    if (!text) return false;
    const tgApi = api || this.getDefaultApi();
    if (!tgApi) {
      return false;
    }

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

      await tgApi.sendMessage(targetChannel, text, {
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
          `❌ [ActivityLog] PENTING: Pastikan bot telah ditambahkan sebagai ADMINISTRATOR di channel log (${configCache.get("config")?.config.logChannel}) dengan izin 'Post Messages'!`
        );
      }
      return false;
    }
  }

  // ── 1. User Registration Log ───────────────────────────────────────────────

  static async logUserRegistration(
    api: Api | undefined,
    data: UserRegisterLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const dateStr = formatDateWIB(data.date || new Date());
    const source = data.registeredVia || "/start (Main Menu)";

    let referralLine = "";
    if (data.referrerUser) {
      referralLine = `👥 <b>Referral Dari:</b> ${formatUserHtml(data.referrerUser)}\n`;
    } else if (data.referredBy) {
      referralLine = `👥 <b>Referral Dari:</b> <code>${escapeHtml(data.referredBy)}</code>\n`;
    }

    const text =
      `🆕 <b>[AUDIT: USER REGISTER]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      referralLine +
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

  // ── 13. Manual Balance Mutation Log ────────────────────────────────────────

  static async logBalanceAdjusted(
    api: Api | undefined,
    data: BalanceAdjustLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Sistem</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const isCredit = ["CREDIT", "TOPUP", "COMMISSION", "REFUND"].includes(data.type.toUpperCase());
    const sign = isCredit ? "+" : "-";
    const badgeType = isCredit ? `🟢 <b>${escapeHtml(data.type)} (TAMBAH)</b>` : `🔴 <b>${escapeHtml(data.type)} (POTONG)</b>`;

    const beforeLine =
      typeof data.balanceBefore === "number"
        ? `💵 <b>Saldo Sebelum:</b> ${formatPrice(data.balanceBefore)}\n`
        : "";

    const text =
      `💰 <b>[AUDIT: MUTASI SALDO MANUAL]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `👮 <b>Eksekutor:</b> ${formattedAdmin}\n` +
      `📊 <b>Jenis Mutasi:</b> ${badgeType}\n` +
      `🔢 <b>Nominal:</b> <b>${sign}${formatPrice(data.amount)}</b>\n` +
      beforeLine +
      `💳 <b>Saldo Akhir:</b> <b>${formatPrice(data.balanceAfter)}</b>\n` +
      `📝 <b>Alasan:</b> <i>${escapeHtml(data.reason || "Penyesuaian saldo oleh admin")}</i>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Saldo pengguna berhasil dimutasi dan tercatat dalam audit log.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 14. User Ban & Security Action Logs ──────────────────────────────────────

  static async logUserBanned(
    api: Api | undefined,
    data: UserBanLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Sistem Anti-Fraud</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `🚫 <b>[AUDIT: USER DIBANNED / BLOKIR]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `👮 <b>Admin / Eksekutor:</b> ${formattedAdmin}\n` +
      `📌 <b>Alasan Pemblokiran:</b> <i>${escapeHtml(data.reason || "Pelanggaran aturan / Indikasi fraud")}</i>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status Akun:</b> 🔴 <b>BANNED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>⚠️ Pengguna telah diblokir dan tidak dapat mengakses fitur transaksi bot.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logUserUnbanned(
    api: Api | undefined,
    data: UserUnbanLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `🔓 <b>[AUDIT: USER DI-UNBAN / AKTIF KEMBALI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `👮 <b>Admin Pemulih:</b> ${formattedAdmin}\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status Akun:</b> 🟢 <b>ACTIVE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Akses pengguna telah dipulihkan dan dapat menggunakan bot kembali.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logUserUnflagged(
    api: Api | undefined,
    data: UserUnflagLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `✅ <b>[AUDIT: STATUS REVIEW PENGGUNA DIPULIHKAN]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>User:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `👮 <b>Admin Verifikator:</b> ${formattedAdmin}\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status Akun:</b> 🟢 <b>ACTIVE (Unflagged)</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Status UNDER_REVIEW telah dinormalisasi kembali menjadi aktif.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 15. Digital Product Catalog Logs ────────────────────────────────────────

  static async logProductCreated(
    api: Api | undefined,
    data: ProductCreatedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const warrantyLine =
      typeof data.warrantyHours === "number" && data.warrantyHours > 0
        ? `🛡️ <b>Durasi Garansi:</b> ${data.warrantyHours} Jam\n`
        : "";

    const text =
      `🛍️ <b>[AUDIT: PRODUK DIGITAL BARU DIBUAT]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Pembuat:</b> ${formattedAdmin}\n` +
      `📦 <b>Nama Produk:</b> <b>${escapeHtml(data.name)}</b>\n` +
      `📂 <b>Kategori:</b> <code>${escapeHtml(data.category)}</code>\n` +
      `💰 <b>Harga:</b> <b>${formatPrice(data.price)}</b>\n` +
      warrantyLine +
      `🆔 <b>Product ID:</b> <code>${escapeHtml(data.productId)}</code>\n` +
      `📅 <b>Waktu Dibuat:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Produk digital baru telah terdaftar di etalase toko.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logProductUpdated(
    api: Api | undefined,
    data: ProductUpdatedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `✏️ <b>[AUDIT: PRODUK DIGITAL DIPERBARUI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Pengubah:</b> ${formattedAdmin}\n` +
      `📦 <b>Produk:</b> <b>${escapeHtml(data.name)}</b>\n` +
      `🆔 <b>Product ID:</b> <code>${escapeHtml(data.productId)}</code>\n` +
      `📝 <b>Perubahan:</b>\n${escapeHtml(data.changes)}\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Konfigurasi produk digital berhasil diperbarui.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logProductDeleted(
    api: Api | undefined,
    data: ProductDeletedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const categoryLine = data.category ? `📂 <b>Kategori:</b> <code>${escapeHtml(data.category)}</code>\n` : "";

    const text =
      `🗑️ <b>[AUDIT: PRODUK DIGITAL DIHAPUS]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin:</b> ${formattedAdmin}\n` +
      `📦 <b>Produk:</b> <b>${escapeHtml(data.name)}</b>\n` +
      categoryLine +
      `🆔 <b>Product ID:</b> <code>${escapeHtml(data.productId)}</code>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>⚠️ Produk digital telah dihapus dari database.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 16. Digital Stock Inventory Logs ────────────────────────────────────────

  static async logStockAdded(
    api: Api | undefined,
    data: StockAddedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const totalLine =
      typeof data.totalUnsoldStock === "number"
        ? `📊 <b>Total Stok Tersedia Sekarang:</b> <b>${data.totalUnsoldStock} item</b>\n`
        : "";

    const text =
      `📥 <b>[AUDIT: STOK DIGITAL DITAMBAHKAN]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin:</b> ${formattedAdmin}\n` +
      `📦 <b>Produk:</b> <b>${escapeHtml(data.productName)}</b>\n` +
      `🆔 <b>Product ID:</b> <code>${escapeHtml(data.productId)}</code>\n` +
      `➕ <b>Jumlah Ditambahkan:</b> <b>+${data.addedCount} item</b>\n` +
      totalLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Stok inventaris produk digital siap dijual kepada pelanggan.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logStockRemoved(
    api: Api | undefined,
    data: StockRemovedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    let actionLabel = "Pengurangan Stok";
    if (data.action === "CLEAR_ALL") actionLabel = "Kosongkan Seluruh Stok Belum Terjual";
    else if (data.action === "DELETE_SINGLE") actionLabel = "Hapus 1 Item Stok Spesifik";
    else if (data.action === "TAKE_MANUAL") actionLabel = "Pengambilan Stok Manual oleh Admin";

    const text =
      `📤 <b>[AUDIT: STOK DIGITAL DIKURANGI / DIAMBIL]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin:</b> ${formattedAdmin}\n` +
      `📦 <b>Produk:</b> <b>${escapeHtml(data.productName)}</b>\n` +
      `🆔 <b>Product ID:</b> <code>${escapeHtml(data.productId)}</code>\n` +
      `🎯 <b>Tindakan:</b> <code>${escapeHtml(actionLabel)}</code>\n` +
      `➖ <b>Jumlah Dikeluarkan:</b> <b>${data.removedCount} item</b>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Item stok digital telah dikeluarkan dari inventaris database.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 17. Promo & Voucher Logs ───────────────────────────────────────────────

  static async logPromoCreated(
    api: Api | undefined,
    data: PromoCreatedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const expStr = formatDateWIB(data.expiresAt);

    const discountStr =
      data.discountType === "FIXED"
        ? formatPrice(data.discountValue)
        : `${data.discountValue}%`;

    const text =
      `🎟️ <b>[AUDIT: KODE PROMO BARU DIBUAT]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Pembuat:</b> ${formattedAdmin}\n` +
      `🏷️ <b>Kode Promo:</b> <code>${escapeHtml(data.code)}</code>\n` +
      `💰 <b>Potongan Diskon:</b> <b>${discountStr}</b> (${data.discountType})\n` +
      `🎯 <b>Kuota Penggunaan:</b> ${data.quota}x\n` +
      `💵 <b>Min. Belanja:</b> ${formatPrice(data.minSpend)}\n` +
      `⏰ <b>Kadaluarsa:</b> ${expStr}\n` +
      `📅 <b>Waktu Dibuat:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Voucher diskon aktif dan dapat digunakan pembeli.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logPromoUsed(
    api: Api | undefined,
    data: PromoUsedLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const dateStr = formatDateWIB(data.date || new Date());
    const orderLine = data.orderId ? `🧾 <b>Order ID:</b> <code>${escapeHtml(data.orderId)}</code>\n` : "";

    const text =
      `🏷️ <b>[AUDIT: KODE PROMO DIGUNAKAN]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Pengguna:</b> ${formattedUser}\n` +
      `🎟️ <b>Kode Digunakan:</b> <code>${escapeHtml(data.code)}</code>\n` +
      `🎉 <b>Potongan Diskon:</b> <b>-${formatPrice(data.discountAmount)}</b>\n` +
      `💰 <b>Total Tagihan Akhir:</b> <b>${formatPrice(data.totalAfterDiscount)}</b>\n` +
      orderLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Diskon promo berhasil diterapkan pada checkout.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 18. Broadcast Log ──────────────────────────────────────────────────────

  static async logBroadcastExecuted(
    api: Api | undefined,
    data: BroadcastLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `📢 <b>[AUDIT: BROADCAST MASSAL SELESAI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Eksekutor:</b> ${formattedAdmin}\n` +
      `🎯 <b>Segmen Target:</b> <code>${escapeHtml(data.filterLabel)}</code>\n` +
      `👥 <b>Total Sasaran:</b> ${data.totalTarget} pengguna\n` +
      `✅ <b>Berhasil Terkirim:</b> <b>${data.sent}</b>\n` +
      `🚫 <b>Akun Blokir/Deactive:</b> ${data.blocked}\n` +
      `❌ <b>Gagal Terkirim:</b> ${data.failed}\n` +
      `📅 <b>Waktu Selesai:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Pesan broadcast berhasil didistribusikan ke target pengguna.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 19. Database Backup Log ────────────────────────────────────────────────

  static async logDatabaseBackup(
    api: Api | undefined,
    data: DatabaseBackupLogData
  ): Promise<boolean> {
    const adminStr =
      data.triggeredBy === "CRON_AUTO"
        ? "<i>⏰ Jadwal Otomatis Sistem (00:00 WIB)</i>"
        : data.admin
        ? formatUserHtml(data.admin)
        : "<i>Admin</i>";

    const dateStr = formatDateWIB(data.date || new Date());
    const fileLine = data.fileName ? `📁 <b>File Arsip:</b> <code>${escapeHtml(data.fileName)}</code>\n` : "";

    const text =
      `🗄️ <b>[AUDIT: BACKUP DATABASE SELESAI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Pemicu Backup:</b> ${adminStr}\n` +
      fileLine +
      `📦 <b>Koleksi Dicadangkan:</b> <b>${data.totalCollections} koleksi</b>\n` +
      `📬 <b>Dikirim Ke:</b> <b>${data.recipientsCount} admin Telegram</b>\n` +
      `📅 <b>Waktu Selesai:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Backup database lengkap berhasil diexport dan diamankan.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 20. Cloudflare Email Routing Logs ──────────────────────────────────────

  static async logCloudflareRuleCreated(
    api: Api | undefined,
    data: CloudflareRuleCreatedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const ruleLine = data.ruleId ? `🆔 <b>Rule ID:</b> <code>${escapeHtml(data.ruleId)}</code>\n` : "";

    const text =
      `☁️ <b>[AUDIT: CLOUDFLARE EMAIL ROUTING DIBUAT]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Pembuat:</b> ${formattedAdmin}\n` +
      `📧 <b>Email Baru:</b> <code>${escapeHtml(data.email)}</code>\n` +
      `🎯 <b>Diteruskan Ke:</b> <code>${escapeHtml(data.destinationEmail)}</code>\n` +
      `🌐 <b>Domain:</b> <code>${escapeHtml(data.domain)}</code>\n` +
      ruleLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Email forwarding Cloudflare aktif untuk menerima pesan / OTP.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logCloudflareRuleDeleted(
    api: Api | undefined,
    data: CloudflareRuleDeletedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());
    const zoneLine = data.zoneId ? `🌐 <b>Zone ID:</b> <code>${escapeHtml(data.zoneId)}</code>\n` : "";

    const text =
      `🗑️ <b>[AUDIT: CLOUDFLARE EMAIL ROUTING DIHAPUS]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin:</b> ${formattedAdmin}\n` +
      `🆔 <b>Rule ID:</b> <code>${escapeHtml(data.ruleId)}</code>\n` +
      zoneLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Rule email forwarding telah dihapus dari Cloudflare.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 21. Bot Settings & Configurations Changed Log ──────────────────────────

  static async logConfigUpdated(
    api: Api | undefined,
    data: ConfigUpdatedLogData
  ): Promise<boolean> {
    const formattedAdmin = data.admin ? formatUserHtml(data.admin) : "<i>Admin</i>";
    const dateStr = formatDateWIB(data.date || new Date());

    const text =
      `⚙️ <b>[AUDIT: PENGATURAN BOT DIUBAH]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👮 <b>Admin Pengubah:</b> ${formattedAdmin}\n` +
      `🔧 <b>Modul / Fitur:</b> <b>${escapeHtml(data.moduleName)}</b>\n` +
      `📝 <b>Detail Perubahan:</b>\n<i>${escapeHtml(data.changeDescription)}</i>\n` +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>ℹ️ Konfigurasi runtime bot berhasil diperbarui di database.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 22. Affiliate / Referral Program Logs ──────────────────────────────────

  static async logAffiliateCommission(
    api: Api | undefined,
    data: AffiliateCommissionLogData
  ): Promise<boolean> {
    const formattedReferrer = formatUserHtml(data.referrer);
    const formattedReferee = formatUserHtml(data.referredUser);
    const dateStr = formatDateWIB(data.date || new Date());
    const balanceLine =
      typeof data.newAffiliateBalance === "number"
        ? `📊 <b>Saldo Afiliasi Sekarang:</b> <b>${formatPrice(data.newAffiliateBalance)}</b>\n`
        : "";

    const text =
      `👥 <b>[AUDIT: KOMISI AFILIASI DITERIMA]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎁 <b>Penerima Komisi:</b> ${formattedReferrer}\n` +
      `🛍️ <b>Pembeli (Referral):</b> ${formattedReferee}\n` +
      `📦 <b>Sumber Transaksi:</b> <code>${escapeHtml(data.sourceType)}</code>\n` +
      `🧾 <b>Order ID:</b> <code>${escapeHtml(data.sourceOrderId)}</code>\n` +
      `💵 <b>Total Pembelian:</b> ${formatPrice(data.purchaseAmount)}\n` +
      `💰 <b>Komisi Diperoleh:</b> <b>+${formatPrice(data.commissionAmount)}</b>\n` +
      balanceLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Bonus komisi referral otomatis dikreditkan ke saldo afiliasi.</i>`;

    return this.sendToLogChannel(api, text);
  }

  static async logAffiliateWithdrawal(
    api: Api | undefined,
    data: AffiliateWithdrawalLogData
  ): Promise<boolean> {
    const formattedUser = formatUserHtml(data.user);
    const dateStr = formatDateWIB(data.date || new Date());
    const balanceLine =
      typeof data.newMainBalance === "number"
        ? `💳 <b>Saldo Utama Baru:</b> <b>${formatPrice(data.newMainBalance)}</b>\n`
        : "";

    const text =
      `💸 <b>[AUDIT: PENARIKAN SALDO AFILIASI]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Pengguna:</b> ${formattedUser}\n` +
      `🆔 <b>Telegram ID:</b> <code>${data.user.telegramId}</code>\n` +
      `💰 <b>Nominal Ditarik:</b> <b>${formatPrice(data.amount)}</b>\n` +
      balanceLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ✅ <b>Dipindahkan ke Saldo Utama</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Saldo komisi afiliasi berhasil dikonversi ke saldo belanja utama.</i>`;

    return this.sendToLogChannel(api, text);
  }

  // ── 23. IMAP OTP Forwarded Log ─────────────────────────────────────────────

  static async logEmailOtpForwarded(
    api: Api | undefined,
    data: EmailOtpForwardedLogData
  ): Promise<boolean> {
    const dateStr = formatDateWIB(data.date || new Date());
    const recipientLine = data.recipientEmail
      ? `👤 <b>Penerima:</b> <code>${escapeHtml(data.recipientEmail)}</code>\n`
      : data.recipientName
      ? `👤 <b>Nama Penerima:</b> <code>${escapeHtml(data.recipientName)}</code>\n`
      : "";

    const codeLine = data.otpCode ? `📬 <b>Kode OTP:</b> <code>${escapeHtml(data.otpCode)}</code>\n` : "";
    const channelLine = data.targetChannel ? `📢 <b>Diteruskan Ke:</b> <code>${escapeHtml(data.targetChannel)}</code>\n` : "";
    const subjectLine = data.subject ? `📝 <b>Subjek:</b> <i>${escapeHtml(data.subject)}</i>\n` : "";

    const text =
      `📬 <b>[AUDIT: EMAIL OTP DITERUSKAN]</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🌐 <b>Provider:</b> <b>${escapeHtml(data.provider)}</b>\n` +
      `📧 <b>Pengirim:</b> <code>${escapeHtml(data.senderEmail)}</code>\n` +
      recipientLine +
      subjectLine +
      codeLine +
      channelLine +
      `📅 <b>Waktu:</b> ${dateStr}\n` +
      `⚡ <b>Status:</b> ✅ <b>Berhasil Diteruskan Otomatis</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>✨ Email OTP dari IMAP listener telah berhasil diproses & diforward.</i>`;

    return this.sendToLogChannel(api, text);
  }
}

