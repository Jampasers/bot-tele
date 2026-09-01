import { Context, NextFunction } from "grammy";
import { User } from "../models/User.js";
import { AntiFraudService } from "../services/antiFraudService.js";
import { isAdmin } from "../core/admin.js";

// ============================================================================
//  In-Memory Banned User Cache for fast middleware lookup (<1ms)
// ============================================================================

interface BannedCacheEntry {
  isBanned: boolean;
  reason?: string | undefined;
  cachedAt: number;
}

const bannedCache = new Map<string, BannedCacheEntry>();
const BAN_CACHE_TTL_MS = 60_000; // 1 minute

export function clearUserBanCache(userId: string): void {
  bannedCache.delete(userId);
}

// ============================================================================
//  Anti-Fraud Middleware
// ============================================================================

export async function antiFraudMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const from = ctx.from;
  if (!from) {
    return next();
  }

  const userId = String(from.id);

  // 1. Bypass all checks for system administrators
  if (isAdmin(ctx)) {
    return next();
  }

  // 2. Velocity Check (burst spam / rapid request limiter)
  const veloCheck = await AntiFraudService.checkVelocity(userId, 5);
  if (!veloCheck.allowed) {
    // Drop rapid-burst requests exceeding 5 actions/sec silently to protect bot loop
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "⏳ Harap tunggu sejenak sebelum menekan tombol lagi.",
        show_alert: false,
      }).catch(() => {});
    }
    return;
  }

  // 3. Fast Banned Status Check
  const now = Date.now();
  let cached = bannedCache.get(userId);

  if (!cached || now - cached.cachedAt > BAN_CACHE_TTL_MS) {
    const userDoc = await User.findOne({ telegramId: userId })
      .select("isBanned banReason accountStatus")
      .lean();

    const isBanned = Boolean(
      userDoc?.isBanned || userDoc?.accountStatus === "BANNED"
    );

    const newEntry: BannedCacheEntry = {
      isBanned,
      reason: userDoc?.banReason ?? undefined,
      cachedAt: now,
    };
    bannedCache.set(userId, newEntry);
    cached = newEntry;
  }

  if (cached && cached.isBanned) {
    const banMsg =
      `🚫 <b>Akses Akun Ditangguhkan</b>\n` +
      `${"─".repeat(30)}\n\n` +
      `Akun Anda saat ini diblokir dari seluruh layanan bot karena terindikasi melanggar aturan keamanan.\n\n` +
      `📌 <b>Alasan:</b> <i>${cached.reason || "Pelanggaran keamanan / aktivitas tidak wajar"}</i>\n\n` +
      `<i>Jika Anda merasa ini adalah kekeliruan, silakan hubungi Administrator.</i>`;

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "🚫 Akun Anda diblokir dari layanan ini.",
        show_alert: true,
      }).catch(() => {});
    } else {
      await ctx.reply(banMsg, { parse_mode: "HTML" }).catch(() => {});
    }
    return;
  }

  return next();
}
