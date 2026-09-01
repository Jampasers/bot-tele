import "dotenv/config";
import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { Api } from "grammy";
import { connectDatabase, disconnectDatabase } from "../core/db.js";
import { BotConfig, IBotConfig } from "../models/BotConfig.js";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export type OtpProviderType = "PAYPAL" | "NETFLIX" | "DISCORD" | "GENERIC";

export interface ParsedEmailOtp {
  uid: number;
  date: Date | null;
  subject: string;
  senderName: string;
  senderEmail: string;
  isRead: boolean;
  provider: OtpProviderType;
  recipientName?: string | undefined;
  recipientEmail?: string | undefined;
  otpCode?: string | undefined;
  expiresIn?: string | undefined;
  magicLink?: string | undefined;
  transactionId?: string | undefined;
  amount?: string | undefined;
  currency?: string | undefined;
  payerEmail?: string | undefined;
  previewText?: string | undefined;
  rawText: string;
}

export type ParsedPayPalTransaction = ParsedEmailOtp;

export interface ImapStatusSummary {
  connected: boolean;
  listening: boolean;
  configured: boolean;
  host: string;
  user: string;
  targetSender: string;
  mailbox: string;
  lastConnectedAt?: Date | undefined;
  lastReceivedAt?: Date | undefined;
  lastReceivedOtp?: string | undefined;
  lastRecipientName?: string | undefined;
  totalOtpForwarded: number;
  lastError?: string | undefined;
  pid?: number | undefined;
}

// ============================================================================
//  Helpers
// ============================================================================

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDateWIB(date: Date = new Date()): string {
  return (
    new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date) + " WIB"
  );
}

/**
 * Masks email address for privacy (e.g. tukav@dstur.my.id -> ***av@**tur.my.id)
 */
function maskEmail(email?: string): string {
  if (!email || !email.includes("@")) return email || "(Tidak terdeteksi)";
  const parts = email.split("@");
  const local = parts[0] || "";
  const domain = parts.slice(1).join("@");
  if (!local || !domain) return email;

  let maskedLocal = local;
  if (local.length <= 2) {
    maskedLocal = "*".repeat(local.length);
  } else if (local.length <= 3) {
    maskedLocal = "**" + local.slice(-1);
  } else {
    // e.g. "tukav" (len 5) -> 3 asterisks + 2 chars = "***av"
    const keepCount = 2;
    const starCount = Math.min(local.length - keepCount, 3);
    maskedLocal = "*".repeat(starCount) + local.slice(-keepCount);
  }

  const dotIndex = domain.indexOf(".");
  if (dotIndex > 0) {
    const mainDomain = domain.slice(0, dotIndex);
    const ext = domain.slice(dotIndex);
    let maskedMain = mainDomain;
    if (mainDomain.length <= 2) {
      maskedMain = "*".repeat(mainDomain.length);
    } else {
      // e.g. "dstur" (len 5) -> 2 asterisks + "tur" = "**tur"
      const starCount = Math.min(2, mainDomain.length - 1);
      maskedMain = "*".repeat(starCount) + mainDomain.slice(starCount);
    }
    return `${maskedLocal}@${maskedMain}${ext}`;
  }

  return `${maskedLocal}@${domain}`;
}

// ============================================================================
//  IMAP Worker Process Controller
// ============================================================================

class ImapChildWorker {
  private client: ImapFlow | null = null;
  private api: Api | null = null;
  private isRunning: boolean = false;
  private isConnected: boolean = false;
  private isListening: boolean = false;
  private processedUids: Set<number> = new Set<number>();
  private totalOtpForwarded: number = 0;
  private lastConnectedAt?: Date | undefined;
  private lastReceivedAt?: Date | undefined;
  private lastReceivedOtp?: string | undefined;
  private lastRecipientName?: string | undefined;
  private lastError?: string | undefined;

  constructor() {
    const token = process.env.BOT_TOKEN;
    if (token) {
      this.api = new Api(token);
    }
  }

  public getStatus(config?: IBotConfig | null): ImapStatusSummary {
    const isConfigured = !!(config?.imapHost && config?.imapUser && config?.imapPass);
    return {
      connected: this.isConnected,
      listening: this.isListening,
      configured: isConfigured,
      host: config?.imapHost || "-",
      user: config?.imapUser ? `${config.imapUser.slice(0, 3)}***` : "-",
      targetSender: config?.imapTargetSender || "service@intl.paypal.com",
      mailbox: config?.imapMailbox || "INBOX",
      lastConnectedAt: this.lastConnectedAt,
      lastReceivedAt: this.lastReceivedAt,
      lastReceivedOtp: this.lastReceivedOtp,
      lastRecipientName: this.lastRecipientName,
      totalOtpForwarded: this.totalOtpForwarded,
      lastError: this.lastError,
      pid: process.pid,
    };
  }

