import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailMessage {
  tenantId: string; sourceType: "MAILBOX" | "DOMAIN_ALIAS"; sourceId: string; messageId: string; uid?: number;
  mailboxId?: string; domainAliasId?: string; rentalId?: string; sender: string; recipient: string; subject: string;
  receivedAt: Date; otpCode?: string; verificationLink?: string; magicLink?: string; preview: string;
  dispatchStatus: "READY" | "SENDING" | "SENT" | "IGNORED" | "FAILED"; createdAt: Date;
}
const schema = new Schema<IEmailMessage>({
  sourceType: { type: String, enum: ["MAILBOX", "DOMAIN_ALIAS"], required: true }, sourceId: { type: String, required: true },
  messageId: { type: String, required: true }, uid: Number, mailboxId: String, domainAliasId: String, rentalId: String,
  sender: { type: String, required: true, maxlength: 320 }, recipient: { type: String, required: true, maxlength: 320 },
  subject: { type: String, required: true, maxlength: 500 }, receivedAt: { type: Date, required: true },
  otpCode: { type: String, maxlength: 24 }, verificationLink: { type: String, maxlength: 2048 }, magicLink: { type: String, maxlength: 2048 },
  preview: { type: String, maxlength: 300, default: "" }, dispatchStatus: { type: String, enum: ["READY", "SENDING", "SENT", "IGNORED", "FAILED"], default: "READY" },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
schema.index({ sourceType: 1, sourceId: 1, messageId: 1 }, { unique: true });
schema.index({ rentalId: 1, receivedAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
schema.plugin(tenantPlugin);
export const EmailMessage = model<IEmailMessage>("EmailMessage", schema);
