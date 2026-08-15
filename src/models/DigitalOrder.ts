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

  /** The delivered stock content/credential */
  itemContent: string;

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
    itemContent: {
      type: String,
      required: true,
      trim: true,
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
