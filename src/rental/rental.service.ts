import { Types } from "mongoose";
import { BotRental, type IBotRental, type RentalStatus } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RENTAL_GRACE_MS = DAY_MS;

export interface RentalRuntimeState {
  tenantId: string;
  rentalId: string;
  ownerTelegramId: string;
  adminTelegramIds: string[];
  botUsername: string;
  plan: string;
  enabledFeatures: string[];
  status: RentalStatus;
  expiresAt: Date;
  graceEndsAt: Date | null;
}

const runtimeStates = new Map<string, RentalRuntimeState>();
const listeners = new Set<(state: RentalRuntimeState) => void>();

export function deriveRentalLifecycle(
  rental: Pick<IBotRental, "status" | "expiresAt" | "graceEndsAt">,
  now = new Date(),
): { status: RentalStatus; graceEndsAt: Date | null } {
  if (rental.status === "pending" || rental.status === "terminated") {
    return { status: rental.status, graceEndsAt: rental.graceEndsAt };
  }
  if (rental.expiresAt.getTime() > now.getTime()) {
    return { status: rental.status === "suspended" ? "suspended" : "active", graceEndsAt: null };
  }
  const graceEndsAt = new Date(rental.expiresAt.getTime() + RENTAL_GRACE_MS);
  return { status: now.getTime() < graceEndsAt.getTime() ? "expired_grace" : "suspended", graceEndsAt };
}

function cacheRental(rental: IBotRental & { _id: unknown }): RentalRuntimeState {
  const lifecycle = deriveRentalLifecycle(rental);
  const state: RentalRuntimeState = {
    rentalId: String(rental._id), tenantId: rental.tenantId,
    ownerTelegramId: rental.ownerTelegramId, adminTelegramIds: rental.adminTelegramIds,
    botUsername: rental.botUsername, plan: rental.plan, enabledFeatures: rental.enabledFeatures,
    status: lifecycle.status, expiresAt: rental.expiresAt, graceEndsAt: lifecycle.graceEndsAt,
  };
  runtimeStates.set(state.rentalId, state);
  for (const listener of listeners) {
    try { listener(state); } catch { console.warn(`[Rental:${state.rentalId}] Runtime listener failed`); }
  }
  return state;
}

export function getRentalRuntimeState(rentalId: string): RentalRuntimeState | undefined {
  return runtimeStates.get(rentalId);
}

