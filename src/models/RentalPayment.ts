import { Schema, model } from "mongoose";

export interface IRentalPayment {
  rentalId: string;
  tenantId: string;
  ownerTelegramId: string;
  planId: string;
  amount: number;
  baseAmount: number;
  durationDays: number;
  provider: "GOPAY";
  providerReference: string;
  merchantId: string;
  matchedTransactionId?: string;
  status: "pending" | "processing" | "paid" | "expired";
  expiresAt: Date;
  createdAt: Date;
  paidAt?: Date;
}

// Platform billing ledger: access only through rentalPayment.service, never tenant CRUD.
const schema = new Schema<IRentalPayment>({
  rentalId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  ownerTelegramId: { type: String, required: true },
  planId: { type: String, required: true },
  amount: { type: Number, required: true, min: 1 },
  baseAmount: { type: Number, required: true, min: 1 },
  durationDays: { type: Number, required: true, min: 1, max: 3650 },
  provider: { type: String, enum: ["GOPAY"], default: "GOPAY" },
  providerReference: { type: String, required: true, unique: true },
  merchantId: { type: String, required: true },
  matchedTransactionId: { type: String },
  status: { type: String, enum: ["pending", "processing", "paid", "expired"], default: "pending", index: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date },
}, { versionKey: false });
schema.index({ merchantId: 1, matchedTransactionId: 1 }, {
  unique: true, partialFilterExpression: { matchedTransactionId: { $type: "string" } },
});
export const RentalPayment = model<IRentalPayment>("RentalPayment", schema);
