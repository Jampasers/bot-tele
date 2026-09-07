import { Bot, Context, InlineKeyboard } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import { TenantMap } from "../../tenant/TenantMap.js";
import { isAdmin } from "../../core/admin.js";
import { BotConfig, type IBotConfig } from "../../models/BotConfig.js";
import { getTenantContext } from "../../tenant/context.js";
import { hasFeature } from "../../tenant/features.js";
import { getTenantPaymentSummary, saveTenantPaymentConfig } from "../../payments/tenantPayment.service.js";
import { validateTenantQrisImage, validateTenantQrisPayload } from "../../payments/paymentConfigValidation.js";
import { readQrCodeImage } from "../../services/payment/qr-reader.js";
import { restartCurrentRental } from "../../rental/rental.service.js";
import { DigitalProductService } from "../../services/digitalProduct.js";
import { User } from "../../models/User.js";
import { ForceSubService } from "../../services/forceSub.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { TestimonialService } from "../../services/testimonial.js";
import { clearMaintenanceCache } from "../../middlewares/maintenance.js";
import { buildRentalAdminHelpText } from "../adminHelp.js";

type Handler = (ctx: Context) => Promise<void>;
const PAYMENT_SETUP_TTL_MS = 15 * 60_000;
const MAX_QRIS_IMAGE_BYTES = 5_000_000;

interface PaymentSetupState {
  step: "qris_image" | "merchant_id" | "email" | "password";
  expiresAt: number;
  qrisPayload?: string;
  merchantId?: string;
  email?: string;
}

interface PaymentSetupInput {
  qris: { enabled: true; payload: string };
  gopayMerchant: {
    enabled: true;
    merchantId: string;
    email: string;
    password: string;
  };
}

export interface RentalAdminDependencies {
  getPaymentSummary: typeof getTenantPaymentSummary;
  savePayment: typeof saveTenantPaymentConfig;
  readQrisPayload(buffer: Buffer): Promise<string>;
  downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer>;
  now(): number;
}

