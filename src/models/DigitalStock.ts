import { tenantPlugin } from "../tenant/tenantPlugin.js";
import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface IDigitalStock {
  tenantId: string;
  /** The product this stock item belongs to */
  productId: Types.ObjectId;

  /** The actual stock payload (credentials, license key, voucher code, etc.) */
  content: string;

  /** Admin-defined public reference used by the buyer to request a TOTP code. */
  accountCode?: string;

  /** AES-GCM encrypted Base32 TOTP secret. Excluded from queries by default. */
  totpSecretEncrypted?: string;

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
    accountCode: {
      type: String,
      trim: true,
      uppercase: true,
      match: [/^[A-Z0-9_-]{3,40}$/, "Invalid accountCode format"],
      default: undefined,
    },
    totpSecretEncrypted: {
      type: String,
      select: false,
      default: undefined,
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

// tenantPlugin prefixes this index with tenantId and converts sparse to a
// partial index, so legacy stock without an accountCode remains valid while an
// account code is unique inside its own tenant.
digitalStockSchema.index({ accountCode: 1 }, { unique: true, sparse: true });

// ============================================================================
//  3. Model
// ============================================================================

digitalStockSchema.plugin(tenantPlugin);

export const DigitalStock: Model<IDigitalStock> = model<IDigitalStock>(
  "DigitalStock",
  digitalStockSchema
);
