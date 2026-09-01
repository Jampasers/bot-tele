import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export interface TotpResult {
  token: string;
  remainingSeconds: number;
  period: number;
  digits: number;
}

export interface TotpViewOptions {
  label?: string | undefined;
  maskedSecret?: boolean | undefined;
  backCallback?: string | undefined;
  backLabel?: string | undefined;
  sourceContext?: string | undefined;
}

// ============================================================================
//  Base32 & RFC 6238 Helpers
// ============================================================================

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes a Base32 string into a Buffer.
 * Supports standard RFC 4648 Base32 with or without padding and whitespace.
 */
export function base32ToBuffer(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[\s\-_=]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]!);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Validates if a string is a potentially valid Base32 secret key.
 */
export function isValidBase32(secret: string): boolean {
  const clean = secret.toUpperCase().replace(/[\s\-_=]/g, "");
  if (clean.length < 8 || clean.length > 128) return false;
  return /^[A-Z2-7]+$/.test(clean);
}

// ============================================================================
//  TotpService Class
// ============================================================================

export class TotpService {
  /**
   * Generates a standard RFC 6238 TOTP 6-digit token and calculates remaining valid seconds.
   *
   * @param secretKey Base32 encoded secret key
   * @param period Time step period in seconds (default: 30)
   * @param digits Number of digits in token (default: 6)
   */
  public static generateToken(
    secretKey: string,
    period = 30,
    digits = 6
  ): TotpResult {
    const cleanSecret = secretKey.toUpperCase().replace(/[\s\-_=]/g, "");
    const key = base32ToBuffer(cleanSecret);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const counter = Math.floor(nowSeconds / period);
    const remainingSeconds = period - (nowSeconds % period);

    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigUInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac("sha1", key);
    hmac.update(timeBuffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1]! & 0x0f;
    const binaryCode =
      ((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff);

    const tokenNumber = binaryCode % Math.pow(10, digits);
    const token = tokenNumber.toString().padStart(digits, "0");

    return {
      token,
      remainingSeconds: Math.max(1, remainingSeconds),
      period,
      digits,
    };
  }

  /**
   * Intelligently extracts a 2FA Base32 secret from various formats:
   * - `otpauth://totp/...?secret=JBSWY3DPEHPK3PXP...`
   * - `email|password|2FA_SECRET` or `email:pass:2FA_SECRET`
   * - `2FA: JBSWY3DPEHPK3PXP`
   * - Direct Base32 string
   */
  public static extractSecret(input: string): string | null {
    if (!input || typeof input !== "string") return null;
    const trimmed = input.trim();

    // 1. Format: otpauth URI
    if (trimmed.toLowerCase().startsWith("otpauth://")) {
      try {
        const url = new URL(trimmed);
        const secretParam = url.searchParams.get("secret");
        if (secretParam && isValidBase32(secretParam)) {
          return secretParam.toUpperCase().replace(/[\s\-_=]/g, "");
        }
      } catch {
        const match = trimmed.match(/[?&]secret=([A-Za-z2-7=]+)/i);
        if (match && match[1] && isValidBase32(match[1])) {
          return match[1].toUpperCase().replace(/[\s\-_=]/g, "");
        }
      }
    }

    // 2. Format: Explicit 2FA prefix like "2FA: XYZ", "2FA Secret: XYZ", "OTP: XYZ"
    const prefixMatch = trimmed.match(/(?:2fa|two[- ]?factor|totp|otp|secret)(?:\s*(?:secret|key|code)?\s*[:=\-|])\s*([A-Za-z2-7]{8,64})/i);
    if (prefixMatch && prefixMatch[1] && isValidBase32(prefixMatch[1])) {
      return prefixMatch[1].toUpperCase().replace(/[\s\-_=]/g, "");
    }

    // 3. Format: Delimited credentials like email|pass|2FA_SECRET or email:pass:2FA_SECRET
    const delimiterSplit = trimmed.split(/[\r\n|:]+/);
    if (delimiterSplit.length >= 3) {
      for (let i = 2; i < delimiterSplit.length; i++) {
        const part = delimiterSplit[i]!.trim();
        if (isValidBase32(part) && part.length >= 16) {
          return part.toUpperCase().replace(/[\s\-_=]/g, "");
        }
      }
    }

    // Also test all tokens in lines if multiline
    const lines = trimmed.split(/[\r\n]+/);
    for (const line of lines) {
      const parts = line.split(/[|,: \t]+/);
      for (const p of parts) {
        const cleaned = p.trim().replace(/^["']|["']$/g, "");
        if (isValidBase32(cleaned) && cleaned.length >= 16 && cleaned.length <= 64) {
          // Avoid matching plain password strings unless they are base32-like
          return cleaned.toUpperCase().replace(/[\s\-_=]/g, "");
        }
      }
    }

    // 4. Format: Standalone Base32 secret string
    const directClean = trimmed.toUpperCase().replace(/[\s\-_=]/g, "");
    if (isValidBase32(directClean) && directClean.length >= 16 && directClean.length <= 64) {
      return directClean;
    }

    return null;
  }

  /**
   * Masks a secret key for safe UI display (e.g. `JBSW••••••••3PXP`).
   */
  public static maskSecret(secret: string): string {
    const clean = secret.toUpperCase().replace(/[\s\-_=]/g, "");
    if (clean.length <= 8) return "••••••••";
    const start = clean.slice(0, 4);
    const end = clean.slice(-4);
    return `${start}••••••••${end}`;
  }

  /**
   * Generates a visual progress bar for the remaining seconds.
   */
  public static renderProgressBar(remainingSeconds: number, totalPeriod = 30): string {
    const totalBars = 6;
    const filledBars = Math.max(1, Math.round((remainingSeconds / totalPeriod) * totalBars));
    const emptyBars = totalBars - filledBars;

    let icon = "🟩";
    if (remainingSeconds <= 5) icon = "🟥";
    else if (remainingSeconds <= 10) icon = "🟨";

    return icon.repeat(filledBars) + "⬜".repeat(emptyBars);
  }

  /**
   * Builds an interactive HTML message and Inline Keyboard for live TOTP viewing.
   */
  public static buildTotpView(
    secret: string,
    options?: TotpViewOptions
  ): { text: string; keyboard: InlineKeyboard } {
    const result = this.generateToken(secret);
    const progressBar = this.renderProgressBar(result.remainingSeconds, result.period);
    const masked = this.maskSecret(secret);

    // Format token with a space in the middle for easier readability (e.g. 123 456)
    const formattedToken =
      result.token.length === 6
        ? `${result.token.slice(0, 3)} ${result.token.slice(3)}`
        : result.token;

    // Base64 encode secret for callback query data (safe URL-safe base64)
    const encodedSecret = Buffer.from(secret).toString("base64url");

    let text =
      `🔐 <b>Kode Verifikasi 2FA (TOTP)</b>\n` +
      `${"─".repeat(30)}\n\n`;

    if (options?.label) {
      text += `🏷️ <b>Label / Akun:</b> ${options.label}\n`;
    }

    text +=
      `🔑 <b>Secret Key:</b> <code>${masked}</code>\n\n` +
      `🔢 <b>Kode OTP Saat Ini:</b>\n` +
      `👉 <code>${result.token}</code> 👈 (<i>${formattedToken}</i>)\n\n` +
      `⏳ <b>Masa Berlaku:</b> ${progressBar} <b>${result.remainingSeconds}s</b>\n` +
      `<i>(Kode akan otomatis berganti setiap ${result.period} detik)</i>\n\n` +
      `💡 <i>Ketuk kode angka di atas untuk langsung menyalin ke clipboard.</i>`;

    const kb = new InlineKeyboard()
      .text(`🔄 Refresh (${result.remainingSeconds}s)`, `totp_ref_${encodedSecret}`)
      .row();

    if (options?.backCallback) {
      kb.text(options.backLabel || "🔙 Kembali", options.backCallback);
    } else {
      kb.text("❌ Tutup", "totp_del");
    }

    return { text, keyboard: kb };
  }
}
