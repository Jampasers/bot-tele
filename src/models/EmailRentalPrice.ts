import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";
import type { EmailResourceType } from "./EmailUsage.js";

export interface IEmailRentalPrice {
  tenantId: string; serviceId: string; providerId?: string; resourceType: EmailResourceType;
  price: number; enabled: boolean; createdAt: Date; updatedAt: Date;
}
const schema = new Schema<IEmailRentalPrice>({
  serviceId: { type: String, required: true, index: true }, providerId: { type: String, default: undefined },
  resourceType: { type: String, enum: ["MAILBOX", "DOMAIN_ALIAS"], required: true },
  price: { type: Number, required: true, min: 1 }, enabled: { type: Boolean, default: true, index: true },
}, { timestamps: true, versionKey: false });
schema.index({ serviceId: 1, resourceType: 1, providerId: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailRentalPrice = model<IEmailRentalPrice>("EmailRentalPrice", schema);
