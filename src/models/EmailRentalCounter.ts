import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailRentalCounter { tenantId: string; userId: string; activeCount: number; }
const schema = new Schema<IEmailRentalCounter>({ userId: { type: String, required: true }, activeCount: { type: Number, min: 0, default: 0 } }, { versionKey: false });
schema.index({ userId: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailRentalCounter = model<IEmailRentalCounter>("EmailRentalCounter", schema);
