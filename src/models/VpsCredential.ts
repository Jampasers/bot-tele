import { Schema, model, type InferSchemaType } from "mongoose";

const schema = new Schema({
  _id: { type: String, required: true }, tenantId: { type: String, default: "platform", enum: ["platform"] },
  label: { type: String, required: true, maxlength: 80 }, tokenEncrypted: { type: String, required: true, select: false },
  priority: { type: Number, default: 100 }, enabled: { type: Boolean, default: true },
  accountId: { type: String, required: true }, accountName: { type: String, default: "" },
  accountStatus: { type: String, default: "unknown" }, statusMessage: { type: String, default: "" },
  health: { type: String, default: "unknown" }, checkedAt: { type: Date, default: null },
  dropletLimit: { type: Number, default: null }, used: { type: Number, default: null }, reservations: { type: Number, default: null },
  lastCreateResult: { type: String, default: null }, lastCreateAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });
schema.index({ enabled: 1, priority: 1 });
schema.index({ accountId: 1 });
export const VpsCredential = model("VpsCredential", schema);
export type IVpsCredential = InferSchemaType<typeof schema>;

// One lease per provider account, shared by all tokens for that account/team.
const account = new Schema({ _id: { type: String, required: true }, lockOwner: { type: String, default: null }, lockUntil: { type: Date, default: null },
  reservations: { type: [new Schema({ orderId: { type: String, required: true }, createName: { type: String, required: true }, credentialId: { type: String, required: true } }, { _id: false })], default: [] },
}, { versionKey: false });
// Unique across account documents: overlapping workers cannot place the same
// order on two accounts. Empty ticket arrays are excluded from the unique index.
account.index({ "reservations.orderId": 1 }, { unique: true, partialFilterExpression: { "reservations.orderId": { $type: "string" } } });
export const VpsAccount = model("VpsAccount", account);
