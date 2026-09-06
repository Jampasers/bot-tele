import { setTenantInterval as setInterval, clearTenantInterval as clearInterval } from "../../runtime/tenantTimers.js";
import { WASocket } from "@whiskeysockets/baileys";
import { IUser, User } from "../../models/User.js";
import { Order } from "../../models/Order.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { smsBower, SMSBowerService } from "../../services/smsbower.js";
import { CurrencyService } from "../../services/currency.js";
import { BalanceLog } from "../../models/BalanceLog.js";
import { formatIDR, bold, italic, mono, cleanJid } from "../formatter.js";
import { WaSessionManager } from "../session.js";
import { HydratedDocument } from "mongoose";

const POPULAR_SERVICES: { code: string; name: string }[] = [
  { code: "wa", name: "WhatsApp" },
  { code: "tg", name: "Telegram" },
  { code: "go", name: "Google / Gmail / YouTube" },
  { code: "dr", name: "OpenAI / ChatGPT" },
  { code: "lf", name: "TikTok" },
  { code: "ka", name: "Shopee" },
  { code: "ig", name: "Instagram" },
];

export class WaOtpController {
  /**
   * Menampilkan menu pilihan layanan OTP SMS.
   */
  static async showOtpMenu(
    sock: WASocket,
    jid: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    const config = await SmsConfig.getOrCreate();
    if (config.enabled === false) {
      await sock.sendMessage(jid, {
        text:
          `💬 ${bold("SEWA NOMOR VIRTUAL SMS OTP")}\n\n` +
          `⚠️ Layanan SMS OTP saat ini sedang dinonaktifkan / maintenance oleh admin.\n\n` +
          `💡 ${italic("Ketik 0 atau .menu untuk kembali.")}`,
      });
      WaSessionManager.setStep(jid, "MAIN_MENU");
      return;
    }

    let msg =
      `💬 ${bold("SEWA NOMOR VIRTUAL SMS OTP")}\n` +
      `${"─".repeat(28)}\n` +
      `Negara: 🇮🇩 ${bold("Indonesia")}\n` +
      `Saldo Kamu: ${bold(formatIDR(user.balance))}\n` +
      `${"─".repeat(28)}\n` +
      `Pilih layanan yang ingin diverifikasi:\n\n`;

    POPULAR_SERVICES.forEach((s, idx) => {
      msg += `${idx + 1}️⃣ ${bold(s.name)}\n`;
    });

    msg += `\n0️⃣ ${italic("Kembali ke Menu Utama")}\n\n`;
    msg += `💡 ${italic("Balas dengan angka 1 - " + POPULAR_SERVICES.length + " untuk sewa nomor.")}`;

    WaSessionManager.setStep(jid, "OTP_SELECT_SERVICE", {
      services: POPULAR_SERVICES,
    });

    await sock.sendMessage(jid, { text: msg });
  }

