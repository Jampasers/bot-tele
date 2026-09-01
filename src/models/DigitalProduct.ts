import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export type WarrantyUnit = "HOURS" | "DAYS" | "WEEKS" | "MONTHS" | "NONE";

export type DeliveryType = "CREDENTIAL" | "FILE" | "DYNAMIC_API" | "MANUAL_PREORDER";

export interface IBulkDiscountTier {
  /** Minimum quantity to activate this wholesale tier (e.g. 5, 10, 50) */
  minQty: number;

  /** Discounted unit price in IDR for purchases >= minQty */
  pricePerUnit: number;
}

export interface IDigitalProduct {
  /** Display name of the digital product (e.g. "Netflix Premium 1 Bulan") */
  name: string;

  /** Category grouping (e.g. "Streaming", "Software", "Games", "Voucher") */
  category: string;

  /** Full description / warranty / usage instructions */
  description?: string | undefined;

  /** Selling price in IDR */
  price: number;

  /** Wholesale / bulk discount tiers (sorted ascending by minQty) */
  bulkDiscounts?: IBulkDiscountTier[] | undefined;

  /** Multi-format delivery mechanism */
  deliveryType?: DeliveryType | undefined;

  /** Telegram File ID if deliveryType is FILE */
  fileId?: string | undefined;

  /** External document/file download URL or local path if deliveryType is FILE */
  fileUrl?: string | undefined;

  /** Webhook or external generator API URL if deliveryType is DYNAMIC_API */
  webhookUrl?: string | undefined;

  /** Optional custom headers / API key object for DYNAMIC_API webhook */
  apiHeader?: Record<string, string> | undefined;

  /** Whether the product is currently visible and purchasable in the catalog */
  isActive: boolean;

  /** Custom note / delivery message sent to buyer on purchase */
  deliveryMessage?: string | undefined;

  /** Warranty duration value (0 = no warranty) */
  warrantyDuration?: number | undefined;

  /** Warranty time unit */
  warrantyUnit?: WarrantyUnit | undefined;

  /** Maximum allowed warranty claims per purchase order (default: 1) */
  maxClaims?: number | undefined;

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
    deliveryMessage: {
      type: String,
      trim: true,
      default: "",
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price cannot be negative"],
    },
    bulkDiscounts: {
      type: [
        {
          minQty: {
            type: Number,
            required: true,
            min: [2, "Bulk discount minimum quantity must be at least 2"],
          },
          pricePerUnit: {
            type: Number,
            required: true,
            min: [0, "Price per unit cannot be negative"],
          },
        },
      ],
      default: [],
    },
    deliveryType: {
      type: String,
      enum: ["CREDENTIAL", "FILE", "DYNAMIC_API", "MANUAL_PREORDER"],
      default: "CREDENTIAL",
      index: true,
    },
    fileId: {
      type: String,
      trim: true,
    },
    fileUrl: {
      type: String,
      trim: true,
    },
    webhookUrl: {
      type: String,
      trim: true,
    },
    apiHeader: {
      type: Schema.Types.Mixed,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
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
    maxClaims: {
      type: Number,
      default: 1,
      min: 0,
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
