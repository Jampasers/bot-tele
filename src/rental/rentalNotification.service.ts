import type { Bot, Context } from "grammy";
import { BotRental, type IBotRental } from "../models/BotRental.js";
import { DAY_MS, getRentalRuntimeState, type RentalRuntimeState } from "./rental.service.js";
import { renewalKeyboard, rentalStatusText } from "../plugins/rental/index.js";

const HOUR_MS = 60 * 60 * 1000;
const MILESTONES = [
  { key: "h-3", offset: -3 * DAY_MS }, { key: "h-1", offset: -DAY_MS },
  ...[0, 1, 3, 6, 12, 18, 23, 24].map((hour) => ({ key: `expired+${hour}h`, offset: hour * HOUR_MS })),
];

export function dueExpiryAlerts(rental: Pick<IBotRental, "expiresAt" | "status" | "sentExpiryAlerts">, now = new Date()): string[] {
  if (rental.status === "pending" || rental.status === "terminated") return [];
  const elapsed = now.getTime() - rental.expiresAt.getTime();
  return MILESTONES.filter((item) => elapsed >= item.offset && !rental.sentExpiryAlerts.includes(item.key)).map((item) => item.key);
}

export async function notifyRentalExpiry(bot: Bot<Context>, state: RentalRuntimeState, now = new Date()): Promise<void> {
  const rental = await BotRental.findOne({ _id: state.rentalId, expiresAt: state.expiresAt }).lean();
  if (!rental) return;
  const due = dueExpiryAlerts(rental, now);
  const newest = due.at(-1);
  if (!newest) return;
  // Claim all overdue milestones together: restarting after downtime sends one useful notice.
  const claim = await BotRental.updateOne({ _id: rental._id, expiresAt: rental.expiresAt, sentExpiryAlerts: { $ne: newest } }, {
    $addToSet: { sentExpiryAlerts: { $each: due } }, $set: { lastExpiryAlertAt: now },
  });
  if (claim.modifiedCount !== 1) return;
  const current = getRentalRuntimeState(state.rentalId);
  if (current && current.expiresAt.getTime() !== state.expiresAt.getTime()) return;
  const prefix = newest === "h-3" ? "⏰ Pengingat: masa aktif bot tersisa paling lama 3 hari.\n\n"
    : newest === "h-1" ? "⏰ Pengingat: masa aktif bot tersisa paling lama 1 hari.\n\n" : "";
  try {
    await bot.api.sendMessage(state.ownerTelegramId, prefix + rentalStatusText(state, now), { reply_markup: renewalKeyboard() });
  } catch {
    // Telegram has no idempotency key; keep the claim on uncertain sends to avoid duplicate alerts.
    console.warn(`[Rental:${state.rentalId}] [Tenant:${state.tenantId}] [@${state.botUsername}] Expiry alert delivery failed (${newest})`);
  }
}