  /**
   * Menangani pilihan layanan, melakukan order nomor, dan memulai polling OTP.
   */
  static async handleSelectService(
    sock: WASocket,
    jid: string,
    choiceText: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    if (choiceText.trim() === "0") {
      WaSessionManager.setStep(jid, "MAIN_MENU");
      await sock.sendMessage(jid, { text: "🔙 Kembali ke Menu Utama. Ketik .menu untuk opsi." });
      return;
    }

    const num = parseInt(choiceText.trim(), 10);
    const session = WaSessionManager.getSession(jid);
    const services: { code: string; name: string }[] =
      session.data?.services || POPULAR_SERVICES;

    if (isNaN(num) || num < 1 || num > services.length) {
      await sock.sendMessage(jid, {
        text: `⚠️ Pilihan tidak valid. Masukkan angka 1 - ${services.length} atau 0 untuk kembali.`,
      });
      return;
    }

    const selected = services[num - 1];
    if (!selected) {
      await sock.sendMessage(jid, { text: "⚠️ Layanan tidak ditemukan." });
      return;
    }

    const countryCode = "6"; // Indonesia default

    await sock.sendMessage(jid, {
      text: `⏳ Sedang memeriksa ketersediaan nomor untuk ${bold(selected.name)}…`,
    });

    try {
      const priceInfo = await SMSBowerService.getServicePrice(selected.code, countryCode);
      if (!priceInfo || priceInfo.cost <= 0) {
        await sock.sendMessage(jid, {
          text: `⚠️ Stok nomor untuk ${bold(selected.name)} (Indonesia) sedang kosong. Silakan coba beberapa saat lagi.`,
        });
        return;
      }

      const [config, usdRate] = await Promise.all([
        SmsConfig.getOrCreate(),
        CurrencyService.getUsdRate(),
      ]);

      const pricing = CurrencyService.calculatePricing(
        priceInfo.cost,
        config.markupType,
        config.markupValue,
        usdRate
      );
      const costIdr = pricing.sellingPriceIdr;
      const maxPriceUsd = pricing.maxPriceUsd;

      if (user.balance < costIdr) {
        await sock.sendMessage(jid, {
          text:
            `⚠️ ${bold("Saldo Tidak Cukup!")}\n\n` +
            `Harga sewa nomor ${bold(selected.name)}: ${bold(formatIDR(costIdr))}\n` +
            `Saldo akun kamu: ${formatIDR(user.balance)}\n` +
            `Kekurangan: ${bold(formatIDR(costIdr - user.balance))}\n\n` +
            `Silakan ketik ${bold(".topup")} untuk mengisi saldo via QRIS.`,
        });
        WaSessionManager.setStep(jid, "MAIN_MENU");
        return;
      }

      // Potong saldo user
      const updatedUser = await User.findOneAndUpdate(
        { telegramId: user.telegramId, balance: { $gte: costIdr } },
        { $inc: { balance: -costIdr, totalOrders: 1 } },
        { returnDocument: "after" }
      );

      if (!updatedUser) {
        await sock.sendMessage(jid, {
          text: "❌ Saldo tidak mencukupi saat proses transaksi.",
        });
        return;
      }

      // Sewa nomor dari provider SMSBower
      const rentResult = await smsBower.getNumber(
        selected.code,
        countryCode,
        maxPriceUsd,
        priceInfo.providerIds
      );

      // Simpan record Order di MongoDB
      const order = await Order.create({
        userId: user.telegramId,
        activationId: rentResult.activationId,
        service: selected.code,
        country: 6,
        phoneNumber: rentResult.phoneNumber,
        cost: costIdr,
        status: "PENDING",
        createdAt: new Date(),
      });

      // Catat log saldo
      await BalanceLog.create({
        userId: user.telegramId,
        type: "DEBIT",
        amount: costIdr,
        balanceBefore: updatedUser.balance + costIdr,
        balanceAfter: updatedUser.balance,
        reason: `Sewa OTP ${selected.name} (+${rentResult.phoneNumber})`,
      });

      const rentMsg =
        `📱 ${bold("NOMOR VIRTUAL BERHASIL DISEWA!")}\n` +
        `${"─".repeat(28)}\n` +
        `🌐 Layanan: ${bold(selected.name)}\n` +
        `📞 Nomor: ${bold("+" + rentResult.phoneNumber)}\n` +
        `💵 Biaya: ${formatIDR(costIdr)}\n` +
        `💰 Sisa Saldo: ${formatIDR(updatedUser.balance)}\n` +
        `${"─".repeat(28)}\n\n` +
        `Silakan masukkan nomor di atas ke aplikasi ${bold(selected.name)}.\n` +
        `⏳ ${italic("Sistem sedang menunggu kode OTP masuk (aktif 10 menit)…")}\n\n` +
        `Kode akan otomatis dikirim ke sini begitu masuk! ⚡\n` +
        `💡 ${italic("Ketik .batal untuk membatalkan pesanan dan refund saldo otomatis.")}`;

      await sock.sendMessage(jid, { text: rentMsg });

      WaSessionManager.setStep(jid, "MAIN_MENU", {
        activeActivationId: rentResult.activationId,
        activeOrderDbId: String(order._id),
      });

      // Mulai background poller OTP
      this.startOtpPoller(
        sock,
        jid,
        String(order._id),
        rentResult.activationId,
        user.telegramId,
        rentResult.phoneNumber,
        costIdr
      );
    } catch (err: any) {
      console.error("[WA OTP] Rent error:", err);
      await sock.sendMessage(jid, {
        text: `❌ Gagal menyewa nomor: ${err.message || "Kesalahan jaringan provider."}`,
      });
    }
  }

