import { Context, MiddlewareFn } from "grammy";
import { isAdmin } from "../core/admin.js";

// ============================================================================
//  Rate Limiter Middleware — Sliding Window (per user, in-memory)
// ============================================================================

interface WindowEntry {
  timestamps: number[];
}

const userWindows = new Map<string, WindowEntry>();

const WINDOW_MS = 1000;   // 1-second sliding window
const MAX_REQUESTS = 3;   // max 3 requests per window

/**
 * In-memory sliding-window rate limiter middleware.
 *
 * - Max 3 messages/callbacks per second per user.
 * - Admin (ADMIN_ID) is always exempted.
 * - On limit exceeded, replies with a warning and drops the update.
 */
export const rateLimitMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  // Only apply to private chats with a known user
  if (ctx.chat?.type !== "private" || !ctx.from) {
    return next();
  }

  // Admin bypass
  if (isAdmin(ctx)) {
    return next();
  }

  const userId = String(ctx.from.id);
  const now = Date.now();

  // Clean up old windows if map grows large (basic memory safety)
  if (userWindows.size > 50_000) {
    const cutoff = now - WINDOW_MS * 10;
    for (const [uid, entry] of userWindows.entries()) {
      if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1]! < cutoff) {
        userWindows.delete(uid);
      }
    }
  }

  let entry = userWindows.get(userId);
  if (!entry) {
    entry = { timestamps: [] };
    userWindows.set(userId, entry);
  }

  // Remove timestamps outside the current window
  const windowStart = now - WINDOW_MS;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= MAX_REQUESTS) {
    // Rate limit exceeded
    try {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Jangan spam, tunggu beberapa detik.",
          show_alert: false,
        });
      } else if (ctx.message) {
        await ctx.reply("⚠️ Jangan spam, tunggu beberapa detik.");
      }
    } catch {
      // Ignore reply errors from rate-limited users
    }
    return; // drop — do NOT call next()
  }

  entry.timestamps.push(now);
  return next();
};
