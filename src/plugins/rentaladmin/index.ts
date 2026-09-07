import { Bot, Context, InlineKeyboard } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { isAdmin } from "../../core/admin.js";
import { BotConfig, type IBotConfig } from "../../models/BotConfig.js";
import { getTenantContext } from "../../tenant/context.js";
import { hasFeature } from "../../tenant/features.js";
import { getTenantPaymentSummary, saveTenantPaymentConfig } from "../../payments/tenantPayment.service.js";
import { restartCurrentRental } from "../../rental/rental.service.js";
import { DigitalProductService } from "../../services/digitalProduct.js";
import { User } from "../../models/User.js";
import { ForceSubService } from "../../services/forceSub.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { TestimonialService } from "../../services/testimonial.js";
import { clearMaintenanceCache } from "../../middlewares/maintenance.js";
import { buildRentalAdminHelpText } from "../adminHelp.js";

type Handler = (ctx: Context) => Promise<void>;
const price = (amount: number): string => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount);

function homeKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("⚙️ Pengaturan Bot", "radmin_settings").text("💳 Payment", "radmin_payment").row();
  if (hasFeature("digital")) keyboard.text("📦 Produk & Stok", "dga_home").row();
  return keyboard.text("📊 Statistik", "radmin_stats").text("🧩 Fitur", "radmin_features").row()
    .text("📅 Masa Aktif", "rental_renew").text("🔄 Restart", "radmin_restart").row()
    .text("📚 Panduan Admin Lengkap", "radmin_help");
}

/** Every command and callback re-checks the numeric tenant owner/admin identity. */
function authorized(handler: Handler): Handler {
  return async (ctx) => {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    if (!getTenantContext().rentalId || !isAdmin(ctx) || ctx.chat?.type !== "private") {
      if (ctx.chat) await ctx.reply("Hanya owner/admin rental melalui chat pribadi.");
      return;
    }
    try { await handler(ctx); }
    catch {
      console.warn(`[Rental:${getTenantContext().rentalId}] [Tenant:${getTenantContext().tenantId}] Admin action failed`);
      await ctx.reply("Pengaturan belum dapat diproses. Periksa input dan coba kembali.", { reply_markup: homeKeyboard() });
    }
  };
}

async function showHome(ctx: Context): Promise<void> {
  await ctx.reply("⚙️ Pengaturan Bot\n\nKelola toko, pembayaran customer, produk, statistik, dan masa aktif bot.", { reply_markup: homeKeyboard() });
}

async function showPayment(ctx: Context): Promise<void> {
  const summary = await getTenantPaymentSummary();
  await ctx.reply(`💳 Payment Toko\n\nKonfigurasi: ${summary.configured ? "tersimpan" : "belum tersedia"}\nQRIS: ${summary.qrisEnabled ? "aktif" : "nonaktif"}\nGoPay Merchant: ${summary.gopayEnabled ? "aktif" : "nonaktif"}\n\nPembayaran customer masuk ke merchant toko ini. Pembayaran /renew selalu masuk ke platform.\n\nUntuk mengganti konfigurasi, kirim satu pesan:\n/setpayment {"qris":{"enabled":true,"payload":"PAYLOAD_QRIS"},"gopayMerchant":{"enabled":true,"merchantId":"ID_MERCHANT","email":"EMAIL","password":"PASSWORD"}}\n\nKonfigurasi ini mengganti seluruh payment toko. Pesan credential dihapus sebelum disimpan. Tunggu invoice customer yang aktif selesai sebelum mengganti merchant.`, { reply_markup: homeKeyboard() });
}

async function showSettings(ctx: Context): Promise<void> {
  const config = await BotConfig.getOrCreate();
  const toggle = (value: boolean): string => value ? "aktif" : "nonaktif";
  await ctx.reply(`⚙️ Pengaturan Toko\n\nMaintenance: ${toggle(config.isMaintenance)}\nWajib join: ${toggle(config.forceSubEnabled)}\nTestimoni: ${toggle(config.testimonialEnabled)}\nLog aktivitas: ${toggle(config.logChannelEnabled)}\nAfiliasi: ${toggle(config.affiliateEnabled)}\n\nAtur nilai melalui /setshop <field> <nilai>.\nField yang tersedia: forceSubChannel, forceSubLink, forceSubName, testimonialChannel, testimonialLink, logChannel, logChannelLink, maintenanceMessage.\n\nKomisi afiliasi: /setaffiliate percentage 5 atau /setaffiliate fixed 1000`, {
    reply_markup: new InlineKeyboard().text("🔧 Maintenance", "radmin_toggle_isMaintenance").row()
      .text("📢 Wajib Join", "radmin_toggle_forceSubEnabled").text("🧾 Testimoni", "radmin_toggle_testimonialEnabled").row()
      .text("📝 Log Aktivitas", "radmin_toggle_logChannelEnabled").text("👥 Afiliasi", "radmin_toggle_affiliateEnabled").row()
      .text("🔙 Pengaturan Bot", "radmin_home"),
  });
}

