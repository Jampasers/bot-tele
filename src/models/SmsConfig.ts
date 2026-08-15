import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript interface
// ---------------------------------------------------------------------------

/**
 * The single SMS configuration document stored in MongoDB.
 *
 * There is exactly ONE document in the `smsconfigs` collection — a singleton.
 * Use `SmsConfig.getOrCreate()` to retrieve (or lazily create) it.
 */
export interface ISmsConfig extends Document {
  /**
   * Whether OTP SMS virtual number service is enabled.
   */
  enabled: boolean;

  /**
   * Whitelisted SMSBower country IDs, in the desired button display order.
   * Only countries whose `id` appears here will ever be shown in the keyboard.
   */
  allowedCountries: string[];

  /**
   * Whitelisted SMSBower service codes, in the desired button display order.
   * Only services whose `code` appears here will ever be shown in the keyboard.
   */
  allowedServices: string[];

  // ── Pricing / Markup ──────────────────────────────────────────────

  /**
   * How the markup is calculated on top of the SMSBower base cost.
   * - `fixed`      : selling price = baseCost + markupValue (e.g. +500 IDR)
   * - `percentage` : selling price = baseCost + baseCost * (markupValue / 100)
   */
  markupType: "fixed" | "percentage";

  /**
   * The raw markup amount.
   * Interpretation depends on `markupType`:
   * - fixed      : absolute units added to the base cost  (e.g. 500)
   * - percentage : percentage added on top of the base cost (e.g. 10 = 10%)
   */
  markupValue: number;

  /** Automatically managed by Mongoose. */
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Schema
// ---------------------------------------------------------------------------

const smsConfigSchema = new Schema<ISmsConfig>(
  {
    enabled: {
      type:    Boolean,
      default: () => process.env.OTP_ENABLED !== "false",
    },
    allowedCountries: {
      type:    [String],
      default: ["6", "0"], // Indonesia, Russia
    },
    allowedServices: {
      type:    [String],
      default: ["wa", "tg"], // WhatsApp, Telegram
    },

    markupType: {
      type:    String,
      enum:    ["fixed", "percentage"],
      default: "fixed",
    },
    markupValue: {
      type:    Number,
      default: 500, // +500 IDR flat on top of base cost
      min:     [0, "markupValue cannot be negative"],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ---------------------------------------------------------------------------
// 3. Model
// ---------------------------------------------------------------------------

export interface ISmsConfigModel extends Model<ISmsConfig> {
  /**
   * Returns the singleton config document, creating it with defaults if it
   * does not yet exist in the database.
   *
   * Always use this instead of `findOne()` so callers never receive `null`.
   *
   * @example
   * const config = await SmsConfig.getOrCreate();
   * console.log(config.allowedServices); // ["wa", "tg", ...]
   */
  getOrCreate(): Promise<ISmsConfig>;
}

smsConfigSchema.static("getOrCreate", async function (): Promise<ISmsConfig> {
  let doc = await this.findOne();
  const defaultEnabled = process.env.OTP_ENABLED !== "false";
  if (!doc) {
    doc = await this.create({
      enabled: defaultEnabled,
    });
    console.log("   🆕  SmsConfig document created with defaults.");
  } else if (doc.enabled === undefined) {
    doc.enabled = defaultEnabled;
    await doc.save();
  }
  return doc;
});

/**
 * Mongoose model for the `smsconfigs` collection.
 *
 * Usage:
 * ```ts
 * import { SmsConfig } from "../../models/SmsConfig.js";
 *
 * const config = await SmsConfig.getOrCreate();
 * config.allowedServices.push("nf");
 * await config.save();
 * ```
 */
export const SmsConfig = model<ISmsConfig, ISmsConfigModel>(
  "SmsConfig",
  smsConfigSchema
);
