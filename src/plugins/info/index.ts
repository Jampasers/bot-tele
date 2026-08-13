import { Bot, Context } from "grammy";
import { Plugin } from "../../types/Plugin.js";

/**
 * ℹ️ Info Plugin
 *
 * Registers the /info command to describe the bot's plugin architecture.
 * Note: /start is intentionally handled by the `panel` plugin, which
 * provides the full interactive main-menu experience.
 */
const infoPlugin: Plugin = {
  name: "info",
  version: "1.0.0",

  commands: [
    {
      command: "info",
      description: "Show information about this bot's architecture",
    },
  ],

  register(bot: Bot<Context>): void {
    // /info — describe the architecture.
    bot.command("info", async (ctx) => {
      await ctx.reply(
        `🤖 <b>grammY Plugin Bot</b>\n\n` +
          `This bot uses a <b>Plugin-Based Architecture</b>.\n` +
          `Each feature lives in its own folder under <code>src/plugins/</code> ` +
          `and is auto-discovered on startup — no manual imports needed!`,
        { parse_mode: "HTML" }
      );
    });

    console.log("   → /info command registered");
  },
};

export default infoPlugin;
