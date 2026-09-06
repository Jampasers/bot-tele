import { TenantPaymentConfig } from "../models/TenantPaymentConfig.js";
import { TopupSession } from "../models/TopupSession.js";
import { PaymentAmountReservation } from "../models/PaymentLedger.js";
import { getTenantContext, getTenantId, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { decryptSecret, encryptSecret } from "../services/crypto.js";
import { GopayMerchant } from "../services/payment/gopay-merchant.js";
import { QrisGenerator } from "../services/payment/qris.js";
import { readQrCodeImage } from "../services/payment/qr-reader.js";
import { getPlatformPaymentClients } from "./platformPayment.service.js";
import { validateTenantQrisImage, validateTenantQrisPayload } from "./paymentConfigValidation.js";

export interface PaymentClients {
  merchantId: string;
  version: number;
  generator: QrisGenerator;
  merchant: GopayMerchant;
}

const clients = new Map<string, { expiresAt: number; value: Promise<PaymentClients> }>();
const locks = new Map<string, Promise<void>>();

export async function withTenantPaymentLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = getTenantId();
  const before = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const queued = before.then(() => done);
  locks.set(key, queued);
  await before;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === queued) locks.delete(key); }
}

export function invalidateTenantPaymentConfig(tenantId: string): void { clients.delete(tenantId); }

export async function getTenantPaymentClients(): Promise<PaymentClients> {
  const tenantId = getTenantId();
  if (tenantId === PLATFORM_TENANT_ID) return getPlatformPaymentClients();
  const cached = clients.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = loadClients(tenantId);
  clients.set(tenantId, { value, expiresAt: Date.now() + 60_000 });
  try { return await value; }
  catch (error) { if (clients.get(tenantId)?.value === value) clients.delete(tenantId); throw error; }
}

async function loadClients(tenantId: string): Promise<PaymentClients> {
  const config = await TenantPaymentConfig.findOne().select(
    "+qris.payloadEncrypted +gopayMerchant.emailEncrypted +gopayMerchant.passwordEncrypted +gopayMerchant.clientSecretEncrypted +gopayMerchant.accessTokenEncrypted",
  ).lean();
  if (!config?.qris.enabled || !config.gopayMerchant.enabled || !config.gopayMerchant.merchantId) {
    throw new Error("Payment toko belum dikonfigurasi oleh administrator bot.");
  }
  const secret = (value: string, field: string) => value ? decryptSecret(value, `${tenantId}:payment:${field}`) : "";
  const merchant = config.gopayMerchant;
  return {
    merchantId: merchant.merchantId,
    version: config.version,
    generator: new QrisGenerator({ qrisStaticPayload: secret(config.qris.payloadEncrypted, "qris") }),
    merchant: new GopayMerchant({
      merchantId: merchant.merchantId,
      clientId: merchant.clientId,
      clientSecret: secret(merchant.clientSecretEncrypted, "clientSecret"),
      email: secret(merchant.emailEncrypted, "email"),
      password: secret(merchant.passwordEncrypted, "password"),
      accessToken: secret(merchant.accessTokenEncrypted, "accessToken"),
    }),
  };
}

export async function getTenantPaymentSummary(): Promise<{
  configured: boolean; qrisEnabled: boolean; gopayEnabled: boolean; merchantId?: string; version?: number;
}> {
  const config = await TenantPaymentConfig.findOne().lean();
  if (!config) return { configured: false, qrisEnabled: false, gopayEnabled: false };
  return { configured: true, qrisEnabled: config.qris.enabled, gopayEnabled: config.gopayMerchant.enabled,
    merchantId: config.gopayMerchant.merchantId, version: config.version };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Konfigurasi payment harus berupa objek JSON.");
  return value as Record<string, unknown>;
}
function field(value: unknown, max: number, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > max) throw new Error("Field konfigurasi payment tidak valid.");
  return value;
}
function enabled(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Field enabled harus boolean.");
  return value;
}
function allowFields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Field konfigurasi payment tidak dikenali.");
}

/** Full replacement; callers must use a private chat and delete the credential message. */
export async function saveTenantPaymentConfig(actorTelegramId: string, input: unknown): Promise<void> {
  const context = getTenantContext();
  if (!context.rentalId || (actorTelegramId !== context.ownerTelegramId && !context.adminTelegramIds?.includes(actorTelegramId))) {
    throw new Error("Hanya owner/admin rental yang dapat mengubah payment.");
  }
  const raw = record(input);
  allowFields(raw, ["qris", "gopayMerchant"]);
  const qris = record(raw["qris"]);
  const merchant = record(raw["gopayMerchant"]);
  allowFields(qris, ["enabled", "payload", "image"]);
  allowFields(merchant, ["enabled", "merchantId", "email", "password", "accessToken", "clientId", "clientSecret", "storeId"]);
  const qrisEnabled = enabled(qris["enabled"]);
  const merchantEnabled = enabled(merchant["enabled"]);
  let payload = field(qris["payload"], 8192).trim();
  const image = field(qris["image"], 2_000_000);
  if (!payload && image) {
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z\d+/=]+$/.test(image)) throw new Error("QRIS image harus data URI PNG/JPEG, bukan path atau URL.");
    const imageBuffer = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
    validateTenantQrisImage(imageBuffer);
    payload = await readQrCodeImage(imageBuffer);
  }
  const merchantId = field(merchant["merchantId"], 128).trim();
  const email = field(merchant["email"], 320).trim();
  const password = field(merchant["password"], 4096);
  const accessToken = field(merchant["accessToken"], 16384);
  if (merchantId && !/^[A-Za-z0-9_:.-]{1,128}$/.test(merchantId)) throw new Error("Merchant ID tidak valid.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Email merchant tidak valid.");
  if (qrisEnabled && !payload) throw new Error("QRIS payload wajib diisi.");
  if (merchantEnabled && (!merchantId || (!(email && password) && !accessToken))) throw new Error("Merchant ID dan email/password atau accessToken wajib diisi.");
  if (payload) validateTenantQrisPayload(payload);
  const encrypt = (value: string, name: string) => value ? encryptSecret(value, `${context.tenantId}:payment:${name}`) : "";
  const next = {
    qris: { enabled: qrisEnabled, payloadEncrypted: encrypt(payload, "qris") },
    gopayMerchant: {
      enabled: merchantEnabled, merchantId,
      clientId: field(merchant["clientId"], 256, "go-biz-web-new"),
      storeId: field(merchant["storeId"], 256),
      emailEncrypted: encrypt(email, "email"), passwordEncrypted: encrypt(password, "password"),
      clientSecretEncrypted: encrypt(field(merchant["clientSecret"], 4096), "clientSecret"),
      accessTokenEncrypted: encrypt(accessToken, "accessToken"),
    },
  };
  await withTenantPaymentLock(async () => {
    const pending = await TopupSession.exists({ status: "PENDING", createdAt: { $gte: new Date(Date.now() - 30 * 60_000) } });
    const reserved = await PaymentAmountReservation.exists({ tenantId: context.tenantId, expiresAt: { $gt: new Date() } });
    if (pending || reserved) throw new Error("Tunggu invoice/reservasi payment aktif selesai (maksimal 30 menit) sebelum mengganti merchant.");
    await TenantPaymentConfig.findOneAndUpdate({}, { $set: next, $inc: { version: 1 } }, { upsert: true, returnDocument: "after", runValidators: true });
    invalidateTenantPaymentConfig(context.tenantId);
  });
}
