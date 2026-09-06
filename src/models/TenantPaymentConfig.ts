import { Schema, model } from "mongoose";
import { tenantPlugin } from "../tenant/tenantPlugin.js";

export interface ITenantPaymentConfig {
  tenantId: string;
  version: number;
  qris: { enabled: boolean; payloadEncrypted: string };
  gopayMerchant: {
    enabled: boolean;
    merchantId: string;
    clientId: string;
    storeId: string;
    emailEncrypted: string;
    passwordEncrypted: string;
    clientSecretEncrypted: string;
    accessTokenEncrypted: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ITenantPaymentConfig>({
  version: { type: Number, default: 1, min: 1 },
  qris: {
    enabled: { type: Boolean, default: false },
    payloadEncrypted: { type: String, default: "", select: false },
  },
  gopayMerchant: {
    enabled: { type: Boolean, default: false },
    merchantId: { type: String, default: "" },
    clientId: { type: String, default: "go-biz-web-new" },
    storeId: { type: String, default: "" },
    emailEncrypted: { type: String, default: "", select: false },
    passwordEncrypted: { type: String, default: "", select: false },
    clientSecretEncrypted: { type: String, default: "", select: false },
    accessTokenEncrypted: { type: String, default: "", select: false },
  },
}, { timestamps: true, strict: "throw" });
schema.plugin(tenantPlugin, { singleton: true });
export const TenantPaymentConfig = model<ITenantPaymentConfig>("TenantPaymentConfig", schema);
