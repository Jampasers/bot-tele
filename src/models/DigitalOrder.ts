import { Schema, model, Model, Document, Types } from "mongoose";
import { DeliveryType, WarrantyUnit } from "./DigitalProduct.js";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface IDigitalOrderItem {
  /** Reference to the purchased DigitalProduct */
  productId: Types.ObjectId;

  /** Snapshot of the product name at time of purchase */
  productName: string;

  /** Snapshot of category */
  category?: string | undefined;

  /** Delivery format type */
  deliveryType: DeliveryType;

  /** Quantity purchased for this line item */
  quantity: number;

  /** Unit price paid per item in IDR */
  unitPrice: number;

  /** Total price for this line item in IDR (unitPrice * quantity) */
  totalPrice: number;

  /** Wholesale discount amount saved in IDR */
  discountAmount?: number | undefined;

  /** Wholesale tier minimum quantity applied (if any) */
  bulkTierMinQty?: number | undefined;

  /** Delivered stock content / credential(s) */
  itemContent?: string | undefined;

  /** Telegram File ID if deliveryType is FILE */
  fileId?: string | undefined;

  /** External document/file download URL or local path if deliveryType is FILE */
  fileUrl?: string | undefined;

  /** Dynamic webhook response or payload if deliveryType is DYNAMIC_API */
  dynamicResponse?: string | undefined;

  /** Optional custom note / delivery message at time of purchase */
  deliveryMessage?: string | undefined;

  /** Snapshot: warranty duration value (0 = no warranty) */
  warrantyDuration?: number | undefined;

  /** Snapshot: warranty unit */
  warrantyUnit?: WarrantyUnit | undefined;

  /** Calculated expiry timestamp for warranty */
  warrantyExpiresAt?: Date | undefined;

  /** Maximum allowed warranty claims for this order line item */
  maxClaims?: number | undefined;

  /** Number of claims filed against this order line item */
  claimsCount?: number | undefined;
}

export interface IDigitalOrder {
  /** Unique Order Reference (e.g. "DIGI-1718000000-1234") */
  orderId: string;

  /** Telegram numeric user ID of buyer */
  userId: string;

  /** Array of multi-item purchase line items */
  items?: IDigitalOrderItem[] | undefined;

  /** Reference to the primary purchased DigitalProduct (legacy / single-item compat) */
  productId?: Types.ObjectId | undefined;

  /** Snapshot of the primary product name (legacy / single-item compat) */
  productName?: string | undefined;

  /** Total number of items purchased across all line items */
  quantity: number;

  /** Total price paid in IDR */
  price: number;

  /** Unit price paid per item in IDR (for single item orders) */
  unitPrice?: number | undefined;

  /** Wholesale discount amount saved in IDR */
  discountAmount?: number | undefined;

  /** Wholesale tier minimum quantity applied (if any) */
  bulkTierMinQty?: number | undefined;

  /** The delivered stock content/credential (for single item orders) */
  itemContent?: string | undefined;

  /** Optional custom note / delivery message at time of purchase */
  deliveryMessage?: string | undefined;

  /** Snapshot: warranty duration value (0 = no warranty) */
  warrantyDuration?: number | undefined;

  /** Snapshot: warranty unit */
  warrantyUnit?: WarrantyUnit | undefined;

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

const digitalOrderItemSchema = new Schema<IDigitalOrderItem>(
  {
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
    category: {
      type: String,
      trim: true,
      default: "Umum",
    },
    deliveryType: {
      type: String,
      enum: ["CREDENTIAL", "FILE", "DYNAMIC_API", "MANUAL_PREORDER"],
      default: "CREDENTIAL",
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least 1"],
      default: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
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
      trim: true,
      default: "",
    },
    fileId: {
      type: String,
      trim: true,
    },
    fileUrl: {
      type: String,
      trim: true,
    },
    dynamicResponse: {
      type: String,
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
  },
  { _id: false }
);

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
    items: {
      type: [digitalOrderItemSchema],
      default: [],
    },
    productId: {
      type: Schema.Types.ObjectId,
      ref: "DigitalProduct",
      required: false,
    },
    productName: {
      type: String,
      required: false,
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
      required: false,
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
