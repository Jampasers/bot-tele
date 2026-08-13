import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User, IUser } from "../../models/User.js";
import { HydratedDocument } from "mongoose";

// ============================================================================
//  TYPES
// ============================================================================

/**
 * Strongly-typed callback_data strings used throughout this plugin.
 * Keeping them as a const enum prevents typos and makes exhaustive
 * switch-cases possible.
 */
const enum CB {
  Info    = "menu_info",
  Catalog = "menu_catalog",
  Topup   = "menu_topup",
  Help    = "menu_help",
  Back    = "menu_back",

  // OTP service sub-actions (inside the catalog sub-menu)
  OtpWhatsApp = "otp_whatsapp",
  OtpTelegram = "otp_telegram",
}

// ============================================================================
//  HELPER — Currency formatter
// ============================================================================

/**
 * Formats a numeric balance as a locale-aware currency string.
 * Example: 15000 → "Rp 15,000"
 *
 * Adjust locale / currency to match your target market.
 */
function formatBalance(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Formats a Date object as a short, human-readable string.
 * Example: 2024-08-13T14:00:00Z → "13 Aug 2024"
 */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  }).format(date);
}

// ============================================================================
//  KEYBOARD BUILDERS
//  Each builder returns a fully assembled InlineKeyboard for its view.
//  Separating keyboards from message text keeps handler code clean.
// ============================================================================

/** Main-menu keyboard — 4 rows as specified. */
function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 Info User",     CB.Info).text("🛒 Catalog", CB.Catalog).row()
    .text("💳 Topup Balance", CB.Topup).row()
    .text("🎧 Help / Support", CB.Help);
}

/** Back-button keyboard — reused by every sub-menu. */
function buildBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Back to Main Menu", CB.Back);
}

/** Catalog sub-menu keyboard — OTP services + back button. */
function buildCatalogKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🟢 WhatsApp",  CB.OtpWhatsApp)
    .text("🔵 Telegram",  CB.OtpTelegram).row()
    .text("🔙 Back to Main Menu", CB.Back);
}

// ============================================================================
//  MESSAGE BUILDERS
//  Pure functions that return HTML-formatted strings.
//  Keeping them separate makes i18n / templating straightforward later.
// ============================================================================

function buildMainMenuText(user: HydratedDocument<IUser>): string {
  const handle = user.username ? `@${user.username}` : `#${user.telegramId}`;
  return (
    `🤖 <b>Main Menu</b>\n\n` +
    `👋 Welcome back, <b>${user.firstName}</b> (${handle})\n\n` +
    `🪙 <b>Balance:</b> ${formatBalance(user.balance)}\n\n` +
    `<i>Select an option below to get started.</i>`
  );
}

function buildInfoText(user: HydratedDocument<IUser>): string {
  const handle   = user.username ? `@${user.username}` : "—";
  const joined   = formatDate(user.createdAt);
  const lastSeen = formatDate(user.updatedAt);

  return (
    `👤 <b>User Information</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `🪪 <b>Telegram ID:</b> <code>${user.telegramId}</code>\n` +
    `📛 <b>Name:</b>        ${user.firstName}\n` +
    `🔗 <b>Username:</b>    ${handle}\n\n` +
    `📅 <b>Registered:</b>  ${joined}\n` +
    `🕐 <b>Last active:</b> ${lastSeen}\n\n` +
    `🛒 <b>Total orders:</b> ${user.totalOrders}\n` +
    `💳 <b>Balance:</b>      ${formatBalance(user.balance)}`
  );
}

function buildCatalogText(): string {
  return (
    `🛒 <b>OTP Catalog</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Select an OTP service to begin the purchase flow.\n\n` +
    `🟢 <b>WhatsApp</b>  — phone verification OTP\n` +
    `🔵 <b>Telegram</b>  — account activation OTP\n\n` +
    `<i>More services coming soon!</i>`
  );
}

function buildTopupText(): string {
  return (
    `💳 <b>Topup Balance</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `To add funds to your account, please contact our admin:\n\n` +
    `👤 <a href="https://t.me/admin">@admin</a>\n\n` +
    `<i>Automated payment gateway coming soon.</i>`
  );
}

function buildHelpText(): string {
  return (
    `🎧 <b>Help & Support</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Having trouble? We're here to help!\n\n` +
    `📩 <b>Email:</b>   support@example.com\n` +
    `💬 <b>Telegram:</b> <a href="https://t.me/support">@support</a>\n` +
    `🕐 <b>Hours:</b>   Mon–Fri, 09:00–18:00 WIB\n\n` +
    `<i>Average response time: under 2 hours.</i>`
  );
}

// ============================================================================
//  DB HELPER — Find-or-create pattern
// ============================================================================