  /**
   * Background polling untuk menunggu SMS OTP masuk dari provider.
   */
  static startOtpPoller(
    sock: WASocket,
    jid: string,
    orderDbId: string,
    activationId: string,
    userId: string,
    phoneNumber: string,
    cost: number
  ): void {
    const POLL_INTERVAL_MS = 8_000;
    const MAX_DURATION_MS = 10 * 60 * 1000; // 10 menit
    const startTime = Date.now();

    const interval = setInterval(async () => {
      try {
        if (Date.now() - startTime >= MAX_DURATION_MS) {
          clearInterval(interval);

          const order = await Order.findById(orderDbId);
          if (order && order.status === "PENDING") {
            // Cancel di SMSBower
            await smsBower.setStatus(activationId, "8").catch(() => {});
            order.status = "CANCELED";
            await order.save();

            // Refund saldo
            await User.findOneAndUpdate(
              { telegramId: userId },
              { $inc: { balance: cost } }
            );

            await BalanceLog.create({
              userId,
              type: "REFUND",
              amount: cost,
              reason: `Refund OTP Timeout (+${phoneNumber})`,
              balanceBefore: 0,
              balanceAfter: cost,
            });

            await sock.sendMessage(jid, {
              text:
                `⏱️ Waktu sewa nomor +${phoneNumber} telah habis (10 menit) tanpa ada SMS masuk.\n` +
                `Dana sebesar ${bold(formatIDR(cost))} telah otomatis ${bold("di-refund")} ke saldo kamu.`,
            });
          }
          return;
        }

        const currentOrder = await Order.findById(orderDbId);
        if (!currentOrder || currentOrder.status !== "PENDING") {
          clearInterval(interval);
          return;
        }

        const statusRes = await smsBower.getStatus(activationId);

        if (statusRes.kind === "OK") {
          clearInterval(interval);

          currentOrder.status = "COMPLETED";
          currentOrder.code = statusRes.code;
          await currentOrder.save();

          // Selesaikan aktivasi di provider
          await smsBower.setStatus(activationId, "6").catch(() => {});

          const otpMsg =
            `🎉 ${bold("KODE OTP TELAH MASUK!")}\n` +
            `${"─".repeat(28)}\n` +
            `📞 Nomor: +${phoneNumber}\n` +
            `🔑 KODE OTP: ${bold(mono(statusRes.code))}\n` +
            `${"─".repeat(28)}\n\n` +
            `Segera masukkan kode di atas untuk menyelesaikan verifikasi kamu! ✅`;

          await sock.sendMessage(jid, { text: otpMsg });
        } else if (statusRes.kind === "CANCEL") {
          clearInterval(interval);

          currentOrder.status = "CANCELED";
          await currentOrder.save();

          // Refund saldo
          await User.findOneAndUpdate(
            { telegramId: userId },
            { $inc: { balance: cost } }
          );

          await sock.sendMessage(jid, {
            text: `⚠️ Nomor dibatalkan oleh provider. Saldo ${formatIDR(cost)} telah di-refund ke akun kamu.`,
          });
        }
      } catch (pollErr) {
        console.warn("[WA OTP] Polling tick error:", pollErr);
      }
    }, POLL_INTERVAL_MS);
  }
}
