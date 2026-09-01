import { Schema, model, Model, Document, Types } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

export interface ICartItem {
  /** Reference to the digital product */
  productId: Types.ObjectId;

  /** Optional variant identifier */
  variantId?: string | undefined;

  /** Number of units requested (positive integer >= 1) */
  quantity: number;

  /** Snapshot of unit price when added to cart in IDR */
  priceAtAdded: number;

  /** When this line item was added to the cart */
  addedAt?: Date | undefined;
}

export interface ICart {
  /** Telegram numeric user ID owning this shopping cart */
  userId: string;

  /** Array of items currently in the cart */
  items: ICartItem[];

  /** Timestamp when cart was created */
  createdAt: Date;

  /** Timestamp when cart was last updated (used for TTL auto-expiration) */
  updatedAt: Date;
}

export type CartDocument = Document<unknown, {}, ICart> &
  ICart & { _id: Types.ObjectId };

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const cartItemSchema = new Schema<ICartItem>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "DigitalProduct",
      required: [true, "Product ID is required in cart item"],
    },
    variantId: {
      type: String,
      trim: true,
      default: undefined,
    },
    quantity: {
      type: Number,
      required: [true, "Quantity is required"],
      min: [1, "Quantity must be at least 1"],
      default: 1,
    },
    priceAtAdded: {
      type: Number,
      required: [true, "Price at added is required"],
      min: [0, "Price cannot be negative"],
    },
    addedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  { _id: false }
);

const cartSchema = new Schema<ICart>(
  {
    userId: {
      type: String,
      required: [true, "User ID is required"],
      unique: true,
      index: true,
      trim: true,
    },
    items: {
      type: [cartItemSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// TTL index: automatically remove abandoned carts after 24 hours (86400 seconds) of inactivity
cartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

// ============================================================================
//  3. Model
// ============================================================================

export const Cart: Model<ICart> = model<ICart>("Cart", cartSchema);
