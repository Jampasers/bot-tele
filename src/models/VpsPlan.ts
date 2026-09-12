import { Schema, model, type InferSchemaType } from "mongoose";
const schema = new Schema({
  _id: { type: String, required: true }, tenantId: { type: String, default: "platform", enum: ["platform"] },
  name: { type: String, required: true, maxlength: 80 }, serviceType: { type: String, required: true, enum: ["purchase", "install"] },
  sizeSlug: { type: String, required: true }, regions: { type: [String], required: true },
  osPrices: { type: [new Schema({ os: { type: String, required: true }, label: { type: String, required: true }, price: { type: Number, required: true, min: 1 } }, { _id: false })], required: true },
  enabled: { type: Boolean, default: true },
}, { timestamps: true, versionKey: false });
schema.index({ serviceType: 1, enabled: 1 });
export const VpsPlan = model("VpsPlan", schema);
export type IVpsPlan = InferSchemaType<typeof schema>;
