import { Bot, Context } from "grammy";
import { loadPlugins } from "./pluginLoader.js";

/**
 * Creates the grammY Bot instance and wires up the dynamic plugin loader.
 * Returns the fully configured bot, ready to be started.
 */
export async function createBot(token: string): Promise<Bot<Context>> {
  const bot = new Bot<Context>(token);

  // Global error handler — prevents the process from crashing on
  // unhandled errors thrown inside handlers.
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(
      `❌  Unhandled error while processing update ${ctx.update.update_id}:`,
      err.error
    );
  });

  // Dynamically load and register all plugins from src/plugins/.
  await loadPlugins(bot);

  return bot;
}
