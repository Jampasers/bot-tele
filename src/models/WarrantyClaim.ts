import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Types & Interface
// ============================================================================

export type ClaimStatus = "PENDING" | "APPROVED_REPLACE" | "APPROVED_REFUND" | "REJECTED";

export interface IWarrantyClaim {
  /** Unique Claim Reference (e.g. "CLM-1718000000-1234") */
  claimId: string;

  /** Reference order ID from DigitalOrder */
  orderId: string;

  /** Telegram numeric user ID of buyer */
  userId: string;

  /** Buyer's username or first name */
  userHandle?: string | undefined;

  /** Reference to the purchased DigitalProduct */
  productId: Types.ObjectId;

  /** Snapshot of the product name */
  productName: string;

  /** Snapshot of the original item content delivered */
  itemContentSnapshot: string;

  /** Complaint / reason described by the user */
  reason: string;

  /** Status of the claim */
  status: ClaimStatus;

  /** Admin note (e.g. rejection explanation or internal remarks) */
  adminNote?: string | undefined;

  /** Replaced stock content if resolved via APPROVED_REPLACE */
  replacementContent?: string | undefined;

  /** Refunded amount in IDR if resolved via APPROVED_REFUND */
  refundAmount?: number | undefined;

  /** Admin Telegram ID who resolved the claim */
  resolvedBy?: string | undefined;

  /** Timestamp when claim was resolved */
  resolvedAt?: Date | undefined;

  /** Timestamp when claim was submitted */
  createdAt: Date;
}

export type WarrantyClaimDocument = Document<unknown, {}, IWarrantyClaim> &
  IWarrantyClaim & { _id: Types.ObjectId };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const warrantyClaimSchema = new Schema<IWarrantyClaim>(
  {
    claimId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    orderId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    userHandle: {
      type: String,
      trim: true,
      default: "",
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "DigitalProduct",
      required: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    itemContentSnapshot: {
      type: String,
      required: true,
      trim: true,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: [1000, "Alasan klaim maksimal 1000 karakter"],
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED_REPLACE", "APPROVED_REFUND", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    adminNote: {
      type: String,
      trim: true,
      default: "",
    },
    replacementContent: {
      type: String,
      trim: true,
      default: "",
    },
    refundAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    resolvedBy: {
      type: String,
      trim: true,
    },
    resolvedAt: {
      type: Date,
    },
    createdAt: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

// Compound index for querying user claims and pending queues
warrantyClaimSchema.index({ userId: 1, createdAt: -1 });
warrantyClaimSchema.index({ orderId: 1, status: 1 });

// ============================================================================
//  3. Model
// ============================================================================

export const WarrantyClaim: Model<IWarrantyClaim> = model<IWarrantyClaim>(
  "WarrantyClaim",
  warrantyClaimSchema
);
