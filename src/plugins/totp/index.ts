import { Bot, Context, type InlineKeyboard } from "grammy";
import { TenantMap } from "../../tenant/TenantMap.js";
import { Plugin } from "../../types/Plugin.js";
import { TotpService, type TotpAccessFailure } from "../../services/totp.js";

const NOT_FOUND_MESSAGE = "❌ Kode akun tidak ditemukan atau akun ini bukan milik kamu.";
const NO_TOTP_MESSAGE = "❌ Akun ini tidak memiliki 2FA yang tersedia melalui bot.";
const UNAVAILABLE_MESSAGE = "❌ Kode 2FA sementara tidak tersedia. Silakan coba lagi.";

interface RequestWindow {
  timestamps: number[];
}

/** Feature-specific limiter shared by /otp and refresh callbacks. */
export class OtpRequestRateLimiter {
  private readonly windows = new TenantMap<string, RequestWindow>();

  constructor(
    private readonly maxRequests = 10,
    private readonly windowMs = 60_000
  ) {}

  tryConsume(telegramId: string, now = Date.now()): boolean {
    if (this.windows.size > 50_000) {
      const cutoff = now - this.windowMs;
      for (const [id, entry] of this.windows.entries()) {
        if (!entry.timestamps.some((timestamp) => timestamp > cutoff)) this.windows.delete(id);
      }
    }

    const entry = this.windows.get(telegramId) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > now - this.windowMs);
    if (entry.timestamps.length >= this.maxRequests) {
      this.windows.set(telegramId, entry);
      return false;
    }

    entry.timestamps.push(now);
    this.windows.set(telegramId, entry);
    return true;
  }
}

const limiter = new OtpRequestRateLimiter();

function failureMessage(reason: TotpAccessFailure): string {
  if (reason === "NO_TOTP") return NO_TOTP_MESSAGE;
  if (reason === "UNAVAILABLE") return UNAVAILABLE_MESSAGE;
  return NOT_FOUND_MESSAGE;
}

async function safeEditOrReply(
  ctx: Context,
  text: string,
  replyMarkup: InlineKeyboard
): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: replyMarkup });
  } catch (error: unknown) {
    const description =
      error && typeof error === "object" && "description" in error
        ? String((error as { description?: unknown }).description)
        : "";
    if (description.includes("message is not modified")) return;
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: replyMarkup });
  }
}

const totpPlugin: Plugin = {
  feature: "totp",
  name: "totp-generator",
  version: "2.0.0",

  commands: [
    {
      command: "otp",
      description: "Ambil kode 2FA untuk akun digital milikmu",
    },
  ],

  register(bot: Bot<Context>): void {
    const handleOtpCommand = async (ctx: Context): Promise<void> => {
      if (ctx.chat?.type !== "private" || !ctx.from) {
        await ctx.reply("❌ Perintah /otp hanya dapat digunakan di chat pribadi dengan bot.");
        return;
      }

      const telegramId = String(ctx.from.id);
      if (!limiter.tryConsume(telegramId)) {
        await ctx.reply("⚠️ Terlalu banyak permintaan OTP. Coba lagi dalam satu menit.");
        return;
      }

      const accountCode = (ctx.message?.text ?? "")
        .replace(/^\/(?:otp|totp|2fa)(?:@\w+)?\s*/i, "")
        .trim();
      if (!accountCode) {
        await ctx.reply(
          `🔐 <b>Ambil Kode 2FA</b>\n\n` +
          `Gunakan <code>/otp &lt;KODE_AKUN&gt;</code>\n` +
          `Contoh: <code>/otp NF-A01</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const result = await TotpService.getOwnedByAccountCode(accountCode, telegramId);
      if (!result.success) {
        await ctx.reply(failureMessage(result.reason));
        return;
      }

      const view = TotpService.buildTotpView(result);
      await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    };

    bot.command("otp", handleOtpCommand);
    // Safe compatibility aliases: these now accept an account code, never a secret.
    bot.command("totp", handleOtpCommand);
    bot.command("2fa", handleOtpCommand);

    bot.callbackQuery(/^totp_refresh_([a-f0-9]{24})$/, async (ctx) => {
      if (ctx.chat?.type !== "private" || !ctx.from) {
        await ctx.answerCallbackQuery({ text: "Fitur ini hanya tersedia di chat pribadi.", show_alert: true });
        return;
      }

      const telegramId = String(ctx.from.id);
      if (!limiter.tryConsume(telegramId)) {
        await ctx.answerCallbackQuery({
          text: "Terlalu banyak permintaan OTP. Coba lagi dalam satu menit.",
          show_alert: true,
        });
        return;
      }

      const result = await TotpService.getOwnedByStockId(ctx.match[1]!, telegramId);
      if (!result.success) {
        await ctx.answerCallbackQuery({ text: failureMessage(result.reason), show_alert: true });
        return;
      }

      const view = TotpService.buildTotpView(result);
      await ctx.answerCallbackQuery({ text: "🔄 Kode 2FA diperbarui." });
      await safeEditOrReply(ctx, view.text, view.keyboard);
    });

    // Retire historical callbacks that contained an encoded secret.
    bot.callbackQuery(/^totp_ref_/, async (ctx) => {
      await ctx.answerCallbackQuery({
        text: "Tombol lama sudah tidak berlaku. Gunakan /otp KODE_AKUN.",
        show_alert: true,
      });
    });

    console.log("   → /otp, /totp, /2fa, callbackQuery: totp_refresh_*");
  },
};

export default totpPlugin;
