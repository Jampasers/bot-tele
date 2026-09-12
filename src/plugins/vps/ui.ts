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
const REGION_LABELS: Record<string, string> = {
  sgp1: "🇸🇬 Singapore (sgp1)",
  fra1: "🇩🇪 Frankfurt (fra1)",
  lon1: "🇬🇧 London (lon1)",
  ams3: "🇳🇱 Amsterdam (ams3)",
  nyc1: "🇺🇸 New York 1 (nyc1)",
  nyc2: "🇺🇸 New York 2 (nyc2)",
  nyc3: "🇺🇸 New York 3 (nyc3)",
  sfo2: "🇺🇸 San Francisco 2 (sfo2)",
  sfo3: "🇺🇸 San Francisco 3 (sfo3)",
  tor1: "🇨🇦 Toronto (tor1)",
  blr1: "🇮🇳 Bangalore (blr1)",
  syd1: "🇦🇺 Sydney (syd1)",
  atl1: "🇺🇸 Atlanta (atl1)",
};

const SIZE_LABELS: Record<string, string> = {
  "s-1vcpu-512mb-10gb": "1 vCPU · 512 MB (10GB)",
  "s-1vcpu-1gb": "1 vCPU · 1 GB (25GB)",
  "s-1vcpu-2gb": "1 vCPU · 2 GB (50GB)",
  "s-2vcpu-2gb": "2 vCPU · 2 GB (60GB)",
  "s-2vcpu-4gb": "2 vCPU · 4 GB (80GB)",
  "s-4vcpu-8gb": "4 vCPU · 8 GB (160GB)",
  "s-8vcpu-16gb": "8 vCPU · 16 GB (320GB)",
};

export const formatRegion = (slug: string): string => REGION_LABELS[slug] || `🌐 ${slug}`;
export const formatSize = (slug: string): string => SIZE_LABELS[slug] || slug;

export async function vpsReply(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = keyboard ? { reply_markup: keyboard } : {};
  if (ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message) {
    try { await ctx.editMessageText(text, options); return; }
    catch { /* A stale/deleted message may be replaced with a new reply. */ }
  }
  await ctx.reply(text, options);
}

