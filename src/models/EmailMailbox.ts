import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export type EmailMailboxStatus = "AVAILABLE" | "RESERVED" | "RENTED" | "COOLDOWN" | "DISABLED" | "BROKEN";
export interface IEmailMailbox {
  tenantId: string; providerId: string; email: string; username: string; credentialEncrypted: string;
  status: EmailMailboxStatus; reservedBy?: string; reservedUntil?: Date; rentedBy?: string; rentedUntil?: Date;
  cooldownUntil?: Date; lastCheckedAt?: Date; lastSuccessfulLoginAt?: Date; lastError?: string;
  lastUid: number; totalRentals: number; totalMessages: number; enabled: boolean; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IEmailMailbox>({
  providerId: { type: String, required: true, index: true }, email: { type: String, required: true, trim: true, lowercase: true },
  username: { type: String, required: true, trim: true }, credentialEncrypted: { type: String, required: true, select: false },
  status: { type: String, enum: ["AVAILABLE", "RESERVED", "RENTED", "COOLDOWN", "DISABLED", "BROKEN"], default: "AVAILABLE", index: true },
  reservedBy: String, reservedUntil: Date, rentedBy: String, rentedUntil: Date, cooldownUntil: Date,
  lastCheckedAt: Date, lastSuccessfulLoginAt: Date, lastError: { type: String, maxlength: 300, select: false },
  lastUid: { type: Number, default: 0, min: 0 }, totalRentals: { type: Number, default: 0, min: 0 },
  totalMessages: { type: Number, default: 0, min: 0 }, enabled: { type: Boolean, default: true, index: true },
}, { timestamps: true, versionKey: false });
schema.index({ email: 1 }, { unique: true });
schema.index({ providerId: 1, status: 1, enabled: 1 });
schema.plugin(tenantPlugin);
export const EmailMailbox = model<IEmailMailbox>("EmailMailbox", schema);
