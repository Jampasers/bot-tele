import { Bot, Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { loadPlugins } from "./pluginLoader.js";
import { forceSubMiddleware } from "../middlewares/forceSub.js";
import { rateLimitMiddleware } from "../middlewares/rateLimit.js";
import { maintenanceMiddleware } from "../middlewares/maintenance.js";
import { antiFraudMiddleware } from "../middlewares/antiFraud.js";
import { platformContext, runWithTenant, type TenantContext } from "../tenant/context.js";
import { rentalMiddleware } from "../rental/rental.middleware.js";
import { rentalTokenInputMiddleware } from "../rental/rentalTokenInput.middleware.js";
import { vpsInputMiddleware } from "../plugins/vps/input.js";

/**
 * Creates the grammY Bot instance and wires up the dynamic plugin loader.
 * Returns the fully configured bot, ready to be started.
 */
export async function createBot(token: string, tenant: TenantContext = platformContext()): Promise<Bot<Context>> {
  const bot = new Bot<Context>(token);
  await bot.init();
  bot.use((_ctx, next) => runWithTenant(tenant, next));

  // Transform API calls to silently handle benign Telegram errors (e.g. expired callback queries)
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err: any) {
      // If a callback query expired (timeout > 10-30s), suppress the error so handlers continue running smoothly
      if (
        method === "answerCallbackQuery" &&
        err?.description?.toLowerCase().includes("query is too old")
      ) {
        return true as any;
      }
      throw err;
    }
  });

  // Global error handler — prevents the process from crashing on
  // unhandled errors thrown inside handlers.
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(
      `[Rental:${tenant.rentalId ?? "platform"}] [Tenant:${tenant.tenantId}] [@${bot.botInfo.username}] Update ${ctx.update.update_id} failed.`
    );
  });

  // 0. Concurrency Sequencer — ensures updates from the same user/chat are processed
  // in order, while updates from different users are processed concurrently in parallel.
  bot.use(
    sequentialize((ctx) => ctx.chat?.id?.toString() || ctx.from?.id?.toString())
  );

  // A BotFather token must be deleted even when a later gate drops the update.
  bot.use(vpsInputMiddleware);
  bot.use(rentalTokenInputMiddleware);

  // 1. Rate Limiter — drop spam before anything else runs
  bot.use(rateLimitMiddleware);
  // Renewal must work even when business, maintenance or subscription gates block.
  bot.use(rentalMiddleware);

  // 2. Anti-Fraud & Velocity Guard — checks banned users and burst rate
  bot.use(antiFraudMiddleware);

  // 3. Maintenance Mode — block non-admin users when bot is under maintenance
  bot.use(maintenanceMiddleware);

  // 4. Wajib Join Channel (Force Subscription) middleware
  bot.use(forceSubMiddleware);

  // Dynamically load and register all plugins from src/plugins/.
  await runWithTenant(tenant, () => loadPlugins(bot));

  return bot;
}
