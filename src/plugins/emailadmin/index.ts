import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { isAdmin } from "../../core/admin.js";
import { getTenantId } from "../../tenant/context.js";
import { TenantMap } from "../../tenant/TenantMap.js";
import { EmailDomain } from "../../models/EmailDomain.js";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailMailbox } from "../../models/EmailMailbox.js";
import { EmailOtpService } from "../../models/EmailOtpService.js";
import { EmailProvider } from "../../models/EmailProvider.js";
import { EmailRental } from "../../models/EmailRental.js";
import { EmailRentalPrice } from "../../models/EmailRentalPrice.js";
import { EmailRentalSettings } from "../../models/EmailRentalSettings.js";
import { EmailUsage } from "../../models/EmailUsage.js";
import { CloudflareService } from "../../services/cloudflare.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { createMailbox, disableMailbox, removeMailboxIfSafe, storeMailboxCredential, testMailbox, upsertEmailProvider, upsertEmailService, toggleService } from "../../email/services/emailRental.service.js";
import { GLOBAL_EMAIL_SERVICE_ID, setEmailRentalPrice, setGlobalEmailRentalPrice } from "../../email/services/emailPricing.service.js";

type InputState = { kind: "provider"; id?: string } | { kind: "mailbox_bulk"; providerId: string } |
  { kind: "mailbox_credential"; mailboxId: string } | { kind: "service"; id?: string } |
  { kind: "domain"; id?: string } | { kind: "price" } | { kind: "global_price" } | { kind: "settings" };
const inputs = new TenantMap<string, InputState>();
const line = (value: string): string => value.replace(/[\r\n\t]+/g, " ").slice(0, 180);
const errorText = (error: unknown): string => error instanceof Error && error.message.length < 250 ? error.message : "Operasi gagal. Data rahasia tidak disimpan atau ditampilkan.";
const privateChat = (ctx: Context): boolean => ctx.chat?.type === "private";
function stateKey(ctx: Context): string { return String(ctx.from?.id ?? ""); }
function admin(ctx: Context): boolean { return isAdmin(ctx) && privateChat(ctx); }
async function guard(ctx: Context): Promise<boolean> {
  if (admin(ctx)) return true;
  await ctx.reply("⛔ Perintah ini hanya untuk admin melalui chat pribadi.");
  return false;
}
function menu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📮 Provider", "ema:providers").text("📦 Mailbox", "ema:mailboxes").row()
    .text("🎯 OTP Service", "ema:services").text("🌐 Domain", "ema:domains").row()
    .text("💰 Harga", "ema:prices").text("📊 Rental Aktif", "ema:active").row()
    .text("📜 Usage History", "ema:usage").text("🧪 Test Mailbox", "ema:testbulk").row()
    .text("⚙️ Settings", "ema:settings");
}
async function panel(ctx: Context): Promise<void> {
  await ctx.reply("📧 Email Rental Admin\n────────────────────────\nKelola provider, mailbox, service OTP, domain, harga, dan rental.", { reply_markup: menu() });
}
function parsePatterns(value: string): string[] { return value.split(";").map((item) => item.trim()).filter(Boolean).slice(0, 20); }
function parseBool(value: string): boolean { return value.trim().toLowerCase() === "true"; }
function parseService(text: string) {
  const [code = "", name = "", icon = "📧", duration = "", cooldown = "5", senders = "", subjects = "", otp = "", magic = "false", verify = "false"] = text.split("|");
  const durationMinutes = Number(duration), cooldownMinutes = Number(cooldown);
  if (!Number.isInteger(durationMinutes) || !Number.isInteger(cooldownMinutes)) throw new Error("Durasi dan cooldown harus angka menit.");
  return {
    code, name, icon, durationMinutes, cooldownMinutes,
    senderPatterns: parsePatterns(senders), subjectPatterns: parsePatterns(subjects), otpPatterns: parsePatterns(otp),
    allowMagicLink: parseBool(magic), allowVerificationLink: parseBool(verify),
  };
}

