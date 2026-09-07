import { Bot } from "grammy";
import { Types } from "mongoose";
import { BotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { encryptSecret, validateEncryptionKey } from "../services/crypto.js";
import { getTenantId, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { DAY_MS } from "./rental.service.js";

const PUBLIC_FEATURES = new Set(["digital", "affiliate", "totp"]);

export interface RentalPlanInput {
  code: string;
  durationDays: number;
  price: number;
  name: string;
  enabledFeatures: string[];
  enabled?: boolean;
}

export interface RentalProvisionInput {
  ownerTelegramId: string;
  planCode: string;
  botToken: string;
  adminTelegramIds?: string[];
  active?: boolean;
}

export function parseRentalPlanSetup(text: string): RentalPlanInput {
  const parts = text.split("|").map(value => value.trim());
  if (parts.length !== 5) throw new Error("Format paket harus: kode | hari | harga | nama | fitur.");
  const [code, days, price, name, features] = parts as [string, string, string, string, string];
  return validateRentalPlanInput({ code, durationDays: Number(days), price: Number(price), name, enabledFeatures: parseRentalFeatures(features) });
}

export function parseRentalProvisionSetup(text: string): RentalProvisionInput {
  const parts = text.split("|").map(value => value.trim());
  if (parts.length < 3 || parts.length > 5) {
    throw new Error("Format rental harus: owner | paket | token | admin opsional | status opsional.");
  }
  const [ownerTelegramId, planCode, botToken, adminsRaw = "", status = "pending"] = parts;
  if (!ownerTelegramId || !planCode || !/^[a-z0-9_-]{1,40}$/.test(planCode) || !botToken) {
    throw new Error("Owner, paket, atau token tidak valid.");
  }
  if (status !== "pending" && status !== "active") throw new Error("Status awal hanya pending atau active.");
  const adminTelegramIds = adminsRaw && adminsRaw !== "-" ? adminsRaw.split(",").map(value => value.trim()).filter(Boolean) : [];
  return { ownerTelegramId, planCode, botToken, adminTelegramIds, active: status === "active" };
}

interface VerifiedBotIdentity {
  id: number;
  username: string;
}

export function parseRentalFeatures(value: string): string[] {
  const features = [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
  if (features.length === 0 || features.some(feature => !PUBLIC_FEATURES.has(feature))) {
    throw new Error("Fitur valid: digital,affiliate,totp. Fitur internal tidak tersedia untuk rental.");
  }
  return features;
}

export function validateProvisionIdentity(ownerId: string, token: string, platformToken: string): void {
  if (!/^[1-9]\d{0,18}$/.test(ownerId)) throw new Error("Owner harus berupa Telegram user ID numerik.");
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Token bot rental dari BotFather tidak valid.");
  if (!/^\d+:/.test(platformToken)) throw new Error("BOT_TOKEN platform wajib tersedia untuk memeriksa konflik identitas bot.");
  if (token.split(":")[0] === platformToken.split(":")[0]) throw new Error("Token bot platform tidak dapat digunakan sebagai rental.");
}

export function validateRentalPlanInput(input: RentalPlanInput): RentalPlanInput {
  if (!/^[a-z0-9_-]{1,40}$/.test(input.code) || !input.name || input.name.length > 80 ||
      !Number.isSafeInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 3650 ||
      !Number.isSafeInteger(input.price) || input.price < 1 || input.price > 1_000_000_000) {
    throw new Error("Kode, durasi, harga, atau nama paket tidak valid.");
  }
  const enabledFeatures = parseRentalFeatures(input.enabledFeatures.join(","));
  return { ...input, enabledFeatures, enabled: input.enabled !== false };
}

function assertPlatform(): void {
  if (getTenantId() !== PLATFORM_TENANT_ID) throw new Error("Provisioning rental hanya tersedia pada bot platform.");
}

export async function saveRentalPlan(input: RentalPlanInput): Promise<Awaited<ReturnType<typeof RentalPlan.findOne>>> {
  assertPlatform();
  const valid = validateRentalPlanInput(input);
  await RentalPlan.createIndexes();
  return RentalPlan.findOneAndUpdate(
    { code: valid.code },
    { $set: valid },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
}

export async function provisionRental(
  input: RentalProvisionInput,
  verifyToken: (token: string) => Promise<VerifiedBotIdentity> = async token => new Bot(token).api.getMe(),
): Promise<{ rentalId: string; tenantId: string; botUsername: string; planId: string; status: "active" | "pending" }> {
  assertPlatform();
  const platformToken = process.env["BOT_TOKEN"] ?? "";
  validateProvisionIdentity(input.ownerTelegramId, input.botToken, platformToken);
  validateEncryptionKey();
  const admins = [...new Set(input.adminTelegramIds ?? [])];
  if (admins.length > 20 || admins.some(id => !/^[1-9]\d{0,18}$/.test(id))) {
    throw new Error("Admin IDs harus numerik, maksimal 20 admin.");
  }
  const plan = await RentalPlan.findOne({ code: input.planCode, enabled: true }).lean();
  if (!plan) throw new Error("Paket aktif tidak ditemukan.");
  let identity: VerifiedBotIdentity;
  try { identity = await verifyToken(input.botToken); }
  catch { throw new Error("Token rental belum berhasil diverifikasi ke Telegram."); }
  if (!identity.username || String(identity.id) !== input.botToken.split(":")[0]) {
    throw new Error("Identitas token bot rental tidak valid.");
  }
  if (String(identity.id) === platformToken.split(":")[0]) throw new Error("Bot platform tidak dapat dijadikan rental.");
  if (await BotRental.exists({ botId: String(identity.id) })) throw new Error("Bot sudah terdaftar sebagai rental.");

  const id = new Types.ObjectId();
  const tenantId = id.toString();
  const active = input.active === true;
  const now = new Date();
  await BotRental.createIndexes();
  try {
    await BotRental.create({
      _id: id,
      tenantId,
      ownerTelegramId: input.ownerTelegramId,
      adminTelegramIds: admins,
      botTokenEncrypted: encryptSecret(input.botToken, `${tenantId}:botToken`),
      botId: String(identity.id),
      botUsername: identity.username,
      plan: String(plan._id),
      enabledFeatures: plan.enabledFeatures,
      status: active ? "active" : "pending",
      startedAt: active ? now : null,
      expiresAt: active ? new Date(now.getTime() + plan.durationDays * DAY_MS) : now,
      graceEndsAt: null,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      throw new Error("Bot tidak tersedia untuk rental.");
    }
    throw error;
  }
  return {
    rentalId: id.toString(),
    tenantId,
    botUsername: identity.username,
    planId: String(plan._id),
    status: active ? "active" : "pending",
  };
}
