import { Bot, Context } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User } from "../../models/User.js";
import { ActivityLogService } from "../../services/activityLog.js";

/**
 * 📝 Register Plugin
 *
 * Demonstrates a database-aware plugin.
 *
 * /register — Saves the Telegram user to MongoDB on first call.
 *             Returns a friendly message on subsequent calls.
 *
 * How it interacts with the database:
 *   - Imports the `User` Mongoose model directly.
 *   - Mongoose reuses the single connection opened by `src/core/db.ts`
 *     at startup — no per-plugin connection setup needed.
 */
const registerPlugin: Plugin = {
  name: "register",
  version: "1.0.0",

  commands: [
    {
      command: "register",
      description: "Create your account in our database",
    },
  ],

  register(bot: Bot<Context>): void {
    bot.command("register", async (ctx) => {
      // Guard: this command only makes sense in a private/group chat where
      // ctx.from is always present. The Telegram API guarantees ctx.from
      // exists for any message update.
      const from = ctx.from;
      if (!from) {
        await ctx.reply("⚠️ Could not identify your user. Please try again.");
        return;
      }

      const telegramId = String(from.id);

      try {
        // --- Check if the user is already registered ---
        const existingUser = await User.findOne({ telegramId }).lean().exec();

        if (existingUser) {
          await ctx.reply(
            `👋 You are already registered, <b>${existingUser.firstName}</b>!`,
            { parse_mode: "HTML" }
          );
          return;
        }

        // --- Create and persist a new user ---
        await User.create({
          telegramId,
          firstName: from.first_name,
          // `username` is optional — only store if present
          ...(from.username && { username: from.username }),
        });

        // Broadcast audit log to dedicated channel
        ActivityLogService.logUserRegistration(ctx.api, {
          user: {
            telegramId,
            firstName: from.first_name,
            username: from.username,
          },
          registeredVia: "/register (Command)",
        }).catch((err) => console.error("[register] ActivityLog error:", err));

        await ctx.reply(
          `🎉 Registration successful!\n\n` +
            `Welcome, <b>${from.first_name}</b>! You are now in our database.`,
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.error("[register] Database error:", err);
        await ctx.reply(
          "❌ An internal error occurred. Please try again later."
        );
      }
    });

    console.log("   → /register command registered");
  },
};

export default registerPlugin;
