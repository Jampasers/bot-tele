import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export type EmailDomainAliasStatus = "RESERVED" | "ACTIVE" | "RETIRED" | "FAILED";
export interface IEmailDomainAlias {
  tenantId: string; domainId: string; address: string; localPart: string; cloudflareZoneId: string;
  cloudflareRuleId?: string; status: EmailDomainAliasStatus; rentalId?: string; cleanupAfter?: Date;
  ruleDeleted: boolean; createdAt: Date; retiredAt?: Date;
}
const schema = new Schema<IEmailDomainAlias>({
  domainId: { type: String, required: true, index: true }, address: { type: String, required: true, lowercase: true, trim: true },
  localPart: { type: String, required: true }, cloudflareZoneId: { type: String, required: true }, cloudflareRuleId: String,
  status: { type: String, enum: ["RESERVED", "ACTIVE", "RETIRED", "FAILED"], default: "RESERVED", index: true },
  rentalId: String, cleanupAfter: Date, ruleDeleted: { type: Boolean, default: false }, retiredAt: Date,
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
// Retired and failed addresses remain here permanently and can never be allocated again.
schema.index({ address: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailDomainAlias = model<IEmailDomainAlias>("EmailDomainAlias", schema);