async function downloadTelegramFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path || !/^[A-Za-z0-9_./-]+$/.test(file.file_path)) {
    throw new Error("File QRIS Telegram tidak valid.");
  }
  const response = await fetch(`https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Gambar QRIS gagal diunduh dari Telegram.");
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_QRIS_IMAGE_BYTES) throw new Error("Gambar QRIS terlalu besar.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1 || buffer.length > MAX_QRIS_IMAGE_BYTES) throw new Error("Gambar QRIS terlalu besar.");
  return buffer;
}

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

export function createRentalAdminPlugin(
  overrides: Partial<RentalAdminDependencies> = {},
): Plugin {
  const dependencies: RentalAdminDependencies = {
    getPaymentSummary: getTenantPaymentSummary,
    savePayment: saveTenantPaymentConfig,
    readQrisPayload: readQrCodeImage,
    downloadTelegramFile,
    now: Date.now,
    ...overrides,
  };
  const paymentSetupState = new TenantMap<string, PaymentSetupState>();

  function getPaymentState(adminId: string): PaymentSetupState | undefined {
    const state = paymentSetupState.get(adminId);
    if (state && state.expiresAt <= dependencies.now()) {
      paymentSetupState.delete(adminId);
      return undefined;
    }
    return state;
  }

  async function deletePaymentInput(ctx: Context, adminId: string): Promise<boolean> {
    try {
      await ctx.deleteMessage();
      return true;
    } catch {
      paymentSetupState.delete(adminId);
      await ctx.reply(
        "Pesan data payment tidak berhasil dihapus. Hapus pesannya secara manual, lalu mulai lagi dengan /setpayment.",
      );
      return false;
    }
  }

  async function showPayment(ctx: Context): Promise<void> {
    const summary = await dependencies.getPaymentSummary();
    await ctx.reply(
      `💳 Payment Toko\n\nKonfigurasi: ${summary.configured ? "tersimpan" : "belum tersedia"}\nQRIS: ${summary.qrisEnabled ? "aktif" : "nonaktif"}\nGoPay Merchant: ${summary.gopayEnabled ? "aktif" : "nonaktif"}\n\nPembayaran customer masuk ke merchant toko ini. Pembayaran /renew selalu masuk ke platform.\n\nKetik /setpayment untuk mengatur payment melalui panduan langkah demi langkah. Siapkan foto QRIS, Merchant ID, email, dan password GoBiz.\n\nKonfigurasi ini mengganti seluruh payment toko. Tunggu invoice customer yang aktif selesai sebelum mengganti merchant.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🧭 Mulai Setup Payment", "radmin_setpayment")
          .row()
          .text("🔙 Pengaturan Bot", "radmin_home"),
      },
    );
  }

  async function startPaymentSetup(ctx: Context): Promise<void> {
    const adminId = String(ctx.from!.id);
    const text = ctx.message?.text ?? "";
    const trailingInput = text.replace(/^\/setpayment(?:@[A-Za-z0-9_]+)?\s*/i, "").trim();
    if (trailingInput && !(await deletePaymentInput(ctx, adminId))) return;
    paymentSetupState.set(adminId, {
      step: "qris_image",
      expiresAt: dependencies.now() + PAYMENT_SETUP_TTL_MS,
    });
    await ctx.reply(
      "💳 Pengaturan Payment (1/4)\n\nKirim foto atau file PNG/JPEG QRIS statis milik toko. Pastikan QR terlihat jelas dan tidak terpotong.\n\nKetik /batal untuk membatalkan.",
    );
  }

  async function handlePaymentImage(ctx: Context): Promise<void> {
    if (!ctx.from) return;
    const adminId = String(ctx.from.id);
    const state = getPaymentState(adminId);
    if (!state) return;
    if (state.step !== "qris_image") {
      await ctx.reply("Lanjutkan langkah yang sedang diminta dalam bentuk teks.");
      return;
    }
    const photo = ctx.message?.photo?.at(-1);
    const document = ctx.message?.document;
    const validDocument = document && ["image/png", "image/jpeg"].includes(document.mime_type ?? "");
    const file = photo ?? (validDocument ? document : undefined);
    if (!file) {
      await ctx.reply("Kirim QRIS sebagai foto atau file PNG/JPEG.");
      return;
    }
    if (!(await deletePaymentInput(ctx, adminId))) return;
    if ((file.file_size ?? 0) > MAX_QRIS_IMAGE_BYTES) {
      await ctx.reply("Gambar QRIS terlalu besar. Maksimal 5 MB; kirim gambar yang lebih kecil.");
      return;
    }
    try {
      const buffer = await dependencies.downloadTelegramFile(ctx, file.file_id);
      if (buffer.length > MAX_QRIS_IMAGE_BYTES) throw new Error("Gambar QRIS terlalu besar.");
      validateTenantQrisImage(buffer);
      const qrisPayload = await dependencies.readQrisPayload(buffer);
      validateTenantQrisPayload(qrisPayload);
      paymentSetupState.set(adminId, {
        step: "merchant_id",
        expiresAt: dependencies.now() + PAYMENT_SETUP_TTL_MS,
        qrisPayload,
      });
      await ctx.reply(
        "✅ QRIS berhasil dibaca.\n\nPengaturan Payment (2/4)\nKirim Merchant ID GoPay/GoBiz toko.",
      );
    } catch {
      console.warn(`[Rental:${getTenantContext().rentalId}] QRIS setup image could not be read`);
      await ctx.reply(
        "QRIS tidak berhasil dibaca. Kirim ulang gambar PNG/JPEG yang jelas, tidak terpotong, dan berisi QRIS statis yang valid.",
      );
    }
  }

  async function handlePaymentText(ctx: Context, next: () => Promise<void>): Promise<void> {
    if (!ctx.from) return next();
    const adminId = String(ctx.from.id);
    const state = getPaymentState(adminId);
    if (!state) return next();
    const rawInput = ctx.message?.text ?? "";
    const trimmedInput = rawInput.trim();
    if (/^\/(?:batal|cancel)(?:@[A-Za-z0-9_]+)?$/i.test(trimmedInput)) {
      paymentSetupState.delete(adminId);
      await ctx.reply("Pengaturan payment dibatalkan.", { reply_markup: homeKeyboard() });
      return;
    }
    if (trimmedInput.startsWith("/") && state.step !== "password") {
      paymentSetupState.delete(adminId);
      return next();
    }
    if (state.step === "qris_image") {
      await ctx.reply("Kirim QRIS sebagai foto atau file PNG/JPEG, bukan teks.");
      return;
    }
    if (!(await deletePaymentInput(ctx, adminId))) return;
    const input = state.step === "password" ? rawInput : trimmedInput;

    if (state.step === "merchant_id") {
      if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(input)) {
        await ctx.reply("Merchant ID tidak valid. Kirim ulang Merchant ID GoPay/GoBiz toko.");
        return;
      }
      paymentSetupState.set(adminId, {
        ...state,
        step: "email",
        merchantId: input,
        expiresAt: dependencies.now() + PAYMENT_SETUP_TTL_MS,
      });
      await ctx.reply("Pengaturan Payment (3/4)\nKirim email akun GoBiz toko.");
      return;
    }

    if (state.step === "email") {
      if (input.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
        await ctx.reply("Format email tidak valid. Kirim ulang email akun GoBiz toko.");
        return;
      }
      paymentSetupState.set(adminId, {
        ...state,
        step: "password",
        email: input,
        expiresAt: dependencies.now() + PAYMENT_SETUP_TTL_MS,
      });
      await ctx.reply("Pengaturan Payment (4/4)\nKirim password akun GoBiz toko.");
      return;
    }

    if (!input || input.length > 4096 || !state.qrisPayload || !state.merchantId || !state.email) {
      paymentSetupState.delete(adminId);
      await ctx.reply("Data payment tidak lengkap. Mulai kembali dengan /setpayment.");
      return;
    }
    const paymentInput: PaymentSetupInput = {
      qris: { enabled: true, payload: state.qrisPayload },
      gopayMerchant: {
        enabled: true,
        merchantId: state.merchantId,
        email: state.email,
        password: input,
      },
    };
    paymentSetupState.delete(adminId);
    try {
      await dependencies.savePayment(adminId, paymentInput);
      await ctx.reply(
        "✅ Konfigurasi payment toko berhasil disimpan. QRIS dan credential merchant sudah dienkripsi.",
        { reply_markup: homeKeyboard() },
      );
    } catch {
      console.warn(`[Rental:${getTenantContext().rentalId}] Payment setup wizard save failed`);
      await ctx.reply(
        "Konfigurasi payment belum dapat disimpan. Pastikan tidak ada invoice aktif, lalu mulai lagi dengan /setpayment.",
        { reply_markup: homeKeyboard() },
      );
    }
  }

  const plugin: Plugin = {
    name: "rentaladmin", version: "1.1.0", rentalOnly: true,
    commands: [
    { command: "admin", description: "[Admin] Pengaturan bot dan toko" },
    { command: "settings", description: "[Admin] Pengaturan bot rental" },
    { command: "payment", description: "[Admin] Konfigurasi pembayaran toko" },
    { command: "setpayment", description: "[Admin] Panduan konfigurasi payment" },
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
    bot.command("setpayment", authorized(startPaymentSetup));
    bot.callbackQuery("radmin_setpayment", authorized(startPaymentSetup));
    bot.on(["message:photo", "message:document"], async (ctx, next) => {
      const adminId = ctx.from ? String(ctx.from.id) : "";
      if (!adminId || !getPaymentState(adminId)) return next();
      await authorized(handlePaymentImage)(ctx);
    });
    bot.on("message:text", async (ctx, next) => {
      const adminId = ctx.from ? String(ctx.from.id) : "";
      if (!adminId || !getPaymentState(adminId)) return next();
      await authorized(innerCtx => handlePaymentText(innerCtx, next))(ctx);
    });
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
  return plugin;
}

export default createRentalAdminPlugin();
