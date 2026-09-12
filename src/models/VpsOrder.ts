import { Schema, model } from "mongoose";

export interface IVpsOrder {
  _id: string; tenantId: string; buyerId: string; chatId: string;
  service: "purchase" | "install";
  snapshot: { planId: string; planName: string; size: string; region: string; os: string; image: string; price: number; vcpus: number; memory: number; disk: number };
  paymentStatus: "unpaid" | "paying" | "paid" | "refunding" | "refunded" | "cancelled";
  paymentMethod: "balance" | "qris" | null; paymentPaidAt: Date | null;
  paymentInvoice?: { reference: string; merchantId: string; amount: number; createdAt: Date; expiresAt: Date; matchedTransactionId?: string; paidAt?: Date };
  paymentInvoiceLeaseUntil: Date | null; refundReason: string | null; refundedAt: Date | null;
  stage: "queued" | "creating" | "droplet" | "ssh" | "installing" | "rebooting" | "monitoring" | "ready" | "needs_token" | "review" | "failed" | "cancelled";
  resumeStage: string | null; credentialId: string | null; accountId: string | null;
  dropletId: number | null; publicIp: string | null; createName: string;
  createAttemptedAt: Date | null; reservationActive: boolean;
  passwordEncrypted: string; lastError: string | null; evidence: string;
  installerLogUrl: string | null; stageStartedAt: Date; rdpSuccesses: number;
  lockOwner: string | null; lockUntil: Date | null; nextRunAt: Date;
  rebootState: "idle" | "requested" | "submitting" | "running" | "completed" | "errored" | "review";
  rebootActionId: number | null; rebootRequestedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}
const invoice = new Schema({ reference: String, merchantId: String, amount: Number, createdAt: Date, expiresAt: Date, matchedTransactionId: String, paidAt: Date }, { _id: false });
const schema = new Schema<IVpsOrder>({
  _id: { type: String, required: true }, tenantId: { type: String, required: true, enum: ["platform"] },
  buyerId: { type: String, required: true }, chatId: { type: String, required: true }, service: { type: String, required: true, enum: ["purchase", "install"] },
  snapshot: { type: new Schema({ planId: String, planName: String, size: String, region: String, os: String, image: String, price: { type: Number, min: 1, required: true }, vcpus: Number, memory: Number, disk: Number }, { _id: false }), required: true, immutable: true },
  paymentStatus: { type: String, enum: ["unpaid", "paying", "paid", "refunding", "refunded", "cancelled"], default: "unpaid" },
  paymentMethod: { type: String, enum: ["balance", "qris", null], default: null }, paymentPaidAt: { type: Date, default: null }, paymentInvoice: { type: invoice, default: undefined },
  paymentInvoiceLeaseUntil: { type: Date, default: null }, refundReason: { type: String, default: null }, refundedAt: { type: Date, default: null },
  stage: { type: String, enum: ["queued", "creating", "droplet", "ssh", "installing", "rebooting", "monitoring", "ready", "needs_token", "review", "failed", "cancelled"], default: "queued" },
  resumeStage: { type: String, default: null }, credentialId: { type: String, default: null }, accountId: { type: String, default: null },
  dropletId: { type: Number, default: null }, publicIp: { type: String, default: null }, createName: { type: String, required: true, unique: true },
  createAttemptedAt: { type: Date, default: null }, reservationActive: { type: Boolean, default: false }, passwordEncrypted: { type: String, required: true, select: false },
  lastError: { type: String, default: null }, evidence: { type: String, default: "Belum diperiksa" }, installerLogUrl: { type: String, default: null },
  stageStartedAt: { type: Date, default: Date.now }, rdpSuccesses: { type: Number, default: 0 }, lockOwner: { type: String, default: null }, lockUntil: { type: Date, default: null }, nextRunAt: { type: Date, default: Date.now },
  rebootState: { type: String, enum: ["idle", "requested", "submitting", "running", "completed", "errored", "review"], default: "idle" },
  rebootActionId: { type: Number, default: null }, rebootRequestedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false, strict: "throw" });
schema.index({ tenantId: 1, buyerId: 1, createdAt: -1 });
schema.index({ paymentStatus: 1, nextRunAt: 1, lockUntil: 1 });
schema.index({ accountId: 1, reservationActive: 1 });
schema.index({ accountId: 1, dropletId: 1 }, { unique: true, partialFilterExpression: { dropletId: { $type: "number" } } });
export const VpsOrder = model<IVpsOrder>("VpsOrder", schema);
