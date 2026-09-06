import { WASocket } from "@whiskeysockets/baileys";
import { IUser, User } from "../../models/User.js";
import { TopupSession } from "../../models/TopupSession.js";
import { BalanceLog } from "../../models/BalanceLog.js";
import { generateQris, getUniquePaymentAmount, checkSessionSettlement } from "../../services/payment/index.js";
import { ReceiptService } from "../../services/receipt.js";
import { formatIDR, bold, italic, mono, cleanJid } from "../formatter.js";
import { WaSessionManager } from "../session.js";
import { HydratedDocument } from "mongoose";

export class WaTopupController {
  /**
   * Menampilkan petunjuk dan meminta input nominal top up.
   */
  static async promptTopupAmount(sock: WASocket, jid: string): Promise<void> {
    WaSessionManager.setStep(jid, "TOPUP_INPUT_AMOUNT");

    const text =
      `💳 ${bold("TOP UP SALDO AKUN — QRIS OTOMATIS")}\n` +
      `${"─".repeat(28)}\n` +
      `Sistem QRIS GoPay terverifikasi otomatis dalam 1-2 menit.\n\n` +
      `📌 ${bold("Ketentuan:")}\n` +
      ` • Minimal top up: ${bold("Rp 5.000")}\n` +
      ` • Maksimal top up: ${bold("Rp 2.000.000")}\n` +
      ` • Pembayaran via BCA, Mandiri, BRI, BNI, GoPay, OVO, DANA, ShopeePay, LinkAja, dll.\n\n` +
      `Ketik ${bold("nominal saldo")} yang ingin di-topup (contoh: 10000 atau 50000).\n` +
      `Ketik 0 untuk membatalkan.`;

    await sock.sendMessage(jid, { text });
  }

  /**
   * Memvalidasi nominal dan membuat dynamic QRIS.
   */
  static async handleTopupAmount(
    sock: WASocket,
    jid: string,
    amountText: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    if (amountText.trim() === "0") {
      WaSessionManager.setStep(jid, "MAIN_MENU");
      await sock.sendMessage(jid, { text: "❌ Top up dibatalkan. Kembali ke Menu Utama." });
      return;
    }

    const cleanAmount = parseInt(amountText.replace(/[^0-9]/g, ""), 10);

    if (isNaN(cleanAmount) || cleanAmount < 5000) {
      await sock.sendMessage(jid, {
        text: `⚠️ Nominal minimal top up adalah ${bold("Rp 5.000")}. Silakan ketik nominal yang valid.`,
      });
      return;
    }

    if (cleanAmount > 2000000) {
      await sock.sendMessage(jid, {
        text: `⚠️ Nominal maksimal top up adalah ${bold("Rp 2.000.000")}. Silakan masukkan nominal di bawahnya.`,
      });
      return;
    }

    await sock.sendMessage(jid, {
      text: `💳 Sedang membuat QRIS Dinamis untuk nominal ${bold(formatIDR(cleanAmount))}…`,
    });

    try {
      const { baseAmount, uniqueCode, totalAmount } = await getUniquePaymentAmount(cleanAmount);
      const orderId = `topup-wa-${cleanJid(jid)}-${Date.now()}`;
      const qrisResult = await generateQris(totalAmount);

      const session = await TopupSession.create({
        telegramId: user.telegramId,
        platform: "whatsapp",
        chatId: jid,
        messageId: "wa_topup_invoice",
        orderId,
        baseAmount,
        uniqueCode,
        amountIDR: totalAmount,
        status: "PENDING",
      });

      const caption =
        `💳 ${bold("INVOICE PEMBAYARAN QRIS")}\n` +
        `${"─".repeat(28)}\n\n` +
        `🏷️ Nominal Topup: ${formatIDR(baseAmount)}\n` +
        `🔢 Kode Unik:     +${formatIDR(uniqueCode)}\n` +
        `${"─".repeat(28)}\n` +
        `💳 ${bold("TOTAL TRANSFER:")} ${bold(formatIDR(totalAmount))}\n` +
        `${"─".repeat(28)}\n\n` +
        `⚠️ ${bold("PERHATIAN PENTING:")}\n` +
        `1. Transfer harus ${bold("TEPAT " + formatIDR(totalAmount))} agar otomatis terdeteksi.\n` +
        `2. ${italic("Kelebihan kode unik (+" + formatIDR(uniqueCode) + ") otomatis ikut masuk ke saldo akun kamu!")}\n` +
        `3. QRIS berlaku selama 15 menit.\n\n` +
        `Begitu kamu transfer, saldo akan bertambah otomatis dalam 10-60 detik! ⚡`;

      await sock.sendMessage(jid, {
        image: qrisResult.buffer,
        caption,
      });

      WaSessionManager.setStep(jid, "MAIN_MENU");

      // Mulai watcher polling
      this.startTopupWatcher(sock, String(session._id), jid, user.telegramId);
    } catch (err) {
      console.error("[WA Topup] Error creating QRIS invoice:", err);
      await sock.sendMessage(jid, {
        text: "❌ Gagal membuat invoice QRIS. Silakan coba kembali beberapa saat lagi.",
      });
    }
  }

