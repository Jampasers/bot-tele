import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface IEmailRentalSettings {
  tenantId: string; maxConcurrentEmailRentalsPerUser: number; reservationMinutes: number;
  messageGraceMinutes: number; aliasGraceMinutes: number; maxConcurrentConnections: number; pollIntervalSeconds: number;
}
const schema = new Schema<IEmailRentalSettings>({
  maxConcurrentEmailRentalsPerUser: { type: Number, default: 3, min: 1, max: 20 },
  reservationMinutes: { type: Number, default: 10, min: 1, max: 60 },
  messageGraceMinutes: { type: Number, default: 5, min: 0, max: 60 },
  aliasGraceMinutes: { type: Number, default: 15, min: 1, max: 1440 },
  maxConcurrentConnections: { type: Number, default: 5, min: 1, max: 25 },
  pollIntervalSeconds: { type: Number, default: 15, min: 5, max: 300 },
}, { timestamps: true, versionKey: false });
schema.plugin(tenantPlugin, { singleton: true });
export const EmailRentalSettings = model<IEmailRentalSettings>("EmailRentalSettings", schema);
