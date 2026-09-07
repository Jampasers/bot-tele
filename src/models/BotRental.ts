import { Schema, model } from "mongoose";

export type RentalStatus = "pending" | "active" | "expired_grace" | "suspended" | "terminated";

export interface IBotRental {
  tenantId: string;
  ownerTelegramId: string;
  adminTelegramIds: string[];
  botTokenEncrypted: string;
  botId: string;
  botUsername: string;
  status: RentalStatus;
  plan: string;
  enabledFeatures: string[];
  startedAt: Date | null;
  expiresAt: Date;
  graceEndsAt: Date | null;
  appliedRentalPaymentIds: string[];
  sentExpiryAlerts: string[];
  lastExpiryAlertAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Platform control-plane collection: never apply the tenant data plugin here.
const schema = new Schema<IBotRental>({
  tenantId: { type: String, required: true, unique: true },
  ownerTelegramId: { type: String, required: true, match: /^\d+$/ },
  adminTelegramIds: { type: [String], default: [] },
  botTokenEncrypted: { type: String, required: true, select: false },
  botId: { type: String, required: true, unique: true },
  botUsername: { type: String, required: true },
  status: { type: String, enum: ["pending", "active", "expired_grace", "suspended", "terminated"], default: "pending", index: true },
  plan: { type: String, required: true },
  enabledFeatures: { type: [String], default: ["digital", "affiliate"] },
  startedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: true },
  graceEndsAt: { type: Date, default: null },
  appliedRentalPaymentIds: { type: [String], default: [], select: false },
  sentExpiryAlerts: { type: [String], default: [] },
  lastExpiryAlertAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ ownerTelegramId: 1, status: 1, createdAt: -1 });

export const BotRental = model<IBotRental>("BotRental", schema);
