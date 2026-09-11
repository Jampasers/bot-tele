import { Bot } from "grammy";
import { Types } from "mongoose";
import { BotRental, type RentalStatus } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { validateEncryptionKey } from "../services/crypto.js";
import { getTenantId, PLATFORM_TENANT_ID } from "../tenant/context.js";
import { provisionRental } from "./rentalProvisioning.service.js";

const MAX_CONCURRENT_TOKEN_CHECKS = 2;
const TOKEN_CHECK_TIMEOUT_MS = 10_000;
let activeTokenChecks = 0;
const ownersBeingProvisioned = new Set<string>();

export interface SelfServiceRentalPlan {
  id: string;
  code: string;
  name: string;
  durationDays: number;
  price: number;
  enabledFeatures: string[];
}

export interface OwnedRentalSummary {
  rentalId: string;
  botUsername: string;
  status: RentalStatus;
  expiresAt: Date;
  planId?: string;
  startedAt?: Date | null;
}

export interface VerifiedSelfServiceBot {
  id: number;
  username: string;
}

export interface SelfServiceProvisionInput {
  ownerTelegramId: string;
  planId: string;
  botToken: string;
}

function assertPlatform(): void {
  if (getTenantId() !== PLATFORM_TENANT_ID) {
    throw new Error("Self-service rental hanya tersedia pada bot platform.");
  }
}

function validateOwnerId(ownerTelegramId: string): void {
  if (!/^[1-9]\d{0,18}$/.test(ownerTelegramId)) throw new Error("Identitas pengguna tidak valid.");
}

export function assertSelfServiceRentalReady(): void {
  assertPlatform();
  if (process.env["RENTAL_ENABLED"] !== "true") throw new Error("Rental belum diaktifkan.");
  validateEncryptionKey();
}

export async function listSelfServiceRentalPlans(): Promise<SelfServiceRentalPlan[]> {
  assertPlatform();
  const plans = await RentalPlan.find({ enabled: true })
    .sort({ durationDays: 1, price: 1 })
    .limit(20)
    .lean();
  return plans.map(plan => ({
    id: String(plan._id),
    code: plan.code,
    name: plan.name,
    durationDays: plan.durationDays,
    price: plan.price,
    enabledFeatures: [...plan.enabledFeatures],
  }));
}

export async function findOwnedRental(ownerTelegramId: string): Promise<OwnedRentalSummary | null> {
  assertPlatform();
  validateOwnerId(ownerTelegramId);
  // Admin provisioning can create more than one rental for an owner. Always
  // surface an unpaid bot first so each pending rental remains activatable.
  const rental = await BotRental.findOne({ ownerTelegramId, status: "pending" })
    .sort({ createdAt: 1 })
    .select("botUsername status expiresAt plan startedAt")
    .lean()
    ?? await BotRental.findOne({ ownerTelegramId, status: { $nin: ["pending", "terminated"] } })
      .sort({ createdAt: -1 })
      .select("botUsername status expiresAt plan startedAt")
      .lean();
  return rental ? {
    rentalId: String(rental._id),
    botUsername: rental.botUsername,
    status: rental.status,
    expiresAt: rental.expiresAt,
    planId: rental.plan,
    startedAt: rental.startedAt,
  } : null;
}

export async function listOwnedRentals(ownerTelegramId: string): Promise<OwnedRentalSummary[]> {
  assertPlatform();
  validateOwnerId(ownerTelegramId);
  const rentals = await BotRental.find({
    ownerTelegramId,
    status: { $ne: "terminated" },
  })
    .sort({ createdAt: -1 })
    .select("botUsername status expiresAt plan startedAt")
    .lean();
  return rentals.map(rental => ({
    rentalId: String(rental._id),
    botUsername: rental.botUsername,
    status: rental.status,
    expiresAt: rental.expiresAt,
    planId: rental.plan,
    startedAt: rental.startedAt,
  }));
}

/** Read-only validation. This never changes or removes a bot's webhook. */
export async function verifySelfServiceBotToken(token: string): Promise<VerifiedSelfServiceBot> {
  if (activeTokenChecks >= MAX_CONCURRENT_TOKEN_CHECKS) throw new Error("Pemeriksaan token sedang penuh.");
  activeTokenChecks++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_CHECK_TIMEOUT_MS);
  timeout.unref();
  try {
    const api = new Bot(token).api;
    // grammY's generated API types use abort-controller's structural type,
    // while Node supplies the compatible runtime signal globally.
    const signal = controller.signal as unknown as Parameters<typeof api.getMe>[0];
    const identity = await api.getMe(signal);
    const webhook = await api.getWebhookInfo(signal);
    if (webhook.url) throw new Error("Bot masih memakai webhook.");
    if (!identity.username) throw new Error("Bot tidak memiliki username.");
    return { id: identity.id, username: identity.username };
  } finally {
    clearTimeout(timeout);
    activeTokenChecks--;
  }
}

export async function provisionSelfServiceRental(
  input: SelfServiceProvisionInput,
  verifyToken: (token: string) => Promise<VerifiedSelfServiceBot> = verifySelfServiceBotToken,
): ReturnType<typeof provisionRental> {
  assertSelfServiceRentalReady();
  validateOwnerId(input.ownerTelegramId);
  if (!Types.ObjectId.isValid(input.planId)) throw new Error("Paket rental tidak valid.");
  if (input.botToken.length > 256 || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(input.botToken)) {
    throw new Error("Token bot rental tidak valid.");
  }
  if (ownersBeingProvisioned.has(input.ownerTelegramId)) throw new Error("Pendaftaran rental sedang diproses.");
  ownersBeingProvisioned.add(input.ownerTelegramId);
  try {
    const [pendingRental, plan] = await Promise.all([
      BotRental.findOne({ ownerTelegramId: input.ownerTelegramId, status: "pending" })
        .select("botUsername")
        .lean(),
      RentalPlan.findOne({ _id: input.planId, enabled: true }).lean(),
    ]);
    if (pendingRental) {
      throw new Error(`Selesaikan pembayaran untuk @${pendingRental.botUsername} terlebih dahulu sebelum menyewa bot baru.`);
    }
    if (!plan) throw new Error("Paket rental tidak tersedia.");
    return await provisionRental({
      ownerTelegramId: input.ownerTelegramId,
      planCode: plan.code,
      botToken: input.botToken,
      adminTelegramIds: [],
      active: false,
    }, verifyToken);
  } finally {
    ownersBeingProvisioned.delete(input.ownerTelegramId);
  }
}
