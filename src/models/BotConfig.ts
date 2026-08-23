import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export interface IBotConfig extends Document {
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
      default: () => process.env.FORCE_SUB_ENABLED !== "false",
    },
    forceSubChannel: {
      type: String,
      default: () => process.env.FORCE_SUB_CHANNEL?.trim() || "",
      trim: true,
    },
    forceSubLink: {
      type: String,
      default: () => process.env.FORCE_SUB_LINK?.trim() || "",
      trim: true,
    },
    forceSubName: {
      type: String,
      default: () => process.env.FORCE_SUB_NAME?.trim() || "Channel Resmi",
      trim: true,
    },
    testimonialEnabled: {
      type: Boolean,
      default: () => {
        if (process.env.TESTIMONIAL_ENABLED === "false") return false;
        const envTesti = process.env.TESTIMONIAL_CHANNEL || process.env.TESTI_CHANNEL_ID || process.env.CHANNEL_TESTIMONI;
        return !!envTesti && envTesti.trim().length > 0;
      },
    },
    testimonialChannel: {
      type: String,
      default: () => (process.env.TESTIMONIAL_CHANNEL || process.env.TESTI_CHANNEL_ID || process.env.CHANNEL_TESTIMONI || "").trim(),
      trim: true,
    },
    testimonialLink: {
      type: String,
      default: () => {
        const envLink = process.env.TESTIMONIAL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (process.env.TESTIMONIAL_CHANNEL || process.env.TESTI_CHANNEL_ID || process.env.CHANNEL_TESTIMONI || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    logChannelEnabled: {
      type: Boolean,
      default: () => {
        if (process.env.LOG_CHANNEL_ENABLED === "false") return false;
        const envLog = process.env.LOG_CHANNEL || process.env.AUDIT_CHANNEL || process.env.CHANNEL_LOG;
        return !!envLog && envLog.trim().length > 0;
      },
    },
    logChannel: {
      type: String,
      default: () => (process.env.LOG_CHANNEL || process.env.AUDIT_CHANNEL || process.env.CHANNEL_LOG || "").trim(),
      trim: true,
    },
    logChannelLink: {
      type: String,
      default: () => {
        const envLink = process.env.LOG_CHANNEL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (process.env.LOG_CHANNEL || process.env.AUDIT_CHANNEL || process.env.CHANNEL_LOG || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
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
        if (process.env.OTP_CHANNEL_ENABLED === "false" || process.env.OTP_PAYPAL_CHANNEL_ENABLED === "false") return false;
        const envOtpChan = process.env.OTP_PAYPAL_CHANNEL || process.env.OTP_CHANNEL || process.env.CHANNEL_OTP;
        return !!envOtpChan && envOtpChan.trim().length > 0;
      },
    },
    otpChannel: {
      type: String,
      default: () => (process.env.OTP_PAYPAL_CHANNEL || process.env.OTP_CHANNEL || process.env.CHANNEL_OTP || "").trim(),
      trim: true,
    },
    otpChannelLink: {
      type: String,
      default: () => {
        const envLink = process.env.OTP_PAYPAL_CHANNEL_LINK?.trim() || process.env.OTP_CHANNEL_LINK?.trim();
        if (envLink) return envLink;
        const envChan = (process.env.OTP_PAYPAL_CHANNEL || process.env.OTP_CHANNEL || process.env.CHANNEL_OTP || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    otpNetflixChannelEnabled: {
      type: Boolean,
      default: () => {
        if (process.env.OTP_NETFLIX_CHANNEL_ENABLED === "false" || process.env.NETFLIX_OTP_CHANNEL_ENABLED === "false") return false;
        const envNfChan = process.env.OTP_NETFLIX_CHANNEL || process.env.NETFLIX_OTP_CHANNEL;
        return !!envNfChan && envNfChan.trim().length > 0;
      },
    },
    otpNetflixChannel: {
      type: String,
      default: () => (process.env.OTP_NETFLIX_CHANNEL || process.env.NETFLIX_OTP_CHANNEL || "").trim(),
      trim: true,
    },
    otpNetflixChannelLink: {
      type: String,
      default: () => {
        const envLink = (process.env.OTP_NETFLIX_CHANNEL_LINK || process.env.NETFLIX_OTP_CHANNEL_LINK)?.trim();
        if (envLink) return envLink;
        const envChan = (process.env.OTP_NETFLIX_CHANNEL || process.env.NETFLIX_OTP_CHANNEL || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    otpDiscordChannelEnabled: {
      type: Boolean,
      default: () => {
        if (process.env.OTP_DISCORD_CHANNEL_ENABLED === "false" || process.env.DISCORD_OTP_CHANNEL_ENABLED === "false") return false;
        const envDcChan = process.env.OTP_DISCORD_CHANNEL || process.env.DISCORD_OTP_CHANNEL;
        return !!envDcChan && envDcChan.trim().length > 0;
      },
    },
    otpDiscordChannel: {
      type: String,
      default: () => (process.env.OTP_DISCORD_CHANNEL || process.env.DISCORD_OTP_CHANNEL || "").trim(),
      trim: true,
    },
    otpDiscordChannelLink: {
      type: String,
      default: () => {
        const envLink = (process.env.OTP_DISCORD_CHANNEL_LINK || process.env.DISCORD_OTP_CHANNEL_LINK)?.trim();
        if (envLink) return envLink;
        const envChan = (process.env.OTP_DISCORD_CHANNEL || process.env.DISCORD_OTP_CHANNEL || "").trim();
        return envChan.startsWith("@") ? `https://t.me/${envChan.slice(1)}` : "";
      },
      trim: true,
    },
    imapEnabled: {
      type: Boolean,
      default: () => process.env.IMAP_ENABLED !== "false",
    },
    imapHost: {
      type: String,
      default: () => (process.env.IMAP_HOST || "imap.gmail.com").trim(),
      trim: true,
    },
    imapPort: {
      type: Number,
      default: () => Number(process.env.IMAP_PORT) || 993,
    },
    imapSecure: {
      type: Boolean,
      default: () => process.env.IMAP_SECURE !== "false",
    },
    imapUser: {
      type: String,
      default: () => (process.env.IMAP_USER || "").trim(),
      trim: true,
    },
    imapPass: {
      type: String,
      default: () => (process.env.IMAP_PASS || process.env.IMAP_PASSWORD || "").trim(),
      trim: true,
    },
    imapMailbox: {
      type: String,
      default: () => (process.env.IMAP_MAILBOX || "INBOX").trim(),
      trim: true,
    },
    imapTargetSender: {
      type: String,
      default: () => (process.env.IMAP_TARGET_SENDER || "service@intl.paypal.com").trim().toLowerCase(),
      trim: true,
    },
    // ── Cloudflare Email Routing ────────────────────────────────────────────
    cfEmail: {
      type: String,
      default: () => (process.env.CF_EMAIL || "").trim(),
      trim: true,
    },
    cfApiKey: {
      type: String,
      default: () => (process.env.CF_GLOBAL_API_KEY || process.env.CF_API_KEY || "").trim(),
      trim: true,
    },
    cfDestinationEmail: {
      type: String,
      default: () => (process.env.CF_DEST_EMAIL || process.env.CF_DESTINATION_EMAIL || "").trim(),
      trim: true,
    },
    cfZones: {
      type: [
        {
          id: { type: String, required: true, trim: true },
          domain: { type: String, required: true, trim: true },
        },
      ],
      default: () => [...DEFAULT_CF_ZONES],
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
  const envTestiChannel = (process.env.TESTIMONIAL_CHANNEL || process.env.TESTI_CHANNEL_ID || process.env.CHANNEL_TESTIMONI || "").trim();
  const envTestiLink = process.env.TESTIMONIAL_LINK?.trim() || (envTestiChannel.startsWith("@") ? `https://t.me/${envTestiChannel.slice(1)}` : "");
  const envTestiEnabled = process.env.TESTIMONIAL_ENABLED !== "false" && envTestiChannel.length > 0;

  const envLogChannel = (process.env.LOG_CHANNEL || process.env.AUDIT_CHANNEL || process.env.CHANNEL_LOG || "").trim();
  const envLogLink = process.env.LOG_CHANNEL_LINK?.trim() || (envLogChannel.startsWith("@") ? `https://t.me/${envLogChannel.slice(1)}` : "");
  const envLogEnabled = process.env.LOG_CHANNEL_ENABLED !== "false" && envLogChannel.length > 0;

  const envOtpChan = (process.env.OTP_PAYPAL_CHANNEL || process.env.OTP_CHANNEL || process.env.CHANNEL_OTP || "").trim();
  const envOtpLink = process.env.OTP_PAYPAL_CHANNEL_LINK?.trim() || process.env.OTP_CHANNEL_LINK?.trim() || (envOtpChan.startsWith("@") ? `https://t.me/${envOtpChan.slice(1)}` : "");
  const envOtpEnabled = process.env.OTP_CHANNEL_ENABLED !== "false" && process.env.OTP_PAYPAL_CHANNEL_ENABLED !== "false" && envOtpChan.length > 0;

  const envNfChan = (process.env.OTP_NETFLIX_CHANNEL || process.env.NETFLIX_OTP_CHANNEL || "").trim();
  const envNfLink = (process.env.OTP_NETFLIX_CHANNEL_LINK || process.env.NETFLIX_OTP_CHANNEL_LINK)?.trim() || (envNfChan.startsWith("@") ? `https://t.me/${envNfChan.slice(1)}` : "");
  const envNfEnabled = process.env.OTP_NETFLIX_CHANNEL_ENABLED !== "false" && process.env.NETFLIX_OTP_CHANNEL_ENABLED !== "false" && envNfChan.length > 0;

  const envDcChan = (process.env.OTP_DISCORD_CHANNEL || process.env.DISCORD_OTP_CHANNEL || "").trim();
  const envDcLink = (process.env.OTP_DISCORD_CHANNEL_LINK || process.env.DISCORD_OTP_CHANNEL_LINK)?.trim() || (envDcChan.startsWith("@") ? `https://t.me/${envDcChan.slice(1)}` : "");
  const envDcEnabled = process.env.OTP_DISCORD_CHANNEL_ENABLED !== "false" && process.env.DISCORD_OTP_CHANNEL_ENABLED !== "false" && envDcChan.length > 0;

  const envImapHost = (process.env.IMAP_HOST || "imap.gmail.com").trim();
  const envImapPort = Number(process.env.IMAP_PORT) || 993;
  const envImapSecure = process.env.IMAP_SECURE !== "false";
  const envImapUser = (process.env.IMAP_USER || "").trim();
  const envImapPass = (process.env.IMAP_PASS || process.env.IMAP_PASSWORD || "").trim();
  const envImapMailbox = (process.env.IMAP_MAILBOX || "INBOX").trim();
  const envImapSender = (process.env.IMAP_TARGET_SENDER || "service@intl.paypal.com").trim().toLowerCase();
  const envImapEnabled = process.env.IMAP_ENABLED !== "false";
  const envCfEmail = (process.env.CF_EMAIL || "").trim();
  const envCfApiKey = (process.env.CF_GLOBAL_API_KEY || process.env.CF_API_KEY || "").trim();
  const envCfDestEmail = (process.env.CF_DEST_EMAIL || process.env.CF_DESTINATION_EMAIL || "").trim();

  if (!doc) {
    const envChannel = process.env.FORCE_SUB_CHANNEL?.trim() || "";
    const envLink = process.env.FORCE_SUB_LINK?.trim() || (envChannel.startsWith("@") ? `https://t.me/${envChannel.slice(1)}` : "");
    const envName = process.env.FORCE_SUB_NAME?.trim() || "Channel Resmi";
    const envEnabled = process.env.FORCE_SUB_ENABLED !== "false" && envChannel.length > 0;

    doc = await this.create({
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
      cfZones: [...DEFAULT_CF_ZONES],
    });
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
      doc.cfZones = [...DEFAULT_CF_ZONES]; needSave = true;
    }

    if (needSave) {
      await doc.save();
    }
  }
  return doc;
});

export const BotConfig = model<IBotConfig, IBotConfigModel>(
  "BotConfig",
  botConfigSchema
);
