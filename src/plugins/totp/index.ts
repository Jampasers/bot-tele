import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { TotpService, isValidBase32 } from "../../services/totp.js";

// ============================================================================
//  Helper: Safe Message Editor
// ============================================================================

async function safeEditOrReply(
  ctx: Context,
  text: string,
  extra: { parse_mode?: "HTML" | "Markdown" | "MarkdownV2"; reply_markup?: InlineKeyboard } = {}
): Promise<void> {
  try {
    if (ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, extra);
    } else {
      await ctx.reply(text, extra);
    }
  } catch (err: any) {
    if (
      err?.description?.includes("message is not modified") ||
      err?.message?.includes("message is not modified")
    ) {
      return;
    }
    await ctx.reply(text, extra);
  }
}

// ============================================================================
//  Plugin Definition: TOTP / 2FA Generator
// ============================================================================

const totpPlugin: Plugin = {
  name: "totp-generator",
  version: "1.0.0",

  commands: [
    {
      command: "totp",
      description: "Generate kode 2FA / TOTP instan dari secret key",
    },
    {
      command: "2fa",
      description: "Generate kode 2FA / TOTP instan dari secret key",
    },
  ],

  register(bot: Bot<Context>): void {
    // ── /totp & /2fa command handler ─────────────────────────────────────────
    const handleTotpCommand = async (ctx: Context) => {
      const messageText = ctx.message?.text || "";
      const parts = messageText.trim().split(/\s+/);
      const rawArg = parts.slice(1).join(" ").trim();

      // Case 1: User didn't pass any argument -> Show guide & example
      if (!rawArg) {
        const guideText =
          `🔐 <b>Generator Kode 2FA / TOTP Instan</b>\n` +
          `${"─".repeat(32)}\n\n` +
          `Gunakan fitur ini untuk mendapatkan kode 2FA 6-digit secara real-time dari secret key akun Anda.\n\n` +
          `📖 <b>Cara Penggunaan:</b>\n` +
          `• <code>/totp &lt;SECRET_KEY&gt;</code>\n` +
          `• <code>/totp email|pass|SECRET_KEY</code>\n` +
          `• <code>/totp otpauth://totp/...?secret=XYZ</code>\n\n` +
          `💡 <b>Contoh:</b>\n` +
          `<code>/totp JBSWY3DPEHPK3PXP</code>\n` +
          `<code>/totp user@gmail.com|Password123|JBSWY3DPEHPK3PXP</code>\n\n` +
          `<i>Kode OTP akan di-generate otomatis dengan countdown waktu berlaku dan tombol refresh live!</i>`;

        const kb = new InlineKeyboard()
          .text("🛍️ Buka Katalog Produk", "product_digital")
          .row()
          .text("📜 Riwayat Pesanan", "dg_myorders");

        await ctx.reply(guideText, { parse_mode: "HTML", reply_markup: kb });
        return;
      }

      // Case 2: Extract secret from the argument
      const secret = TotpService.extractSecret(rawArg);
      if (!secret) {
        await ctx.reply(
          `❌ <b>Secret Key 2FA Tidak Valid!</b>\n\n` +
          `Sistem tidak dapat menemukan format Base32 2FA yang valid dari teks yang Anda kirim.\n\n` +
          `💡 <b>Pastikan secret key:</b>\n` +
          `• Menggunakan karakter Base32 standar (A-Z dan angka 2-7)\n` +
          `• Memiliki panjang minimal 8-64 karakter\n` +
          `• Contoh: <code>/totp JBSWY3DPEHPK3PXP</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Extract label if input was email|pass|secret
      let label: string | undefined;
      const delimiterParts = rawArg.split(/[\r\n|:]+/);
      if (delimiterParts.length >= 2 && delimiterParts[0]!.includes("@")) {
        label = delimiterParts[0]!.trim();
      }

      const { text, keyboard } = TotpService.buildTotpView(secret, { label });
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    };

    bot.command("totp", handleTotpCommand);
    bot.command("2fa", handleTotpCommand);

    // ── totp_ref_<encodedSecret> — Live refresh TOTP code ────────────────────
    bot.callbackQuery(/^totp_ref_(.+)$/, async (ctx) => {
      const encodedSecret = ctx.match[1]!;
      let secret: string;

      try {
        secret = Buffer.from(encodedSecret, "base64url").toString("utf8");
      } catch {
        await ctx.answerCallbackQuery({ text: "⚠️ Secret key tidak valid.", show_alert: true });
        return;
      }

      if (!isValidBase32(secret)) {
        await ctx.answerCallbackQuery({ text: "⚠️ Secret key tidak valid.", show_alert: true });
        return;
      }

      const { text, keyboard } = TotpService.buildTotpView(secret);
      await ctx.answerCallbackQuery({ text: "🔄 Kode OTP diperbarui!" });
      await safeEditOrReply(ctx, text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── totp_del — Close TOTP view for privacy ──────────────────────────────
    bot.callbackQuery("totp_del", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Tutup" });
      try {
        await ctx.deleteMessage();
      } catch {
        await safeEditOrReply(ctx, "🔒 <i>Kode OTP telah ditutup untuk keamanan.</i>", {
          parse_mode: "HTML",
        });
      }
    });

    console.log("   → /totp, /2fa, callbackQuery: totp_ref_*, totp_del");
  },
};

export default totpPlugin;
