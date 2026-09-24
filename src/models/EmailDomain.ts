import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailDomain {
  tenantId: string; domain: string; provider: "CLOUDFLARE"; zoneId: string; enabled: boolean; sellable: boolean;
  routingMode: "FORWARD" | "WORKER"; destinationMailboxId: string; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IEmailDomain>({
  domain: { type: String, required: true, lowercase: true, trim: true }, provider: { type: String, enum: ["CLOUDFLARE"], default: "CLOUDFLARE" },
  zoneId: { type: String, required: true, trim: true }, enabled: { type: Boolean, default: true }, sellable: { type: Boolean, default: false },
  routingMode: { type: String, enum: ["FORWARD", "WORKER"], default: "FORWARD" }, destinationMailboxId: { type: String, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ domain: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailDomain = model<IEmailDomain>("EmailDomain", schema);
