import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export type BalanceLogType =
  | "CREDIT"
  | "DEBIT"
  | "REFUND"
  | "COMMISSION"
  | "PURCHASE"
  | "TOPUP";

export interface IBalanceLog extends Document {
  /** Telegram ID of the user whose balance changed */
  userId: string;

  /** Telegram ID of the admin who triggered this change (optional, admin-initiated only) */
  adminId?: string;

  /** Type of mutation */
  type: BalanceLogType;

  /** Absolute amount changed (always positive) */
  amount: number;

  /** Balance before this mutation */
  balanceBefore: number;

  /** Balance after this mutation */
  balanceAfter: number;

  /** Human-readable reason / note */
  reason: string;

  createdAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Mongoose Schema
// ---------------------------------------------------------------------------

const balanceLogSchema = new Schema<IBalanceLog>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    adminId: {
      type: String,
      default: undefined,
    },
    type: {
      type: String,
      enum: ["CREDIT", "DEBIT", "REFUND", "COMMISSION", "PURCHASE", "TOPUP"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Compound index for fast user history queries
balanceLogSchema.index({ userId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// 3. Model
// ---------------------------------------------------------------------------

export const BalanceLog: Model<IBalanceLog> = model<IBalanceLog>(
  "BalanceLog",
  balanceLogSchema
);
