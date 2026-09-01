import { PromoCode } from "../models/PromoCode.js";
import { AntiFraudService } from "./antiFraudService.js";

// ============================================================================
//  Promo / Voucher Service
// ============================================================================

export interface PromoValidationResult {
  valid: boolean;
  discountAmount: number;
  discountedPrice: number;
  message: string;
  promoDoc?: import("../models/PromoCode.js").IPromoCode | undefined;
}

/**
 * Validates a promo code for a given user and purchase amount.
 * Does NOT apply the promo (does not modify the database).
 * Call `applyPromo()` after a confirmed purchase.
 */
export async function validatePromo(
  code: string,
  userId: string,
  purchaseAmount: number
): Promise<PromoValidationResult> {
  const normalizedCode = code.trim().toUpperCase();

  // 1. Check if user is temporarily blocked from promo attempts
  const lockCheck = await AntiFraudService.checkPromoAttempt(userId);
  if (lockCheck.blocked) {
    const minutesLeft = Math.max(1, Math.ceil((lockCheck.remainingSeconds || 0) / 60));
    return {
      valid: false,
      discountAmount: 0,
      discountedPrice: purchaseAmount,
      message: `⛔ <b>Input Promo Diblokir Sementara!</b>\n\nKamu telah gagal memasukkan kode promo sebanyak 5 kali berturut-turut.\nSilakan coba lagi dalam <b>${minutesLeft} menit</b>.`,
    };
  }

  const promo = await PromoCode.findOne({ code: normalizedCode });

  if (!promo) {
    const failRes = await AntiFraudService.recordPromoFailure(userId);
    const failWarning = failRes.blocked
      ? `\n\n⛔ <i>Batas percobaan terlampaui. Input promo dikunci selama ${Math.ceil((failRes.remainingSeconds || 0) / 60)} menit.</i>`
      : ` (Percobaan gagal: ${failRes.attempts}/5)`;
    return {
      valid: false,
      discountAmount: 0,
      discountedPrice: purchaseAmount,
      message: `❌ Kode promo tidak ditemukan.${failWarning}`,
    };
  }

  if (!promo.isActive) {
    return { valid: false, discountAmount: 0, discountedPrice: purchaseAmount, message: "❌ Kode promo ini sudah tidak aktif." };
  }

  if (new Date() > promo.expiresAt) {
    return { valid: false, discountAmount: 0, discountedPrice: purchaseAmount, message: "❌ Kode promo sudah kedaluwarsa." };
  }

  if (promo.usedCount >= promo.quota) {
    return { valid: false, discountAmount: 0, discountedPrice: purchaseAmount, message: "❌ Kuota promo sudah habis." };
  }

  if (promo.usedBy.includes(userId)) {
    return { valid: false, discountAmount: 0, discountedPrice: purchaseAmount, message: "❌ Kamu sudah pernah menggunakan kode promo ini." };
  }

  if (purchaseAmount < promo.minSpend) {
    return {
      valid: false,
      discountAmount: 0,
      discountedPrice: purchaseAmount,
      message: `❌ Minimal pembelian untuk kode ini adalah Rp ${promo.minSpend.toLocaleString("id-ID")}.`,
    };
  }

  // Reset failed attempts on valid code
  await AntiFraudService.resetPromoFailure(userId);

  // Calculate discount
  let discount = 0;
  if (promo.discountType === "FIXED") {
    discount = promo.discountValue;
  } else {
    // PERCENTAGE
    discount = Math.round((purchaseAmount * promo.discountValue) / 100);
    if (promo.maxDiscount && discount > promo.maxDiscount) {
      discount = promo.maxDiscount;
    }
  }

  discount = Math.min(discount, purchaseAmount); // cannot discount more than the price
  const discountedPrice = Math.max(0, purchaseAmount - discount);

  return {
    valid: true,
    discountAmount: discount,
    discountedPrice,
    message: `✅ Promo <b>${normalizedCode}</b> berhasil diterapkan! Diskon: Rp ${discount.toLocaleString("id-ID")}`,
    promoDoc: promo,
  };
}

/**
 * Atomically marks a promo code as used by a user.
 * Call this only after a successful purchase.
 */
export async function applyPromo(code: string, userId: string): Promise<void> {
  const normalizedCode = code.trim().toUpperCase();
  await PromoCode.findOneAndUpdate(
    { code: normalizedCode },
    {
      $inc: { usedCount: 1 },
      $push: { usedBy: userId },
    }
  );
  await AntiFraudService.resetPromoFailure(userId);
}

/**
 * Creates a new promo code (admin use).
 */
export async function createPromo(data: {
  code: string;
  discountType: "FIXED" | "PERCENTAGE";
  discountValue: number;
  maxDiscount?: number;
  minSpend?: number;
  quota: number;
  expiresAt: Date;
  isActive?: boolean;
}): Promise<import("../models/PromoCode.js").IPromoCode> {
  return await PromoCode.create({
    code: data.code.trim().toUpperCase(),
    discountType: data.discountType,
    discountValue: data.discountValue,
    ...(data.maxDiscount !== undefined && { maxDiscount: data.maxDiscount }),
    minSpend: data.minSpend ?? 0,
    quota: data.quota,
    expiresAt: data.expiresAt,
    isActive: data.isActive ?? true,
  });
}

/**
 * Lists all currently active (non-expired) promo codes.
 */
export async function listActivePromos(): Promise<import("../models/PromoCode.js").IPromoCode[]> {
  return await PromoCode.find({
    isActive: true,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });
}

/**
 * Lists all promo codes (including expired/inactive), paginated.
 */
export async function listAllPromos(
  page = 0,
  limit = 10
): Promise<import("../models/PromoCode.js").IPromoCode[]> {
  return await PromoCode.find({})
    .sort({ createdAt: -1 })
    .skip(page * limit)
    .limit(limit);
}
