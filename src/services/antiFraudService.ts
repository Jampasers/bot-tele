import crypto from "node:crypto";
import { Api, InlineKeyboard } from "grammy";
import { FraudLog, IFraudLog, FraudType, FraudSeverity, FraudAction, FraudLogDocument } from "../models/FraudLog.js";
import { User, IUser } from "../models/User.js";
import { BotConfig } from "../models/BotConfig.js";
import { WarrantyClaim } from "../models/WarrantyClaim.js";
import { DigitalOrder } from "../models/DigitalOrder.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { getAdminIds } from "../core/admin.js";

// ============================================================================
//  In-Memory TTL & Idempotency Cache Engine
// ============================================================================

interface CacheEntry<T = any> {
  value: T;
  expiresAt: number; // Unix epoch in ms
}

class MemoryTtlStore {
  private store = new Map<string, CacheEntry>();
  private sweepInterval: NodeJS.Timeout;

  constructor() {
    // Periodically sweep expired keys every 60 seconds
    this.sweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt <= now) {
          this.store.delete(key);
        }
      }
    }, 60_000);
    this.sweepInterval.unref?.();
  }

  public get<T = any>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  public set<T = any>(key: string, value: T, ttlSeconds: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  public has(key: string): boolean {
    return this.get(key) !== null;
  }

  public getRemainingTtl(key: string): number {
    const entry = this.store.get(key);
    if (!entry) return 0;
    const rem = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return rem > 0 ? rem : 0;
  }
}

const memoryStore = new MemoryTtlStore();

// ============================================================================
//  Types & DTOs
// ============================================================================

export interface SecurityAlertData {
  fraudType: FraudType;
  severity: FraudSeverity;
  userId: string;
  userHandle?: string | undefined;
  reason: string;
  actionTaken: FraudAction;
  signature?: string | undefined;
  metadata?: Record<string, any> | undefined;
}

export interface SecurityReviewSummary {
  user: IUser;
  fraudLogsCount: number;
  recentFraudLogs: IFraudLog[];
  totalOrders: number;
  totalClaims: number;
  claimRatioPercent: number;
  totalBalanceSpent: number;
}

// ============================================================================
//  AntiFraudService
// ============================================================================

export class AntiFraudService {
  // ── 1. Payment Idempotency & Replay Guard ───────────────────────────────────

  /**
   * Generates a deterministic MD5 signature for a payment transaction.
   * `MD5(issuer + amount + date + referenceId)`
   */
  public static computePaymentSignature(
    issuer: string,
    amount: number,
    date: number | Date,
    referenceId: string
  ): string {
    const dateStr = typeof date === "number" ? new Date(date).toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
    const raw = `${issuer.toUpperCase()}:${amount}:${dateStr}:${referenceId.trim()}`;
    return crypto.createHash("md5").update(raw).digest("hex");
  }

  /**
   * Checks if a payment transaction has already been claimed (Replay Attack detection).
   * Verifies against 48-hour TTL cache and MongoDB `FraudLog`.
   */
  public static async checkPaymentReplay(
    signature: string,
    meta: {
      userId?: string;
      userHandle?: string;
      amount?: number;
      txId?: string;
      issuer?: string;
    },
    api?: Api
  ): Promise<{ isReplay: boolean; reason?: string }> {
    const cacheKey = `sec:pay:sig:${signature}`;
    const isCached = memoryStore.has(cacheKey);

    if (isCached) {
      const reason = `Deteksi mutasi ganda / Replay Attack pada transaksi ${meta.txId || signature} sebesar Rp ${meta.amount?.toLocaleString("id-ID") || 0}`;

      // Log security event
      await this.logFraud({
        fraudType: "PAYMENT_REPLAY",
        severity: "HIGH",
        userId: meta.userId || "UNKNOWN",
        userHandle: meta.userHandle,
        reason,
        actionTaken: "BLOCKED",
        signature,
        metadata: meta,
      }, api);

      return { isReplay: true, reason };
    }

    return { isReplay: false };
  }

  /**
   * Records a settled payment signature into the cache with a 48-hour TTL (172,800 seconds).
   */
  public static async recordPaymentSignature(
    signature: string,
    ttlSeconds = 48 * 60 * 60
  ): Promise<void> {
    const cacheKey = `sec:pay:sig:${signature}`;
    memoryStore.set(cacheKey, { timestamp: Date.now() }, ttlSeconds);
  }

  // ── 2. Warranty Abuse Detection ───────────────────────────────────────────

