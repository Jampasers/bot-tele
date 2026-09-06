import { getTenantId, PLATFORM_TENANT_ID, tenantEnvironment } from "../tenant/context.js";
import { tenantPlugin } from "../tenant/tenantPlugin.js";
import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export interface IBotConfig extends Document {
  tenantId: string;
  /** Apakah fitur wajib join channel diaktifkan */
  forceSubEnabled: boolean;

  /** Username atau ID channel Telegram (contoh: @namachannel atau -1001234567890) */
  forceSubChannel: string;

  /** Link invite atau link tautan publik channel (contoh: https://t.me/namachannel) */
  forceSubLink: string;

  /** Nama tampilan channel (contoh: Official Channel) */
  forceSubName: string;

  /** Apakah pengiriman testimoni transaksi otomatis ke channel diaktifkan */
  testimonialEnabled: boolean;

  /** Username atau ID channel testimoni (contoh: @testimoni_store atau -1001234567890) */
  testimonialChannel: string;

  /** Link invite atau link tautan publik channel testimoni */
  testimonialLink: string;

  /** Apakah pengiriman audit / activity log otomatis ke channel diaktifkan */
  logChannelEnabled: boolean;

  /** Username atau ID channel log aktivitas (contoh: @bot_logs atau -1001234567890) */
  logChannel: string;

  /** Link invite atau tautan publik channel log aktivitas */
  logChannelLink: string;

  // ── Security & Anti-Fraud Alert ─────────────────────────────────────────────

  /** Apakah notifikasi security alert diaktifkan */
  securityAlertChannelEnabled: boolean;

  /** Username atau ID channel security alert (contoh: @bot_security atau -1001234567890) */
  securityAlertChannel: string;

  /** Link invite channel security alert */
  securityAlertChannelLink: string;

  /** Batas maksimum klaim garansi dalam 24 jam sebelum auto-flag (default: 3) */
  maxWarrantyClaimsPerDay: number;

  /** Batas rasio klaim terhadap total pesanan dalam persen (default: 50) */
  maxWarrantyClaimRatioPercent: number;

  /** Batas kegagalan input promo sebelum diblokir (default: 5) */
  maxPromoFailedAttempts: number;

  /** Durasi blokir promo dalam menit (default: 60) */
  promoBlockDurationMinutes: number;

  /** Batas kecepatan aksi per detik per user (default: 5) */
  velocityMaxActionsPerSecond: number;

  // ── Maintenance Mode ────────────────────────────────────────────────────────

  /** Apakah bot sedang dalam mode maintenance (semua non-admin diblokir) */
  isMaintenance: boolean;

  /** Pesan banner yang ditampilkan saat maintenance */
  maintenanceMessage: string;

  // ── Affiliate / Referral System ─────────────────────────────────────────────

  /** Apakah sistem referral/afiliasi diaktifkan */
  affiliateEnabled: boolean;

  /** Tipe komisi afiliasi: "fixed" (flat IDR) atau "percentage" */
  affiliateCommissionType: "fixed" | "percentage";

  /** Nilai komisi: jumlah flat IDR atau persentase (0-100) */
  affiliateCommissionValue: number;

  // ── OTP Forwarder Channels (PayPal & Netflix) & IMAP Config ─────────────────

  /** Apakah pengiriman OTP PayPal dari IMAP ke channel diaktifkan */
  otpChannelEnabled: boolean;

  /** Username atau ID channel penerusan OTP PayPal (contoh: @channel_otp atau -1001234567890) */
  otpChannel: string;

  /** Link invite atau link tautan channel penerusan OTP PayPal */
  otpChannelLink: string;

  /** Apakah pengiriman OTP Netflix dari IMAP ke channel diaktifkan */
  otpNetflixChannelEnabled: boolean;

  /** Username atau ID channel penerusan OTP Netflix (contoh: @netflix_otp atau -1001234567890) */
  otpNetflixChannel: string;

  /** Link invite atau link tautan channel penerusan OTP Netflix */
  otpNetflixChannelLink: string;

  /** Apakah pengiriman OTP Discord dari IMAP ke channel diaktifkan */
  otpDiscordChannelEnabled: boolean;

  /** Username atau ID channel penerusan OTP Discord (contoh: @discord_otp atau -1001234567890) */
  otpDiscordChannel: string;

  /** Link invite atau link tautan channel penerusan OTP Discord */
  otpDiscordChannelLink: string;

  /** Apakah listener email IMAP diaktifkan */
  imapEnabled: boolean;

  /** Host server IMAP (contoh: imap.gmail.com atau mail.example.com) */
  imapHost: string;

  /** Port server IMAP (contoh: 993) */
  imapPort: number;

  /** Apakah menggunakan TLS/SSL secure connection (default: true) */
  imapSecure: boolean;

  /** Username / email akun IMAP */
  imapUser: string;

  /** Password / App Password akun IMAP */
  imapPass: string;

  /** Folder mailbox IMAP (default: INBOX) */
  imapMailbox: string;

  /** Target email pengirim yang dipantau (default: service@intl.paypal.com) */
  imapTargetSender: string;

  // ── Cloudflare Email Routing ────────────────────────────────────────────────

  /** Cloudflare account email */
  cfEmail: string;

  /** Cloudflare Global API Key or API Token */
  cfApiKey: string;

  /** Default destination email for forwarding */
  cfDestinationEmail: string;

  /** Configured Cloudflare zones */
  cfZones: CloudflareZoneConfig[];

  createdAt: Date;
  updatedAt: Date;
}