  /**
   * Background poller untuk memantau pembayaran top up saldo.
   */
  static startTopupWatcher(
    sock: WASocket,
    sessionId: string,
    jid: string,
    userId: string
  ): void {
    const POLLING_INTERVAL_MS = 10_000;
    const MAX_DURATION_MS = 15 * 60 * 1000;
    const startTime = Date.now();

    const interval = setInterval(async () => {
      try {
        if (Date.now() - startTime >= MAX_DURATION_MS) {
          clearInterval(interval);
          await TopupSession.findByIdAndUpdate(sessionId, { status: "EXPIRED" });
          await sock.sendMessage(jid, {
            text: `⏱️ Masa berlaku pembayaran QRIS Topup telah berakhir (15 menit).`,
          });
          return;
        }

        const session = await TopupSession.findById(sessionId);
        if (!session || session.status !== "PENDING") {
          clearInterval(interval);
          return;
        }

        const matchedTx = await checkSessionSettlement(session);
        if (matchedTx) {
          clearInterval(interval);

          const settledSession = await TopupSession.findByIdAndUpdate(
            sessionId,
            {
              status: "SETTLED",
              matchedTransactionId: matchedTx.transactionId,
            },
            { returnDocument: "after" }
          );

          if (!settledSession) return;

          // Tambahkan saldo user secara atomik
          const updatedUser = await User.findOneAndUpdate(
            { telegramId: userId },
            { $inc: { balance: settledSession.amountIDR } },
            { returnDocument: "after" }
          );

          // Catat audit log saldo
          try {
            await BalanceLog.create({
              userId,
              type: "TOPUP",
              amount: settledSession.amountIDR,
              balanceBefore: (updatedUser?.balance || 0) - settledSession.amountIDR,
              balanceAfter: updatedUser?.balance || 0,
              reason: `Topup QRIS GoPay (${settledSession.orderId})`,
            });
          } catch (logErr) {
            console.error("[WA Topup] BalanceLog error:", logErr);
          }

          const successMsg =
            `🎉 ${bold("TOP UP SALDO BERHASIL!")}\n` +
            `${"─".repeat(28)}\n` +
            `🆔 Order ID: ${mono(settledSession.orderId)}\n` +
            `💵 Jumlah Masuk: ${bold(formatIDR(settledSession.amountIDR))}\n` +
            `💰 Saldo Sekarang: ${bold(formatIDR(updatedUser?.balance || 0))}\n` +
            `${"─".repeat(28)}\n\n` +
            `Terima kasih! Saldo sudah siap digunakan untuk berbelanja produk digital atau OTP. 🚀`;

          await sock.sendMessage(jid, { text: successMsg });

          // Kirim struk Puppeteer
          try {
            const receiptBuf = await ReceiptService.generateReceiptBuffer({
              orderId: settledSession.orderId,
              product: `Topup Saldo Akun (${formatIDR(settledSession.amountIDR)})`,
              category: "Deposit Saldo",
              date: new Date().toLocaleDateString("id-ID", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
              totalIdr: settledSession.amountIDR,
              method: "QRIS GoPay",
              status: "SETTLED / SUCCESS",
              buyerName: updatedUser?.firstName || cleanJid(jid),
            });

            await sock.sendMessage(jid, {
              image: receiptBuf,
              caption: `🧾 ${bold("Struk Deposit Saldo")} — ${settledSession.orderId}`,
            });
          } catch (err) {
            console.warn("[WA Topup] Failed to generate receipt:", err);
          }
        }
      } catch (err) {
        console.error("[WA Topup] Poller exception:", err);
      }
    }, POLLING_INTERVAL_MS);
  }
}
