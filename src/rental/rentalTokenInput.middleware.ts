import type { Context, MiddlewareFn } from "grammy";
import { getTenantContext } from "../tenant/context.js";
import {
  clearRentalTokenInput,
  getRentalTokenInput,
  markRentalTokenMessageDeleted,
} from "./rentalTokenInput.js";

/** Delete a pending BotFather token before any middleware that may stop the update. */
export const rentalTokenInputMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  if (getTenantContext().rentalId || !ctx.from || !ctx.message || !("text" in ctx.message)) return next();
  const ownerTelegramId = String(ctx.from.id);
  if (!getRentalTokenInput(ownerTelegramId)) return next();
  const text = ctx.message.text;
  if (text.startsWith("/")) return next();
  if (ctx.chat?.type !== "private") {
    clearRentalTokenInput(ownerTelegramId);
    await ctx.reply("🔒 Token hanya boleh dikirim melalui chat pribadi.").catch(() => {});
    return;
  }
  try {
    await ctx.deleteMessage();
  } catch {
    clearRentalTokenInput(ownerTelegramId);
    await ctx.reply("⚠️ Pesan token tidak berhasil dihapus, jadi token tidak diproses. Hapus dan rotasi token di @BotFather, lalu mulai lagi melalui /sewa.").catch(() => {});
    return;
  }
  markRentalTokenMessageDeleted(ctx);
  return next();
};
