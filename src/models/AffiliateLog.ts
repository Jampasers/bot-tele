import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export type AffiliateSourceType =
  | "TOPUP"
  | "DIGITAL_PURCHASE"
  | "OTP_PURCHASE";

export interface IAffiliateLog extends Document {
  /** Telegram ID of the referrer who earns the commission */
  referrerId: string;

  /** Telegram ID of the user who triggered the commission (the referred user) */
  referredUserId: string;

  /** What triggered this commission */
  sourceType: AffiliateSourceType;

  /** Order/Session ID of the triggering transaction */
  sourceOrderId: string;

  /** Total purchase amount that commission was calculated from */
  purchaseAmount: number;

  /** The commission amount credited to the referrer */
  commissionAmount: number;

  createdAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Mongoose Schema
// ---------------------------------------------------------------------------

const affiliateLogSchema = new Schema<IAffiliateLog>(
  {
    referrerId: {
      type: String,
      required: true,
      index: true,
    },
    referredUserId: {
      type: String,
      required: true,
    },
    sourceType: {
      type: String,
      enum: ["TOPUP", "DIGITAL_PURCHASE", "OTP_PURCHASE"],
      required: true,
    },
    sourceOrderId: {
      type: String,
      required: true,
    },
    purchaseAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    commissionAmount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

affiliateLogSchema.index({ referrerId: 1, createdAt: -1 });
affiliateLogSchema.index({ referredUserId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// 3. Model
// ---------------------------------------------------------------------------

export const AffiliateLog: Model<IAffiliateLog> = model<IAffiliateLog>(
  "AffiliateLog",
  affiliateLogSchema
);
