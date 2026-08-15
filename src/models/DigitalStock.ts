import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface IDigitalStock {
  /** The product this stock item belongs to */
  productId: Types.ObjectId;

  /** The actual stock payload (credentials, license key, voucher code, etc.) */
  content: string;

  /** Whether this item has already been delivered to a buyer */
  isSold: boolean;

  /** Telegram user ID of the buyer (if sold) */
  soldTo?: string;

  /** Date when this item was purchased */
  soldAt?: Date;

  /** Order ID associated with the purchase */
  orderId?: string;

  /** When the stock was added */
  createdAt: Date;
}

export type DigitalStockDocument = Document<unknown, {}, IDigitalStock> &
  IDigitalStock & { _id: Types.ObjectId };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const digitalStockSchema = new Schema<IDigitalStock>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "DigitalProduct",
      required: [true, "productId is required"],
      index: true,
    },
    content: {
      type: String,
      required: [true, "Stock content is required"],
      trim: true,
    },
    isSold: {
      type: Boolean,
      default: false,
      index: true,
    },
    soldTo: {
      type: String,
      trim: true,
      default: undefined,
    },
    soldAt: {
      type: Date,
      default: undefined,
    },
    orderId: {
      type: String,
      trim: true,
      default: undefined,
    },
    createdAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

// Compound index for finding and acquiring available stock FIFO
digitalStockSchema.index({ productId: 1, isSold: 1, createdAt: 1 });

// ============================================================================
//  3. Model
// ============================================================================

export const DigitalStock: Model<IDigitalStock> = model<IDigitalStock>(
  "DigitalStock",
  digitalStockSchema
);
