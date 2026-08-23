import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User } from "../../models/User.js";
import { BotConfig } from "../../models/BotConfig.js";
import {
  getAffiliateStats,
  withdrawAffiliateBalance,
} from "../../services/affiliate.js";

// ============================================================================
//  AFFILIATE PLUGIN — Referral Program Dashboard
// ============================================================================

function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

async function buildAffiliateDashboard(
  userId: string,
  botUsername: string
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const config = await BotConfig.getOrCreate();
  const stats = await getAffiliateStats(userId);

  const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;

  const commissionInfo =
    config.affiliateCommissionType === "percentage"
      ? `${config.affiliateCommissionValue}% dari setiap transaksi`
      : `${formatIDR(config.affiliateCommissionValue)} per transaksi`;

  const statusLine = config.affiliateEnabled
    ? `🟢 <b>Aktif</b>`
    : `🔴 <b>Nonaktif</b> (Program afiliasi sedang dinonaktifkan oleh admin)`;

  const text =
    `👥 <b>Program Afiliasi</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `📊 <b>Status Program:</b> ${statusLine}\n` +
    `💰 <b>Komisi Per Transaksi:</b> ${commissionInfo}\n\n` +
    `${"─".repeat(30)}\n` +
    `🔗 <b>Link Referral Kamu:</b>\n` +
    `<code>${refLink}</code>\n\n` +
    `📈 <b>Statistik Kamu:</b>\n` +
    `• Total Diundang: <b>${stats.totalInvited} user</b>\n` +
    `• Total Komisi Didapat: <b>${formatIDR(stats.totalEarned)}</b>\n` +
    `• Saldo Afiliasi Saat Ini: <b>${formatIDR(stats.affiliateBalance)}</b>\n\n` +
    `<i>💡 Bagikan link referral kamu! Setiap teman yang bergabung dan bertransaksi akan memberimu komisi otomatis.</i>`;

  const kb = new InlineKeyboard();

  if (stats.affiliateBalance > 0) {
    kb.text(
      `💸 Tarik ke Saldo Bot (${formatIDR(stats.affiliateBalance)})`,
      "aff_withdraw"
    ).row();
  } else {
    kb.text("💸 Tarik Saldo Afiliasi (Kosong)", "aff_noop").row();
  }

  kb.text("🔄 Refresh", "aff_home");

  return { text, keyboard: kb };
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const affiliatePlugin: Plugin = {
  name: "affiliate",
  version: "1.0.0",

  commands: [
    {
      command: "afiliasi",
      description: "Buka dashboard program afiliasi & referral kamu",
    },
  ],

  register(bot: Bot<Context>): void {
    // Helper to open the affiliate dashboard
    const openDashboard = async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      // Ensure user exists
      const user = await User.findOne({ telegramId: String(from.id) }).lean();
      if (!user) {
        const msg = "⚠️ Kamu belum terdaftar. Silakan ketik /start terlebih dahulu.";
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: msg, show_alert: true });
        } else {
          await ctx.reply(msg);
        }
        return;
      }

      // Get bot username for referral link
      const botInfo = await bot.api.getMe();
      const { text, keyboard } = await buildAffiliateDashboard(
        String(from.id),
        botInfo.username
      );

      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch (err: any) {
          if (!err?.description?.includes("message is not modified")) {
            await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
          }
        }
      } else {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    };

    // ── /afiliasi command ─────────────────────────────────────────────────────
    bot.command("afiliasi", async (ctx) => {
      try {
        await openDashboard(ctx);
      } catch (err) {
        console.error("[affiliate] /afiliasi error:", err);
        await ctx.reply("❌ Gagal membuka dashboard afiliasi. Coba lagi.");
      }
    });

    // ── aff_home callback ─────────────────────────────────────────────────────
    bot.callbackQuery("aff_home", async (ctx) => {
      try {
        await openDashboard(ctx);
      } catch (err) {
        console.error("[affiliate] aff_home error:", err);
        await ctx.answerCallbackQuery({ text: "❌ Terjadi kesalahan.", show_alert: true });
      }
    });

    // ── aff_withdraw callback — transfer affiliateBalance → balance ───────────
    bot.callbackQuery("aff_withdraw", async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;

      try {
        const result = await withdrawAffiliateBalance(String(from.id));

        const botInfo = await bot.api.getMe();
        const { text, keyboard } = await buildAffiliateDashboard(
          String(from.id),
          botInfo.username
        );

        const notif = result.success
          ? `✅ ${result.message}\n\n`
          : `❌ ${result.message}\n\n`;

        try {
          await ctx.editMessageText(notif + text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } catch {
          await ctx.reply(notif + text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        }
      } catch (err) {
        console.error("[affiliate] aff_withdraw error:", err);
        await ctx.reply("❌ Gagal memproses penarikan saldo afiliasi.");
      }
    });

    // ── aff_noop — noop button (empty affiliate balance) ─────────────────────
    bot.callbackQuery("aff_noop", async (ctx) => {
      await ctx.answerCallbackQuery({
        text: "Saldo afiliasi kamu masih kosong. Undang teman untuk mendapatkan komisi!",
        show_alert: true,
      });
    });
  },
};

export default affiliatePlugin;