export function onRentalStateChange(listener: (state: RentalRuntimeState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function refreshRentalState(rentalId: string): Promise<RentalRuntimeState | null> {
  if (!Types.ObjectId.isValid(rentalId)) return null;
  const rental = await BotRental.findById(rentalId).lean();
  if (!rental) { runtimeStates.delete(rentalId); return null; }
  return cacheRental(rental);
}

export async function synchronizeRentalLifecycle(rentalId: string, now = new Date()): Promise<RentalRuntimeState | null> {
  const rental = await BotRental.findById(rentalId).lean();
  if (!rental) return null;
  const lifecycle = deriveRentalLifecycle(rental, now);
  if (rental.status !== lifecycle.status || rental.graceEndsAt?.getTime() !== lifecycle.graceEndsAt?.getTime()) {
    // A renewal racing this update changes expiresAt, so stale expiry work cannot suspend it.
    await BotRental.updateOne({ _id: rental._id, status: rental.status, expiresAt: rental.expiresAt }, { $set: lifecycle });
  }
  return refreshRentalState(rentalId);
}

export function renewalExpiresAt(expiresAt: Date, durationDays: number, now = new Date()): Date {
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error("Durasi rental tidak valid.");
  return new Date(Math.max(expiresAt.getTime(), now.getTime()) + durationDays * DAY_MS);
}

/** Exactly-once application uses one atomic rental update, including the payment receipt. */
export async function applyRenewal(rentalId: string, paymentId: string, durationDays: number, planId: string): Promise<RentalRuntimeState> {
  renewalExpiresAt(new Date(), durationDays);
  if (!Types.ObjectId.isValid(rentalId) || !paymentId || paymentId.length > 128 || !Types.ObjectId.isValid(planId)) {
    throw new Error("Referensi renewal tidak valid.");
  }
  const plan = await RentalPlan.findById(planId).lean();
  if (!plan) throw new Error("Paket rental tidak ditemukan.");
  await BotRental.findOneAndUpdate({
    _id: rentalId, status: { $ne: "terminated" }, appliedRentalPaymentIds: { $ne: paymentId },
  }, [{ $set: {
    expiresAt: { $add: [{ $max: ["$expiresAt", "$$NOW"] }, durationDays * DAY_MS] },
    startedAt: { $ifNull: ["$startedAt", "$$NOW"] },
    status: "active", graceEndsAt: null,
    plan: { $literal: planId }, enabledFeatures: { $literal: plan.enabledFeatures },
    appliedRentalPaymentIds: { $concatArrays: [{ $ifNull: ["$appliedRentalPaymentIds", []] }, { $literal: [paymentId] }] },
    sentExpiryAlerts: [], lastExpiryAlertAt: null, updatedAt: "$$NOW",
  } }], { returnDocument: "after", updatePipeline: true });
  const state = await refreshRentalState(rentalId);
  if (!state || state.status === "terminated") throw new Error("Rental tidak dapat diperpanjang.");
  return state;
}

export interface RentalRuntimeControls {
  restartRentalBot(rentalId: string): Promise<unknown>;
  startRentalBot(rentalId: string): Promise<unknown>;
  stopRentalBot?(rentalId: string): Promise<unknown>;
}
let runtimeControls: RentalRuntimeControls | undefined;
export function setRentalRuntimeControls(controls: RentalRuntimeControls): void { runtimeControls = controls; }
export async function restartCurrentRental(rentalId: string): Promise<void> {
  if (!runtimeControls) throw new Error("Runtime belum siap.");
  await runtimeControls.restartRentalBot(rentalId);
}

export async function startProvisionedRental(rentalId: string): Promise<void> {
  if (!runtimeControls) throw new Error("Runtime rental belum aktif.");
  await runtimeControls.startRentalBot(rentalId);
}

export async function stopProvisionedRental(rentalId: string): Promise<void> {
  if (runtimeControls?.stopRentalBot) {
    await runtimeControls.stopRentalBot(rentalId);
  }
}

export interface RentalRefundCalculation {
  planName: string;
  planPrice: number;
  durationDays: number;
  dailyRate: number;
  daysUsed: number;
  daysRemaining: number;
  usedCost: number;
  refundAmount: number;
}

export interface RentalRefundResult extends RentalRefundCalculation {
  credited: boolean;
  newBalance?: number | undefined;
  ownerTelegramId: string;
}

export interface TerminateRentalOptions {
  actorTelegramId?: string | undefined;
  refundIfOwner?: boolean | undefined;
}

export type TerminateRentalResult = RentalRuntimeState & {
  refund?: RentalRefundResult | undefined;
};

export function calculateRentalRefund(
  rental: { status: string; startedAt?: Date | null; expiresAt: Date; plan?: string },
  plan: { price: number; durationDays: number; name?: string },
  now = new Date(),
): RentalRefundCalculation {
  const durationDays = Math.max(1, plan.durationDays);
  const dailyRateExact = plan.price / durationDays;

  const result: RentalRefundCalculation = {
    planName: plan.name ?? "Rental",
    planPrice: plan.price,
    durationDays,
    dailyRate: Math.round(dailyRateExact),
    daysUsed: durationDays,
    daysRemaining: 0,
    usedCost: plan.price,
    refundAmount: 0,
  };

  if (rental.status !== "active" || !rental.expiresAt) {
    return result;
  }

  const remainingMs = rental.expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return result;
  }

  const rawRemainingDays = Math.floor(remainingMs / DAY_MS);
  const potentialRemaining = Math.max(0, Math.min(durationDays, rawRemainingDays));
  const daysUsed = Math.max(1, Math.min(durationDays, durationDays - potentialRemaining));
  const daysRemaining = Math.max(0, durationDays - daysUsed);

  const usedCost = Math.min(plan.price, Math.round(daysUsed * dailyRateExact));
  const refundAmount = Math.max(0, plan.price - usedCost);

  result.dailyRate = Math.round(dailyRateExact);
  result.daysUsed = daysUsed;
  result.daysRemaining = daysRemaining;
  result.usedCost = usedCost;
  result.refundAmount = refundAmount;

  return result;
}

export async function terminateRental(
  rentalId: string,
  options?: TerminateRentalOptions,
): Promise<TerminateRentalResult | null> {
  if (!Types.ObjectId.isValid(rentalId)) return null;
  const existing = await BotRental.findById(rentalId).lean();
  if (!existing) return null;

  let refundResult: RentalRefundResult | undefined;

  if (existing.status === "active") {
    let plan = null;
    if (Types.ObjectId.isValid(existing.plan)) {
      plan = await RentalPlan.findById(existing.plan).lean();
    }
    if (!plan) {
      plan = await RentalPlan.findOne({ code: existing.plan }).lean();
    }
    if (plan) {
      const calc = calculateRentalRefund(existing, plan);
      refundResult = {
        ...calc,
        credited: false,
        ownerTelegramId: existing.ownerTelegramId,
      };

      const shouldRefund =
        Boolean(options?.refundIfOwner) &&
        Boolean(options?.actorTelegramId) &&
        options?.actorTelegramId === existing.ownerTelegramId &&
        calc.refundAmount > 0;

      if (shouldRefund) {
        try {
          const { adjustBalance } = await import("../services/balance.js");
          const adjustRes = await adjustBalance(
            existing.ownerTelegramId,
            calc.refundAmount,
            "REFUND",
            `Refund pembatalan sewa bot @${existing.botUsername} (${calc.daysRemaining} hari sisa)`,
          );
          if (adjustRes.success) {
            refundResult.credited = true;
            if (adjustRes.newBalance !== undefined) {
              refundResult.newBalance = adjustRes.newBalance;
            }
          }
        } catch (err) {
          console.warn(`[Rental:${rentalId}] Failed to credit refund to user ${existing.ownerTelegramId}:`, err);
        }
      }
    }
  }

  const updated = await BotRental.findByIdAndUpdate(
    rentalId,
    { $set: { status: "terminated", updatedAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  if (!updated) return null;
  const state = cacheRental(updated);
  try {
    await stopProvisionedRental(rentalId);
  } catch (error) {
    console.warn(`[Rental:${rentalId}] Stop runtime failed during termination:`, error);
  }
  try {
    const { RentalPayment } = await import("../models/RentalPayment.js");
    await RentalPayment.updateMany(
      { rentalId, status: { $in: ["pending", "processing"] } },
      { $set: { status: "expired" } },
    );
  } catch {
    // Payment ledger update is best-effort
  }
  return {
    ...state,
    ...(refundResult ? { refund: refundResult } : {}),
  };
}

