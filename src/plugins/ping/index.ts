import { Bot, Context } from "grammy";
import { Plugin } from "../../types/Plugin.js";

/**
 * 📌 Ping Plugin
 *
 * Demonstrates the minimal plugin structure.
 * Listens to /ping and replies with "🏓 Pong!".
 */
const pingPlugin: Plugin = {
  name: "ping",
  version: "1.0.0",

  // Declares the command that will appear in Telegram's command picker.
  commands: [
    {
      command: "ping",
      description: "Check if the bot is alive — replies with Pong!",
    },
  ],

  register(bot: Bot<Context>): void {
    bot.command("ping", async (ctx) => {
      await ctx.reply("🏓 Pong!");
    });

    console.log("   → /ping command registered");
  },
};

export default pingPlugin;
