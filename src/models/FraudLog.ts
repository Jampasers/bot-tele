import { Schema, model, Document, Model } from "mongoose";

// ============================================================================
//  1. Types & Interfaces
// ============================================================================

export type FraudType =
  | "PAYMENT_REPLAY"
  | "WARRANTY_ABUSE"
  | "PROMO_BRUTEFORCE"
  | "VELOCITY_LIMIT"
  | "BALANCE_ABUSE"
  | "SUSPICIOUS_ACTIVITY";

export type FraudSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type FraudAction =
  | "BLOCKED"
  | "FLAGGED_UNDER_REVIEW"
  | "ALERTED_ADMIN"
  | "AUTO_BANNED";

export interface IFraudLog {
  fraudType: FraudType;
  userId: string;
  userHandle?: string | undefined;
  severity: FraudSeverity;
  actionTaken: FraudAction;
  signature?: string | undefined;
  reason: string;
  metadata?: Record<string, any> | undefined;
  resolved: boolean;
  resolvedBy?: string | undefined;
  resolvedAt?: Date | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export type FraudLogDocument = Document<unknown, {}, IFraudLog> &
  IFraudLog & {
    _id: import("mongoose").Types.ObjectId;
  };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const fraudLogSchema = new Schema<IFraudLog>(
  {
    fraudType: {
      type: String,
      enum: [
        "PAYMENT_REPLAY",
        "WARRANTY_ABUSE",
        "PROMO_BRUTEFORCE",
        "VELOCITY_LIMIT",
        "BALANCE_ABUSE",
        "SUSPICIOUS_ACTIVITY",
      ],
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    userHandle: {
      type: String,
      trim: true,
      default: undefined,
    },
    severity: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
      index: true,
    },
    actionTaken: {
      type: String,
      enum: ["BLOCKED", "FLAGGED_UNDER_REVIEW", "ALERTED_ADMIN", "AUTO_BANNED"],
      default: "BLOCKED",
    },
    signature: {
      type: String,
      trim: true,
      index: true,
      default: undefined,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    resolved: {
      type: Boolean,
      default: false,
      index: true,
    },
    resolvedBy: {
      type: String,
      trim: true,
      default: undefined,
    },
    resolvedAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Compound indexes for fast security queries
fraudLogSchema.index({ userId: 1, createdAt: -1 });
fraudLogSchema.index({ fraudType: 1, createdAt: -1 });
fraudLogSchema.index({ resolved: 1, createdAt: -1 });

// ============================================================================
//  3. Model Export
// ============================================================================

export const FraudLog: Model<IFraudLog> = model<IFraudLog>("FraudLog", fraudLogSchema);
