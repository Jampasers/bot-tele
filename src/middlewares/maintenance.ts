import { Context, MiddlewareFn } from "grammy";
import { BotConfig } from "../models/BotConfig.js";
import { isAdmin } from "../core/admin.js";
import { TenantMap } from "../tenant/TenantMap.js";

// ============================================================================
//  Maintenance Mode Middleware
// ============================================================================

// 5-second TTL cache to avoid hitting the DB on every single message
const maintenanceCache = new TenantMap<string, { isMaintenance: boolean; message: string; expiresAt: number }>();

async function getMaintenanceStatus(): Promise<{ isMaintenance: boolean; message: string }> {
  const now = Date.now();
  const cached = maintenanceCache.get("status");
  if (cached && now < cached.expiresAt) return cached;

  const config = await BotConfig.getOrCreate();
  const status = {
    isMaintenance: config.isMaintenance ?? false,
    message: config.maintenanceMessage || "🔧 <b>Bot Sedang Maintenance</b>\n\nSilakan coba beberapa saat lagi.",
    expiresAt: now + 5_000,
  };
  maintenanceCache.set("status", status);
  return status;
}

/**
 * Clears the maintenance status cache.
 * Call this whenever the maintenance flag is toggled via admin panel.
 */
export function clearMaintenanceCache(): void {
  maintenanceCache.clear();
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
