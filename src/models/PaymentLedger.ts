import { Schema, model } from "mongoose";

// Global uniqueness coordinates all tenants that use the same merchant, including
// platform store invoices and rental invoices. These are private service models.
const reservation = new Schema({
  _id: { type: String, required: true },
  merchantId: { type: String, required: true },
  tenantId: { type: String, required: true },
  amount: { type: Number, required: true },
  reservedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
reservation.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const claim = new Schema({
  _id: { type: String, required: true },
  merchantId: { type: String, required: true },
  transactionId: { type: String, required: true },
  invoiceReference: { type: String, required: true },
  tenantId: { type: String, required: true },
  kind: { type: String, enum: ["store", "rental", "vps"], required: true },
  paidAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
// Claims deliberately have no TTL: process restarts must not permit payment replay.
export const PaymentAmountReservation = model("PaymentAmountReservation", reservation);
export const PaymentSettlementClaim = model("PaymentSettlementClaim", claim);
