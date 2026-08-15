import { Bot, Context } from "grammy";
import { loadPlugins } from "./pluginLoader.js";
import { forceSubMiddleware } from "../middlewares/forceSub.js";

/**
 * Creates the grammY Bot instance and wires up the dynamic plugin loader.
 * Returns the fully configured bot, ready to be started.
 */
export async function createBot(token: string): Promise<Bot<Context>> {
  const bot = new Bot<Context>(token);

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
      `❌  Unhandled error while processing update ${ctx.update.update_id}:`,
      err.error
    );
  });

  // Wajib Join Channel (Force Subscription) middleware
  bot.use(forceSubMiddleware);

  // Dynamically load and register all plugins from src/plugins/.
  await loadPlugins(bot);

  return bot;
}
