import { existsSync } from "node:fs";
import { QrisGenerator } from "./qris.js";
import { GopayMerchant } from "./gopay-merchant.js";
import type { PaymentTransaction } from "./types.js";
import { TopupSession, ITopupSession } from "../../models/TopupSession.js";

// ============================================================================
//  GoPay & QRIS Unified Payment Service
// ============================================================================

let qrisGeneratorInstance: QrisGenerator | null = null;
let gopayMerchantInstance: GopayMerchant | null = null;

/**
 * Returns or initializes the QrisGenerator singleton.
 */
export function getQrisGenerator(): QrisGenerator {
  if (!qrisGeneratorInstance) {
    const staticPayload = process.env["QRIS_STATIC_PAYLOAD"];
    const imagePath = process.env["QRIS_IMAGE_PATH"] || "./qris-static.png";

    if (staticPayload && staticPayload.trim()) {
      qrisGeneratorInstance = new QrisGenerator({ qrisStaticPayload: staticPayload.trim() });
    } else if (existsSync(imagePath)) {
      qrisGeneratorInstance = new QrisGenerator({ qrisImage: imagePath });
    } else {
      // Fallback instance - will throw descriptive error on generate() if no config exists
      qrisGeneratorInstance = new QrisGenerator({ qrisImage: imagePath });
    }
  }
  return qrisGeneratorInstance;
}

/**
 * Returns or initializes the GopayMerchant singleton.
 */
export function getGopayMerchant(): GopayMerchant {
  if (!gopayMerchantInstance) {
    const merchantId = process.env["GOPAY_MERCHANT_ID"] || "";
    const email = process.env["GOJEK_EMAIL"] || process.env["GOBIZ_EMAIL"] || "";
    const password = process.env["GOJEK_PASSWORD"] || process.env["GOBIZ_PASSWORD"] || "";

    gopayMerchantInstance = new GopayMerchant({
      merchantId,
      email,
      password,
    });
  }
  return gopayMerchantInstance;
}

export interface GeneratedQris {
  buffer: Buffer;
  dataUri: string;
  payload: string;
}

export interface UniquePaymentResult {
  baseAmount: number;
  uniqueCode: number;
  totalAmount: number;
}

/**
 * Generates an incremental unique payment code (1 - 1000) for a given base amount.
 * - Trx 1 dengan nominal 5000 -> 5001 (kode unik: 1)
 * - Trx 2 dengan nominal 5000 -> 5002 (kode unik: 2)
 * - Begitu transaksi selesai (SETTLED / EXPIRED / CANCELLED), kode urut kembali mulai dari 1.
 *
 * @param baseAmount Nominal dasar dalam IDR (misal: 5000)
 * @returns { baseAmount, uniqueCode, totalAmount }
 */
export async function getUniquePaymentAmount(baseAmount: number): Promise<UniquePaymentResult> {
  const roundedBase = Math.round(baseAmount);

  // Ambil semua sesi PENDING aktif dengan baseAmount yang sama
  const activeSessions = await TopupSession.find({
    status: "PENDING",
    baseAmount: roundedBase,
    createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
  }).select("uniqueCode amountIDR").lean();

  const usedCodes = new Set<number>(
    activeSessions
      .map((s) => s.uniqueCode ?? (s.amountIDR - roundedBase))
      .filter((code): code is number => typeof code === "number" && code > 0)
  );

  // Cari angka urut terkecil mulai dari 1 sampai 1000 yang belum dipakai
  for (let code = 1; code <= 1000; code++) {
    if (!usedCodes.has(code)) {
      return {
        baseAmount: roundedBase,
        uniqueCode: code,
        totalAmount: roundedBase + code,
      };
    }
  }

  // Fallback jika slot 1-1000 penuh
  return {
    baseAmount: roundedBase,
    uniqueCode: 1,
    totalAmount: roundedBase + 1,
  };
}

/**
 * Generates a dynamic QRIS image and payload for a given amount.
 */
export async function generateQris(amountIDR: number): Promise<GeneratedQris> {
  const generator = getQrisGenerator();
  const dataUri = await generator.generate(Math.round(amountIDR));
  const payload = await generator.getDynamicPayload(Math.round(amountIDR));

  const base64Data = dataUri.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  return { buffer, dataUri, payload };
}

import { AntiFraudService } from "../antiFraudService.js";

/**
 * Checks if a pending TopupSession has a matching GoPay QRIS settlement.
 */
export async function checkSessionSettlement(
  session: ITopupSession
): Promise<PaymentTransaction | null> {
  if (session.status !== "PENDING") {
    return null;
  }

  const merchant = getGopayMerchant();
  const startTime = new Date(session.createdAt.getTime() - 2 * 60 * 1000); // 2 min margin
  const endTime = new Date();

  const transactions = await merchant.getQrisSettlements({
    startTime,
    endTime,
  });

  // Find candidate matches
  for (const tx of transactions) {
    const isSettled = tx.status.toUpperCase() === "SETTLEMENT" || tx.status.toUpperCase() === "SETTLED";
    const isAmountMatch = tx.amount === session.amountIDR;
    const isTimeValid = tx.paidAt >= session.createdAt.getTime() - 60_000;

    if (isSettled && isAmountMatch && isTimeValid) {
      // 1. Payment Idempotency & Replay Attack signature check
      const signature = AntiFraudService.computePaymentSignature(
        "GOPAY",
        tx.amount,
        tx.paidAt,
        tx.transactionId
      );

      const replayCheck = await AntiFraudService.checkPaymentReplay(signature, {
        userId: session.telegramId,
        amount: tx.amount,
        txId: tx.transactionId,
        issuer: "GOPAY",
      });

      if (replayCheck.isReplay) {
        console.warn(`[Payment] Blocked replay attack for transaction ${tx.transactionId}`);
        continue;
      }

      // 2. Ensure this transaction wasn't already claimed by another session in MongoDB
      const alreadyClaimed = await TopupSession.exists({
        matchedTransactionId: tx.transactionId,
        _id: { $ne: session._id },
      });

      if (!alreadyClaimed) {
        // Record idempotency signature (TTL: 48h)
        await AntiFraudService.recordPaymentSignature(signature);
        return tx;
      }
    }
  }

  return null;
}
