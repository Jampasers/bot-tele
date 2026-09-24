import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailPaymentEffect { tenantId: string; effectId: string; rentalId: string; userId: string; kind: "BALANCE_DEBIT" | "REFUND"; amount: number; createdAt: Date; }
const schema = new Schema<IEmailPaymentEffect>({
  effectId: { type: String, required: true }, rentalId: { type: String, required: true }, userId: { type: String, required: true },
  kind: { type: String, enum: ["BALANCE_DEBIT", "REFUND"], required: true }, amount: { type: Number, required: true, min: 1 },
  createdAt: { type: Date, default: Date.now },
}, { versionKey: false });
schema.index({ effectId: 1, kind: 1 }, { unique: true });
schema.plugin(tenantPlugin);
export const EmailPaymentEffect = model<IEmailPaymentEffect>("EmailPaymentEffect", schema);
