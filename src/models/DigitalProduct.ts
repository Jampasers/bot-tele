import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface IDigitalProduct {
  /** Display name of the digital product (e.g. "Netflix Premium 1 Bulan") */
  name: string;

  /** Category grouping (e.g. "Streaming", "Software", "Games", "Voucher") */
  category: string;

  /** Full description / warranty / usage instructions */
  description?: string;

  /** Selling price in IDR */
  price: number;

  /** Whether the product is currently visible and purchasable in the catalog */
  isActive: boolean;

  /** Auto timestamps */
  createdAt: Date;
  updatedAt: Date;
}

export type DigitalProductDocument = Document<unknown, {}, IDigitalProduct> &
  IDigitalProduct & { _id: Types.ObjectId };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const digitalProductSchema = new Schema<IDigitalProduct>(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      maxlength: [120, "Product name must be 120 characters or fewer"],
    },
    category: {
      type: String,
      required: [true, "Category is required"],
      trim: true,
      default: "Umum",
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price cannot be negative"],
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Compound index for browsing active products by category
digitalProductSchema.index({ category: 1, isActive: 1 });

// ============================================================================
//  3. Model
// ============================================================================

export const DigitalProduct: Model<IDigitalProduct> = model<IDigitalProduct>(
  "DigitalProduct",
  digitalProductSchema
);
