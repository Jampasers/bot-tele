import { Schema, model, type Types } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";
import type { EmailResourceType } from "./EmailUsage.js";

export type EmailRentalStatus = "RESERVED" | "WAITING_PAYMENT" | "PROCESSING" | "ACTIVE" | "COMPLETED" | "EXPIRED" | "CANCELLED" | "FAILED";
export interface IEmailRental {
  _id: Types.ObjectId; tenantId: string; userId: string; serviceId: string; resourceType: EmailResourceType; resourceId: string; emailAddress: string;
  providerId?: string; providerName: string; serviceSnapshot: { code: string; name: string; icon: string; durationMinutes: number; cooldownMinutes: number; senderPatterns: string[]; subjectPatterns: string[]; otpPatterns: string[]; allowMagicLink: boolean; allowVerificationLink: boolean };
  price: number; paymentMethod?: "BALANCE" | "QRIS"; paymentReference?: string; qrisAmount?: number; paymentMerchantId?: string;
  paymentConfigVersion?: number; paymentExpiresAt?: Date; matchedTransactionId?: string; qrisChatId?: string; qrisMessageId?: number; status: EmailRentalStatus;
  createdAt: Date; reservedAt?: Date; reservationExpiresAt?: Date; paidAt?: Date; startedAt?: Date; expiresAt?: Date;
  completedAt?: Date; lastMessageAt?: Date; startUid: number; usageCommitted: boolean; counterReleased: boolean;
}
const serviceSnapshot = new Schema({
  code: { type: String, required: true }, name: { type: String, required: true }, icon: { type: String, required: true },
  durationMinutes: { type: Number, required: true }, cooldownMinutes: { type: Number, required: true },
  senderPatterns: { type: [String], default: [] }, subjectPatterns: { type: [String], default: [] }, otpPatterns: { type: [String], default: [] },
  allowMagicLink: { type: Boolean, default: false }, allowVerificationLink: { type: Boolean, default: false },
}, { _id: false });
const schema = new Schema<IEmailRental>({
  userId: { type: String, required: true, index: true }, serviceId: { type: String, required: true, index: true },
  resourceType: { type: String, enum: ["MAILBOX", "DOMAIN_ALIAS"], required: true }, resourceId: { type: String, required: true, index: true },
  emailAddress: { type: String, required: true, lowercase: true }, providerId: String, providerName: { type: String, required: true },
  serviceSnapshot: { type: serviceSnapshot, required: true }, price: { type: Number, required: true, min: 1 },
  paymentMethod: { type: String, enum: ["BALANCE", "QRIS"] }, paymentReference: String, qrisAmount: Number, paymentMerchantId: String,
  paymentConfigVersion: Number, paymentExpiresAt: Date, matchedTransactionId: String, qrisChatId: String, qrisMessageId: Number,
  status: { type: String, enum: ["RESERVED", "WAITING_PAYMENT", "PROCESSING", "ACTIVE", "COMPLETED", "EXPIRED", "CANCELLED", "FAILED"], default: "WAITING_PAYMENT", index: true },
  reservedAt: Date, reservationExpiresAt: Date, paidAt: Date, startedAt: Date, expiresAt: Date, completedAt: Date, lastMessageAt: Date,
  startUid: { type: Number, default: 0 }, usageCommitted: { type: Boolean, default: false }, counterReleased: { type: Boolean, default: false },
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, status: 1, createdAt: -1 });
schema.index({ resourceType: 1, resourceId: 1, status: 1 });
schema.index({ status: 1, reservationExpiresAt: 1 });
schema.plugin(tenantPlugin);
export const EmailRental = model<IEmailRental>("EmailRental", schema);
