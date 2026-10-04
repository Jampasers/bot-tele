import { Schema, model } from "mongoose";

export interface IVpsInstallInvite {
  _id: string;
  tenantId: "platform";
  createdBy: string;
  recipientId: string | null;
  sourceMode: "any" | "digitalocean" | "direct";
  orderId: string;
  claimedBy: string | null;
  redeemedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IVpsInstallInvite>({
  _id: { type: String, required: true, match: /^[a-f0-9]{32}$/ },
  tenantId: { type: String, required: true, enum: ["platform"] },
  createdBy: { type: String, required: true },
  recipientId: { type: String, default: null },
  sourceMode: { type: String, enum: ["any", "digitalocean", "direct"], required: true },
  orderId: { type: String, required: true, unique: true, immutable: true },
  claimedBy: { type: String, default: null },
  redeemedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false, strict: "throw" });
// Keep expired/redeemed records for audit and interrupted-payment recovery.
schema.index({ tenantId: 1, createdAt: -1 });
export const VpsInstallInvite = model<IVpsInstallInvite>("VpsInstallInvite", schema);
