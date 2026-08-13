import { Schema, model, Model } from "mongoose";

// ============================================================================
//  1. TypeScript Interface
// ============================================================================

/** The possible lifecycle states of an OTP order. */
export type OrderStatus = "PENDING" | "COMPLETED" | "CANCELED";

/**
 * Shape of an Order document in application code.
 * createdAt is managed manually (not via timestamps) so it maps to the
 * field name the request specifies.
 */
export interface IOrder {
  /** Telegram numeric user ID — mirrors User.telegramId but stored as Number. */
  userId: number;

  /** SMSBower activation ID — used for status polling and cancellation. */
  activationId: string;

  /** Service code sent to the SMSBower API (e.g. "wa", "tg"). */
  service: string;

  /** Country code sent to the SMSBower API (e.g. 6 = Indonesia). */
  country: number;

  /** The phone number rented for this activation. */
  phoneNumber: string;

  /** Cost charged to the user's balance (in the same unit as User.balance). */
  cost: number;

  /** Lifecycle state of the order. */
  status: OrderStatus;

  /**
   * The OTP code received from SMSBower.
   * Only present once status transitions to "COMPLETED".
   */
  code?: string;

  /** When the order was created. */
  createdAt: Date;
}

// ============================================================================
//  2. Mongoose Schema
// ============================================================================

const orderSchema = new Schema<IOrder>(
  {
    userId: {
      type:     Number,
      required: [true, "userId is required"],
      index:    true, // fast look-ups by user
    },
    activationId: {
      type:     String,
      required: [true, "activationId is required"],
      unique:   true, // one document per SMSBower activation
      trim:     true,
    },
    service: {
      type:     String,
      required: [true, "service is required"],
      trim:     true,
    },
    country: {
      type:     Number,
      required: [true, "country is required"],
    },
    phoneNumber: {
      type:     String,
      required: [true, "phoneNumber is required"],
      trim:     true,
    },
    cost: {
      type:     Number,
      required: [true, "cost is required"],
      min:      [0, "cost cannot be negative"],
    },
    status: {
      type:    String,
      enum:    ["PENDING", "COMPLETED", "CANCELED"] satisfies OrderStatus[],
      default: "PENDING" as OrderStatus,
      index:   true, // querying active (PENDING) orders is common
    },
    code: {
      type:    String,
      trim:    true,
      default: undefined, // absent until an OTP arrives
    },
    createdAt: {
      type:    Date,
      default: () => new Date(),
      index:   true,
    },
  },
  {
    // We manage createdAt manually above; disable automatic timestamps so
    // Mongoose doesn't create a separate `updatedAt` field (not in the spec).
    timestamps: false,
    versionKey: false,
  }
);

// ============================================================================
//  3. Model
// ============================================================================

/**
 * Mongoose model for the `orders` collection.
 *
 * @example
 * import { Order } from "../../models/Order.js";
 * const order = await Order.findOne({ activationId: "12345" });
 */
export const Order: Model<IOrder> = model<IOrder>("Order", orderSchema);
