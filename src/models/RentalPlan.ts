import { Schema, model } from "mongoose";

export interface IRentalPlan {
  code: string;
  name: string;
  durationDays: number;
  price: number;
  enabledFeatures: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IRentalPlan>({
  code: { type: String, required: true, unique: true, match: /^[a-z0-9_-]{1,40}$/ },
  name: { type: String, required: true, maxlength: 80 },
  durationDays: { type: Number, required: true, min: 1, max: 3650, validate: Number.isInteger },
  price: { type: Number, required: true, min: 1, max: 1_000_000_000, validate: Number.isSafeInteger },
  enabledFeatures: { type: [String], default: ["digital", "affiliate"] },
  enabled: { type: Boolean, default: true },
}, { timestamps: true });

export const RentalPlan = model<IRentalPlan>("RentalPlan", schema);
