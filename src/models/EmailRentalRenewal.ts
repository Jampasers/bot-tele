import { Schema, model, type Types } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailRentalRenewal {
  _id: Types.ObjectId; tenantId: string; rentalId: string; userId: string; price: number; durationMinutes: number;
  paymentMethod?: "BALANCE" | "QRIS"; paymentReference?: string; qrisAmount?: number;
  paymentMerchantId?: string; paymentConfigVersion?: number; paymentExpiresAt?: Date;
  matchedTransactionId?: string; status: "WAITING_PAYMENT" | "PROCESSING" | "PAID" | "CANCELLED" | "FAILED";
  createdAt: Date; paidAt?: Date;
}
const schema = new Schema<IEmailRentalRenewal>({
  rentalId: { type: String, required: true, index: true }, userId: { type: String, required: true, index: true },
  price: { type: Number, required: true, min: 1 }, durationMinutes: { type: Number, required: true, min: 1, max: 1440 },
  paymentMethod: { type: String, enum: ["BALANCE", "QRIS"] }, paymentReference: String, qrisAmount: Number,
  paymentMerchantId: String, paymentConfigVersion: Number, paymentExpiresAt: Date, matchedTransactionId: String,
  status: { type: String, enum: ["WAITING_PAYMENT", "PROCESSING", "PAID", "CANCELLED", "FAILED"], default: "WAITING_PAYMENT", index: true },
  createdAt: { type: Date, default: Date.now }, paidAt: Date,
}, { versionKey: false });
schema.index({ rentalId: 1 }, { unique: true, partialFilterExpression: { status: "WAITING_PAYMENT" } });
schema.index({ paymentReference: 1 }, { unique: true, partialFilterExpression: { paymentReference: { $type: "string" } } });
schema.plugin(tenantPlugin);
export const EmailRentalRenewal = model<IEmailRentalRenewal>("EmailRentalRenewal", schema);
