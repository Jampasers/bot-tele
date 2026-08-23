import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export type DiscountType = "FIXED" | "PERCENTAGE";

export interface IPromoCode extends Document {
  /** Promo code string — always stored uppercase */
  code: string;

  /** Discount calculation mode */
  discountType: DiscountType;

  /** Discount value: amount in IDR (FIXED) or percentage 0-100 (PERCENTAGE) */
  discountValue: number;

  /**
   * Maximum discount cap in IDR (only meaningful for PERCENTAGE type).
   * e.g. 50% discount capped at Rp10,000.
   */
  maxDiscount?: number;

  /** Minimum purchase amount (IDR) required to use this promo */
  minSpend: number;

  /** Maximum total uses allowed */
  quota: number;

  /** Current number of times used */
  usedCount: number;

  /** Array of Telegram IDs who have used this code (for single-use enforcement) */
  usedBy: string[];

  /** When this promo expires */
  expiresAt: Date;

  /** Whether this promo is currently active */
  isActive: boolean;

  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Mongoose Schema
// ---------------------------------------------------------------------------

const promoCodeSchema = new Schema<IPromoCode>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    discountType: {
      type: String,
      enum: ["FIXED", "PERCENTAGE"],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    maxDiscount: {
      type: Number,
      default: undefined,
      min: 0,
    },
    minSpend: {
      type: Number,
      default: 0,
      min: 0,
    },
    quota: {
      type: Number,
      required: true,
      min: 1,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    usedBy: {
      type: [String],
      default: [],
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

promoCodeSchema.index({ isActive: 1, expiresAt: 1 });

// ---------------------------------------------------------------------------
// 3. Model
// ---------------------------------------------------------------------------

export const PromoCode: Model<IPromoCode> = model<IPromoCode>(
  "PromoCode",
  promoCodeSchema
);
