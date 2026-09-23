import { InlineKeyboard } from "grammy";
import { Types } from "mongoose";
import { createGuardrails, generateSync } from "otplib";
import { DigitalStock, type DigitalStockDocument } from "../models/DigitalStock.js";
import { decryptSecret } from "./crypto.js";

export const ACCOUNT_CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

const TOTP_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 5 });

export interface TotpResult {
  token: string;
  remainingSeconds: number;
  period: number;
  digits: number;
}

export interface TotpStockReference {
  stockId: string;
  accountCode: string;
}

export type TotpAccessFailure = "NOT_FOUND" | "NO_TOTP" | "UNAVAILABLE";

export type TotpAccessResult =
  | ({ success: true } & TotpStockReference & TotpResult)
  | { success: false; reason: TotpAccessFailure };

export interface TotpStockAccessSnapshot {
  _id: Types.ObjectId | string;
  isSold: boolean;
  soldTo?: string | undefined;
  accountCode?: string | undefined;
  totpSecretEncrypted?: string | undefined;
}

export function normalizeAccountCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidAccountCode(value: string): boolean {
  return ACCOUNT_CODE_PATTERN.test(normalizeAccountCode(value));
}

export function normalizeTotpSecret(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/g, "");
}

export function isValidTotpSecret(value: string): boolean {
  const normalized = normalizeTotpSecret(value);
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Z2-7]+$/.test(normalized)) {
    return false;
  }

  try {
    generateSync({
      secret: normalized,
      algorithm: "sha1",
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      epoch: 0,
      guardrails: TOTP_GUARDRAILS,
    });
    return true;
  } catch {
    return false;
  }
}

export function digitalStockTotpPurpose(stockId: Types.ObjectId | string): string {
  return `digital-stock:totp:${stockId.toString()}`;
}

/** Filters used by both command and refresh paths. Ownership is never inferred from a callback. */
export function ownedStockByAccountCodeFilter(accountCode: string, telegramId: string): Record<string, unknown> {
  return {
    accountCode: normalizeAccountCode(accountCode),
    isSold: true,
    soldTo: telegramId,
  };
}

export function ownedStockByIdFilter(stockId: string, telegramId: string): Record<string, unknown> {
  return {
    _id: stockId,
    isSold: true,
    soldTo: telegramId,
  };
}

/** Defense-in-depth check used after the already owner-scoped database query. */
export function classifyTotpStockAccess(
  stock: TotpStockAccessSnapshot | null,
  telegramId: string
): TotpAccessFailure | "AUTHORIZED" {
  if (!stock || !stock.isSold || stock.soldTo !== telegramId || !stock.accountCode) {
    return "NOT_FOUND";
  }
  if (!stock.totpSecretEncrypted) return "NO_TOTP";
  return "AUTHORIZED";
}

export class TotpService {
  public static generateToken(secretKey: string, epochSeconds = Math.floor(Date.now() / 1000)): TotpResult {
    const normalized = normalizeTotpSecret(secretKey);
    if (!isValidTotpSecret(normalized)) throw new Error("Invalid TOTP secret.");

    const token = generateSync({
      secret: normalized,
      algorithm: "sha1",
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      epoch: epochSeconds,
      guardrails: TOTP_GUARDRAILS,
    });
    const remainingSeconds = TOTP_PERIOD_SECONDS - (epochSeconds % TOTP_PERIOD_SECONDS);

    return {
      token,
      remainingSeconds: Math.max(1, remainingSeconds),
      period: TOTP_PERIOD_SECONDS,
      digits: TOTP_DIGITS,
    };
  }

  public static async getOwnedByAccountCode(
    accountCode: string,
    telegramId: string
  ): Promise<TotpAccessResult> {
    if (!isValidAccountCode(accountCode)) return { success: false, reason: "NOT_FOUND" };

    const stock = await DigitalStock.findOne(ownedStockByAccountCodeFilter(accountCode, telegramId))
      .select("+totpSecretEncrypted")
      .exec();
    return this.resolveOwnedStock(stock, telegramId);
  }

  public static async getOwnedByStockId(stockId: string, telegramId: string): Promise<TotpAccessResult> {
    if (!Types.ObjectId.isValid(stockId)) return { success: false, reason: "NOT_FOUND" };

    const stock = await DigitalStock.findOne(ownedStockByIdFilter(stockId, telegramId))
      .select("+totpSecretEncrypted")
      .exec();
    return this.resolveOwnedStock(stock, telegramId);
  }

  public static async getReferencesForOrders(
    orderIds: string[],
    telegramId: string
  ): Promise<Map<string, TotpStockReference[]>> {
    const result = new Map<string, TotpStockReference[]>();
    if (orderIds.length === 0) return result;

    const stocks = await DigitalStock.find({
      orderId: { $in: orderIds },
      isSold: true,
      soldTo: telegramId,
      accountCode: { $exists: true },
      totpSecretEncrypted: { $exists: true },
    })
      .select("accountCode orderId")
      .lean();

    for (const stock of stocks) {
      if (!stock.orderId || !stock.accountCode) continue;
      const refs = result.get(stock.orderId) ?? [];
      refs.push({ stockId: stock._id.toString(), accountCode: stock.accountCode });
      result.set(stock.orderId, refs);
    }

    return result;
  }

  public static buildTotpView(result: TotpAccessResult & { success: true }): {
    text: string;
    keyboard: InlineKeyboard;
  } {
    const formattedToken = `${result.token.slice(0, 3)} ${result.token.slice(3)}`;
    return {
      text:
        `🔐 <b>Kode 2FA</b>\n\n` +
        `Akun: <code>${result.accountCode}</code>\n` +
        `Kode: <code>${formattedToken}</code>\n\n` +
        `⏳ Berlaku sekitar ${result.remainingSeconds} detik lagi.`,
      keyboard: new InlineKeyboard().text("🔄 Refresh Code", `totp_refresh_${result.stockId}`),
    };
  }

  private static resolveOwnedStock(
    stock: DigitalStockDocument | null,
    telegramId: string
  ): TotpAccessResult {
    const classification = classifyTotpStockAccess(stock, telegramId);
    if (classification !== "AUTHORIZED") return { success: false, reason: classification };

    try {
      const secret = decryptSecret(
        stock!.totpSecretEncrypted!,
        digitalStockTotpPurpose(stock!._id)
      );
      const generated = this.generateToken(secret);
      return {
        success: true,
        stockId: stock!._id.toString(),
        accountCode: stock!.accountCode!,
        ...generated,
      };
    } catch {
      return { success: false, reason: "UNAVAILABLE" };
    }
  }
}
