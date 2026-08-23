import { Api, Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User, IUser } from "../../models/User.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { ActivityLogService } from "../../services/activityLog.js";
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
 * Reply Keyboards send plain text messages when tapped, which are
 * caught by `bot.hears()` handlers below.
 *
 * `.resized()` makes Telegram shrink the keyboard to the minimum height
 * needed for the buttons — prevents it looking like a huge blank slab.
 */
export function buildMainMenuReplyKeyboard(): Keyboard {
  return new Keyboard()
    .text("👤 Info User").text("🛍️ Catalog").row()
    .text("💳 Topup").text("👥 Afiliasi").row()
    .text("❓ Help")
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
export async function buildCatalogKeyboard(): Promise<InlineKeyboard> {
  const config = await SmsConfig.getOrCreate();
  const kb = new InlineKeyboard();

  if (config.enabled !== false) {
    kb.text("💬 OTP SMS (Virtual Number)", "product_otp");
  } else {
    kb.text("💬 OTP SMS (🔴 Nonaktif)", "product_otp_disabled");
  }

  kb.row().text("📦 Produk Digital (Akun / Lisensi)", "product_digital");
  kb.row().text("👥 Program Afiliasi", "aff_home");
  return kb;
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

export function buildWelcomeText(user: HydratedDocument<IUser>): string {
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
export async function buildCatalogText(): Promise<string> {
  const config = await SmsConfig.getOrCreate();
  const otpDesc = config.enabled !== false
    ? `💬 <b>OTP SMS</b> — Sewa nomor virtual untuk verifikasi kode OTP sekali pakai.\n`
    : `💬 <b>OTP SMS</b> — <i>(Layanan sedang dinonaktifkan / maintenance)</i>\n`;

  return (
    `🛍️ <b>Catalog Layanan</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Pilih kategori produk yang ingin dibeli:\n\n` +
    otpDesc +
    `📦 <b>Produk Digital</b> — Akun premium, lisensi, voucher, & produk digital instan.\n\n` +
    `<i>Stok dan pesanan diproses otomatis 24/7.</i>`
  );
}

function buildTopupText(): string {
  return (
    `💳 <b>Topup Balance</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `To add funds to your account, please contact our admin:\n\n` +
    `👤 <a href="https://t.me/myoneandonlyaccount">@myoneandonlyaccount</a>\n\n` +
    `<i>Automated payment gateway coming soon.</i>`
  );
}

function buildHelpText(): string {
  return (
    `❓ <b>Help & Support</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `Having trouble? We're here to help!\n\n` +
    `📩 <b>Email:</b>    support@example.com\n` +
    `💬 <b>Telegram:</b> <a href="https://t.me/myoneandonlyaccount">@myoneandonlyaccount</a>\n` +
    `🕐 <b>Hours:</b>    Mon–Fri, 09:30–22:00 WIB\n\n` +
    `<i>Average response time: under 2 hours.</i>`
  );
}

// ============================================================================
//  DB HELPER
// ============================================================================

export async function findOrCreateUser(
  telegramId: string,
  firstName:  string,
  username?:  string,
  api?:       Api,
  referredBy?: string
): Promise<HydratedDocument<IUser>> {
  const existing = await User.findOne({ telegramId });
  if (!existing) {
    const newUser = await User.create({
      telegramId,
      firstName,
      ...(username && { username }),
      ...(referredBy && { referredBy }),
      balance:     0,
      totalOrders: 0,
    });

    if (api) {
      ActivityLogService.logUserRegistration(api, {
        user: { telegramId, firstName, username },
        registeredVia: "/start (Main Menu)",
      }).catch((err) => console.error("[ActivityLog] register log error:", err));
    }

    return newUser;
  }

  // Update name/username if changed
  let needSave = false;
  if (existing.firstName !== firstName) {
    existing.firstName = firstName;
    needSave = true;
  }
  if (username !== undefined && existing.username !== username) {
    existing.username = username;
    needSave = true;
  }
  if (needSave) {
    await existing.save();
  }

  return existing;
}

// ============================================================================
//  PLUGIN
// ============================================================================

const panelPlugin: Plugin = {
  name:    "panel",
  version: "2.1.0",

  commands: [
    { command: "start", description: "Open the main menu" },
    { command: "menu",  description: "Open the main menu" },
  ],

  register(bot: Bot<Context>): void {

    // ── /start ────────────────────────────────────────────────────────────────
    // Supports deep-link referral: /start ref_<referrerId>
    bot.command("start", async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      try {
        // Parse referral payload
        const payload = ctx.message?.text?.split(" ")[1]?.trim() ?? "";
        let referredBy: string | undefined;

        if (payload.startsWith("ref_")) {
          const candidateId = payload.slice(4).trim();
          // Validate: referrer must exist and cannot refer themselves
          if (candidateId && candidateId !== String(from.id)) {
            const referrerExists = await User.exists({ telegramId: candidateId });
            if (referrerExists) {
              referredBy = candidateId;
            }
          }
        }

        const user = await findOrCreateUser(
          String(from.id), from.first_name, from.username, ctx.api, referredBy
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

    // ── /menu ─────────────────────────────────────────────────────────────────
    bot.command("menu", async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      try {
        const user = await findOrCreateUser(
          String(from.id), from.first_name, from.username, ctx.api
        );
        await ctx.reply(buildWelcomeText(user), {
          parse_mode:   "HTML",
          reply_markup: buildMainMenuReplyKeyboard(),
        });
      } catch (err) {
        console.error("[panel] /menu error:", err);
        await ctx.reply("❌ Something went wrong. Please try again.");
      }
    });

    // ── 👤 Info User (bot.hears) ──────────────────────────────────────────────
    bot.hears("👤 Info User", async (ctx) => {
      const from = ctx.from;
      if (!from) return;

      try {
        const user = await findOrCreateUser(
          String(from.id), from.first_name, from.username, ctx.api
        );
        await ctx.reply(buildInfoText(user), { parse_mode: "HTML" });
      } catch (err) {
        console.error("[panel] hears:Info User error:", err);
        await ctx.reply("❌ Could not load your info. Please try again.");
      }
    });

    // ── 🛍️ Catalog (bot.hears) ───────────────────────────────────────────────
    bot.hears("🛍️ Catalog", async (ctx) => {
      try {
        await ctx.reply(await buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: await buildCatalogKeyboard(),
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

    // ── 👥 Afiliasi (bot.hears) ───────────────────────────────────────────────
    // Forwards to the affiliate plugin via its callback
    bot.hears("👥 Afiliasi", async (ctx) => {
      try {
        // Build and send affiliate dashboard inline
        const from = ctx.from;
        if (!from) return;

        const user = await User.findOne({ telegramId: String(from.id) }).lean();
        if (!user) {
          await ctx.reply("⚠️ Kamu belum terdaftar. Silakan ketik /start terlebih dahulu.");
          return;
        }

        // Redirect to /afiliasi command
        await ctx.reply(
          `👥 <b>Program Afiliasi</b>\n\nGunakan perintah /afiliasi untuk membuka dashboard afiliasi kamu.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("👥 Buka Dashboard Afiliasi", "aff_home"),
          }
        );
      } catch (err) {
        console.error("[panel] hears:Afiliasi error:", err);
        await ctx.reply("❌ Could not load affiliate info. Please try again.");
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
    bot.callbackQuery(CB_CATALOG, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        const isMedia = ctx.msg && (!("text" in ctx.msg) || !ctx.msg.text);
        if (isMedia) {
          try { await ctx.deleteMessage(); } catch { /* ignore */ }
          await ctx.reply(await buildCatalogText(), {
            parse_mode:   "HTML",
            reply_markup: await buildCatalogKeyboard(),
          });
          return;
        }

        await ctx.editMessageText(await buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: await buildCatalogKeyboard(),
        });
      } catch (err: any) {
        if (err?.description?.includes("message is not modified")) return;
        if (err?.description?.includes("there is no text in the message to edit")) {
          try { await ctx.deleteMessage(); } catch { /* ignore */ }
          await ctx.reply(await buildCatalogText(), {
            parse_mode:   "HTML",
            reply_markup: await buildCatalogKeyboard(),
          }).catch(() => {});
          return;
        }
        console.error("[panel] menu_catalog callback error:", err);
      }
    });

    // ── product_otp_disabled (callbackQuery) ──────────────────────────────────
    bot.callbackQuery("product_otp_disabled", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance oleh admin.",
        show_alert: true,
      });
    });

    console.log(
      "   → /start /menu (deep-link ref support) | hears: 👤 Info User, 🛍️ Catalog, 💳 Topup, 👥 Afiliasi, ❓ Help | callbackQuery: menu_catalog"
    );
  },
};

export default panelPlugin;
