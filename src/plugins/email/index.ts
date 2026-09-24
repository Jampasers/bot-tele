import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { EmailOtpService } from "../../models/EmailOtpService.js";
import { TenantMap } from "../../tenant/TenantMap.js";
import { getEmailRentalOptions, createEmailRentalReservation, payEmailRentalFromBalance, createEmailRentalQrisInvoice, checkEmailRentalQris, cancelEmailRental, completeEmailRental, getUserEmailRentals, getRentalInbox } from "../../email/services/emailRental.service.js";
import { createEmailRenewal, renewEmailRentalFromBalance, createEmailRenewalQrisInvoice, checkEmailRenewalQris } from "../../email/services/emailRentalRenewal.service.js";

const lastRefresh = new TenantMap<string, number>();
const actionHistory = new TenantMap<string, number[]>();
const line = (value: string): string => value.replace(/[\r\n\t]+/g, " ").slice(0, 240);
function userId(ctx: Context): string {
  if (!ctx.from) throw new Error("Akun Telegram tidak ditemukan.");
  return String(ctx.from.id);
}
function privateChat(ctx: Context): boolean { return ctx.chat?.type === "private"; }
function rateLimit(uid: string, action: string, maximum: number, windowMs: number): void {
  const key = uid + ":" + action;
  const now = Date.now();
  const recent = (actionHistory.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maximum) throw new Error("Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.");
  recent.push(now);
  actionHistory.set(key, recent);
}
function messageError(error: unknown): string {
  if (error instanceof Error && error.message.length < 300) return error.message;
  return "Terjadi kendala. Coba lagi sebentar.";
}
function activeText(rental: { emailAddress: string; providerName: string; serviceSnapshot: { icon: string; name: string }; expiresAt?: Date; _id: unknown }): string {
  const remaining = Math.max(0, (rental.expiresAt?.getTime() ?? Date.now()) - Date.now());
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return [
    "📧 Email OTP aktif",
    "────────────────────────",
    "Layanan: " + rental.serviceSnapshot.icon + " " + line(rental.serviceSnapshot.name),
    "Email: " + line(rental.emailAddress),
    "Provider: " + line(rental.providerName),
    "Sisa waktu: " + minutes + " menit " + seconds + " detik",
    "",
    "Pesan masuk akan dikirim ke chat ini secara otomatis.",
  ].join("\n");
}
function activeKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Refresh Inbox", "em:refresh:" + id).text("📨 Lihat Email", "em:inbox:" + id).row()
    .text("⏱ Perpanjang", "em:renew:" + id).text("✅ Selesai", "em:done:" + id);
}
async function openCatalog(ctx: Context, edit = false): Promise<void> {
  const services = await EmailOtpService.find({ enabled: true }).sort({ name: 1 }).lean();
  const keyboard = new InlineKeyboard();
  const visible: string[] = [];
  for (const service of services) {
    const options = await getEmailRentalOptions(String(service._id));
    if (!options.length) continue;
    visible.push(service.icon + " " + line(service.name));
    keyboard.text(service.icon + " " + line(service.name), "em:s:" + String(service._id)).row();
  }
  if (!visible.length) {
    const text = "📧 Sewa OTP Email\n────────────────────────\nBelum ada layanan dengan stok dan harga aktif.";
    if (edit) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    else await ctx.reply(text);
    return;
  }
  keyboard.text("📜 Rental Email Saya", "em:history");
  const text = "📧 Sewa OTP Email\n────────────────────────\n\nPilih layanan yang ingin diverifikasi:\n\n" + visible.join("\n");
  if (edit) await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => ctx.reply(text, { reply_markup: keyboard }));
  else await ctx.reply(text, { reply_markup: keyboard });
}
async function showReservation(ctx: Context, rental: { _id: unknown; emailAddress: string; serviceSnapshot: { icon: string; name: string; durationMinutes: number }; providerName: string; price: number }): Promise<void> {
  const id = String(rental._id);
  const keyboard = new InlineKeyboard().text("💳 Bayar saldo", "em:bal:" + id)
    .text("📱 QRIS", "em:qris:" + id).row().text("❌ Batal", "em:cancel:" + id);
  await ctx.reply([
    "📧 Konfirmasi Rental",
    "────────────────────────",
    "Layanan: " + rental.serviceSnapshot.icon + " " + line(rental.serviceSnapshot.name),
    "Jenis email: " + line(rental.providerName),
    "Email: " + line(rental.emailAddress),
    "Durasi: " + rental.serviceSnapshot.durationMinutes + " menit",
    "Harga: Rp" + rental.price.toLocaleString("id-ID"),
    "",
    "Alamat ini ditahan sementara selama 10 menit.",
  ].join("\n"), { reply_markup: keyboard });
}
async function showInbox(ctx: Context, id: string): Promise<void> {
  const uid = userId(ctx);
  const now = Date.now();
  const last = lastRefresh.get(uid) ?? 0;
  if (now - last < 2500) {
    await ctx.answerCallbackQuery({ text: "Tunggu sebentar sebelum refresh lagi." }).catch(() => {});
    return;
  }
  lastRefresh.set(uid, now);
  const messages = await getRentalInbox(id, uid) as Array<{ sender: string; subject: string; receivedAt: Date; otpCode?: string; verificationLink?: string; magicLink?: string; preview: string }>;
  if (!messages.length) {
    await ctx.reply("📨 Belum ada email OTP masuk. Inbox dicek otomatis oleh bot.");
    return;
  }
  for (const message of messages) {
    await ctx.reply([
      "📨 Email baru",
      "From: " + line(message.sender),
      "Subject: " + line(message.subject),
      message.otpCode ? "🔐 OTP: " + line(message.otpCode) : "",
      message.verificationLink ? "🔗 Verification link: " + message.verificationLink : "",
      message.magicLink ? "🔗 Magic link: " + message.magicLink : "",
      "Received: " + new Date(message.receivedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour12: false }) + " WIB",
      "",
      line(message.preview),
    ].filter(Boolean).join("\n"), { link_preview_options: { is_disabled: true } });
  }
}

