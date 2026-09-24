import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailOtpService {
  tenantId: string; code: string; name: string; icon: string; enabled: boolean; description?: string;
  rentalDurationMinutes: number; cooldownMinutes: number; senderPatterns: string[]; subjectPatterns: string[];
  otpPatterns: string[]; allowMagicLink: boolean; allowVerificationLink: boolean; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IEmailOtpService>({
  code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
  name: { type: String, required: true, trim: true, maxlength: 80 }, icon: { type: String, default: "📧", maxlength: 12 },
  enabled: { type: Boolean, default: true, index: true }, description: { type: String, maxlength: 500 },
  rentalDurationMinutes: { type: Number, required: true, min: 1, max: 1440, default: 20 },
  cooldownMinutes: { type: Number, required: true, min: 0, max: 10080, default: 5 },
  senderPatterns: { type: [String], default: [] }, subjectPatterns: { type: [String], default: [] }, otpPatterns: { type: [String], default: [] },
  allowMagicLink: { type: Boolean, default: false }, allowVerificationLink: { type: Boolean, default: false },
}, { timestamps: true, versionKey: false });
schema.index({ code: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailOtpService = model<IEmailOtpService>("EmailOtpService", schema);