  public broadcastStatus(config?: IBotConfig | null): void {
    if (process.send) {
      process.send({
        type: "STATUS_UPDATE",
        payload: this.getStatus(config),
      });
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.runBackgroundLoop().catch((err) => {
      console.error("[IMAP Worker] Fatal error in background worker loop:", err);
    });
  }

  public async restart(): Promise<void> {
    console.log("[IMAP Worker] Restarting IMAP connection...");
    await this.disconnectClient();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    await this.disconnectClient();
    try {
      await disconnectDatabase();
    } catch {
      // ignore
    }
  }

  private async disconnectClient(): Promise<void> {
    this.isConnected = false;
    this.isListening = false;
    if (this.client) {
      try {
        if (this.client.usable) {
          await this.client.logout();
        } else {
          this.client.close();
        }
      } catch {
        try {
          this.client.close();
        } catch {
          // ignore
        }
      }
      this.client = null;
    }
  }

  private async runBackgroundLoop(): Promise<void> {
    while (this.isRunning) {
      let config: IBotConfig | null = null;
      try {
        config = await BotConfig.getOrCreate();

        if (!config.imapEnabled || !config.imapHost || !config.imapUser || !config.imapPass) {
          this.isConnected = false;
          this.isListening = false;
          this.broadcastStatus(config);
          await new Promise((res) => setTimeout(res, 15000));
          continue;
        }

        console.log(`[IMAP Worker (PID ${process.pid})] Menghubungkan ke ${config.imapHost}:${config.imapPort} (${config.imapUser})...`);

        this.client = new ImapFlow({
          host: config.imapHost,
          port: config.imapPort || 993,
          secure: config.imapSecure !== false,
          auth: {
            user: config.imapUser,
            pass: config.imapPass,
          },
          logger: false,
          emitLogs: false,
          autoIdleDelay: 500, // Re-engage IDLE quickly within 500ms after queries (default is 15s)
          maxIdleTime: 20000, // Refresh IDLE session every 20s to prevent stale sockets
          missingIdleCommand: "STATUS", // Use fast STATUS command if server lacks IDLE
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 30000,
        });

        this.client.on("error", (err: any) => {
          this.isConnected = false;
          this.isListening = false;
          const msg = err?.message || String(err);
          this.lastError = msg;
          this.broadcastStatus(config);
        });

        this.client.on("close", () => {
          this.isConnected = false;
          this.isListening = false;
          this.broadcastStatus(config);
        });

        await this.client.connect();
        this.isConnected = true;
        this.lastConnectedAt = new Date();
        this.lastError = undefined;
        this.broadcastStatus(config);
        console.log(`[IMAP Worker] ✅ Terhubung dan terautentikasi ke ${config.imapHost}.`);

        await this.listenMailbox(config);
      } catch (err: any) {
        this.isConnected = false;
        this.isListening = false;
        const errMsg = err?.message || String(err);
        this.lastError = errMsg;
        this.broadcastStatus(config);

        const isAuthError =
          err?.authenticationFailed ||
          err?.code === "NoConnection" ||
          errMsg.toLowerCase().includes("authentication") ||
          errMsg.toLowerCase().includes("credentials");

        if (isAuthError) {
          console.warn(
            `[IMAP Worker] ❌ Autentikasi Gagal atau Koneksi Ditolak (${errMsg}).\n` +
            `       💡 Periksa email & password di Admin Panel. Mencoba kembali dalam 30s...`
          );
        } else {
          console.warn(`[IMAP Worker] ⚠️ Koneksi terputus (${errMsg}). Reconnecting in 10s...`);
        }

        await this.disconnectClient();

        if (!this.isRunning) break;
        await new Promise((res) => setTimeout(res, isAuthError ? 30000 : 10000));
      }
    }
  }

  private async listenMailbox(config: IBotConfig): Promise<void> {
    if (!this.client || !this.client.usable) return;

    const mailboxName = config.imapMailbox || "INBOX";
    const rawTargetSender = (config.imapTargetSender || "service@intl.paypal.com").toLowerCase().trim();
    const lock = await this.client.getMailboxLock(mailboxName);

    try {
      this.isListening = true;
      this.broadcastStatus(config);

      let lastKnownUid = 0;
      if (this.client.mailbox && typeof this.client.mailbox === "object" && this.client.mailbox.uidNext) {
        lastKnownUid = Math.max(0, this.client.mailbox.uidNext - 1);
      } else {
        const uids = await this.client.search({ all: true }, { uid: true });
        if (uids && uids.length > 0) {
          lastKnownUid = Math.max(...uids);
        }
      }

      console.log(`[IMAP Worker] 📡 Standby mendengarkan email di folder "${mailboxName}"... (Target: ${rawTargetSender}, Baseline UID: ${lastKnownUid})`);

      let isProcessing = false;
      let hasPendingCheck = false;

      const processIncomingNewEmails = async () => {
        if (isProcessing) {
          hasPendingCheck = true;
          return;
        }
        if (!this.client || !this.client.usable) return;

        isProcessing = true;
        try {
          do {
            hasPendingCheck = false;
            const searchRange = `${Math.max(1, lastKnownUid + 1)}:*`;

            // Query only new incoming UIDs (strictly higher than baseline lastKnownUid)
            const rangeUids = await this.client.search({ uid: searchRange }, { uid: true }).catch(() => [] as number[]);

            const newUids = (rangeUids || []).filter(
              (uid) => !this.processedUids.has(uid) && uid > lastKnownUid
            );

            if (newUids.length === 0) break;

            console.log(`[IMAP Worker] ⚡ [FAST DISPATCH] Ditemukan ${newUids.length} email baru di ${mailboxName}. Memproses...`);
            newUids.sort((a, b) => a - b);

            const messages = this.client.fetch(
              newUids,
              { uid: true, source: true, flags: true },
              { uid: true }
            );

            for await (const msg of messages) {
              this.processedUids.add(msg.uid);
              if (msg.uid > lastKnownUid) {
                lastKnownUid = msg.uid;
              }

              // Prune old processed UIDs if memory set exceeds 5000 entries
              if (this.processedUids.size > 5000) {
                const uidsArr = Array.from(this.processedUids);
                for (let i = 0; i < 1000 && i < uidsArr.length; i++) {
                  const uidToDelete = uidsArr[i];
                  if (uidToDelete !== undefined) {
                    this.processedUids.delete(uidToDelete);
                  }
                }
              }

              if (!msg.source) continue;

              const parsed = await simpleParser(msg.source);
              const isRead = msg.flags ? msg.flags.has("\\Seen") : false;

              const emailData = this.parseEmailContent(msg.uid, parsed, isRead, rawTargetSender);
              this.logEmailData(emailData);

              // Forward to Telegram Channel if matches criteria
              await this.forwardToTelegramChannel(emailData, config);
            }
          } while (hasPendingCheck && this.client && this.client.usable);
        } catch (procErr: any) {
          console.error("[IMAP Worker ERROR] Gagal memproses email baru:", procErr);
        } finally {
          isProcessing = false;
        }
      };

      const onExists = async (data: { count: number }) => {
        console.log(`[IMAP Worker NOTIF] ⚡ Push event masuk ke mailbox ${mailboxName} (Total: ${data.count}).`);
        await processIncomingNewEmails();
      };

      this.client.on("exists", onExists);

      // Fast Active Polling Ticker (Every 2 seconds)
      // Solves server IDLE delay by immediately checking incoming emails every 2s
      const pollInterval = setInterval(() => {
        if (!this.isRunning || !this.isConnected || !this.client || !this.client.usable) {
          return;
        }
        processIncomingNewEmails().catch(() => {});
      }, 2000);

      try {
        // Run initial immediate check
        await processIncomingNewEmails();

        while (this.isRunning && this.isConnected && this.client && this.client.usable) {
          try {
            await this.client.idle();
          } catch {
            if (!this.isRunning || !this.client?.usable) break;
          }
          if (!this.client?.usable) break;
          await processIncomingNewEmails();
        }
      } finally {
        clearInterval(pollInterval);
        if (this.client) {
          this.client.off("exists", onExists);
        }
      }
    } finally {
      this.isListening = false;
      this.broadcastStatus(config);
      try {
        lock.release();
      } catch {
        // ignore lock release error
      }
    }
  }

  /**
   * Universal email parser supporting Netflix, PayPal, and generic OTP codes.
   */
  public parseEmailContent(
    uid: number,
    parsed: ParsedMail,
    isRead: boolean,
    defaultTargetSender: string = "service@intl.paypal.com"
  ): ParsedEmailOtp {
    let rawText = (parsed.text || "").trim();
    if (!rawText && parsed.html) {
      rawText = parsed.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }

    const subject = parsed.subject || "(Tanpa Subjek)";
    const date = parsed.date || null;
    const senderName = parsed.from?.value[0]?.name || parsed.from?.text || "Unknown Sender";
    const senderEmail = parsed.from?.value[0]?.address || defaultTargetSender;

    // Recipient extraction from To header
    let recipientEmail: string | undefined;
    let recipientName: string | undefined;

    if (parsed.to) {
      const toObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
      const toVal = toObj?.value && toObj.value.length > 0 ? toObj.value[0] : undefined;
      if (toVal) {
        recipientEmail = toVal.address;
        if (toVal.name && toVal.name.trim() && !toVal.name.includes("@")) {
          recipientName = toVal.name.trim();
        } else if (toVal.address) {
          recipientName = toVal.address.split("@")[0];
        }
      }
    }

    // Determine Provider
    const senderLower = `${senderName} ${senderEmail}`.toLowerCase();
    const subjectLower = subject.toLowerCase();
    let provider: OtpProviderType = "GENERIC";

    if (senderLower.includes("netflix") || subjectLower.includes("netflix")) {
      provider = "NETFLIX";
    } else if (senderLower.includes("paypal") || subjectLower.includes("paypal")) {
      provider = "PAYPAL";
    } else if (senderLower.includes("discord") || subjectLower.includes("discord")) {
      provider = "DISCORD";
    }

    // 1. Ekstraksi Nama Penerima Lebih Spesifik dari Teks Body (hanya pada baris yang sama dengan greeting)
    // Gunakan [ \t]+ horizontal space agar tidak mencocokkan baris baru/kalimat berikutnya
    const greetingMatch = rawText.match(
      /(?:Hello|Halo|Hi|Hey|Dear)[ \t]+([A-Za-z0-9.'_-]+(?:\s+[A-Za-z0-9.'_-]+){0,3})\s*[,!?:;]?(?:\r?\n|$)/i
    );
    if (greetingMatch && greetingMatch[1]?.trim()) {
      const candidate = greetingMatch[1].trim();
      const invalidWords = /^(kami|kita|anda|kamu|menerima|permintaan|untuk|mengubah|received|request|update|information|change|confirm|please|mohon|klik|click|netflix|paypal|discord|customer|pelanggan|member|user|pengguna|there|everyone|all)$/i;
      if (!invalidWords.test(candidate) && candidate.length >= 2 && candidate.length <= 35) {
        recipientName = candidate;
      }
    } else if (provider === "PAYPAL") {
      const headerMatch = rawText.match(
        /^([A-Za-z0-9\s.'-]+?),\s*(?:THIS CODE EXPIRES|KODE INI AKAN KADALUARSA|KODE INI AKAN KEDALUWARSA)/im
      );
      if (headerMatch && headerMatch[1]?.trim()) {
        recipientName = headerMatch[1].trim();
      }
    }

    // Fallback recipient email from rawText body if not in To header
    if (!recipientEmail) {
      const bodyEmailMatch = rawText.match(/(?:email ke|email to|ke|to)\s*\[?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\]?/i);
      if (bodyEmailMatch && bodyEmailMatch[1]) {
        recipientEmail = bodyEmailMatch[1].trim();
      }
    }

    // 2. Ekstraksi Kode OTP
    let otpCode: string | undefined;

    if (provider === "NETFLIX") {
      // Pola khusus Netflix OTP:
      // A. Change email / Account change confirmation code:
      // "Konfirmasikan perubahan akunmu dengan kode ini:\n\n483542"
      // "Confirm your account change with this code:\n\n483542"
      // "masukkan kode ini untuk mengonfirmasi"
      const netflixChangeMatch =
        rawText.match(/(?:konfirmasikan perubahan akun(?:mu)? dengan kode ini|confirm your account change with this code|masukkan kode ini untuk mengonfirmasi|masukkan kode ini untuk memverifikasi|enter this code to confirm|enter this code to verify|kode ini untuk mengonfirmasi)[^\d]*?([0-9]{4,8})/i);

      // B. Sign-in code & Temporary access / household:
      // "Enter this code to sign in\n\n7065\n\nEnter the code above..."
      // "Masukkan kode ini untuk masuk\n\n7065"
      const netflixSigninMatch =
        rawText.match(/(?:enter this code to sign in|masukkan kode ini untuk masuk|enter the code above|sign-in code|kode masuk|temporary access code|kode akses sementara|kode akses|access code)[^\d]*?([0-9]{4,8})/i);

      // C. Generic "kode ini / this code / kode verifikasimu / code is / kode adalah / kode:":
      const netflixGenericCodeMatch =
        rawText.match(/(?:kode ini|this code|with this code|menggunakan kode ini|gunakan kode ini|use this code|kode verifikasimu|your verification code)\s*(?:adalah|is|:)?\s*([0-9]{4,8})/i) ||
        rawText.match(/(?:code|kode)\s*(?:is|:|adalah)\s*([0-9]{4,8})/i);

      if (netflixChangeMatch && netflixChangeMatch[1]) {
        otpCode = netflixChangeMatch[1];
      } else if (netflixSigninMatch && netflixSigninMatch[1]) {
        otpCode = netflixSigninMatch[1];
      } else if (netflixGenericCodeMatch && netflixGenericCodeMatch[1]) {
        otpCode = netflixGenericCodeMatch[1];
      } else if (
        /sign-in code|kode masuk|access code|temporary access|verifikasi|verification|ubah|change|update|reset|informasi akun|account/i.test(subject) ||
        /mengubah informasi akun|update your account|perubahan akun|account change/i.test(rawText)
      ) {
        // Cari angka 4-8 digit terisolasi dalam baris tersendiri di bagian atas email
        const isolatedMatch = rawText.match(/(?:^|\r?\n)\s*([0-9]{4,8})\s*(?:\r?\n|$)/m);
        if (isolatedMatch && isolatedMatch[1]) {
          otpCode = isolatedMatch[1];
        }
      }
    } else if (provider === "PAYPAL") {
      const ppMatch =
        rawText.match(/(?:verification code|security code|kode verifikasi|kode keamanan|one-time code|one-time password|otp)\s*(?:is|:|adalah)?\s*([0-9]{4,8})/i) ||
        rawText.match(/(?:use code|gunakan kode|masukkan kode|enter code)\s*([0-9]{4,8})/i) ||
        rawText.match(/(?:THIS CODE EXPIRES|KODE INI AKAN KADALUARSA|KODE INI AKAN KEDALUWARSA)[^0-9]*([0-9]{4,8})/i);

      if (ppMatch && ppMatch[1]) {
        otpCode = ppMatch[1];
      } else if (/verification|verifikasi|security|keamanan|otp|code/i.test(subject)) {
        const fallbackPp = rawText.match(/\b([0-9]{6})\b/);
        if (fallbackPp && fallbackPp[1]) {
          otpCode = fallbackPp[1];
        }
      }
    } else if (provider === "DISCORD") {
      // 1. Cek subject (e.g. "Your Discord email verification code is Y66MF6")
      const subjectCodeMatch = subject.match(/(?:verification code|security code|kode verifikasi|kode keamanan)\s*(?:is|:|adalah)?\s*([A-Za-z0-9]{4,8})/i);
      if (subjectCodeMatch && subjectCodeMatch[1]) {
        otpCode = subjectCodeMatch[1].trim().toUpperCase();
      }

      // 2. Cek HTML body jika belum dapat
      if (!otpCode && parsed.html) {
        const htmlCodeMatch = String(parsed.html).match(/font-size:\s*(?:24|28|30|32|36)px[^>]*>\s*([A-Za-z0-9]{4,8})\s*<\/div>/i);
        if (htmlCodeMatch && htmlCodeMatch[1]) {
          otpCode = htmlCodeMatch[1].trim().toUpperCase();
        }
      }

      // 3. Cek text body
      if (!otpCode) {
        const dcCodeMatch =
          rawText.match(/(?:verification code|security code|kode verifikasi|kode keamanan|security code is|kode kamu adalah|your code is|verification code:)\s*(?:is|:|adalah)?\s*([A-Za-z0-9]{4,8})/i) ||
          rawText.match(/(?:code|kode)\s*(?:is|:|adalah)\s*([A-Za-z0-9]{4,8})/i);

        if (dcCodeMatch && dcCodeMatch[1]) {
          otpCode = dcCodeMatch[1].trim().toUpperCase();
        } else if (/verification|verifikasi|security|keamanan|otp|code|auth/i.test(subject)) {
          const fallbackDc = rawText.match(/\b([A-Za-z0-9]{6})\b/);
          if (fallbackDc && fallbackDc[1]) {
            otpCode = fallbackDc[1].trim().toUpperCase();
          }
        }
      }
    }

    // Fallback Generic OTP Extraction jika belum terdeteksi
    if (!otpCode) {
      const genericMatch =
        rawText.match(/(?:verification code|security code|kode verifikasi|kode keamanan|one-time code|one-time password|sign-in code|access code|kode masuk|kode akses|otp)\s*(?:is|:|adalah)?\s*([0-9]{4,8})/i) ||
        rawText.match(/(?:use code|gunakan kode|masukkan kode|enter code)\s*([0-9]{4,8})/i);

      if (genericMatch && genericMatch[1]) {
        otpCode = genericMatch[1];
      }
    }

    // 3. Ekstraksi Link / Magic Link
    let magicLink: string | undefined;
    if (provider === "NETFLIX") {
      const netflixLinkMatch = rawText.match(/(https?:\/\/(?:www\.)?netflix\.com\/(?:val|epr|accountaccess|account\/travel\/verify|youraccount)[^\s"'<>\])]+)/i);
      if (netflixLinkMatch && netflixLinkMatch[1]) {
        magicLink = netflixLinkMatch[1];
      }
    } else if (provider === "DISCORD") {
      const dcLinkMatch =
        rawText.match(/(https?:\/\/(?:click\.discord\.com\/[^\s"'<>\])]+|discord\.com\/(?:verify|ls\/click|account-verification|reset|email-verify)[^\s"'<>\])]+))/i) ||
        rawText.match(/(?:Verify Email|Verifikasi Email|Verify)\s*:\s*(https?:\/\/[^\s"'<>\])]+)/i);
      if (dcLinkMatch && dcLinkMatch[1]) {
        magicLink = dcLinkMatch[1];
      }
    }

    // 4. Ekstraksi Waktu Kadaluarsa
    let expiresIn: string | undefined;
    const expireMatch =
      rawText.match(/(?:expire(?:s)?(?:\s+in)?|kedaluwarsa(?:\s*dalam)?|kadaluarsa(?:\s*dalam)?|berlaku(?:\s+selama)?)\s*([0-9]+\s*(?:minutes|menit|hours|jam|detik|seconds))/i) ||
      rawText.match(/(?:dalam|in)\s*([0-9]+\s*(?:minutes|menit|hours|jam|detik|seconds))/i);
    if (expireMatch && expireMatch[1]) {
      expiresIn = expireMatch[1];
    }

    // 5. Ekstraksi Transaksi Standar (PayPal / Lainnya)
    let transactionId: string | undefined;
    const txMatch = rawText.match(/(?:Transaction ID|ID Transaksi|Transaction-ID):\s*([A-Z0-9]{10,20})/i);
    if (txMatch && txMatch[1]) {
      transactionId = txMatch[1];
    }

    let amount: string | undefined;
    let currency: string | undefined;
    const amountMatch = rawText.match(
      /(?:received|sent|total|amount|jumlah|sebesar|payment)\s*(?:a\s+payment\s+)?(?:of\s+)?([$€£¥]|Rp\.?|USD|EUR|IDR|SGD|AUD)?\s*([\d,.]+)\s*(USD|EUR|IDR|SGD|AUD)?/i
    );
    if (amountMatch) {
      currency = amountMatch[1] || amountMatch[3] || "USD";
      amount = amountMatch[2];
    }

    // Clean single-line preview text
    const previewText = rawText.replace(/\s+/g, " ").slice(0, 200).trim();

    const data: ParsedEmailOtp = {
      uid,
      date,
      subject,
      senderName,
      senderEmail,
      isRead,
      provider,
      previewText,
      rawText,
    };

    if (recipientName !== undefined) data.recipientName = recipientName;
    if (recipientEmail !== undefined) data.recipientEmail = recipientEmail;
    if (otpCode !== undefined) data.otpCode = otpCode;
    if (expiresIn !== undefined) data.expiresIn = expiresIn;
    if (magicLink !== undefined) data.magicLink = magicLink;
    if (transactionId !== undefined) data.transactionId = transactionId;
    if (amount !== undefined) data.amount = amount;
    if (currency !== undefined) data.currency = currency;

    return data;
  }

  // Alias for backward compatibility
  public parsePayPalContent(
    uid: number,
    parsed: ParsedMail,
    isRead: boolean,
    defaultTargetSender: string = "service@intl.paypal.com"
  ): ParsedEmailOtp {
    return this.parseEmailContent(uid, parsed, isRead, defaultTargetSender);
  }

  private logEmailData(tx: ParsedEmailOtp): void {
    const providerBadge =
      tx.provider === "NETFLIX"
        ? "🎬 NETFLIX"
        : tx.provider === "PAYPAL"
        ? "🅿️ PAYPAL"
        : tx.provider === "DISCORD"
        ? "🎮 DISCORD"
        : "📧 EMAIL OTP";

    console.log(`┌────────────────────── HASIL PARSING ${providerBadge} (WORKER) ─────────────┐`);
    console.log(`│ UID            : ${tx.uid}`);
    console.log(`│ Provider       : ${tx.provider}`);
    console.log(`│ Status         : ${tx.isRead ? "Sudah Dibaca (Read)" : "Belum Dibaca (Unread)"}`);
    console.log(`│ Tanggal        : ${tx.date ? tx.date.toLocaleString("id-ID") : "-"}`);
    console.log(`│ Subjek         : ${tx.subject}`);
    console.log(`│ Nama Penerima  : ${tx.recipientName ? `\x1b[32m${tx.recipientName}\x1b[0m` : "(Tidak terdeteksi)"}`);
    console.log(`│ Email Penerima : ${tx.recipientEmail || "(Tidak terdeteksi)"}`);
    console.log(`│ Kode OTP       : ${tx.otpCode ? `\x1b[33m\x1b[1m${tx.otpCode}\x1b[0m` : "(Tidak terdeteksi)"}`);
    if (tx.expiresIn) {
      console.log(`│ Kadaluarsa     : ${tx.expiresIn}`);
    }
    if (tx.magicLink) {
      console.log(`│ Link Akses     : ${tx.magicLink.slice(0, 60)}...`);
    }
    if (tx.transactionId) {
      console.log(`│ ID Transaksi   : ${tx.transactionId}`);
    }
    if (tx.amount) {
      console.log(`│ Nominal        : ${tx.currency || ""} ${tx.amount}`);
    }
    console.log("└──────────────────────────────────────────────────────────────────┘\n");
  }

  public async forwardToTelegramChannel(tx: ParsedEmailOtp, liveConfig?: IBotConfig | null): Promise<boolean> {
    if (!this.api) {
      console.warn("[IMAP Worker] Telegram API tidak tersedia.");
      return false;
    }

    try {
      const config = liveConfig || (await BotConfig.getOrCreate());

      let targetChannel = "";
      let isEnabled = false;

      if (tx.provider === "NETFLIX") {
        isEnabled = config.otpNetflixChannelEnabled !== false;
        targetChannel = (config.otpNetflixChannel || config.otpChannel || "").trim();
        if (!isEnabled || !targetChannel) {
          console.log("[IMAP Worker] ℹ️ Channel OTP Netflix dinonaktifkan atau belum diatur.");
          return false;
        }
      } else if (tx.provider === "PAYPAL") {
        isEnabled = config.otpChannelEnabled !== false;
        targetChannel = (config.otpChannel || "").trim();
        if (!isEnabled || !targetChannel) {
          console.log("[IMAP Worker] ℹ️ Channel OTP PayPal dinonaktifkan atau belum diatur.");
          return false;
        }
      } else if (tx.provider === "DISCORD") {
        isEnabled = config.otpDiscordChannelEnabled !== false;
        targetChannel = (config.otpDiscordChannel || config.otpChannel || "").trim();
        if (!isEnabled || !targetChannel) {
          console.log("[IMAP Worker] ℹ️ Channel OTP Discord dinonaktifkan atau belum diatur.");
          return false;
        }
      } else {
        // Mode dibatasi khusus PayPal, Netflix, dan Discord saja
        console.log(`[IMAP Worker] ℹ️ Email non-PayPal/Netflix/Discord (${tx.provider}, Pengirim: ${tx.senderEmail}, Subjek: "${tx.subject}") dilewati: Forwarder saat ini dibatasi khusus PayPal, Netflix & Discord.`);
        return false;
      }

      const subject = (tx.subject || "").trim();
      const dateStr = formatDateWIB(tx.date || new Date());
      const safeRecipient = tx.recipientName
        ? escapeHtml(tx.recipientName)
        : tx.recipientEmail
        ? escapeHtml(tx.recipientEmail)
        : "<i>(Tidak terdeteksi)</i>";
      const safeSender = escapeHtml(tx.senderEmail || tx.senderName);
      const expireLine = tx.expiresIn ? `⏳ <b>Masa Berlaku:</b> <code>${escapeHtml(tx.expiresIn)}</code>\n` : "";
      const otpCodeStr = tx.otpCode ? `<code>${escapeHtml(tx.otpCode)}</code>` : "<i>(Tidak terdeteksi)</i>";

      // ── Filter Wajib: Email HARUS memiliki kode OTP atau Magic Link (khusus Discord) ──────────
      if (!tx.otpCode && !(tx.provider === "DISCORD" && tx.magicLink)) {
        console.log(`[IMAP Worker] ℹ️ Email ${tx.provider} UID ${tx.uid} dilewati: Tidak ada kode OTP (Subjek: "${subject}").`);
        return false;
      }

      let text = "";

      if (tx.provider === "NETFLIX") {
        if (!tx.otpCode) {
          console.log(`[IMAP Worker] ℹ️ Email Netflix UID ${tx.uid} dilewati: Tidak ada kode OTP terdeteksi.`);
          return false;
        }

        const maskedEmailStr = tx.recipientEmail ? maskEmail(tx.recipientEmail) : undefined;
        const emailLine = maskedEmailStr
          ? `📧 <b>Email Akun:</b> <code>${escapeHtml(maskedEmailStr)}</code>\n`
          : "";

        const isChangeEmailOrUpdate =
          /ubah|change|update|verifikas|verif|informasi akun|account/i.test(subject) ||
          /mengubah informasi akun|update your account|perubahan akun|account change/i.test(tx.rawText);

        const title = isChangeEmailOrUpdate
          ? `🎬 <b>KODE VERIFIKASI NETFLIX DITERIMA</b> 🎬`
          : `🎬 <b>KODE MASUK NETFLIX DITERIMA</b> 🎬`;
        const codeLabel = isChangeEmailOrUpdate
          ? `🔑 <b>Kode Verifikasi (OTP):</b>`
          : `🔑 <b>Kode Masuk (OTP):</b>`;
        const note = isChangeEmailOrUpdate
          ? `<i>✨ Kode verifikasi Netflix (Ganti Email / Akun) diterima secara real-time. Klik kode untuk menyalin.</i>`
          : `<i>✨ Kode masuk Netflix diterima secara real-time. Klik kode untuk menyalin.</i>`;

        text =
          `${title}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          emailLine +
          `${codeLabel} ${otpCodeStr}\n` +
          expireLine +
          `📅 <b>Waktu:</b> ${dateStr}\n` +
          `📧 <b>Pengirim:</b> <code>${safeSender}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          note;
      } else if (tx.provider === "PAYPAL") {
        if (!tx.otpCode) {
          console.log(`[IMAP Worker] ℹ️ Email PayPal UID ${tx.uid} dilewati: Tidak ada kode OTP terdeteksi.`);
          return false;
        }

        const safeRecipientName = tx.recipientName
          ? escapeHtml(tx.recipientName)
          : "<i>(Tidak terdeteksi)</i>";

        text =
          `🔐 <b>KODE OTP PAYPAL DITERIMA</b> 🔐\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 <b>Nama Penerima:</b> <b>${safeRecipientName}</b>\n` +
          `🔑 <b>Kode OTP:</b> ${otpCodeStr}\n` +
          expireLine +
          `📅 <b>Waktu:</b> ${dateStr}\n` +
          `📧 <b>Pengirim:</b> <code>${safeSender}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>✨ Kode OTP diterima secara real-time via email. Klik kode di atas untuk menyalin.</i>`;
      } else if (tx.provider === "DISCORD") {
        const recipientDisplay = tx.recipientName
          ? `<b>${escapeHtml(tx.recipientName)}</b>`
          : tx.recipientEmail
          ? `<code>${escapeHtml(maskEmail(tx.recipientEmail))}</code>`
          : `<i>(Tidak terdeteksi)</i>`;
        const recipientLine = `👤 <b>Penerima:</b> ${recipientDisplay}\n`;

        const isChangeEmail =
          /change the email|change email|ganti email|ubah email|email verification code/i.test(subject) ||
          /change the email on your account/i.test(tx.rawText);
        const isPasswordReset =
          /reset password|atur ulang kata sandi|ubah kata sandi/i.test(subject) ||
          /reset your password/i.test(tx.rawText);

        const title = isChangeEmail
          ? `🎮 <b>KODE GANTI EMAIL DISCORD DITERIMA</b> 🎮`
          : isPasswordReset
          ? `🎮 <b>RESET PASSWORD DISCORD DITERIMA</b> 🎮`
          : tx.otpCode
          ? `🎮 <b>KODE VERIFIKASI DISCORD DITERIMA</b> 🎮`
          : `🎮 <b>LINK VERIFIKASI DISCORD DITERIMA</b> 🎮`;
        const codeLabel = `🔑 <b>Kode Verifikasi (OTP):</b>`;
        const codeLine = tx.otpCode ? `${codeLabel} ${otpCodeStr}\n` : "";
        const linkLine = tx.magicLink
          ? `🔗 <b>Link Verifikasi:</b> <a href="${escapeHtml(tx.magicLink)}">Verifikasi Email Discord</a>\n`
          : "";
        const previewLine = (!tx.recipientName && tx.previewText)
          ? `📝 <b>Preview:</b> <i>"${escapeHtml(tx.previewText.length > 140 ? tx.previewText.slice(0, 140) + "…" : tx.previewText)}"</i>\n`
          : "";

        text =
          `${title}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          recipientLine +
          codeLine +
          linkLine +
          previewLine +
          expireLine +
          `📅 <b>Waktu:</b> ${dateStr}\n` +
          `📧 <b>Pengirim:</b> <code>${safeSender}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>✨ Verifikasi Discord diterima secara real-time via email. Klik kode untuk menyalin.</i>`;
      } else {
        // Generic OTP email
        if (!tx.otpCode) {
          console.log(`[IMAP Worker] ℹ️ Email generic UID ${tx.uid} dilewati: Tidak ada kode OTP terdeteksi.`);
          return false;
        }

        const maskedEmailStr = tx.recipientEmail ? maskEmail(tx.recipientEmail) : undefined;
        const emailLine = maskedEmailStr
          ? `📧 <b>Email Akun:</b> <code>${escapeHtml(maskedEmailStr)}</code>\n`
          : "";

        text =
          `🔑 <b>KODE VERIFIKASI OTP DITERIMA</b> 🔑\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          emailLine +
          `👤 <b>Penerima:</b> <b>${safeRecipient}</b>\n` +
          `🔑 <b>Kode OTP:</b> ${otpCodeStr}\n` +
          expireLine +
          `📌 <b>Subjek:</b> <code>${escapeHtml(subject.slice(0, 50))}</code>\n` +
          `📅 <b>Waktu:</b> ${dateStr}\n` +
          `📧 <b>Pengirim:</b> <code>${safeSender}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>✨ Kode OTP diterima secara real-time via email. Klik kode untuk menyalin.</i>`;
      }

      await this.api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });

      this.totalOtpForwarded += 1;
      this.lastReceivedAt = new Date();
      if (tx.otpCode) this.lastReceivedOtp = tx.otpCode;
      if (tx.recipientName) this.lastRecipientName = tx.recipientName;

      this.broadcastStatus(config);
      console.log(`[IMAP Worker] 🚀 Berhasil meneruskan OTP (${tx.provider}) ke channel ${targetChannel} (Penerima: ${tx.recipientEmail ? maskEmail(tx.recipientEmail) : (tx.recipientName || "N/A")}, OTP: ${tx.otpCode || "N/A"})`);
      return true;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[IMAP Worker] ⚠️ Gagal mengirim OTP ke channel:`, errMsg);
      return false;
    }
  }

  public async sendTestOtp(target: "paypal" | "netflix" | "discord" = "netflix"): Promise<{ success: boolean; channel?: string; error?: string }> {
    if (!this.api) {
      return { success: false, error: "Bot token not set in worker." };
    }
    const config = await BotConfig.getOrCreate();

    const targetChannel =
      target === "netflix"
        ? (config.otpNetflixChannel || config.otpChannel || "").trim()
        : target === "discord"
        ? (config.otpDiscordChannel || config.otpChannel || "").trim()
        : (config.otpChannel || "").trim();

    if (!targetChannel) {
      return {
        success: false,
        error: `Target channel ${target === "netflix" ? "Netflix" : target === "discord" ? "Discord" : "PayPal"} belum diatur. Silakan atur username atau ID channel terlebih dahulu.`,
      };
    }

    const dateStr = formatDateWIB(new Date());

    let text = "";
    if (target === "netflix") {
      const testOtpCode = String(Math.floor(100000 + Math.random() * 900000));
      const testEmailMasked = maskEmail("kahfianj@hanifhara.biz.id");

      text =
        `🧪 <b>[UJI COBA FORWARDER OTP NETFLIX]</b> 🧪\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📧 <b>Email Akun:</b> <code>${testEmailMasked}</code>\n` +
        `🔑 <b>Kode Verifikasi (OTP):</b> <code>${testOtpCode}</code>\n` +
        `⏳ <b>Masa Berlaku:</b> <code>10 menit</code>\n` +
        `📅 <b>Waktu:</b> ${dateStr}\n` +
        `📧 <b>Pengirim:</b> <code>info@account.netflix.com</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>ℹ️ Ini adalah pesan tes konfigurasi Channel OTP Netflix. Klik kode untuk menyalin.</i>`;
    } else if (target === "discord") {
      const testOtpCode = String(Math.floor(100000 + Math.random() * 900000));

      text =
        `🧪 <b>[UJI COBA FORWARDER OTP DISCORD]</b> 🧪\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Username:</b> <b>dankaasli1</b>\n` +
        `🔑 <b>Kode Verifikasi (OTP):</b> <code>${testOtpCode}</code>\n` +
        `🔗 <b>Link Verifikasi:</b> <a href="https://discord.com/verify">Verifikasi Email Discord</a>\n` +
        `⏳ <b>Masa Berlaku:</b> <code>10 menit</code>\n` +
        `📅 <b>Waktu:</b> ${dateStr}\n` +
        `📧 <b>Pengirim:</b> <code>noreply@discord.com</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>ℹ️ Ini adalah pesan tes konfigurasi Channel OTP Discord.</i>`;
    } else {
      const testOtpCode = String(Math.floor(100000 + Math.random() * 900000));

      text =
        `🧪 <b>[UJI COBA FORWARDER OTP PAYPAL]</b> 🧪\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>Nama Penerima:</b> <b>Coyeb Raihan</b>\n` +
        `🔑 <b>Kode OTP:</b> <code>${testOtpCode}</code>\n` +
        `⏳ <b>Masa Berlaku:</b> <code>10 minutes</code>\n` +
        `📅 <b>Waktu:</b> ${dateStr}\n` +
        `📧 <b>Pengirim:</b> <code>service@intl.paypal.com</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>ℹ️ Ini adalah pesan tes konfigurasi Channel OTP PayPal. Klik kode untuk menyalin.</i>`;
    }

    try {
      await this.api.sendMessage(targetChannel, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return { success: true, channel: targetChannel };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      return { success: false, channel: targetChannel, error: errMsg };
    }
  }

  public async fetchLatestEmails(
    limit: number = 5,
    unreadOnly: boolean = false,
    filterSender?: string
  ): Promise<ParsedEmailOtp[]> {
    const config = await BotConfig.getOrCreate();
    if (!config.imapHost || !config.imapUser || !config.imapPass) {
      throw new Error("Kredensial IMAP belum dikonfigurasi.");
    }

    const client = new ImapFlow({
      host: config.imapHost,
      port: config.imapPort || 993,
      secure: config.imapSecure !== false,
      auth: {
        user: config.imapUser,
        pass: config.imapPass,
      },
      logger: false,
    });

    client.on("error", () => {});

    await client.connect();
    const mailbox = config.imapMailbox || "INBOX";
    const lock = await client.getMailboxLock(mailbox);
    const results: ParsedEmailOtp[] = [];

    try {
      const searchQuery: SearchObject = {};
      if (filterSender && filterSender.trim() !== "" && filterSender.trim() !== "all" && filterSender.trim() !== "*") {
        searchQuery.from = filterSender.trim();
      }
      if (unreadOnly) {
        searchQuery.seen = false;
      }

      // If no search filter specified, use { all: true }
      const finalSearchQuery = Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };

      const allUids = await client.search(finalSearchQuery, { uid: true });
      if (!allUids || allUids.length === 0) {
        return [];
      }

      const targetUids = allUids.slice(-limit).reverse();
      const messages = client.fetch(
        targetUids,
        { uid: true, source: true, flags: true, envelope: true },
        { uid: true }
      );

      for await (const message of messages) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        const isRead = message.flags ? message.flags.has("\\Seen") : false;
        const emailData = this.parseEmailContent(message.uid, parsed, isRead);
        results.push(emailData);
      }

      return results;
    } finally {
      try {
        lock.release();
      } catch {
        // ignore
      }
      try {
        if (client.usable) {
          await client.logout();
        } else {
          client.close();
        }
      } catch {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
  }
}

// ============================================================================
//  Process Boot & IPC Communication
// ============================================================================

async function bootstrap() {
  console.log(`[IMAP Worker] Initializing Child Process (PID: ${process.pid})...`);
  await connectDatabase();
  const worker = new ImapChildWorker();

  // Handle IPC messages from Parent Process
  process.on("message", async (msg: any) => {
    if (!msg || typeof msg !== "object") return;

    try {
      switch (msg.type) {
        case "START":
          await worker.start();
          break;

        case "STOP":
          await worker.stop();
          process.exit(0);
          break;

        case "RESTART":
          await worker.restart();
          break;

        case "GET_STATUS": {
          const config = await BotConfig.getOrCreate().catch(() => null);
          const status = worker.getStatus(config);
          if (process.send) {
            process.send({ type: "STATUS_RESP", reqId: msg.reqId, payload: status });
          }
          break;
        }

        case "SEND_TEST": {
          const result = await worker.sendTestOtp(msg.target || "netflix");
          if (process.send) {
            process.send({ type: "TEST_RESP", reqId: msg.reqId, result });
          }
          break;
        }

        case "FETCH_EMAILS": {
          try {
            const emails = await worker.fetchLatestEmails(msg.limit || 5, msg.unreadOnly || false, msg.filterSender);
            if (process.send) {
              process.send({ type: "FETCH_RESP", reqId: msg.reqId, success: true, emails });
            }
          } catch (fetchErr: any) {
            if (process.send) {
              process.send({ type: "FETCH_RESP", reqId: msg.reqId, success: false, error: fetchErr.message });
            }
          }
          break;
        }

        default:
          break;
      }
    } catch (msgErr) {
      console.error("[IMAP Worker] Error processing IPC message:", msgErr);
    }
  });

  // Start immediately upon bootstrap
  await worker.start();

  // Handle termination signals
  const cleanup = async () => {
    console.log("[IMAP Worker] Exiting child process gracefully...");
    await worker.stop();
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.on("disconnect", cleanup);
}

bootstrap().catch((err) => {
  console.error("[IMAP Worker] Startup failed:", err);
  process.exit(1);
});
