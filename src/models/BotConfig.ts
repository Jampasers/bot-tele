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

  createdAt: Date;
  updatedAt: Date;
}

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
    });
    console.log("   🆕  BotConfig document created with defaults.");
  } else {
    // If existing document was created before testimonial fields were added, populate from env if missing
    let needSave = false;
    if (doc.testimonialChannel === undefined && envTestiChannel) {
      doc.testimonialChannel = envTestiChannel;
      needSave = true;
    }
    if (doc.testimonialLink === undefined && envTestiLink) {
      doc.testimonialLink = envTestiLink;
      needSave = true;
    }
    if (doc.testimonialEnabled === undefined) {
      doc.testimonialEnabled = envTestiEnabled;
      needSave = true;
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
