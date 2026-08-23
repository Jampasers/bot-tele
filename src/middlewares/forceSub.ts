import { Context, MiddlewareFn } from "grammy";
import { ForceSubService } from "../services/forceSub.js";
import { isAdmin } from "../core/admin.js";
import {
  buildWelcomeText,
  buildMainMenuReplyKeyboard,
  findOrCreateUser,
} from "../plugins/panel/index.js";

/**
 * Middleware that enforces channel membership (Force Subscription)
 * on all private chat interactions.
 */
export const forceSubMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  // 1. Only enforce on private chats where `ctx.from` is present.
  if (ctx.chat?.type !== "private" || !ctx.from) {
    return next();
  }

  // 2. Admin bypass — Admin can always use all bot features and commands.
  if (isAdmin(ctx)) {
    return next();
  }

  // 3. Handle the "Saya Sudah Bergabung" verification button.
  if (ctx.callbackQuery?.data === "forcesub_check") {
    const check = await ForceSubService.checkUserJoined(ctx.api, ctx.from.id, true);

    if (!check.isMember) {
      await ctx.answerCallbackQuery({
        text: "❌ Anda belum bergabung ke channel! Silakan klik tombol 'Gabung Channel' terlebih dahulu lalu coba lagi.",
        show_alert: true,
      });
      return;
    }

    // Successfully verified!
    await ctx.answerCallbackQuery({
      text: "✅ Verifikasi berhasil! Selamat datang.",
    });

    try {
      await ctx.deleteMessage();
    } catch {
      // Ignore if message deletion fails
    }

    try {
      const user = await findOrCreateUser(
        String(ctx.from.id),
        ctx.from.first_name,
        ctx.from.username
      );

      await ctx.reply(buildWelcomeText(user), {
        parse_mode: "HTML",
        reply_markup: buildMainMenuReplyKeyboard(),
      });
    } catch (err) {
      console.error("[forceSubMiddleware] Verification menu error:", err);
      await ctx.reply("✅ Verifikasi berhasil! Silakan ketik /start untuk mulai menggunakan bot.");
    }
    return;
  }

  // 4. Check if the user has joined the channel.
  const check = await ForceSubService.checkUserJoined(ctx.api, ctx.from.id);

  if (check.isMember) {
    // User is a member (or force sub is disabled/unconfigured) → proceed.
    return next();
  }

  // 5. User is NOT a member → block access and show prompt.
  const { text, keyboard } = ForceSubService.buildForceSubPrompt(
    check.channelName,
    check.channelLink
  );

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: "⚠️ Anda wajib bergabung ke channel resmi terlebih dahulu untuk menggunakan bot!",
      show_alert: true,
    });

    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
    return;
  }

  if (ctx.message) {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  // For other update types, stop propagation.
};
