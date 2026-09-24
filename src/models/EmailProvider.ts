import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export type EmailAuthType = "PASSWORD" | "APP_PASSWORD";
export interface IEmailProvider {
  tenantId: string; code: string; name: string; icon: string; protocol: "IMAP";
  imapHost: string; imapPort: number; imapSecure: boolean; authType: EmailAuthType;
  enabled: boolean; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IEmailProvider>({
  code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  icon: { type: String, default: "📮", maxlength: 12 },
  protocol: { type: String, enum: ["IMAP"], default: "IMAP", required: true },
  imapHost: { type: String, required: true, trim: true, maxlength: 255 },
  imapPort: { type: Number, required: true, min: 1, max: 65535, default: 993 },
  imapSecure: { type: Boolean, default: true },
  authType: { type: String, enum: ["PASSWORD", "APP_PASSWORD"], default: "APP_PASSWORD" },
  enabled: { type: Boolean, default: true, index: true },
}, { timestamps: true, versionKey: false });
schema.index({ code: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailProvider = model<IEmailProvider>("EmailProvider", schema);