export interface CloudflareZoneConfig {
  id: string;
  domain: string;
}

export const DEFAULT_CF_ZONES: readonly CloudflareZoneConfig[] = [
  { id: "79f4b48dab6a3c999f36cedba5ecfc12", domain: "danka.web.id" },
  { id: "2b6e2664dc7cf2bc0597944ca15af9e7", domain: "dstur.my.id" },
  { id: "c41e875d6fba9ff6b6fac72abdd89e52", domain: "hanifhara.biz.id" },
];

// ---------------------------------------------------------------------------
// 2. Mongoose Schema
// ---------------------------------------------------------------------------

const botConfigSchema = new Schema<IBotConfig>(
  {
    forceSubEnabled: {
      type: Boolean,
      default: () => tenantEnvironment().FORCE_SUB_ENABLED !== "false",
    },
    forceSubChannel: {
      type: String,
      default: () => tenantEnvironment().FORCE_SUB_CHANNEL?.trim() || "",
      trim: true,
    },
    forceSubLink: {
      type: String,
      default: () => tenantEnvironment().FORCE_SUB_LINK?.trim() || "",
      trim: true,
    },
    forceSubName: {
      type: String,
      default: () => tenantEnvironment().FORCE_SUB_NAME?.trim() || "Channel Resmi",
      trim: true,
    },
    testimonialEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().TESTIMONIAL_ENABLED === "false") return false;
        const envTesti = tenantEnvironment().TESTIMONIAL_CHANNEL || tenantEnvironment().TESTI_CHANNEL_ID || tenantEnvironment().CHANNEL_TESTIMONI;
        return !!envTesti && envTesti.trim().length > 0;
      },
    },
    testimonialChannel: {
      type: String,
      default: () => (tenantEnvironment().TESTIMONIAL_CHANNEL || tenantEnvironment().TESTI_CHANNEL_ID || tenantEnvironment().CHANNEL_TESTIMONI || "").trim(),
      trim: true,
    },
    testimonialLink: {
      type: String,
      default: () => {
        const envLink = tenantEnvironment().TESTIMONIAL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().TESTIMONIAL_CHANNEL || tenantEnvironment().TESTI_CHANNEL_ID || tenantEnvironment().CHANNEL_TESTIMONI || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    logChannelEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().LOG_CHANNEL_ENABLED === "false") return false;
        const envLog = tenantEnvironment().LOG_CHANNEL || tenantEnvironment().AUDIT_CHANNEL || tenantEnvironment().CHANNEL_LOG;
        return !!envLog && envLog.trim().length > 0;
      },
    },
    logChannel: {
      type: String,
      default: () => (tenantEnvironment().LOG_CHANNEL || tenantEnvironment().AUDIT_CHANNEL || tenantEnvironment().CHANNEL_LOG || "").trim(),
      trim: true,
    },
    logChannelLink: {
      type: String,
      default: () => {
        const envLink = tenantEnvironment().LOG_CHANNEL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().LOG_CHANNEL || tenantEnvironment().AUDIT_CHANNEL || tenantEnvironment().CHANNEL_LOG || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    // ── Security & Anti-Fraud ────────────────────────────────────────────────
    securityAlertChannelEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().SECURITY_ALERT_CHANNEL_ENABLED === "false") return false;
        const envSec = tenantEnvironment().SECURITY_ALERT_CHANNEL || tenantEnvironment().SECURITY_CHANNEL;
        return !!envSec && envSec.trim().length > 0;
      },
    },
    securityAlertChannel: {
      type: String,
      default: () => (tenantEnvironment().SECURITY_ALERT_CHANNEL || tenantEnvironment().SECURITY_CHANNEL || "").trim(),
      trim: true,
    },
    securityAlertChannelLink: {
      type: String,
      default: () => {
        const envLink = tenantEnvironment().SECURITY_ALERT_CHANNEL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().SECURITY_ALERT_CHANNEL || tenantEnvironment().SECURITY_CHANNEL || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    maxWarrantyClaimsPerDay: {
      type: Number,
      default: 3,
      min: 1,
    },
    maxWarrantyClaimRatioPercent: {
      type: Number,
      default: 50,
      min: 1,
      max: 100,
    },
    maxPromoFailedAttempts: {
      type: Number,
      default: 5,
      min: 1,
    },
    promoBlockDurationMinutes: {
      type: Number,
      default: 60,
      min: 1,
    },
    velocityMaxActionsPerSecond: {
      type: Number,
      default: 5,
      min: 1,
    },
    // ── Maintenance Mode ────────────────────────────────────────────────────
    isMaintenance: {
      type: Boolean,
      default: false,
    },
    maintenanceMessage: {
      type: String,
      default: "🔧 <b>Bot Sedang Maintenance</b>\n\nMaaf, bot sedang dalam proses pemeliharaan dan peningkatan sistem.\nSilakan coba lagi beberapa saat kemudian.\n\n<i>Terima kasih atas kesabaran Anda! 🙏</i>",
      trim: true,
    },
    // ── Affiliate / Referral ────────────────────────────────────────────────
    affiliateEnabled: {
      type: Boolean,
      default: false,
    },
    affiliateCommissionType: {
      type: String,
      enum: ["fixed", "percentage"],
      default: "percentage",
    },
    affiliateCommissionValue: {
      type: Number,
      default: 2,
      min: 0,
    },
    // ── OTP Forwarder Channels (PayPal & Netflix) & IMAP Config ────────────
    otpChannelEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().OTP_CHANNEL_ENABLED === "false" || tenantEnvironment().OTP_PAYPAL_CHANNEL_ENABLED === "false") return false;
        const envOtpChan = tenantEnvironment().OTP_PAYPAL_CHANNEL || tenantEnvironment().OTP_CHANNEL || tenantEnvironment().CHANNEL_OTP;
        return !!envOtpChan && envOtpChan.trim().length > 0;
      },
    },
    otpChannel: {
      type: String,
      default: () => (tenantEnvironment().OTP_PAYPAL_CHANNEL || tenantEnvironment().OTP_CHANNEL || tenantEnvironment().CHANNEL_OTP || "").trim(),
      trim: true,
    },
    otpChannelLink: {
      type: String,
      default: () => {
        const envLink = tenantEnvironment().OTP_PAYPAL_CHANNEL_LINK?.trim() || tenantEnvironment().OTP_CHANNEL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().OTP_PAYPAL_CHANNEL || tenantEnvironment().OTP_CHANNEL || tenantEnvironment().CHANNEL_OTP || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    otpNetflixChannelEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().OTP_NETFLIX_CHANNEL_ENABLED === "false" || tenantEnvironment().NETFLIX_OTP_CHANNEL_ENABLED === "false") return false;
        const envNfChan = tenantEnvironment().OTP_NETFLIX_CHANNEL || tenantEnvironment().NETFLIX_OTP_CHANNEL;
        return !!envNfChan && envNfChan.trim().length > 0;
      },
    },
    otpNetflixChannel: {
      type: String,
      default: () => (tenantEnvironment().OTP_NETFLIX_CHANNEL || tenantEnvironment().NETFLIX_OTP_CHANNEL || "").trim(),
      trim: true,
    },
    otpNetflixChannelLink: {
      type: String,
      default: () => {
        const envLink = (tenantEnvironment().OTP_NETFLIX_CHANNEL_LINK || tenantEnvironment().NETFLIX_OTP_CHANNEL_LINK)?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().OTP_NETFLIX_CHANNEL || tenantEnvironment().NETFLIX_OTP_CHANNEL || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    otpDiscordChannelEnabled: {
      type: Boolean,
      default: () => {
        if (tenantEnvironment().OTP_DISCORD_CHANNEL_ENABLED === "false" || tenantEnvironment().DISCORD_OTP_CHANNEL_ENABLED === "false") return false;
        const envDcChan = tenantEnvironment().OTP_DISCORD_CHANNEL || tenantEnvironment().DISCORD_OTP_CHANNEL;
        return !!envDcChan && envDcChan.trim().length > 0;
      },
    },
    otpDiscordChannel: {
      type: String,
      default: () => (tenantEnvironment().OTP_DISCORD_CHANNEL || tenantEnvironment().DISCORD_OTP_CHANNEL || "").trim(),
      trim: true,
    },
    otpDiscordChannelLink: {
      type: String,
      default: () => {
        const envLink = (tenantEnvironment().OTP_DISCORD_CHANNEL_LINK || tenantEnvironment().DISCORD_OTP_CHANNEL_LINK)?.trim();
        if (envLink) return envLink;
        const envChan = (tenantEnvironment().OTP_DISCORD_CHANNEL || tenantEnvironment().DISCORD_OTP_CHANNEL || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    imapEnabled: {
      type: Boolean,
      default: () => getTenantId() === PLATFORM_TENANT_ID && tenantEnvironment().IMAP_ENABLED !== "false",
    },
    imapHost: {
      type: String,
      default: () => (tenantEnvironment().IMAP_HOST || "imap.gmail.com").trim(),
      trim: true,
    },
    imapPort: {
      type: Number,
      default: () => Number(tenantEnvironment().IMAP_PORT) || 993,
    },
    imapSecure: {
      type: Boolean,
      default: () => tenantEnvironment().IMAP_SECURE !== "false",
    },
    imapUser: {
      type: String,
      default: () => (tenantEnvironment().IMAP_USER || "").trim(),
      trim: true,
    },
    imapPass: {
      type: String,
      default: () => (tenantEnvironment().IMAP_PASS || tenantEnvironment().IMAP_PASSWORD || "").trim(),
      trim: true,
    },
    imapMailbox: {
      type: String,
      default: () => (tenantEnvironment().IMAP_MAILBOX || "INBOX").trim(),
      trim: true,
    },
    imapTargetSender: {
      type: String,
      default: () => (tenantEnvironment().IMAP_TARGET_SENDER || "service@intl.paypal.com").trim().toLowerCase(),
      trim: true,
    },
    // ── Cloudflare Email Routing ────────────────────────────────────────────
    cfEmail: {
      type: String,
      default: () => (tenantEnvironment().CF_EMAIL || "").trim(),
      trim: true,
    },
    cfApiKey: {
      type: String,
      default: () => (tenantEnvironment().CF_GLOBAL_API_KEY || tenantEnvironment().CF_API_KEY || "").trim(),
      trim: true,
    },
    cfDestinationEmail: {
      type: String,
      default: () => (tenantEnvironment().CF_DEST_EMAIL || tenantEnvironment().CF_DESTINATION_EMAIL || "").trim(),
      trim: true,
    },
    cfZones: {
      type: [
        {
          id: { type: String, required: true, trim: true },
          domain: { type: String, required: true, trim: true },
        },
      ],
      default: () => (getTenantId() === PLATFORM_TENANT_ID ? [...DEFAULT_CF_ZONES] : []),
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ---------------------------------------------------------------------------
// 3. Model & Singleton Loader
// ---------------------------------------------------------------------------

export interface IBotConfigModel extends Model<IBotConfig> {
  getOrCreate(): Promise<IBotConfig>;
}

botConfigSchema.static("getOrCreate", async function (): Promise<IBotConfig> {
  let doc = await this.findOne();
  const envTestiChannel = (tenantEnvironment().TESTIMONIAL_CHANNEL || tenantEnvironment().TESTI_CHANNEL_ID || tenantEnvironment().CHANNEL_TESTIMONI || "").trim();
  const envTestiLink = tenantEnvironment().TESTIMONIAL_LINK?.trim() || (envTestiChannel.startsWith("@") ? `https://t.me/${envTestiChannel.slice(1)}` : "");
  const envTestiEnabled = tenantEnvironment().TESTIMONIAL_ENABLED !== "false" && envTestiChannel.length > 0;

  const envLogChannel = (tenantEnvironment().LOG_CHANNEL || tenantEnvironment().AUDIT_CHANNEL || tenantEnvironment().CHANNEL_LOG || "").trim();
  const envLogLink = tenantEnvironment().LOG_CHANNEL_LINK?.trim() || (envLogChannel.startsWith("@") ? `https://t.me/${envLogChannel.slice(1)}` : "");
  const envLogEnabled = tenantEnvironment().LOG_CHANNEL_ENABLED !== "false" && envLogChannel.length > 0;

  const envOtpChan = (tenantEnvironment().OTP_PAYPAL_CHANNEL || tenantEnvironment().OTP_CHANNEL || tenantEnvironment().CHANNEL_OTP || "").trim();
  const envOtpLink = tenantEnvironment().OTP_PAYPAL_CHANNEL_LINK?.trim() || tenantEnvironment().OTP_CHANNEL_LINK?.trim() || (envOtpChan.startsWith("@") ? `https://t.me/${envOtpChan.slice(1)}` : "");
  const envOtpEnabled = tenantEnvironment().OTP_CHANNEL_ENABLED !== "false" && tenantEnvironment().OTP_PAYPAL_CHANNEL_ENABLED !== "false" && envOtpChan.length > 0;

  const envNfChan = (tenantEnvironment().OTP_NETFLIX_CHANNEL || tenantEnvironment().NETFLIX_OTP_CHANNEL || "").trim();
  const envNfLink = (tenantEnvironment().OTP_NETFLIX_CHANNEL_LINK || tenantEnvironment().NETFLIX_OTP_CHANNEL_LINK)?.trim() || (envNfChan.startsWith("@") ? `https://t.me/${envNfChan.slice(1)}` : "");
  const envNfEnabled = tenantEnvironment().OTP_NETFLIX_CHANNEL_ENABLED !== "false" && tenantEnvironment().NETFLIX_OTP_CHANNEL_ENABLED !== "false" && envNfChan.length > 0;

  const envDcChan = (tenantEnvironment().OTP_DISCORD_CHANNEL || tenantEnvironment().DISCORD_OTP_CHANNEL || "").trim();
  const envDcLink = (tenantEnvironment().OTP_DISCORD_CHANNEL_LINK || tenantEnvironment().DISCORD_OTP_CHANNEL_LINK)?.trim() || (envDcChan.startsWith("@") ? `https://t.me/${envDcChan.slice(1)}` : "");
  const envDcEnabled = tenantEnvironment().OTP_DISCORD_CHANNEL_ENABLED !== "false" && tenantEnvironment().DISCORD_OTP_CHANNEL_ENABLED !== "false" && envDcChan.length > 0;

  const envImapHost = (tenantEnvironment().IMAP_HOST || "imap.gmail.com").trim();
  const envImapPort = Number(tenantEnvironment().IMAP_PORT) || 993;
  const envImapSecure = tenantEnvironment().IMAP_SECURE !== "false";
  const envImapUser = (tenantEnvironment().IMAP_USER || "").trim();
  const envImapPass = (tenantEnvironment().IMAP_PASS || tenantEnvironment().IMAP_PASSWORD || "").trim();
  const envImapMailbox = (tenantEnvironment().IMAP_MAILBOX || "INBOX").trim();
  const envImapSender = (tenantEnvironment().IMAP_TARGET_SENDER || "service@intl.paypal.com").trim().toLowerCase();
  const envImapEnabled = getTenantId() === PLATFORM_TENANT_ID && tenantEnvironment().IMAP_ENABLED !== "false";
  const envCfEmail = (tenantEnvironment().CF_EMAIL || "").trim();
  const envCfApiKey = (tenantEnvironment().CF_GLOBAL_API_KEY || tenantEnvironment().CF_API_KEY || "").trim();
  const envCfDestEmail = (tenantEnvironment().CF_DEST_EMAIL || tenantEnvironment().CF_DESTINATION_EMAIL || "").trim();

  const envSecChannel = (tenantEnvironment().SECURITY_ALERT_CHANNEL || tenantEnvironment().SECURITY_CHANNEL || "").trim();
  const envSecLink = tenantEnvironment().SECURITY_ALERT_CHANNEL_LINK?.trim() || (envSecChannel.startsWith("@") ? `https://t.me/${envSecChannel.slice(1)}` : "");
  const envSecEnabled = tenantEnvironment().SECURITY_ALERT_CHANNEL_ENABLED !== "false" && envSecChannel.length > 0;

  if (!doc) {
    const envChannel = tenantEnvironment().FORCE_SUB_CHANNEL?.trim() || "";
    const envLink = tenantEnvironment().FORCE_SUB_LINK?.trim() || (envChannel.startsWith("@") ? `https://t.me/${envChannel.slice(1)}` : "");
    const envName = tenantEnvironment().FORCE_SUB_NAME?.trim() || "Channel Resmi";
    const envEnabled = tenantEnvironment().FORCE_SUB_ENABLED !== "false" && envChannel.length > 0;

    doc = await this.findOneAndUpdate({}, { $setOnInsert: {
      forceSubEnabled: envEnabled,
      forceSubChannel: envChannel,
      forceSubLink: envLink,
      forceSubName: envName,
      testimonialEnabled: envTestiEnabled,
      testimonialChannel: envTestiChannel,
      testimonialLink: envTestiLink,
      logChannelEnabled: envLogEnabled,
      logChannel: envLogChannel,
      logChannelLink: envLogLink,
      securityAlertChannelEnabled: envSecEnabled,
      securityAlertChannel: envSecChannel,
      securityAlertChannelLink: envSecLink,
      maxWarrantyClaimsPerDay: 3,
      maxWarrantyClaimRatioPercent: 50,
      maxPromoFailedAttempts: 5,
      promoBlockDurationMinutes: 60,
      velocityMaxActionsPerSecond: 5,
      isMaintenance: false,
      maintenanceMessage: "🔧 <b>Bot Sedang Maintenance</b>\n\nMaaf, bot sedang dalam proses pemeliharaan dan peningkatan sistem.\nSilakan coba lagi beberapa saat kemudian.\n\n<i>Terima kasih atas kesabaran Anda! 🙏</i>",
      affiliateEnabled: false,
      affiliateCommissionType: "percentage",
      affiliateCommissionValue: 2,
      otpChannelEnabled: envOtpEnabled,
      otpChannel: envOtpChan,
      otpChannelLink: envOtpLink,
      otpNetflixChannelEnabled: envNfEnabled,
      otpNetflixChannel: envNfChan,
      otpNetflixChannelLink: envNfLink,
      otpDiscordChannelEnabled: envDcEnabled,
      otpDiscordChannel: envDcChan,
      otpDiscordChannelLink: envDcLink,
      imapEnabled: envImapEnabled,
      imapHost: envImapHost,
      imapPort: envImapPort,
      imapSecure: envImapSecure,
      imapUser: envImapUser,
      imapPass: envImapPass,
      imapMailbox: envImapMailbox,
      imapTargetSender: envImapSender,
      cfEmail: envCfEmail,
      cfApiKey: envCfApiKey,
      cfDestinationEmail: envCfDestEmail,
      cfZones: (getTenantId() === PLATFORM_TENANT_ID ? [...DEFAULT_CF_ZONES] : []),
    } }, { upsert: true, returnDocument: "after" });
    console.log("   🆕  BotConfig document created with defaults.");
  } else {
    // Migration: populate missing fields from env or defaults
    let needSave = false;

    if (doc.testimonialChannel === undefined && envTestiChannel) {
      doc.testimonialChannel = envTestiChannel; needSave = true;
    }
    if (doc.testimonialLink === undefined && envTestiLink) {
      doc.testimonialLink = envTestiLink; needSave = true;
    }
    if (doc.testimonialEnabled === undefined) {
      doc.testimonialEnabled = envTestiEnabled; needSave = true;
    }
    if (doc.logChannel === undefined && envLogChannel) {
      doc.logChannel = envLogChannel; needSave = true;
    }
    if (doc.logChannelLink === undefined && envLogLink) {
      doc.logChannelLink = envLogLink; needSave = true;
    }
    if (doc.logChannelEnabled === undefined) {
      doc.logChannelEnabled = envLogEnabled; needSave = true;
    }
    if (doc.securityAlertChannel === undefined && envSecChannel) {
      doc.securityAlertChannel = envSecChannel; needSave = true;
    }
    if (doc.securityAlertChannelLink === undefined && envSecLink) {
      doc.securityAlertChannelLink = envSecLink; needSave = true;
    }
    if (doc.securityAlertChannelEnabled === undefined) {
      doc.securityAlertChannelEnabled = envSecEnabled; needSave = true;
    }
    if (doc.maxWarrantyClaimsPerDay === undefined) {
      doc.maxWarrantyClaimsPerDay = 3; needSave = true;
    }
    if (doc.maxWarrantyClaimRatioPercent === undefined) {
      doc.maxWarrantyClaimRatioPercent = 50; needSave = true;
    }
    if (doc.maxPromoFailedAttempts === undefined) {
      doc.maxPromoFailedAttempts = 5; needSave = true;
    }
    if (doc.promoBlockDurationMinutes === undefined) {
      doc.promoBlockDurationMinutes = 60; needSave = true;
    }
    if (doc.velocityMaxActionsPerSecond === undefined) {
      doc.velocityMaxActionsPerSecond = 5; needSave = true;
    }
    // New fields migration
    if (doc.isMaintenance === undefined) {
      doc.isMaintenance = false; needSave = true;
    }
    if (!doc.maintenanceMessage) {
      doc.maintenanceMessage = "🔧 <b>Bot Sedang Maintenance</b>\n\nMaaf, bot sedang dalam proses pemeliharaan dan peningkatan sistem.\nSilakan coba lagi beberapa saat kemudian.\n\n<i>Terima kasih atas kesabaran Anda! 🙏</i>";
      needSave = true;
    }
    if (doc.affiliateEnabled === undefined) {
      doc.affiliateEnabled = false; needSave = true;
    }
    if (doc.affiliateCommissionType === undefined) {
      doc.affiliateCommissionType = "percentage"; needSave = true;
    }
    if (doc.affiliateCommissionValue === undefined) {
      doc.affiliateCommissionValue = 2; needSave = true;
    }

    // OTP Channels & IMAP migration
    if (doc.otpChannel === undefined) {
      doc.otpChannel = envOtpChan; needSave = true;
    }
    if (doc.otpChannelLink === undefined) {
      doc.otpChannelLink = envOtpLink; needSave = true;
    }
    if (doc.otpChannelEnabled === undefined) {
      doc.otpChannelEnabled = envOtpEnabled; needSave = true;
    }
    if (doc.otpNetflixChannel === undefined) {
      doc.otpNetflixChannel = envNfChan; needSave = true;
    }
    if (doc.otpNetflixChannelLink === undefined) {
      doc.otpNetflixChannelLink = envNfLink; needSave = true;
    }
    if (doc.otpNetflixChannelEnabled === undefined) {
      doc.otpNetflixChannelEnabled = envNfEnabled; needSave = true;
    }
    if (doc.otpDiscordChannel === undefined) {
      doc.otpDiscordChannel = envDcChan; needSave = true;
    }
    if (doc.otpDiscordChannelLink === undefined) {
      doc.otpDiscordChannelLink = envDcLink; needSave = true;
    }
    if (doc.otpDiscordChannelEnabled === undefined) {
      doc.otpDiscordChannelEnabled = envDcEnabled; needSave = true;
    }
    if (doc.imapEnabled === undefined) {
      doc.imapEnabled = envImapEnabled; needSave = true;
    }
    if (doc.imapHost === undefined) {
      doc.imapHost = envImapHost; needSave = true;
    }
    if (doc.imapPort === undefined) {
      doc.imapPort = envImapPort; needSave = true;
    }
    if (doc.imapSecure === undefined) {
      doc.imapSecure = envImapSecure; needSave = true;
    }
    if (doc.imapUser === undefined) {
      doc.imapUser = envImapUser; needSave = true;
    }
    if (doc.imapPass === undefined) {
      doc.imapPass = envImapPass; needSave = true;
    }
    if (doc.imapMailbox === undefined) {
      doc.imapMailbox = envImapMailbox; needSave = true;
    }
    if (doc.imapTargetSender === undefined) {
      doc.imapTargetSender = envImapSender; needSave = true;
    }

    // Cloudflare Email Routing migration
    if (doc.cfEmail === undefined) {
      doc.cfEmail = envCfEmail; needSave = true;
    }
    if (doc.cfApiKey === undefined) {
      doc.cfApiKey = envCfApiKey; needSave = true;
    }
    if (doc.cfDestinationEmail === undefined) {
      doc.cfDestinationEmail = envCfDestEmail; needSave = true;
    }
    if (!doc.cfZones || doc.cfZones.length === 0) {
      doc.cfZones = (getTenantId() === PLATFORM_TENANT_ID ? [...DEFAULT_CF_ZONES] : []); needSave = true;
    }

    if (needSave) {
      await doc.save();
    }
  }
  return doc;
});

botConfigSchema.plugin(tenantPlugin, { singleton: true });

export const BotConfig = model<IBotConfig, IBotConfigModel>(
  "BotConfig",
  botConfigSchema
);
