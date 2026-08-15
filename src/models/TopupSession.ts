import { Schema, model, Model, Document } from "mongoose";

// ============================================================================
//  TopupSession — tracks a pending QRIS payment initiated in the bot
//
//  One document is created every time a user is sent a QRIS invoice.
//  After payment is confirmed (status → "SETTLED") the session is kept for
//  audit purposes but is no longer actively polled.
// ============================================================================

export type TopupSessionStatus =
  | "PENDING"   // QRIS sent, waiting for user to pay
  | "SETTLED"   // Payment confirmed by GoPay Merchant — balance credited
  | "EXPIRED"   // QR expired without payment (15 min timeout)
  | "CANCELLED"; // User dismissed or admin cancelled

export interface ITopupSession extends Document {
  /** Telegram numeric user ID (string to avoid JS integer overflow). */
  telegramId: string;

  /** Chat ID where the QRIS invoice message was sent. */
  chatId: number;

  /** The Telegram message_id of the QRIS invoice message (used to edit/delete it). */
  messageId: number;

  /** Unique order/session ID, format: `topup-<telegramId>-<timestamp>` */
  orderId: string;

  /** Base amount required (e.g. price of the service). */
  baseAmount?: number;

  /** Unique random code offset added to base amount (e.g. 10 - 499). */
  uniqueCode?: number;

  /** Total amount charged in IDR (= baseAmount + uniqueCode). */
  amountIDR: number;

  /**
   * If this top-up was triggered by an intent to buy a specific SMS service,
   * these fields are saved so the purchase can auto-execute after payment.
   */
  pendingServiceCode?: string;
  pendingCountryId?: string;

  /**
   * Type of product being purchased ("SMS" or "DIGITAL").
   */
  pendingProductType?: "SMS" | "DIGITAL";

  /**
   * If buying a digital product, the ID of the product.
   */
  pendingDigitalProductId?: string;

  /**
   * Quantity of digital product being purchased.
   */
  pendingQuantity?: number;

  /** GoPay transaction ID once matched and settled. */
  matchedTransactionId?: string;

  /** Current lifecycle state. */
  status: TopupSessionStatus;

  /** When the session was created. */
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Schema
// ─────────────────────────────────────────────────────────────────────────────

const topupSessionSchema = new Schema<ITopupSession>(
  {
    telegramId: {
      type: String,
      required: true,
      index: true,
    },
    chatId: {
      type: Number,
      required: true,
    },
    messageId: {
      type: Number,
      required: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    baseAmount: {
      type: Number,
      required: false,
    },
    uniqueCode: {
      type: Number,
      required: false,
    },
    amountIDR: {
      type: Number,
      required: true,
      min: [1, "amountIDR must be at least 1"],
    },
    pendingServiceCode: {
      type: String,
      trim: true,
      default: undefined,
    },
    pendingCountryId: {
      type: String,
      trim: true,
      default: undefined,
    },
    pendingProductType: {
      type: String,
      enum: ["SMS", "DIGITAL"],
      default: undefined,
    },
    pendingDigitalProductId: {
      type: String,
      trim: true,
      default: undefined,
    },
    pendingQuantity: {
      type: Number,
      min: 1,
      default: undefined,
    },
    matchedTransactionId: {
      type: String,
      trim: true,
      default: undefined,
    },
    status: {
      type: String,
      enum: ["PENDING", "SETTLED", "EXPIRED", "CANCELLED"] satisfies TopupSessionStatus[],
      default: "PENDING" as TopupSessionStatus,
      index: true,
    },
    createdAt: {
      type: Date,
      default: () => new Date(),
      expires: 7200, // auto-delete after 2 hours
      index: true,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  Model
// ─────────────────────────────────────────────────────────────────────────────

export const TopupSession: Model<ITopupSession> = model<ITopupSession>(
  "TopupSession",
  topupSessionSchema
);
