import "dotenv/config";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import mongoose from "mongoose";
import { BotConfig } from "../models/BotConfig.js";

function escapeClean(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const args = process.argv.slice(2);
  const filterArg = args.find((a) => a.startsWith("--filter="))?.split("=")[1] ||
    (args.includes("--netflix") ? "netflix" : args.includes("--paypal") ? "paypal" : undefined);
  const limitArg = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 5;

  console.log("══════════════════════════════════════════════════════════════════");
  console.log("  📬  IMAP Inspector — Baca 5 Email Terakhir & Cek Format OTP    ");
  console.log("══════════════════════════════════════════════════════════════════\n");

  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    try {
      await mongoose.connect(mongoUri, { dbName: process.env.DATABASE_NAME || "telegram-danka" });
    } catch {
      // ignore
    }
  }

  const config = await BotConfig.getOrCreate().catch(() => null);

  const host = config?.imapHost || process.env.IMAP_HOST || "imap.gmail.com";
  const port = config?.imapPort || Number(process.env.IMAP_PORT) || 993;
  const secure = config?.imapSecure !== undefined ? config.imapSecure : process.env.IMAP_SECURE !== "false";
  const user = config?.imapUser || process.env.IMAP_USER || "";
  const pass = config?.imapPass || process.env.IMAP_PASS || process.env.IMAP_PASSWORD || "";
  const mailbox = config?.imapMailbox || process.env.IMAP_MAILBOX || "INBOX";

  console.log(`📡 Menghubungkan ke ${host}:${port} (${user ? user.slice(0, 4) + "***" : "KOSONG"})...`);

  if (!user || !pass) {
    console.error("❌ Kredensial IMAP belum diisi di .env atau database.");
    if (mongoose.connection.readyState === 1) await mongoose.disconnect();
    return;
  }

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    console.log(`✅ Terhubung ke IMAP! Folder Mailbox: [${mailbox}]`);

    const lock = await client.getMailboxLock(mailbox);
    try {
      let searchQuery: any = { all: true };
      if (filterArg) {
        searchQuery = { from: filterArg };
        console.log(`🔍 Filter Pengirim: "${filterArg}"`);
      }

      const allUids = await client.search(searchQuery, { uid: true });
      if (!allUids || allUids.length === 0) {
        console.log("📭 Tidak ada email ditemukan.");
        return;
      }

      console.log(`📊 Ditemukan: ${allUids.length} email matching.\n`);
      const targetUids = allUids.slice(-limitArg).reverse();
      console.log(`📥 Mengambil ${targetUids.length} email terbaru (UIDs: ${targetUids.join(", ")})\n`);

      for (const [i, uid] of targetUids.entries()) {
        const msg = await client.fetchOne(uid, { uid: true, source: true, flags: true, envelope: true }, { uid: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const subject = parsed.subject || "(Tanpa Subjek)";
        const fromText = parsed.from?.text || parsed.from?.value[0]?.address || "Unknown";
        const toText = parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to.text) : "N/A";
        const dateStr = parsed.date ? parsed.date.toLocaleString("id-ID") : "N/A";

        let rawText = (parsed.text || "").trim();
        if (!rawText && parsed.html) {
          rawText = parsed.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        }

        // Provider Detection
        const isNetflix = fromText.toLowerCase().includes("netflix") || subject.toLowerCase().includes("netflix");
        const isPayPal = fromText.toLowerCase().includes("paypal") || subject.toLowerCase().includes("paypal");
        const providerName = isNetflix ? "🎬 NETFLIX" : isPayPal ? "🅿️ PAYPAL" : "📧 EMAIL";

        // OTP Detection
        let detectedOtp: string | undefined;
        if (isNetflix) {
          const netflixChangeMatch =
            rawText.match(/(?:konfirmasikan perubahan akun(?:mu)? dengan kode ini|confirm your account change with this code|masukkan kode ini untuk mengonfirmasi|masukkan kode ini untuk memverifikasi|enter this code to confirm|enter this code to verify|kode ini untuk mengonfirmasi)[^\d]*?([0-9]{4,8})/i);
          const netflixSigninMatch =
            rawText.match(/(?:enter this code to sign in|masukkan kode ini untuk masuk|enter the code above|sign-in code|kode masuk|temporary access code|kode akses sementara|kode akses|access code)[^\d]*?([0-9]{4,8})/i);
          const netflixGenericCodeMatch =
            rawText.match(/(?:kode ini|this code|with this code|menggunakan kode ini|gunakan kode ini|use this code|kode verifikasimu|your verification code)\s*(?:adalah|is|:)?\s*([0-9]{4,8})/i) ||
            rawText.match(/(?:code|kode)\s*(?:is|:|adalah)\s*([0-9]{4,8})/i);

          if (netflixChangeMatch && netflixChangeMatch[1]) {
            detectedOtp = netflixChangeMatch[1];
          } else if (netflixSigninMatch && netflixSigninMatch[1]) {
            detectedOtp = netflixSigninMatch[1];
          } else if (netflixGenericCodeMatch && netflixGenericCodeMatch[1]) {
            detectedOtp = netflixGenericCodeMatch[1];
          } else if (
            /sign-in code|kode masuk|access code|temporary access|verifikasi|verification|ubah|change|update|reset|informasi akun|account/i.test(subject) ||
            /mengubah informasi akun|update your account|perubahan akun|account change/i.test(rawText)
          ) {
            const isolated = rawText.match(/(?:^|\r?\n)\s*([0-9]{4,8})\s*(?:\r?\n|$)/m);
            if (isolated && isolated[1]) detectedOtp = isolated[1];
          }
        } else if (isPayPal) {
          const ppMatch =
            rawText.match(/(?:verification code|security code|kode verifikasi|kode keamanan|one-time code|one-time password|otp)\s*(?:is|:|adalah)?\s*([0-9]{4,8})/i) ||
            rawText.match(/(?:use code|gunakan kode|masukkan kode|enter code)\s*([0-9]{4,8})/i) ||
            rawText.match(/(?:THIS CODE EXPIRES|KODE INI AKAN KADALUARSA|KODE INI AKAN KEDALUWARSA)[^0-9]*([0-9]{4,8})/i);
          if (ppMatch && ppMatch[1]) {
            detectedOtp = ppMatch[1];
          } else if (/verification|verifikasi|security|keamanan|otp|code/i.test(subject)) {
            const fallbackPp = rawText.match(/\b([0-9]{6})\b/);
            if (fallbackPp && fallbackPp[1]) detectedOtp = fallbackPp[1];
          }
        } else {
          const genMatch =
            rawText.match(/(?:verification code|security code|kode verifikasi|kode keamanan|one-time code|one-time password|sign-in code|access code|kode masuk|kode akses|otp)\s*(?:is|:|adalah)?\s*([0-9]{4,8})/i) ||
            rawText.match(/(?:use code|gunakan kode|masukkan kode|enter code)\s*([0-9]{4,8})/i);
          if (genMatch && genMatch[1]) detectedOtp = genMatch[1];
        }

        // Expiry Detection
        const expireMatch =
          rawText.match(/(?:expire(?:s)?(?:\s+in)?|kedaluwarsa(?:\s*dalam)?|kadaluarsa(?:\s*dalam)?|berlaku(?:\s+selama)?)\s*([0-9]+\s*(?:minutes|menit|hours|jam|detik|seconds))/i) ||
          rawText.match(/(?:dalam|in)\s*([0-9]+\s*(?:minutes|menit|hours|jam|detik|seconds))/i);
        const expiresIn = expireMatch ? expireMatch[1] : undefined;

        // Magic Link Detection
        const linkMatch = rawText.match(/(https?:\/\/(?:www\.)?netflix\.com\/(?:val|epr|accountaccess|account\/travel\/verify|youraccount)[^\s"'<>\])]+)/i);
        const magicLink = linkMatch ? linkMatch[1] : undefined;

        console.log(`┌─────────────────── [${providerName}] EMAIL #${i + 1} (UID: ${uid}) ───────────────────┐`);
        console.log(`│ 📅 Waktu       : ${dateStr}`);
        console.log(`│ 👤 Dari        : ${fromText}`);
        console.log(`│ 🎯 Kepada      : ${toText}`);
        console.log(`│ 📌 Subjek      : ${subject}`);
        console.log(`│ 🔑 Kode OTP    : ${detectedOtp ? `\x1b[33m\x1b[1m${detectedOtp}\x1b[0m` : "\x1b[90m(Tidak terdeteksi)\x1b[0m"}`);
        if (expiresIn) {
          console.log(`│ ⏳ Masa Berlaku: ${expiresIn}`);
        }
        if (magicLink) {
          console.log(`│ 🔗 Link Akses  : ${magicLink}`);
        }
        console.log(`├─────────────────── ISI EMAIL LENGKAP (BODY TEXT) ───────────────────┤`);
        console.log(rawText);
        console.log(`└────────────────────────────────────────────────────────────────────────┘\n`);
      }
    } finally {
      lock.release();
      await client.logout();
    }
  } catch (err: any) {
    console.error("❌ IMAP error:", err);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  }
}

main().catch(console.error);
