import { Schema, model, type InferSchemaType } from "mongoose";

const region = new Schema({ slug: { type: String, required: true }, name: { type: String, required: true }, country: { type: String, required: true } }, { _id: false });
const size = new Schema({ slug: { type: String, required: true }, cpu: { type: Number, required: true, min: 1 }, ram: { type: String, required: true }, disk: { type: String, required: true }, transfer: { type: String, required: true }, price: { type: String, required: true } }, { _id: false });
const os = new Schema({ key: { type: String, required: true }, name: { type: String, required: true }, slug: { type: String, required: true }, family: { type: String, enum: ["linux", "windows"], required: true }, installerImage: { type: String, default: null }, windowsImageName: { type: String, default: null } }, { _id: false });
const schema = new Schema({ _id: { type: String, default: "platform" }, regions: { type: [region], default: [] }, sizes: { type: [size], default: [] }, os: { type: [os], default: [] } }, { versionKey: false, timestamps: true });
export const VpsCatalog = model("VpsCatalog", schema);
export type IVpsCatalog = InferSchemaType<typeof schema>;