const emailPlugin: Plugin = {
  name: "email-otp-rental",
  version: "1.0.0",
  feature: "email_otp",
  commands: [
    { command: "email", description: "Sewa OTP Email" },
    { command: "emailrent", description: "Mulai rental OTP Email" },
    { command: "myemail", description: "Lihat rental email saya" },
  ],
  register(bot: Bot<Context>): void {
    bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      if ((data === "email_otp" || data.startsWith("em:")) && !privateChat(ctx)) {
        await ctx.answerCallbackQuery({ text: "Rental OTP Email hanya bisa digunakan melalui chat pribadi.", show_alert: true }).catch(() => {});
        return;
      }
      await next();
    });

    bot.command(["email", "emailrent"], async (ctx) => {
      if (!privateChat(ctx)) return void await ctx.reply("📧 Silakan buka chat pribadi bot untuk menyewa OTP Email.");
      try { await openCatalog(ctx); }
      catch { await ctx.reply("Layanan OTP Email belum siap. Coba lagi nanti."); }
    });
    bot.command("myemail", async (ctx) => {
      if (!privateChat(ctx)) return void await ctx.reply("📧 Riwayat rental email hanya tersedia melalui chat pribadi.");
      try {
        const rentals = await getUserEmailRentals(userId(ctx), 10);
        if (!rentals.length) return void await ctx.reply("Belum ada riwayat rental email.");
        const keyboard = new InlineKeyboard();
        const rows = rentals.map((rental) => {
          const id = String(rental._id);
          keyboard.text(rental.serviceSnapshot.icon + " " + line(rental.serviceSnapshot.name) + " · " + rental.status, "em:history:" + id).row();
          return line(rental.emailAddress) + " — " + rental.status;
        });
        keyboard.text("📧 Sewa OTP Email", "email_otp");
        await ctx.reply("📜 Rental Email Saya\n────────────────────────\n" + rows.join("\n"), { reply_markup: keyboard });
      } catch (error) { await ctx.reply(messageError(error)); }
    });

    bot.callbackQuery("email_otp", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await openCatalog(ctx, true); } catch { await ctx.reply("Catalog OTP Email belum tersedia."); }
    });

    bot.callbackQuery(/^em:s:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const serviceId = ctx.match[1]!;
        const service = await EmailOtpService.findOne({ _id: serviceId, enabled: true }).lean();
        if (!service) throw new Error("Layanan sudah tidak tersedia.");
        const options = await getEmailRentalOptions(serviceId);
        const keyboard = new InlineKeyboard();
        for (const option of options) {
          const code = option.resourceType === "MAILBOX" ? "M" : "D";
          const resourceId = option.providerId ?? option.domainId!;
          const label = option.resourceType === "MAILBOX"
            ? "📮 " + line(option.providerName) + " — " + option.stock + " tersedia · Rp" + option.price.toLocaleString("id-ID")
            : "🌐 " + line(option.providerName) + " — tersedia · Rp" + option.price.toLocaleString("id-ID");
          keyboard.text(label, "em:o:" + code + ":" + serviceId + ":" + resourceId).row();
        }
        if (options.length > 1) keyboard.text("🎲 Provider acak", "em:random:" + serviceId).row();
        keyboard.text("🔙 Kembali", "email_otp");
        await ctx.reply("📮 Pilih jenis email\n────────────────────────\n" + service.icon + " " + line(service.name), { reply_markup: keyboard });
      } catch (error) { await ctx.reply(messageError(error)); }
    });

    const reserveOption = async (ctx: Context, serviceId: string, type: "MAILBOX" | "DOMAIN_ALIAS", resourceId: string) => {
      rateLimit(userId(ctx), "create", 3, 60_000);
      const rental = await createEmailRentalReservation({
        userId: userId(ctx), serviceId, resourceType: type,
        ...(type === "MAILBOX" ? { providerId: resourceId } : { domainId: resourceId }),
      });
      await showReservation(ctx, rental);
    };
    bot.callbackQuery(/^em:o:(M|D):([a-f\d]{24}):([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await reserveOption(ctx, ctx.match[2]!, ctx.match[1]!.toUpperCase() === "M" ? "MAILBOX" : "DOMAIN_ALIAS", ctx.match[3]!); }
      catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery("em:history", async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const rentals = await getUserEmailRentals(userId(ctx), 10);
      if (!rentals.length) return void await ctx.reply("Belum ada riwayat rental email.");
      await ctx.reply(rentals.map((rental) => rental.serviceSnapshot.name + " · " + rental.emailAddress + " · " + rental.status).join("\n"));
    });
    bot.callbackQuery(/^em:random:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const serviceId = ctx.match[1]!;
        const options = await getEmailRentalOptions(serviceId);
        if (!options.length) throw new Error("Stok layanan ini habis.");
        const option = options[Math.floor(Math.random() * options.length)]!;
        await reserveOption(ctx, serviceId, option.resourceType, option.providerId ?? option.domainId!);
      } catch (error) { await ctx.reply(messageError(error)); }
    });

    bot.callbackQuery(/^em:bal:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const rental = await payEmailRentalFromBalance(ctx.match[1]!, userId(ctx));
        await ctx.reply(activeText(rental), { reply_markup: activeKeyboard(String(rental._id)) });
      } catch (error) {
        const text = messageError(error);
        const keyboard = /saldo/i.test(text) ? new InlineKeyboard().text("📱 Bayar QRIS", "em:qris:" + ctx.match[1]!) : undefined;
        await ctx.reply(text, keyboard ? { reply_markup: keyboard } : {});
      }
    });
    bot.callbackQuery(/^em:qris:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const result = await createEmailRentalQrisInvoice(ctx.match[1]!, userId(ctx));
        const caption = "📱 QRIS OTP Email\nNominal: Rp" + (result.rental.qrisAmount ?? result.rental.price).toLocaleString("id-ID") + "\nInvoice berlaku sampai reservasi berakhir.";
        await ctx.replyWithPhoto(new InputFile(result.qr, "email-rental-qris.png"), {
          caption, reply_markup: new InlineKeyboard().text("✅ Cek pembayaran", "em:check:" + String(result.rental._id))
            .text("❌ Batal", "em:cancel:" + String(result.rental._id)),
        });
      } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:check:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        rateLimit(userId(ctx), "payment_check", 6, 60_000);
        const rental = await checkEmailRentalQris(ctx.match[1]!, userId(ctx));
        if (rental.status === "ACTIVE") await ctx.reply(activeText(rental), { reply_markup: activeKeyboard(String(rental._id)) });
        else await ctx.reply("Pembayaran diterima dan sedang diproses.");
      } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:cancel:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { rateLimit(userId(ctx), "cancel", 5, 60_000); await cancelEmailRental(ctx.match[1]!, userId(ctx)); await ctx.reply("Reservasi dibatalkan. Mailbox dilepas dan alamat domain dipensiunkan."); }
      catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:refresh:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await showInbox(ctx, ctx.match[1]!); } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:inbox:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await showInbox(ctx, ctx.match[1]!); } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:done:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await completeEmailRental(ctx.match[1]!, userId(ctx)); await ctx.reply("✅ Rental diselesaikan. Mailbox masuk cooldown; alias domain dipensiunkan."); }
      catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:renew:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const renewal = await createEmailRenewal(ctx.match[1]!, userId(ctx));
        await ctx.reply("⏱ Perpanjang rental OTP Email\nHarga: Rp" + renewal.price.toLocaleString("id-ID") +
          "\nDurasi tambahan: " + renewal.durationMinutes + " menit", {
            reply_markup: new InlineKeyboard().text("💳 Bayar saldo", "em:renewbal:" + String(renewal._id))
              .text("📱 QRIS", "em:renewqris:" + String(renewal._id)),
          });
      } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:renewbal:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await renewEmailRentalFromBalance(ctx.match[1]!, userId(ctx)); await ctx.reply("✅ Rental berhasil diperpanjang."); }
      catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:renewqris:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const result = await createEmailRenewalQrisInvoice(ctx.match[1]!, userId(ctx));
        await ctx.replyWithPhoto(new InputFile(result.qr, "email-renewal-qris.png"), {
          caption: "QRIS perpanjangan · Rp" + (result.renewal.qrisAmount ?? result.renewal.price).toLocaleString("id-ID"),
          reply_markup: new InlineKeyboard().text("✅ Cek pembayaran", "em:renewcheck:" + String(result.renewal._id)),
        });
      } catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:renewcheck:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try { await checkEmailRenewalQris(ctx.match[1]!, userId(ctx)); await ctx.reply("✅ Pembayaran diterima, masa rental diperpanjang."); }
      catch (error) { await ctx.reply(messageError(error)); }
    });
    bot.callbackQuery(/^em:history:([a-f\d]{24})$/i, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      try {
        const rentals = await getUserEmailRentals(userId(ctx), 20);
        const rental = rentals.find((item) => String(item._id) === ctx.match[1]);
        if (!rental) throw new Error("Riwayat rental tidak ditemukan.");
        await ctx.reply(activeText(rental), rental.status === "ACTIVE" ? { reply_markup: activeKeyboard(String(rental._id)) } : {});
      } catch (error) { await ctx.reply(messageError(error)); }
    });
  },
};

export default emailPlugin;
