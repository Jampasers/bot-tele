import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface IDigitalOrder {
  /** Unique Order Reference (e.g. "DIGI-1718000000-1234") */
  orderId: string;

  /** Telegram numeric user ID of buyer */
  userId: string;

  /** Reference to the purchased DigitalProduct */
  productId: Types.ObjectId;

  /** Snapshot of the product name at time of purchase */
  productName: string;

  /** Total number of items purchased */
  quantity: number;

  /** Total price paid in IDR */
  price: number;

  /** Unit price paid per item in IDR */
  unitPrice?: number | undefined;

  /** Wholesale discount amount saved in IDR */
  discountAmount?: number | undefined;

  /** Wholesale tier minimum quantity applied (if any) */
  bulkTierMinQty?: number | undefined;

  /** The delivered stock content/credential */
  itemContent: string;

  /** Optional custom note / delivery message at time of purchase */
  deliveryMessage?: string | undefined;

  /** Snapshot: warranty duration value (0 = no warranty) */
  warrantyDuration?: number | undefined;

  /** Snapshot: warranty unit */
  warrantyUnit?: "HOURS" | "DAYS" | "WEEKS" | "MONTHS" | "NONE" | undefined;

  /** Calculated expiry timestamp for warranty */
  warrantyExpiresAt?: Date | undefined;

  /** Maximum allowed warranty claims for this order */
  maxClaims?: number | undefined;

  /** Number of claims filed against this order */
  claimsCount?: number | undefined;

  /** When the order was completed */
  createdAt: Date;
}

export type DigitalOrderDocument = Document<unknown, {}, IDigitalOrder> &
  IDigitalOrder & { _id: Types.ObjectId };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const digitalOrderSchema = new Schema<IDigitalOrder>(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
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
    quantity: {
      type: Number,
      required: true,
      default: 1,
      min: [1, "Quantity must be at least 1"],
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    unitPrice: {
      type: Number,
      min: 0,
      default: undefined,
    },
    discountAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    bulkTierMinQty: {
      type: Number,
      min: 0,
      default: undefined,
    },
    itemContent: {
      type: String,
      required: true,
      trim: true,
    },
    deliveryMessage: {
      type: String,
      trim: true,
      default: "",
    },
    warrantyDuration: {
      type: Number,
      default: 0,
      min: 0,
    },
    warrantyUnit: {
      type: String,
      enum: ["HOURS", "DAYS", "WEEKS", "MONTHS", "NONE"],
      default: "NONE",
    },
    warrantyExpiresAt: {
      type: Date,
      index: true,
    },
    maxClaims: {
      type: Number,
      default: 1,
      min: 0,
    },
    claimsCount: {
      type: Number,
      default: 0,
      min: 0,
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

// ============================================================================
//  3. Model
// ============================================================================

export const DigitalOrder: Model<IDigitalOrder> = model<IDigitalOrder>(
  "DigitalOrder",
  digitalOrderSchema
);
