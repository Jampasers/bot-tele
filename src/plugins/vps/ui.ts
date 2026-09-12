import { Context, InlineKeyboard } from "grammy";
import { getTenantContext, PLATFORM_TENANT_ID } from "../../tenant/context.js";

export const vpsPrice = (amount: number): string => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount);
export const vpsDate = (value: Date | string | null | undefined): string => {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(date.getTime()) ? "belum diketahui" : `${new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" }).format(date)} WIB`;
};
export function isVpsPlatform(): boolean {
  const tenant = getTenantContext();
  return tenant.tenantId === PLATFORM_TENANT_ID && !tenant.rentalId;
}
export async function vpsReply(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = keyboard ? { reply_markup: keyboard } : {};
  if (ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message) {
    try { await ctx.editMessageText(text, options); return; }
    catch { /* A stale/deleted message may be replaced with a new reply. */ }
  }
  await ctx.reply(text, options);
}
