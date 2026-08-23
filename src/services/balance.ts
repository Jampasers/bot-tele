import { User } from "../models/User.js";
import { BalanceLog, BalanceLogType } from "../models/BalanceLog.js";

// ============================================================================
//  Balance Service — Atomic balance mutations with full audit trail
// ============================================================================

export interface AdjustBalanceResult {
  success: boolean;
  newBalance?: number;
  message?: string;
}

/**
 * Atomically adjusts a user's balance and creates a BalanceLog record.
 *
 * For DEBIT / PURCHASE / REFUND types, validates that the user has sufficient
 * balance before applying. Returns success=false if balance would go negative.
 *
 * @param userId   - Telegram ID of the user
 * @param amount   - Absolute amount to add (positive) or subtract (positive)
 * @param type     - Mutation type label for the audit log
 * @param reason   - Human-readable description
 * @param adminId  - Telegram ID of admin performing this action (optional)
 * @param isDebit  - If true, the amount is SUBTRACTED from balance (default: inferred from type)
 */
export async function adjustBalance(
  userId: string,
  amount: number,
  type: BalanceLogType,
  reason: string,
  adminId?: string,
  isDebit?: boolean
): Promise<AdjustBalanceResult> {
  const absAmount = Math.abs(Math.round(amount));
  if (absAmount <= 0) {
    return { success: false, message: "Amount harus lebih dari 0." };
  }

  // Determine direction
  const shouldDebit =
    isDebit !== undefined
      ? isDebit
      : ["DEBIT", "PURCHASE"].includes(type);

  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    return { success: false, message: "User tidak ditemukan di database." };
  }

  const balanceBefore = user.balance;

  if (shouldDebit && user.balance < absAmount) {
    return {
      success: false,
      message: `Saldo tidak mencukupi. Saldo saat ini: Rp ${user.balance.toLocaleString("id-ID")}, Dibutuhkan: Rp ${absAmount.toLocaleString("id-ID")}.`,
    };
  }

  const delta = shouldDebit ? -absAmount : absAmount;

  const updated = await User.findOneAndUpdate(
    shouldDebit
      ? { telegramId: userId, balance: { $gte: absAmount } }
      : { telegramId: userId },
    { $inc: { balance: delta } },
    { new: true }
  );

  if (!updated) {
    return {
      success: false,
      message: "Gagal memutasi saldo. Mungkin terjadi race condition — coba lagi.",
    };
  }

  const balanceAfter = updated.balance;

  // Create audit log entry
  await BalanceLog.create({
    userId,
    ...(adminId !== undefined && { adminId }),
    type,
    amount: absAmount,
    balanceBefore,
    balanceAfter,
    reason: reason || "",
  });

  return { success: true, newBalance: balanceAfter };
}

/**
 * Retrieves recent balance mutation logs for a user.
 */
export async function getUserBalanceLogs(
  userId: string,
  limit = 10
): Promise<import("../models/BalanceLog.js").IBalanceLog[]> {
  return await BalanceLog.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean() as any;
}

/**
 * Retrieves balance logs created by a specific admin.
 */
export async function getAdminBalanceLogs(
  adminId: string,
  limit = 20
): Promise<import("../models/BalanceLog.js").IBalanceLog[]> {
  return await BalanceLog.find({ adminId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean() as any;
}