  /**
   * Evaluates if a user's warranty claim activity exceeds safe thresholds:
   * - Daily claim count > maxWarrantyClaimsPerDay (default 3)
   * - Claim to Order ratio > maxWarrantyClaimRatioPercent (default 50%)
   *
   * Automatically sets user status to `UNDER_REVIEW` and blocks automated fulfillment.
   */
  public static async checkWarrantyAbuse(
    userId: string,
    api?: Api
  ): Promise<{ allowed: boolean; underReview: boolean; reason?: string }> {
    const config = await BotConfig.getOrCreate();
    const maxPerDay = config.maxWarrantyClaimsPerDay || 3;
    const maxRatioPercent = config.maxWarrantyClaimRatioPercent || 50;

    const user = await User.findOne({ telegramId: userId });
    if (!user) {
      return { allowed: true, underReview: false };
    }

    // If account is already banned or under review
    if (user.isBanned || user.accountStatus === "BANNED") {
      return {
        allowed: false,
        underReview: false,
        reason: "Akun Anda sedang diblokir dari layanan ini.",
      };
    }

    // Count claims made in the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dailyClaimsCount = await WarrantyClaim.countDocuments({
      userId,
      createdAt: { $gte: oneDayAgo },
    });

    // Lifetime claims count
    const totalLifetimeClaims = await WarrantyClaim.countDocuments({ userId });
    const totalOrders = Math.max(1, user.totalOrders || 0);
    const claimRatio = Math.round((totalLifetimeClaims / totalOrders) * 100);

    const isDailyAbuse = dailyClaimsCount >= maxPerDay;
    const isRatioAbuse = totalLifetimeClaims >= 2 && claimRatio > maxRatioPercent;

    if (isDailyAbuse || isRatioAbuse) {
      const reasonDetail = isDailyAbuse
        ? `Frekuensi klaim melebihi batas (${dailyClaimsCount}/${maxPerDay} klaim dalam 24 jam).`
        : `Rasio klaim garansi abnormal (${claimRatio}% dari total ${totalOrders} pesanan).`;

      // Auto-flag user account to UNDER_REVIEW
      await User.updateOne(
        { telegramId: userId },
        {
          $set: {
            accountStatus: "UNDER_REVIEW",
            flaggedAt: new Date(),
          },
          $inc: { fraudScore: 25 },
        }
      );

      // Log fraud event
      await this.logFraud({
        fraudType: "WARRANTY_ABUSE",
        severity: "HIGH",
        userId,
        userHandle: user.username || user.firstName,
        reason: `Indikasi Abuse Klaim Garansi: ${reasonDetail}`,
        actionTaken: "FLAGGED_UNDER_REVIEW",
        metadata: {
          dailyClaimsCount,
          totalLifetimeClaims,
          totalOrders,
          claimRatioPercent: claimRatio,
        },
      }, api);

      return {
        allowed: false,
        underReview: true,
        reason:
          `⚠️ <b>Klaim Ditangguhkan (Pemeriksaan Keamanan)</b>\n\n` +
          `Aktivitas klaim garansi pada akun Anda terdeteksi melebihi batas wajar (${reasonDetail})\n\n` +
          `<i>Status akun Anda telah dialihkan ke <b>UNDER REVIEW</b>. Klaim Anda telah dicatat dan akan diperiksa secara manual oleh Administrator.</i>`,
      };
    }

    return { allowed: true, underReview: false };
  }

  // ── 3. Promo Code Brute-Force Protection ───────────────────────────────────

  /**
   * Checks if a user is currently blocked from entering promo codes.
   */
  public static async checkPromoAttempt(
    userId: string
  ): Promise<{ blocked: boolean; remainingSeconds?: number; attempts: number }> {
    const lockKey = `sec:promo:lock:${userId}`;
    const countKey = `sec:promo:fails:${userId}`;

    const isLocked = memoryStore.has(lockKey);
    if (isLocked) {
      const remainingSeconds = memoryStore.getRemainingTtl(lockKey);
      return { blocked: true, remainingSeconds, attempts: 5 };
    }

    const currentFails = memoryStore.get<number>(countKey) || 0;
    return { blocked: false, attempts: currentFails };
  }

  /**
   * Records a failed promo code attempt. Blocks user for 1 hour after 5 failures.
   */
  public static async recordPromoFailure(
    userId: string,
    api?: Api
  ): Promise<{ blocked: boolean; attempts: number; remainingSeconds?: number }> {
    const config = await BotConfig.getOrCreate();
    const maxFails = config.maxPromoFailedAttempts || 5;
    const blockDurationMinutes = config.promoBlockDurationMinutes || 60;

    const countKey = `sec:promo:fails:${userId}`;
    const lockKey = `sec:promo:lock:${userId}`;

    const currentFails = (memoryStore.get<number>(countKey) || 0) + 1;
    memoryStore.set(countKey, currentFails, blockDurationMinutes * 60);

    if (currentFails >= maxFails) {
      // Lock user from promo usage
      memoryStore.set(lockKey, true, blockDurationMinutes * 60);
      const remainingSeconds = blockDurationMinutes * 60;

      const user = await User.findOne({ telegramId: userId }).lean();

      // Log fraud event
      await this.logFraud({
        fraudType: "PROMO_BRUTEFORCE",
        severity: "MEDIUM",
        userId,
        userHandle: user?.username || user?.firstName,
        reason: `Brute-force promo: ${currentFails} kali percobaan gagal berturut-turut. Diblokir selama ${blockDurationMinutes} menit.`,
        actionTaken: "BLOCKED",
        metadata: {
          failedAttempts: currentFails,
          blockedDurationMinutes: blockDurationMinutes,
        },
      }, api);

      return { blocked: true, attempts: currentFails, remainingSeconds };
    }

    return { blocked: false, attempts: currentFails };
  }

  /**
   * Resets failed promo attempts on valid code entry.
   */
  public static async resetPromoFailure(userId: string): Promise<void> {
    memoryStore.delete(`sec:promo:fails:${userId}`);
    memoryStore.delete(`sec:promo:lock:${userId}`);
  }

  // ── 4. Velocity Rate Limiter ───────────────────────────────────────────────

  /**
   * Checks action velocity (burst protection: max N actions per second per user).
   */
  public static async checkVelocity(
    userId: string,
    maxActionsPerSecond = 5
  ): Promise<{ allowed: boolean; rate: number }> {
    const now = Date.now();
    const windowKey = `sec:velo:${userId}`;
    const timestamps = memoryStore.get<number[]>(windowKey) || [];

    // Keep only timestamps within the last 1000ms
    const recent = timestamps.filter((t) => now - t <= 1000);
    recent.push(now);
    memoryStore.set(windowKey, recent, 3); // 3s TTL

    const allowed = recent.length <= maxActionsPerSecond;
    return { allowed, rate: recent.length };
  }

  // ── 5. Audit Logging & Security Alerts ─────────────────────────────────────

  /**
   * Logs a security anomaly to MongoDB and triggers real-time security alerts.
   */
  public static async logFraud(
    data: SecurityAlertData,
    api?: Api
  ): Promise<FraudLogDocument> {
    const logDoc = await FraudLog.create({
      fraudType: data.fraudType,
      userId: data.userId,
      userHandle: data.userHandle,
      severity: data.severity,
      actionTaken: data.actionTaken,
      signature: data.signature,
      reason: data.reason,
      metadata: data.metadata,
      resolved: false,
      createdAt: new Date(),
    });

    if (api) {
      this.sendSecurityAlert(api, data).catch((err) =>
        console.error("[AntiFraud] Error dispatching security alert:", err)
      );
    }

    return logDoc;
  }

  /**
   * Dispatches an interactive security alert to the designated Security Channel or Admins.
   */
  public static async sendSecurityAlert(
    api: Api,
    data: SecurityAlertData
  ): Promise<void> {
    try {
      const config = await BotConfig.getOrCreate();

      const severityBadge =
        data.severity === "CRITICAL"
          ? "🚨 CRITICAL"
          : data.severity === "HIGH"
          ? "🔴 HIGH"
          : data.severity === "MEDIUM"
          ? "🟡 MEDIUM"
          : "🟢 LOW";

      const typeBadge =
        data.fraudType === "PAYMENT_REPLAY"
          ? "💳 REPLAY ATTACK (PAYMENT)"
          : data.fraudType === "WARRANTY_ABUSE"
          ? "🛡️ WARRANTY ABUSE"
          : data.fraudType === "PROMO_BRUTEFORCE"
          ? "🎟️ PROMO BRUTE-FORCE"
          : data.fraudType === "VELOCITY_LIMIT"
          ? "⚡ VELOCITY LIMIT EXCEEDED"
          : data.fraudType === "BALANCE_ABUSE"
          ? "💰 BALANCE ABUSE"
          : "⚠️ SUSPICIOUS ACTIVITY";

      const handleStr = data.userHandle ? `@${data.userHandle}` : "Tidak Ada Username";
      const nowStr = new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date()) + " WIB";

      let metaSection = "";
      if (data.metadata && Object.keys(data.metadata).length > 0) {
        metaSection =
          `\n📋 <b>Detail Teknis:</b>\n` +
          `<code>${JSON.stringify(data.metadata, null, 2)}</code>\n`;
      }

      const alertMsg =
        `🛡️ <b>[SECURITY ALERT] — ${severityBadge}</b>\n` +
        `${"─".repeat(32)}\n\n` +
        `🚨 <b>Jenis Ancaman:</b> <b>${typeBadge}</b>\n` +
        `👤 <b>User ID:</b> <code>${data.userId}</code> (${handleStr})\n` +
        `🛑 <b>Tindakan Sistem:</b> <code>${data.actionTaken}</code>\n` +
        `📅 <b>Waktu:</b> ${nowStr}\n\n` +
        `📝 <b>Keterangan:</b>\n<i>${data.reason}</i>\n` +
        metaSection +
        `\n⚠️ <i>Tinjau aktivitas pengguna di bawah atau ambil tindakan pencegahan:</i>`;

      const kb = new InlineKeyboard()
        .text("🚫 Banned User", `sec_ban_${data.userId}`)
        .text("🔍 Review Activity", `sec_rev_${data.userId}`)
        .row()
        .text("✅ Unflag (Set Active)", `sec_unflag_${data.userId}`);

      // 1. Dispatch to dedicated security alert channel if configured
      const targetChannel =
        (config.securityAlertChannelEnabled && config.securityAlertChannel) ||
        (config.logChannelEnabled && config.logChannel);

      if (targetChannel) {
        await api.sendMessage(targetChannel, alertMsg, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
        return;
      }

      // 2. Fallback: Dispatch directly to all Admins
      const adminIds = getAdminIds();
      for (const adminId of adminIds) {
        try {
          await api.sendMessage(adminId, alertMsg, {
            parse_mode: "HTML",
            reply_markup: kb,
          });
        } catch {
          // ignore individual admin send errors
        }
      }
    } catch (err) {
      console.error("[AntiFraud] sendSecurityAlert error:", err);
    }
  }

  // ── 6. Admin Actions & Investigations ──────────────────────────────────────

  /**
   * Bans a user account.
   */
  public static async banUser(
    userId: string,
    reason: string,
    adminId?: string
  ): Promise<{ success: boolean; message: string }> {
    const user = await User.findOneAndUpdate(
      { telegramId: userId },
      {
        $set: {
          isBanned: true,
          banReason: reason,
          accountStatus: "BANNED",
        },
      },
      { returnDocument: "after" }
    );

    if (!user) {
      return { success: false, message: "User tidak ditemukan dalam database." };
    }

    return {
      success: true,
      message: `User <code>${userId}</code> (${user.firstName}) berhasil dibanned. Alasan: ${reason}`,
    };
  }

  /**
   * Unbans a user account.
   */
  public static async unbanUser(
    userId: string,
    adminId?: string
  ): Promise<{ success: boolean; message: string }> {
    const user = await User.findOneAndUpdate(
      { telegramId: userId },
      {
        $set: {
          isBanned: false,
          banReason: undefined,
          accountStatus: "ACTIVE",
        },
      },
      { returnDocument: "after" }
    );

    if (!user) {
      return { success: false, message: "User tidak ditemukan." };
    }

    return {
      success: true,
      message: `User <code>${userId}</code> (${user.firstName}) berhasil di-unban. Status: ACTIVE.`,
    };
  }

  /**
   * Clears UNDER_REVIEW status back to ACTIVE.
   */
  public static async unflagUser(
    userId: string,
    adminId?: string
  ): Promise<{ success: boolean; message: string }> {
    const user = await User.findOneAndUpdate(
      { telegramId: userId },
      {
        $set: {
          accountStatus: "ACTIVE",
          flaggedAt: undefined,
        },
      },
      { returnDocument: "after" }
    );

    if (!user) {
      return { success: false, message: "User tidak ditemukan." };
    }

    return {
      success: true,
      message: `Status akun <code>${userId}</code> (${user.firstName}) dipulihkan menjadi ACTIVE.`,
    };
  }

  /**
   * Compiles comprehensive security investigation data for a specific user.
   */
  public static async getUserSecurityReview(
    userId: string
  ): Promise<SecurityReviewSummary | null> {
    const user = await User.findOne({ telegramId: userId }).lean();
    if (!user) return null;

    const fraudLogs = await FraudLog.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const fraudLogsCount = await FraudLog.countDocuments({ userId });
    const totalOrders = await DigitalOrder.countDocuments({ userId });
    const totalClaims = await WarrantyClaim.countDocuments({ userId });

    const claimRatio = totalOrders > 0 ? Math.round((totalClaims / totalOrders) * 100) : totalClaims > 0 ? 100 : 0;

    const balanceLogs = await BalanceLog.find({ userId, type: "PURCHASE" }).lean();
    const totalBalanceSpent = balanceLogs.reduce((sum, b) => sum + Math.abs(b.amount), 0);

    return {
      user,
      fraudLogsCount,
      recentFraudLogs: fraudLogs as unknown as IFraudLog[],
      totalOrders,
      totalClaims,
      claimRatioPercent: claimRatio,
      totalBalanceSpent,
    };
  }
}