const adminPlugin: Plugin = {
  name: "email-rental-admin", version: "1.0.0", internalOnly: true,
  commands: [{ command: "emailadmin", description: "Panel admin OTP Email" }],
  register(bot: Bot<Context>): void {
    bot.command("emailadmin", async (ctx) => { if (await guard(ctx)) await panel(ctx); });

    bot.on("message:text", async (ctx, next) => {
      const state = inputs.get(stateKey(ctx));
      if (!state || !ctx.from || !isAdmin(ctx)) return next();
      if (!privateChat(ctx)) {
        if (state.kind === "mailbox_bulk" || state.kind === "mailbox_credential") await ctx.deleteMessage().catch(() => {});
        inputs.delete(stateKey(ctx));
        return next();
      }
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      const secretInput = state.kind === "mailbox_bulk" || state.kind === "mailbox_credential";
      if (secretInput) {
        try { await ctx.deleteMessage(); }
        catch {
          inputs.delete(stateKey(ctx));
          await ctx.reply("⛔ Pesan credential gagal dihapus. Gua batal menyimpan credential ini.");
          return;
        }
      }
      inputs.delete(stateKey(ctx));
      try {
        if (state.kind === "provider") {
          const [code = "", name = "", icon = "", host = "", portText = "", secureText = "true", authType = "APP_PASSWORD"] = text.split("|");
          if (state.id && await EmailRental.exists({ providerId: state.id, status: { $in: ["WAITING_PAYMENT", "PROCESSING", "ACTIVE"] } })) {
            throw new Error("Provider tidak bisa diedit selama masih ada reservasi atau rental aktif.");
          }
          await upsertEmailProvider({
            ...(state.id ? { id: state.id } : {}), code, name, icon, host, port: Number(portText),
            secure: parseBool(secureText), authType: authType.trim().toUpperCase() === "PASSWORD" ? "PASSWORD" : "APP_PASSWORD",
          });
          await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "provider_created", userId: String(ctx.from.id) });
          await ctx.reply("✅ Provider IMAP disimpan.");
        } else if (state.kind === "mailbox_bulk") {
          const rows = text.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
          let success = 0, failed = 0;
          for (const row of rows) {
            const fields = row.split("|");
            const email = fields[0]?.trim() || "";
            const username = fields.length === 3 ? fields[1]?.trim() || email : email;
            const password = fields.length === 3 ? fields[2] ?? "" : fields[1] ?? "";
            try {
              if (!email || !password || fields.length < 2 || fields.length > 3) throw new Error("invalid row");
              await createMailbox({ providerId: state.providerId, email, ...(username ? { username } : {}), password });
              success++;
            } catch { failed++; }
          }
          await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "mailbox_added", userId: String(ctx.from.id) });
          await ctx.reply("Selesai.\n✅ " + success + " berhasil\n❌ " + failed + " gagal\nCredential tidak dicatat.");
        } else if (state.kind === "mailbox_credential") {
          await storeMailboxCredential(state.mailboxId, text);
          await ctx.reply("✅ Credential berhasil diuji dan diperbarui. Password tidak akan ditampilkan lagi.");
        } else if (state.kind === "service") {
          await upsertEmailService({ ...(state.id ? { id: state.id } : {}), ...parseService(text) });
          await ctx.reply("✅ OTP service disimpan. Perubahan aktif tanpa restart.");
        } else if (state.kind === "domain") {
          const [domainText = "", zoneId = "", collectorEmail = "", sellableText = "true"] = text.split("|");
          const domain = domainText.trim().toLowerCase();
          if (state.id && await EmailDomainAlias.exists({ domainId: state.id, status: { $in: ["RESERVED", "ACTIVE"] } })) {
            throw new Error("Domain tidak bisa diedit selama masih ada alias yang sedang dipakai atau menunggu pembayaran.");
          }
          const zone = (await CloudflareService.getZones()).find((item) => item.id === zoneId.trim() && item.domain.toLowerCase() === domain);
          if (!zone) throw new Error("Domain dan zone ID harus cocok dengan zone di /cf.");
          const collector = await EmailMailbox.findOne({ email: collectorEmail.trim().toLowerCase(), enabled: true, status: { $in: ["AVAILABLE", "COOLDOWN"] } }).lean();
          if (!collector) throw new Error("Collector mailbox harus terdaftar dan aktif.");
          await EmailDomain.findOneAndUpdate(state.id ? { _id: state.id } : { domain }, {
            $set: { domain, zoneId: zone.id, provider: "CLOUDFLARE", routingMode: "FORWARD",
              destinationMailboxId: String(collector._id), enabled: true, sellable: parseBool(sellableText) },
          }, { upsert: true, returnDocument: "after", runValidators: true });
          await ctx.reply("✅ Domain Email Routing disimpan menggunakan Cloudflare config yang sama dengan /cf.");
        } else if (state.kind === "price") {
          const [serviceCode = "", typeText = "", providerCode = "", priceText = ""] = text.split("|");
          const service = await EmailOtpService.findOne({ code: serviceCode.trim().toUpperCase() }).lean();
          if (!service) throw new Error("OTP service tidak ditemukan.");
          const resourceType = typeText.trim().toUpperCase() === "MAILBOX" ? "MAILBOX" : typeText.trim().toUpperCase() === "DOMAIN_ALIAS" ? "DOMAIN_ALIAS" : null;
          if (!resourceType) throw new Error("Tipe harus MAILBOX atau DOMAIN_ALIAS.");
          const provider = resourceType === "MAILBOX" ? await EmailProvider.findOne({ code: providerCode.trim().toUpperCase() }).lean() : null;
          if (resourceType === "MAILBOX" && !provider) throw new Error("Provider tidak ditemukan.");
          await setEmailRentalPrice({ serviceId: String(service._id), resourceType, ...(provider ? { providerId: String(provider._id) } : {}), price: Number(priceText) });
          await ctx.reply("✅ Harga OTP Email disimpan.");
        } else if (state.kind === "global_price") {
          const [providerCode = "", priceText = ""] = text.split("|");
          const provider = await EmailProvider.findOne({ code: providerCode.trim().toUpperCase() }).lean();
          if (!provider) throw new Error("Provider tidak ditemukan.");
          await setGlobalEmailRentalPrice({ resourceType: "MAILBOX", providerId: String(provider._id), price: Number(priceText) });
          await ctx.reply("✅ Harga global " + provider.name + " disimpan. Semua service tanpa harga khusus akan memakai harga ini.");
        } else if (state.kind === "settings") {
          const [max = "3", reservation = "10", grace = "5", aliasGrace = "15", connections = "5", poll = "15"] = text.split("|");
          await EmailRentalSettings.findOneAndUpdate({}, { $set: {
            maxConcurrentEmailRentalsPerUser: Number(max), reservationMinutes: Number(reservation), messageGraceMinutes: Number(grace),
            aliasGraceMinutes: Number(aliasGrace), maxConcurrentConnections: Number(connections), pollIntervalSeconds: Number(poll),
          } }, { upsert: true, returnDocument: "after", runValidators: true, setDefaultsOnInsert: true });
          await ctx.reply("✅ Pengaturan tersimpan. Jumlah koneksi worker dibatasi sesuai nilai ini.");
        }
      } catch (error) {
        await ctx.reply(secretInput ? "❌ Gagal memproses credential. Password tidak dicatat; periksa ulang lalu coba lagi." : errorText(error));
      }
    });

    bot.callbackQuery(/^ema:/, async (ctx) => {
      if (!admin(ctx)) { await ctx.answerCallbackQuery({ text: "Admin only.", show_alert: true }); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const data = ctx.callbackQuery.data;
      try {
        if (data === "ema:home") return void await panel(ctx);
        if (data === "ema:providers") {
          const providers = await EmailProvider.find().sort({ name: 1 }).lean();
          const kb = new InlineKeyboard().text("➕ Tambah Provider", "ema:addprovider").row();
          for (const provider of providers) kb.text(provider.name + (provider.enabled ? " ✅" : " 🔴"), "ema:provider:" + String(provider._id)).row();
          kb.text("🔙 Menu", "ema:home");
          await ctx.reply("📮 Provider IMAP\n" + (providers.map((item) => item.code + " — " + item.imapHost + ":" + item.imapPort).join("\n") || "Belum ada provider."), { reply_markup: kb });
        } else if (data === "ema:addprovider") {
          inputs.set(stateKey(ctx), { kind: "provider" });
          await ctx.reply("Kirim: CODE|Nama|Ikon|Host|Port|TLS true/false|PASSWORD atau APP_PASSWORD\nContoh: CUSTOM|Custom Mail|📮|mail.example.com|993|true|APP_PASSWORD");
        } else if (data.startsWith("ema:provider:")) {
          const id = data.slice("ema:provider:".length);
          const provider = await EmailProvider.findById(id).lean();
          if (!provider) throw new Error("Provider tidak ditemukan.");
          await ctx.reply(provider.code + " · " + provider.name + "\n" + provider.imapHost + ":" + provider.imapPort + "\nStatus: " + (provider.enabled ? "Aktif" : "Nonaktif"), {
            reply_markup: new InlineKeyboard().text("✏️ Edit", "ema:editprovider:" + id).text(provider.enabled ? "🔴 Nonaktifkan" : "🟢 Aktifkan", "ema:toggleprovider:" + id).row()
              .text("🗑 Hapus jika aman", "ema:deleteprovider:" + id).text("🔙 Provider", "ema:providers"),
          });
        } else if (data.startsWith("ema:editprovider:")) {
          inputs.set(stateKey(ctx), { kind: "provider", id: data.slice("ema:editprovider:".length) });
          await ctx.reply("Kirim field provider lengkap:\nCODE|Nama|Ikon|Host|Port|TLS true/false|PASSWORD atau APP_PASSWORD");
        } else if (data.startsWith("ema:toggleprovider:")) {
          const id = data.slice("ema:toggleprovider:".length);
          if (await EmailMailbox.exists({ providerId: id, status: { $in: ["RENTED", "RESERVED"] } })) throw new Error("Provider punya mailbox yang sedang dirental/direservasi.");
          const provider = await EmailProvider.findById(id);
          if (!provider) throw new Error("Provider tidak ditemukan.");
          provider.enabled = !provider.enabled;
          await provider.save();
          await ctx.reply("Status provider diperbarui.");
        } else if (data.startsWith("ema:deleteprovider:")) {
          const id = data.slice("ema:deleteprovider:".length);
          if (await EmailMailbox.exists({ providerId: id }) || await EmailRental.exists({ providerId: id }) || await EmailRentalPrice.exists({ providerId: id })) {
            throw new Error("Provider masih dipakai inventory, histori, atau harga. Nonaktifkan agar konfigurasi tetap utuh.");
          }
          await EmailProvider.deleteOne({ _id: id });
          await ctx.reply("Provider dihapus.");
        } else if (data === "ema:mailboxes") {
          const providers = await EmailProvider.find({ enabled: true }).sort({ name: 1 }).lean();
          const kb = new InlineKeyboard();
          for (const provider of providers) kb.text("➕ " + provider.name, "ema:addmailbox:" + String(provider._id)).row();
          const mailboxes = await EmailMailbox.find().sort({ createdAt: -1 }).limit(25).lean();
          for (const mailbox of mailboxes) kb.text(mailbox.email + " · " + mailbox.status, "ema:mailbox:" + String(mailbox._id)).row();
          kb.text("🔙 Menu", "ema:home");
          await ctx.reply("📦 Mailbox\nAktif: " + await EmailMailbox.countDocuments({ enabled: true }) + "\nPilih provider untuk tambah mailbox atau pilih item untuk mengelola.", { reply_markup: kb });
        } else if (data.startsWith("ema:addmailbox:")) {
          const providerId = data.slice("ema:addmailbox:".length);
          if (!(await EmailProvider.exists({ _id: providerId, enabled: true }))) throw new Error("Provider tidak ditemukan.");
          inputs.set(stateKey(ctx), { kind: "mailbox_bulk", providerId });
          await ctx.reply("Kirim daftar credential satu baris per mailbox:\nemail|appPassword\natau email|username|appPassword\nCredential akan dihapus dari chat sebelum dites.");
        } else if (data.startsWith("ema:mailbox:")) {
          const id = data.slice("ema:mailbox:".length);
          const mailbox = await EmailMailbox.findById(id).lean();
          if (!mailbox) throw new Error("Mailbox tidak ditemukan.");
          await ctx.reply(mailbox.email + "\nStatus: " + mailbox.status + "\nTotal rentals: " + mailbox.totalRentals +
            "\nLast successful login: " + (mailbox.lastSuccessfulLoginAt?.toLocaleString("id-ID") ?? "Belum ada"), {
            reply_markup: new InlineKeyboard().text("🧪 Test", "ema:test:" + id).text("🔐 Ganti credential", "ema:credential:" + id).row()
              .text("🔴 Nonaktifkan", "ema:disable:" + id).text("🗑 Hapus jika aman", "ema:remove:" + id).row().text("🔙 Mailbox", "ema:mailboxes"),
          });
        } else if (data.startsWith("ema:credential:")) {
          const id = data.slice("ema:credential:".length);
          inputs.set(stateKey(ctx), { kind: "mailbox_credential", mailboxId: id });
          await ctx.reply("Kirim password/app password baru. Pesan akan dihapus sebelum diuji dan tidak akan ditampilkan ulang.");
        } else if (data.startsWith("ema:test:")) {
          const id = data.slice("ema:test:".length);
          await testMailbox(id);
          await ctx.reply("✅ IMAP terhubung. Credential tetap terenkripsi.");
        } else if (data.startsWith("ema:disable:")) {
          await disableMailbox(data.slice("ema:disable:".length));
          await ctx.reply("Mailbox dinonaktifkan. Usage history tetap disimpan.");
        } else if (data.startsWith("ema:remove:")) {
          await removeMailboxIfSafe(data.slice("ema:remove:".length));
          await ctx.reply("Mailbox dihapus karena tidak punya rental atau usage history.");
        } else if (data === "ema:services") {
          const services = await EmailOtpService.find().sort({ name: 1 }).lean();
          const kb = new InlineKeyboard().text("➕ Tambah service", "ema:addservice").row();
          for (const service of services) kb.text(service.icon + " " + service.name + (service.enabled ? " ✅" : " 🔴"), "ema:service:" + String(service._id)).row();
          kb.text("🔙 Menu", "ema:home");
          await ctx.reply("🎯 OTP Service\n" + (services.map((item) => item.code + " · " + item.rentalDurationMinutes + " menit · " + item.senderPatterns.length + " sender matcher").join("\n") || "Belum ada service."), { reply_markup: kb });
        } else if (data === "ema:addservice" || data.startsWith("ema:editservice:")) {
          const id = data === "ema:addservice" ? undefined : data.slice("ema:editservice:".length);
          inputs.set(stateKey(ctx), { kind: "service", ...(id ? { id } : {}) });
          await ctx.reply("Kirim:\nCODE|Nama|Ikon|Durasi menit|Cooldown menit|sender regex (;)|subject regex (;)|OTP regex (;) |magic link true/false|verification link true/false\nContoh: DISCORD|Discord|🎮|20|5|discord.com|verification;verify|\\b(code|OTP)\\D{0,8}(\\d{6})|false|true");
        } else if (data.startsWith("ema:service:")) {
          const id = data.slice("ema:service:".length);
          const service = await EmailOtpService.findById(id).lean();
          if (!service) throw new Error("Service tidak ditemukan.");
          await ctx.reply(service.name + " · " + service.code + "\nDurasi " + service.rentalDurationMinutes + " menit · Cooldown " + service.cooldownMinutes + " menit", {
            reply_markup: new InlineKeyboard().text("✏️ Edit", "ema:editservice:" + id).text(service.enabled ? "🔴 Nonaktif" : "🟢 Aktif", "ema:toggle-service:" + id).row().text("🔙 Service", "ema:services"),
          });
        } else if (data.startsWith("ema:toggle-service:")) {
          await toggleService(data.slice("ema:toggle-service:".length));
          await ctx.reply("Status service diperbarui.");
        } else if (data === "ema:domains") {
          const domains = await EmailDomain.find().sort({ domain: 1 }).lean();
          const kb = new InlineKeyboard().text("➕ Tambah domain", "ema:adddomain").row();
          for (const item of domains) kb.text("🌐 " + item.domain + (item.sellable ? " ✅" : " 🔴"), "ema:domain:" + String(item._id)).row();
          kb.text("🔙 Menu", "ema:home");
          await ctx.reply("🌐 Domain Email Routing\n" + (domains.map((item) => item.domain + " · " + (item.sellable ? "Dijual" : "Disembunyikan") + (item.enabled ? "" : " · Nonaktif")).join("\n") || "Belum ada domain.") +
            "\n\nDomain harus sudah tercantum di /cf, dan collector harus mailbox IMAP yang tersedia.", { reply_markup: kb });
        } else if (data === "ema:adddomain" || data.startsWith("ema:editdomain:")) {
          const id = data === "ema:adddomain" ? undefined : data.slice("ema:editdomain:".length);
          inputs.set(stateKey(ctx), { kind: "domain", ...(id ? { id } : {}) });
          await ctx.reply("Kirim: domain|zoneId|collectorEmail|sellable true/false\nZone harus ada di konfigurasi Cloudflare /cf.");
        } else if (data.startsWith("ema:domain:")) {
          const id = data.slice("ema:domain:".length);
          const domain = await EmailDomain.findById(id).lean();
          if (!domain) throw new Error("Domain tidak ditemukan.");
          await ctx.reply("🌐 " + domain.domain + "\nStatus: " + (domain.enabled ? "Aktif" : "Nonaktif") + " · Catalog: " + (domain.sellable ? "Dijual" : "Disembunyikan"), {
            reply_markup: new InlineKeyboard().text("✏️ Edit", "ema:editdomain:" + id).text(domain.enabled ? "🔴 Nonaktif" : "🟢 Aktif", "ema:toggledomain:" + id).row()
              .text("🔙 Domain", "ema:domains"),
          });
        } else if (data.startsWith("ema:toggledomain:")) {
          const domain = await EmailDomain.findById(data.slice("ema:toggledomain:".length));
          if (!domain) throw new Error("Domain tidak ditemukan.");
          domain.enabled = !domain.enabled;
          await domain.save();
          await ctx.reply("Status domain diperbarui. Rental yang sedang berjalan tetap terisolasi pada aliasnya.");
        } else if (data === "ema:prices") {
          const prices = await EmailRentalPrice.find({ enabled: true }).sort({ serviceId: 1 }).limit(100).lean();
          const lines: string[] = [];
          for (const price of prices) {
            const global = price.serviceId === GLOBAL_EMAIL_SERVICE_ID;
            const service = global ? null : await EmailOtpService.findById(price.serviceId).select("name").lean();
            const provider = price.providerId ? await EmailProvider.findById(price.providerId).select("name").lean() : null;
            lines.push((global ? "Semua Service" : service?.name ?? "Service") + " + " + (provider?.name ?? "Domain") + " · Rp" + price.price.toLocaleString("id-ID"));
          }
          await ctx.reply("💰 Harga\n" + (lines.join("\n") || "Belum ada harga.") +
            "\n\nHarga khusus service selalu mengalahkan harga global provider.", {
              reply_markup: new InlineKeyboard().text("🌐 Harga Global Provider", "ema:setglobalprice").row()
                .text("🎯 Harga per Service", "ema:setprice").row().text("🔙 Menu", "ema:home"),
            });
        } else if (data === "ema:setglobalprice") {
          inputs.set(stateKey(ctx), { kind: "global_price" });
          await ctx.reply("Kirim providerCode|price\nContoh: GMAIL|2000\n\nHarga ini otomatis berlaku untuk semua service yang belum punya harga khusus.");
        } else if (data === "ema:setprice") {
          inputs.set(stateKey(ctx), { kind: "price" });
          await ctx.reply("Format harga khusus service:\nDISCORD|MAILBOX|GMAIL|2500\nDISCORD|DOMAIN_ALIAS|-|1000\n\nHarga khusus ini mengalahkan harga global provider.");
        } else if (data === "ema:active") {
          const rentals = await EmailRental.find({ status: { $in: ["ACTIVE", "WAITING_PAYMENT", "PROCESSING"] } }).sort({ createdAt: -1 }).limit(50).lean();
          await ctx.reply("📊 Rental Aktif\n" + (rentals.map((rental) => rental.serviceSnapshot.name + " · " + rental.emailAddress + " · " + rental.status + " · " + rental.userId.slice(-4)).join("\n") || "Tidak ada rental aktif."));
        } else if (data === "ema:usage") {
          const uses = await EmailUsage.find().sort({ usedAt: -1 }).limit(30).lean();
          const lines: string[] = [];
          for (const usage of uses) {
            const service = await EmailOtpService.findById(usage.serviceId).select("name").lean();
            lines.push(usage.emailResourceId + " + " + (service?.name ?? "service") + " · " + usage.usedAt.toLocaleDateString("id-ID"));
          }
          await ctx.reply("📜 Usage History (permanen)\n" + (lines.join("\n") || "Belum ada usage."));
        } else if (data === "ema:testbulk") {
          const settings = await EmailRentalSettings.findOne().lean();
          const limit = Math.min(100, Math.max(1, settings?.maxConcurrentConnections ?? 5));
          const mailboxes = await EmailMailbox.find({ enabled: true, status: { $ne: "DISABLED" } }).sort({ lastCheckedAt: 1 }).select("_id email").lean();
          let next = 0, passed = 0, failed = 0;
          const workers = Array.from({ length: Math.min(limit, mailboxes.length) }, async () => {
            while (next < mailboxes.length) {
              const item = mailboxes[next++];
              if (!item) return;
              try { await testMailbox(String(item._id)); passed++; }
              catch { failed++; }
            }
          });
          await Promise.all(workers);
          await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: failed ? "health_failed" : "health_ok", userId: String(ctx.from.id) });
          await ctx.reply("🧪 Health check selesai\n✅ " + passed + " connected\n❌ " + failed + " gagal\nBatas koneksi: " + limit);
        } else if (data === "ema:settings") {
          const settings = await EmailRentalSettings.findOne().lean();
          inputs.set(stateKey(ctx), { kind: "settings" });
          await ctx.reply("Pengaturan saat ini:\nmaxConcurrentEmailRentalsPerUser=" + (settings?.maxConcurrentEmailRentalsPerUser ?? 3) +
            "\nreservationMinutes=" + (settings?.reservationMinutes ?? 10) + "\nmessageGraceMinutes=" + (settings?.messageGraceMinutes ?? 5) +
            "\naliasGraceMinutes=" + (settings?.aliasGraceMinutes ?? 15) + "\nmaxConcurrentConnections=" + (settings?.maxConcurrentConnections ?? 5) +
            "\npollIntervalSeconds=" + (settings?.pollIntervalSeconds ?? 15) +
            "\n\nKirim: maxConcurrent|reservationMinutes|messageGrace|aliasGrace|maxConnections|pollSeconds");
        } else {
          await ctx.reply("Menu email admin tidak dikenali. Gunakan /emailadmin.");
        }
      } catch (error) { await ctx.reply(errorText(error)); }
    });
  },
};
export default adminPlugin;
