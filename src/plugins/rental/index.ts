import { Context, InlineKeyboard, InputFile } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { RentalPlan } from "../../models/RentalPlan.js";
import type { RentalRuntimeState } from "../../rental/rental.service.js";
import { createRentalInvoice, checkRentalPayment } from "../../rental/rentalPayment.service.js";

export const renewalKeyboard = (): InlineKeyboard => new InlineKeyboard().text("📅 Perpanjang Sekarang", "rental_renew");
const formatDate = (date: Date): string => new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta", dateStyle: "long", timeStyle: "short",
}).format(date);
const formatPrice = (amount: number): string => new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0,
}).format(amount);

export function rentalStatusText(state: RentalRuntimeState, now = new Date()): string {
  const base = `📅 Masa Aktif Bot\n\nBot: @${state.botUsername}\nStatus: ${state.status}\nBerakhir: ${formatDate(state.expiresAt)} WIB`;
  if (state.status === "pending") return `${base}\n\nSelesaikan pembayaran paket untuk mengaktifkan bot.`;
  if (state.status === "expired_grace") {
    const minutes = Math.max(0, Math.ceil(((state.graceEndsAt?.getTime() ?? 0) - now.getTime()) / 60_000));
    return `⚠️ MASA RENTAL BOT TELAH HABIS\n\n${base}\n\nBot sedang dalam masa tenggang 24 jam.\nFitur bot sementara dinonaktifkan.\nSisa masa tenggang: ${Math.floor(minutes / 60)} jam ${minutes % 60} menit.`;
  }
  if (state.status === "suspended") return `⚠️ BOT DITANGGUHKAN\n\n${base}\n\nFitur bisnis dikunci. Perpanjang sekarang untuk mengaktifkan kembali bot.`;
  if (state.status === "terminated") return `${base}\n\nLayanan telah dihentikan. Hubungi platform untuk bantuan.`;
  return `${base}\n\nPerpanjangan sebelum masa aktif habis ditambahkan ke tanggal berakhir saat ini.`;
}

export async function showRentalStatus(ctx: Context, state: RentalRuntimeState): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(rentalStatusText(state), { reply_markup: renewalKeyboard() });
}

export async function handleRentalRenewal(ctx: Context, state: RentalRuntimeState): Promise<void> {
  const actorId = String(ctx.from?.id ?? "");
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  try {
    const data = ctx.callbackQuery?.data ?? "";
    const planMatch = /^rental_plan_([a-f0-9]{24})$/.exec(data);
    const checkMatch = /^rental_check_([A-Za-z0-9_-]{1,96})$/.exec(data);
    if (planMatch) {
      const invoice = await createRentalInvoice(state.rentalId, actorId, planMatch[1]!);
      if (invoice.payment.planId !== planMatch[1]) {
        await ctx.reply("Masih ada invoice paket sebelumnya yang aktif. Selesaikan invoice tersebut atau tunggu hingga kedaluwarsa sebelum mengganti paket.");
      }
      await ctx.replyWithPhoto(new InputFile(invoice.qris.buffer, "renewal-qris.png"), {
        caption: `📅 Perpanjangan ${invoice.payment.durationDays} Hari\n\nTotal: ${formatPrice(invoice.payment.amount)}\nBayar sesuai nominal QRIS platform.\nBerlaku sampai: ${formatDate(invoice.payment.expiresAt)} WIB\n\nPembayaran otomatis diperiksa.`,
        reply_markup: new InlineKeyboard().text("🔄 Cek Pembayaran", `rental_check_${invoice.payment.providerReference}`).row().text("📅 Paket Lain", "rental_renew"),
      });
      return;
    }
    if (checkMatch) {
      const result = await checkRentalPayment(checkMatch[1]!, actorId);
      if (result.status === "paid") {
        await ctx.reply(`✅ Pembayaran renewal berhasil. Bot aktif kembali.${result.rental ? `\nBerlaku sampai: ${formatDate(result.rental.expiresAt)} WIB` : ""}`);
      } else {
        await ctx.reply(result.status === "expired" ? "Invoice sudah kedaluwarsa. Buat invoice baru melalui /renew." : "Pembayaran belum terkonfirmasi. Bot memeriksa pembayaran secara berkala.", { reply_markup: renewalKeyboard() });
      }
      return;
    }
    const plans = await RentalPlan.find({ enabled: true }).sort({ durationDays: 1, price: 1 }).limit(40).lean();
    const keyboard = new InlineKeyboard();
    for (const plan of plans) keyboard.text(`${plan.name} · ${formatPrice(plan.price)}`, `rental_plan_${plan._id}`).row();
    await ctx.reply(`${rentalStatusText(state)}\n\n${plans.length ? "Pilih paket perpanjangan. Pembayaran menggunakan QRIS milik platform." : "Paket belum tersedia. Hubungi platform."}`, { reply_markup: keyboard });
  } catch {
    // Provider failures may contain credentials or raw request objects: do not echo them.
    console.warn(`[Rental:${state.rentalId}] [Tenant:${state.tenantId}] Renewal request failed`);
    await ctx.reply("Permintaan renewal belum dapat diproses. Coba kembali atau hubungi platform.", { reply_markup: renewalKeyboard() });
  }
}

const rentalPlugin: Plugin = {
  name: "rental", version: "1.0.0", rentalOnly: true,
  commands: [
    { command: "renew", description: "[Owner] Perpanjang masa aktif bot" },
    { command: "status", description: "[Owner] Status masa aktif bot" },
  ],
  // These controls run in rental.middleware before business and force-subscription gates.
  register(): void {},
};
export default rentalPlugin;
