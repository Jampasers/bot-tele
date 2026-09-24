import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export type EmailResourceType = "MAILBOX" | "DOMAIN_ALIAS";
export interface IEmailUsage {
  tenantId: string; emailResourceType: EmailResourceType; emailResourceId: string; serviceId: string;
  rentalId: string; usedBy: string; usedAt: Date;
}
const schema = new Schema<IEmailUsage>({
  emailResourceType: { type: String, enum: ["MAILBOX", "DOMAIN_ALIAS"], required: true },
  emailResourceId: { type: String, required: true }, serviceId: { type: String, required: true },
  rentalId: { type: String, required: true }, usedBy: { type: String, required: true }, usedAt: { type: Date, required: true, default: Date.now },
}, { versionKey: false });
// tenantPlugin prepends tenantId; emailResourceId stores the normalized email
// address so a removed/re-imported mailbox can never reset service history.
schema.index({ emailResourceId: 1, serviceId: 1 }, { unique: true });
schema.index({ serviceId: 1, usedAt: -1 });
schema.plugin(tenantPlugin);
export const EmailUsage = model<IEmailUsage>("EmailUsage", schema);