async function updateSettings(updates: Partial<IBotConfig>): Promise<void> {
  // Refresh the affected service's own tenant cache together with its configuration.
  if (Object.keys(updates).some(key => key.startsWith("forceSub"))) await ForceSubService.updateConfig(updates);
  else if (Object.keys(updates).some(key => key.startsWith("testimonial"))) await TestimonialService.updateConfig(updates);
  else if (Object.keys(updates).some(key => key.startsWith("logChannel"))) await ActivityLogService.updateConfig(updates);
  else {
    const config = await BotConfig.getOrCreate();
    Object.assign(config, updates);
    await config.save();
  }
  clearMaintenanceCache();
}

const STRING_SETTINGS = new Set(["forceSubChannel", "forceSubLink", "forceSubName", "testimonialChannel", "testimonialLink", "logChannel", "logChannelLink", "maintenanceMessage"]);
const BOOLEAN_SETTINGS = new Set(["isMaintenance", "forceSubEnabled", "testimonialEnabled", "logChannelEnabled", "affiliateEnabled"]);

/** Restrict config writes to storefront settings, never internal/global credential fields. */
export function parseShopSetting(input: string): Partial<IBotConfig> {
  const match = /^(\w+)\s+([\s\S]+)$/.exec(input.trim());
  if (!match || !STRING_SETTINGS.has(match[1]!)) throw new Error("Field pengaturan tidak valid.");
  const field = match[1]!;
  const value = match[2]!.trim();
  if (!value || value.length > (field === "maintenanceMessage" ? 1500 : 256)) throw new Error("Nilai pengaturan tidak valid.");
  if (field.endsWith("Channel") && !/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100\d{5,16})$/.test(value)) throw new Error("Gunakan username atau ID channel Telegram.");
  if (field.endsWith("Link") && !/^https:\/\/t\.me\/[A-Za-z0-9_+/-]+$/.test(value)) throw new Error("Gunakan link Telegram https://t.me/.");
  // Existing maintenance renderer uses HTML; store supplied free text escaped.
  const safeValue = field === "maintenanceMessage" ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : value;
  return { [field]: safeValue };
}