/**
 * Looks up an existing user by telegramId.
 * If not found, creates a new document with default balance/totalOrders.
 * Returns the hydrated Mongoose document either way.
 */
async function findOrCreateUser(
  telegramId: string,
  firstName: string,
  username?: string
): Promise<HydratedDocument<IUser>> {
  // `findOneAndUpdate` with `upsert: true` is atomic — safe against race conditions
  // that could occur if a user fires two commands simultaneously.
  const user = await User.findOneAndUpdate(
    { telegramId },
    {
      $setOnInsert: {
        telegramId,
        firstName,
        ...(username && { username }),
        balance:     0,
        totalOrders: 0,
      },
    },
    {
      upsert:    true,  // create the doc if it doesn't exist
      new:       true,  // return the document after the operation
      runValidators: true,
    }
  );

  // findOneAndUpdate with upsert + new always returns a document.
  // This assertion is safe — we throw rather than silently returning null.
  if (!user) throw new Error(`findOrCreateUser: unexpected null for id ${telegramId}`);
  return user;
}

// ============================================================================
//  PLUGIN DEFINITION
// ============================================================================

const panelPlugin: Plugin = {
  name:    "panel",
  version: "1.0.0",

  // /start is the canonical entry point — always keep it first in the menu.
  commands: [
    {
      command: "start",
      description: "Open the main menu",
    },
  ],

  register(bot: Bot<Context>): void {

    // ─────────────────────────────────────────────────────────────────────────
    //  /start  — Entry point: fetch/create user → send Main Menu
    // ─────────────────────────────────────────────────────────────────────────
    bot.command("start", async (ctx) => {
      const from = ctx.from;
      if (!from) return; // Telegram always sets `from` for message updates

      try {
        const user = await findOrCreateUser(
          String(from.id),
          from.first_name,
          from.username
        );

        await ctx.reply(buildMainMenuText(user), {
          parse_mode:   "HTML",
          reply_markup: buildMainMenuKeyboard(),
        });
      } catch (err) {
        console.error("[panel] /start error:", err);
        await ctx.reply("❌ Something went wrong. Please try again.");
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  menu_info — Edit message → User stats view
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.Info, async (ctx) => {
      // ALWAYS answer the callback query first to clear the loading spinner.
      await ctx.answerCallbackQuery();

      const from = ctx.from;
      try {
        const user = await findOrCreateUser(
          String(from.id),
          from.first_name,
          from.username
        );

        await ctx.editMessageText(buildInfoText(user), {
          parse_mode:   "HTML",
          reply_markup: buildBackKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_info error:", err);
        await ctx.answerCallbackQuery({ text: "❌ Error loading info." });
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  menu_catalog — Edit message → OTP catalog view
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.Catalog, async (ctx) => {
      await ctx.answerCallbackQuery();

      try {
        await ctx.editMessageText(buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_catalog error:", err);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  OTP service handlers — Stub: reply with a "coming soon" alert.
    //  Replace these with your actual OTP purchasing flow when ready.
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.OtpWhatsApp, async (ctx) => {
      await ctx.answerCallbackQuery({
        text:       "🟢 WhatsApp OTP — Coming soon!",
        show_alert: true, // shows as a popup, not just a toast
      });
    });

    bot.callbackQuery(CB.OtpTelegram, async (ctx) => {
      await ctx.answerCallbackQuery({
        text:       "🔵 Telegram OTP — Coming soon!",
        show_alert: true,
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  menu_topup — Edit message → Topup instructions view
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.Topup, async (ctx) => {
      await ctx.answerCallbackQuery();

      try {
        await ctx.editMessageText(buildTopupText(), {
          parse_mode:   "HTML",
          reply_markup: buildBackKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_topup error:", err);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  menu_help — Edit message → Help & Support view
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.Help, async (ctx) => {
      await ctx.answerCallbackQuery();

      try {
        await ctx.editMessageText(buildHelpText(), {
          parse_mode:   "HTML",
          reply_markup: buildBackKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_help error:", err);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  menu_back — Edit message → return to Main Menu
    // ─────────────────────────────────────────────────────────────────────────
    bot.callbackQuery(CB.Back, async (ctx) => {
      await ctx.answerCallbackQuery();

      const from = ctx.from;
      try {
        const user = await findOrCreateUser(
          String(from.id),
          from.first_name,
          from.username
        );

        // Restore both the message text AND the keyboard atomically.
        await ctx.editMessageText(buildMainMenuText(user), {
          parse_mode:   "HTML",
          reply_markup: buildMainMenuKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_back error:", err);
      }
    });

    console.log(
      "   → /start (main menu), menu_info, menu_catalog, menu_topup, menu_help, menu_back registered"
    );
  },
};

export default panelPlugin;
