import { User } from "../models/User.js";
import { AffiliateLog, AffiliateSourceType } from "../models/AffiliateLog.js";
import { BotConfig } from "../models/BotConfig.js";
import { adjustBalance } from "./balance.js";

// ============================================================================
//  Affiliate / Referral Commission Service
// ============================================================================

/**
 * Awards commission to the referrer of a referred user.
 *
 * Flow:
 * 1. Looks up the `referredBy` field on the referred user.
 * 2. If referrer exists and affiliate is enabled in BotConfig, calculates commission.
 * 3. Credits `affiliateBalance` (NOT main `balance`) on the referrer's account.
 * 4. Creates an AffiliateLog + BalanceLog record.
 *
 * This function is fire-and-forget safe — always wrap calls in .catch().
 */
export async function awardCommission(
  referredUserId: string,
  purchaseAmount: number,
  sourceType: AffiliateSourceType,
  sourceOrderId: string
): Promise<void> {
  try {
    // 1. Get BotConfig to check if affiliate is enabled and read commission settings
    const config = await BotConfig.getOrCreate();
    if (!config.affiliateEnabled) return;

    // 2. Look up referred user to find their referrer
    const referredUser = await User.findOne({ telegramId: referredUserId }).lean();
    if (!referredUser || !referredUser.referredBy) return;

    const referrerId = referredUser.referredBy;

    // 3. Confirm referrer exists
    const referrer = await User.findOne({ telegramId: referrerId });
    if (!referrer) return;

    // 4. Calculate commission amount
    let commissionAmount = 0;
    if (config.affiliateCommissionType === "fixed") {
      commissionAmount = Math.round(config.affiliateCommissionValue);
    } else {
      // percentage
      commissionAmount = Math.round((purchaseAmount * config.affiliateCommissionValue) / 100);
    }

    if (commissionAmount <= 0) return;

    // 5. Credit referrer's affiliateBalance (atomic)
    await User.findOneAndUpdate(
      { telegramId: referrerId },
      {
        $inc: {
          affiliateBalance: commissionAmount,
          totalEarnedAffiliate: commissionAmount,
        },
      }
    );

    // 6. Create AffiliateLog record
    await AffiliateLog.create({
      referrerId,
      referredUserId,
      sourceType,
      sourceOrderId,
      purchaseAmount,
      commissionAmount,
    });

    console.log(
      `[affiliate] Commission Rp${commissionAmount.toLocaleString("id-ID")} awarded to ${referrerId} ` +
      `(referred ${referredUserId}, ${sourceType})`
    );
  } catch (err) {
    console.error("[affiliate] awardCommission error:", err);
  }
}

/**
 * Withdraws the referrer's affiliateBalance into their main balance.
 * Returns the amount withdrawn, or 0 if nothing to withdraw.
 */
export async function withdrawAffiliateBalance(userId: string): Promise<{
  success: boolean;
  amount: number;
  message: string;
}> {
  const user = await User.findOne({ telegramId: userId });
  if (!user) {
    return { success: false, amount: 0, message: "User tidak ditemukan." };
  }

  const amount = user.affiliateBalance;
  if (amount <= 0) {
    return { success: false, amount: 0, message: "Saldo afiliasi kamu kosong, belum ada komisi yang bisa ditarik." };
  }

  // Atomically move affiliateBalance → balance
  const updated = await User.findOneAndUpdate(
    { telegramId: userId, affiliateBalance: { $gte: amount } },
    {
      $inc: { balance: amount, affiliateBalance: -amount },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    return { success: false, amount: 0, message: "Gagal menarik saldo afiliasi. Coba lagi." };
  }

  // Record in BalanceLog
  await adjustBalance(userId, amount, "COMMISSION", "Penarikan saldo afiliasi ke saldo utama");

  return {
    success: true,
    amount,
    message: `✅ Berhasil! Rp ${amount.toLocaleString("id-ID")} dari saldo afiliasi sudah ditambahkan ke saldo utama kamu.`,
  };
}

/**
 * Gets affiliate stats for a user.
 */
export async function getAffiliateStats(userId: string): Promise<{
  totalInvited: number;
  totalEarned: number;
  affiliateBalance: number;
  recentLogs: import("../models/AffiliateLog.js").IAffiliateLog[];
}> {
  const user = await User.findOne({ telegramId: userId }).lean();
  const totalInvited = await User.countDocuments({ referredBy: userId });
  const recentLogs = await AffiliateLog.find({ referrerId: userId })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean() as any;

  return {
    totalInvited,
    totalEarned: user?.totalEarnedAffiliate ?? 0,
    affiliateBalance: user?.affiliateBalance ?? 0,
    recentLogs,
  };
}