const rentalAdminPlugin: Plugin = {
  name: "rentaladmin", version: "1.0.0", rentalOnly: true,
  commands: [
    { command: "admin", description: "[Admin] Pengaturan bot dan toko" },
    { command: "settings", description: "[Admin] Pengaturan bot rental" },
    { command: "payment", description: "[Admin] Konfigurasi pembayaran toko" },
    { command: "setpayment", description: "[Admin] Simpan konfigurasi payment JSON" },
    { command: "setshop", description: "[Admin] Atur field konfigurasi toko" },
    { command: "setaffiliate", description: "[Admin] Atur komisi afiliasi" },
    { command: "stats", description: "[Admin] Statistik toko" },
    { command: "restart", description: "[Admin] Restart bot rental ini" },
  ],
  register(bot: Bot<Context>): void {
    bot.command(["admin", "settings"], authorized(showHome));
    bot.callbackQuery(["radmin_home", "adm_home"], authorized(showHome));
    bot.callbackQuery("radmin_settings", authorized(showSettings));
    bot.command("payment", authorized(showPayment));
    bot.callbackQuery("radmin_payment", authorized(showPayment));
    bot.command("setpayment", authorized(async ctx => {
      const text = ctx.message?.text ?? "";
      const json = text.replace(/^\/setpayment(?:@[A-Za-z0-9_]+)?\s*/i, "");
      if (!json || json.length > 32_000) { await ctx.reply("Gunakan /payment untuk format konfigurasi."); return; }
      // Do not persist credentials if Telegram could not remove the input message.
      try { await ctx.deleteMessage(); }
      catch { await ctx.reply("Pesan credential belum berhasil dihapus. Hapus pesan tersebut dan coba kembali melalui chat pribadi."); return; }
      await saveTenantPaymentConfig(String(ctx.from!.id), JSON.parse(json) as unknown);
      await ctx.reply("✅ Konfigurasi payment toko tersimpan dengan credential terenkripsi.", { reply_markup: homeKeyboard() });
    }));
    bot.command("setshop", authorized(async ctx => {
      const input = (ctx.message?.text ?? "").replace(/^\/setshop(?:@[A-Za-z0-9_]+)?\s*/i, "");
      await updateSettings(parseShopSetting(input));
      await ctx.reply("✅ Pengaturan toko diperbarui.", { reply_markup: homeKeyboard() });
    }));
    bot.command("setaffiliate", authorized(async ctx => {
      if (!hasFeature("affiliate")) { await ctx.reply("Paket ini belum menyediakan fitur afiliasi."); return; }
      const input = (ctx.message?.text ?? "").replace(/^\/setaffiliate(?:@[A-Za-z0-9_]+)?\s*/i, "");
      const match = /^(fixed|percentage)\s+(\d+(?:\.\d{1,2})?)$/.exec(input);
      if (!match) throw new Error("Format komisi tidak valid.");
      const type = match[1] as "fixed" | "percentage";
      const value = Number(match[2]);
      if (value > (type === "percentage" ? 100 : 1_000_000) || (type === "fixed" && !Number.isInteger(value))) throw new Error("Komisi tidak valid.");
      await updateSettings({ affiliateCommissionType: type, affiliateCommissionValue: value });
      await ctx.reply("✅ Komisi afiliasi diperbarui.", { reply_markup: homeKeyboard() });
    }));
    bot.callbackQuery(/^radmin_toggle_(\w+)$/, authorized(async ctx => {
      const field = ctx.callbackQuery!.data!.slice("radmin_toggle_".length);
      if (!BOOLEAN_SETTINGS.has(field)) return;
      if (field === "affiliateEnabled" && !hasFeature("affiliate")) { await ctx.reply("Paket ini belum menyediakan fitur afiliasi."); return; }
      const config = await BotConfig.getOrCreate();
      const current = Boolean(config.get(field));
      if (!current) {
        const channel = field === "forceSubEnabled" ? config.forceSubChannel : field === "testimonialEnabled" ? config.testimonialChannel : field === "logChannelEnabled" ? config.logChannel : undefined;
        if (channel !== undefined && !channel) { await ctx.reply("Atur channel tujuan melalui /setshop sebelum mengaktifkan fitur."); return; }
      }
      await updateSettings({ [field]: !current });
      await showSettings(ctx);
    }));
    bot.callbackQuery("radmin_features", authorized(async ctx => {
      const features = getTenantContext().enabledFeatures ?? [];
      await ctx.reply(`🧩 Fitur Paket\n\n${features.length ? features.join("\n") : "Belum ada fitur toko aktif."}\n\nUbah paket melalui /renew.`, { reply_markup: homeKeyboard() });
    }));
    bot.callbackQuery("radmin_help", authorized(async ctx => {
      await ctx.reply(buildRentalAdminHelpText(), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔙 Pengaturan Bot", "radmin_home"),
      });
    }));
    const stats = authorized(async ctx => {
      const [digital, users] = await Promise.all([DigitalProductService.getPlatformStats(), User.countDocuments()]);
      await ctx.reply(`📊 Statistik Toko\n\nPengguna: ${users}\nProduk: ${digital.totalProducts}\nProduk aktif: ${digital.activeProducts}\nStok tersedia: ${digital.totalStockAvailable}\nStok terjual: ${digital.totalStockSold}\nPendapatan produk: ${price(digital.totalRevenue)}`, { reply_markup: homeKeyboard() });
    });
    bot.command("stats", stats);
    bot.callbackQuery("radmin_stats", stats);
    const restart = authorized(async ctx => {
      const rentalId = getTenantContext().rentalId!;
      await ctx.reply("🔄 Bot sedang direstart. Gunakan /start beberapa saat lagi.");
      // Finish this update first: runner.stop() waits for active handlers to drain.
      setImmediate(() => { void restartCurrentRental(rentalId).catch(() => console.warn(`[Rental:${rentalId}] Admin restart failed`)); });
    });
    bot.command("restart", restart);
    bot.callbackQuery("radmin_restart", restart);
  },
};

export default rentalAdminPlugin;
