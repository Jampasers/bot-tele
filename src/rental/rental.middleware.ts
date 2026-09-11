import type { Context, MiddlewareFn } from "grammy";
import { getTenantContext } from "../tenant/context.js";
import { deriveRentalLifecycle, getRentalRuntimeState, refreshRentalState, type RentalRuntimeState } from "./rental.service.js";
import { handleRentalRenewal, showRentalStatus } from "../plugins/rental/index.js";

export function isRentalAdministrator(state: Pick<RentalRuntimeState, "ownerTelegramId" | "adminTelegramIds">, actorId: string): boolean {
  return state.ownerTelegramId === actorId || state.adminTelegramIds.includes(actorId);
}

export function rentalCommand(ctx: Context): string {
  const text = ctx.message?.text ?? "";
  const entity = ctx.message?.entities?.find((item) => item.type === "bot_command" && item.offset === 0);
  if (!entity) return "";
  const raw = text.slice(1, entity.length);
  const [command, username] = raw.split("@");
  if (username && username.toLowerCase() !== ctx.me.username.toLowerCase()) return "";
  return command?.toLowerCase() ?? "";
}

export const rentalMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  const tenant = getTenantContext();
  if (!tenant.rentalId) return next();
  const cached = getRentalRuntimeState(tenant.rentalId) ?? await refreshRentalState(tenant.rentalId);
  if (!cached) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Status layanan belum tersedia." }).catch(() => {});
    return;
  }
  const state = { ...cached, ...deriveRentalLifecycle(cached) };
  const actorId = String(ctx.from?.id ?? "");
  const admin = isRentalAdministrator(state, actorId);
  const command = rentalCommand(ctx);
  const callback = ctx.callbackQuery?.data ?? "";
  const renewal = command === "renew" || ctx.message?.text === "📅 Perpanjang Bot" || callback === "rental_renew" || /^rental_(plan|bal|qris)_[a-f0-9]{24}$/.test(callback) || /^rental_check_[A-Za-z0-9_-]{1,96}$/.test(callback);
  const help = command === "help" || ctx.message?.text === "❓ Help";
  const control = renewal || command === "status" || (help && admin);
  if (control) {
    if (!admin || ctx.chat?.type !== "private") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Hanya owner/admin rental melalui chat pribadi.", show_alert: true }).catch(() => {});
      else await ctx.reply("Perintah ini hanya untuk owner/admin rental melalui chat pribadi.");
      return;
    }
    if (state.status === "terminated") { await showRentalStatus(ctx, state); return; }
    if (renewal) await handleRentalRenewal(ctx, state);
    else {
      await showRentalStatus(ctx, state);
      if (help) await ctx.reply(state.status === "active"
        ? "Gunakan /admin untuk mengelola toko, /status untuk masa aktif, dan /renew untuk perpanjangan."
        : "Selama layanan tidak aktif, gunakan /start, /status, /help, atau /renew. Pembayaran perpanjangan diproses langsung dari bot ini.");
    }
    return;
  }
  if (state.status === "active") return next();
  // All business actions are blocked, including stale inline callbacks and non-private updates.
  if (admin && ctx.chat?.type === "private") {
    await showRentalStatus(ctx, state);
  } else {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    if (ctx.chat && (ctx.message || ctx.callbackQuery)) await ctx.reply("⚠️ Bot sedang tidak aktif.\n\nMasa layanan bot telah berakhir.\nSilakan hubungi administrator bot.");
  }
};
