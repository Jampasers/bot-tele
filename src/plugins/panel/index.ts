import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User, IUser } from "../../models/User.js";
import { HydratedDocument } from "mongoose";

// ============================================================================
//  EXPORTS used by other plugins
//  ─ CB_CATALOG      : callback_data string the smsbower plugin references for
//                      its own "Back to Catalog" button.
//  ─ buildCatalogText / buildCatalogKeyboard : smsbower renders the catalog
//                      view when navigating back, so these must stay exported.
// ============================================================================

/**
 * The catalog callback_data string.
 * Exported so the smsbower plugin can wire its "Back to Catalog" button
 * without duplicating the literal string.
 */
export const CB_CATALOG = "menu_catalog" as const;

// ============================================================================
//  REPLY KEYBOARD — Main Menu (persistent bottom bar)
// ============================================================================

/**
 * Builds the persistent Reply Keyboard shown after /start.
 *
 * Reply Keyboard buttons send plain text messages when tapped, which are
 * caught by `bot.hears()` handlers below.
 *
 * `.resized()` makes Telegram shrink the keyboard to the minimum height
 * needed for the buttons — prevents it looking like a huge blank slab.
 */
function buildMainMenuReplyKeyboard(): Keyboard {
  return new Keyboard()
    .text("👤 Info User").text("🛍️ Catalog").row()
    .text("💳 Topup").text("❓ Help")
    .resized();
}

// ============================================================================
//  INLINE KEYBOARDS — Sub-menus (message-level, overlaid on the message)
// ============================================================================

/**
 * Catalog inline keyboard — top-level product categories.
 *
 * Exported so the smsbower plugin can redraw this keyboard when the user
 * navigates "Back to Catalog" from the OTP service picker.
 */
export function buildCatalogKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 OTP SMS (Virtual Number)", "product_otp");
}

// ============================================================================
//  MESSAGE BUILDERS — pure functions, no side-effects
// ============================================================================

function formatBalance(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style:                 "currency",
    currency:              "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  }).format(date);
}

function buildWelcomeText(user: HydratedDocument<IUser>): string {
  const handle = user.username ? `@${user.username}` : `#${user.telegramId}`;
  return (
    `🤖 <b>Main Menu</b>\n\n` +
    `👋 Welcome back, <b>${user.firstName}</b> (${handle})\n\n` +
    `🪙 <b>Balance:</b> ${formatBalance(user.balance)}\n\n` +
    `<i>Use the buttons below to navigate.</i>`
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

/**
 * Catalog landing page text.
 * Exported so the smsbower plugin can redraw this message when navigating back.
 */
export function buildCatalogText(): string {
  return (
    `🛍️ <b>Catalog</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Choose a product category:\n\n` +
    `💬 <b>OTP SMS</b> — Rent a virtual number to receive a one-time code.\n\n` +
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
    `❓ <b>Help & Support</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Having trouble? We're here to help!\n\n` +
    `📩 <b>Email:</b>    support@example.com\n` +
    `💬 <b>Telegram:</b> <a href="https://t.me/support">@support</a>\n` +
    `🕐 <b>Hours:</b>    Mon–Fri, 09:00–18:00 WIB\n\n` +
    `<i>Average response time: under 2 hours.</i>`
  );
}

// ============================================================================
//  DB HELPER
// ============================================================================

async function findOrCreateUser(
  telegramId: string,
  firstName:  string,
  username?:  string
): Promise<HydratedDocument<IUser>> {
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
    { upsert: true, new: true, runValidators: true }
  );
  if (!user) throw new Error(`findOrCreateUser: null for id ${telegramId}`);
  return user;
}

// ============================================================================
//  PLUGIN
// ============================================================================

const panelPlugin: Plugin = {
  name:    "panel",
  version: "2.0.0",

  commands: [
    { command: "start", description: "Open the main menu" },
  ],

  register(bot: Bot<Context>): void {

    // ── /start ────────────────────────────────────────────────────────────────
    // Sends the welcome message AND attaches the persistent Reply Keyboard.
    // The Reply Keyboard stays until explicitly removed — the user always has
    // the main-menu buttons available without needing to type /start again.
    bot.command("start", async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      try {
        const user = await findOrCreateUser(
          String(from.id), from.first_name, from.username
        );

        await ctx.reply(buildWelcomeText(user), {
          parse_mode:   "HTML",
          reply_markup: buildMainMenuReplyKeyboard(),
        });
      } catch (err) {
        console.error("[panel] /start error:", err);
        await ctx.reply("❌ Something went wrong. Please try again.");
      }
    });

    // ── 👤 Info User (bot.hears) ──────────────────────────────────────────────
    // Reply Keyboards send plain text — bot.hears() matches the exact button label.
    bot.hears("👤 Info User", async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      try {
        const user = await findOrCreateUser(
          String(from.id), from.first_name, from.username
        );
        // Reply with a fresh message — no inline keyboard needed here.
        await ctx.reply(buildInfoText(user), { parse_mode: "HTML" });
      } catch (err) {
        console.error("[panel] hears:Info User error:", err);
        await ctx.reply("❌ Could not load your info. Please try again.");
      }
    });

    // ── 🛍️ Catalog (bot.hears) ───────────────────────────────────────────────
    // Sends the catalog as a new message with an Inline Keyboard for deeper
    // navigation. Sub-menus always live in Inline Keyboards so the persistent
    // bottom bar stays accessible at all times.
    bot.hears("🛍️ Catalog", async (ctx) => {
      try {
        await ctx.reply(buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[panel] hears:Catalog error:", err);
        await ctx.reply("❌ Could not load the catalog. Please try again.");
      }
    });

    // ── 💳 Topup (bot.hears) ─────────────────────────────────────────────────
    bot.hears("💳 Topup", async (ctx) => {
      try {
        await ctx.reply(buildTopupText(), { parse_mode: "HTML" });
      } catch (err) {
        console.error("[panel] hears:Topup error:", err);
        await ctx.reply("❌ Could not load topup info. Please try again.");
      }
    });

    // ── ❓ Help (bot.hears) ───────────────────────────────────────────────────
    bot.hears("❓ Help", async (ctx) => {
      try {
        await ctx.reply(buildHelpText(), { parse_mode: "HTML" });
      } catch (err) {
        console.error("[panel] hears:Help error:", err);
        await ctx.reply("❌ Could not load help info. Please try again.");
      }
    });

    // ── menu_catalog (callbackQuery) ──────────────────────────────────────────
    // The smsbower plugin registers its own CB_CATALOG listener, but we keep
    // this handler here so that any inline "Back to Catalog" button works even
    // if the smsbower plugin isn't loaded (e.g. during development).
    bot.callbackQuery(CB_CATALOG, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[panel] menu_catalog callback error:", err);
      }
    });

    console.log(
      "   → /start (Reply Keyboard) | hears: 👤 Info User, 🛍️ Catalog, 💳 Topup, ❓ Help | callbackQuery: menu_catalog"
    );
  },
};

export default panelPlugin;
