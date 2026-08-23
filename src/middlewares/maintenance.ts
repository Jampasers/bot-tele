import { Context, MiddlewareFn } from "grammy";
import { BotConfig } from "../models/BotConfig.js";
import { isAdmin } from "../core/admin.js";

// ============================================================================
//  Maintenance Mode Middleware
// ============================================================================

// 5-second TTL cache to avoid hitting the DB on every single message
let cachedIsMaintenance: boolean | null = null;
let cachedMessage: string = "";
let cacheExpiresAt = 0;

async function getMaintenanceStatus(): Promise<{ isMaintenance: boolean; message: string }> {
  const now = Date.now();
  if (cachedIsMaintenance !== null && now < cacheExpiresAt) {
    return { isMaintenance: cachedIsMaintenance, message: cachedMessage };
  }

  const config = await BotConfig.getOrCreate();
  cachedIsMaintenance = config.isMaintenance ?? false;
  cachedMessage = config.maintenanceMessage || "🔧 <b>Bot Sedang Maintenance</b>\n\nSilakan coba beberapa saat lagi.";
  cacheExpiresAt = now + 5_000; // 5-second TTL

  return { isMaintenance: cachedIsMaintenance, message: cachedMessage };
}

/**
 * Clears the maintenance status cache.
 * Call this whenever the maintenance flag is toggled via admin panel.
 */
export function clearMaintenanceCache(): void {
  cachedIsMaintenance = null;
  cacheExpiresAt = 0;
}

/**
 * Maintenance middleware.
 *
 * If `isMaintenance === true` and the user is NOT an admin, all updates are
 * intercepted and a maintenance banner is shown. Admin always bypasses.
 */
export const maintenanceMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  // Only enforce in private chats
  if (ctx.chat?.type !== "private" || !ctx.from) {
    return next();
  }

  // Admin always bypasses maintenance
  if (isAdmin(ctx)) {
    return next();
  }

  const { isMaintenance, message } = await getMaintenanceStatus();

  if (!isMaintenance) {
    return next();
  }

  // Block with maintenance banner
  try {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "🔧 Bot sedang maintenance. Silakan coba lagi nanti.",
        show_alert: true,
      });
    } else if (ctx.message) {
      await ctx.reply(message, { parse_mode: "HTML" });
    }
  } catch {
    // Ignore reply errors
  }
  // Do NOT call next() — stop propagation
};
