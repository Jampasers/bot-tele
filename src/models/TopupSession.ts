import { tenantPlugin } from "../tenant/tenantPlugin.js";
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
  tenantId: string;
  paymentMerchantId?: string;
  paymentConfigVersion?: number;
  /** User identifier (telegram numeric ID or WA formatted ID). */
  telegramId: string;

  /** Platform the topup was initiated on ("telegram" | "whatsapp"). */
  platform?: "telegram" | "whatsapp";

  /** Chat ID / JID where the QRIS invoice message was sent. */
  chatId: number | string;

  /** The message ID of the QRIS invoice message (Telegram message_id or WhatsApp key ID). */
  messageId: number | string;

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
    paymentMerchantId: { type: String },
    paymentConfigVersion: { type: Number },
    telegramId: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ["telegram", "whatsapp"],
      default: "telegram",
      index: true,
    },
    chatId: {
      type: Schema.Types.Mixed,
      required: true,
    },
    messageId: {
      type: Schema.Types.Mixed,
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

topupSessionSchema.plugin(tenantPlugin);

export const TopupSession: Model<ITopupSession> = model<ITopupSession>(
  "TopupSession",
  topupSessionSchema
);
