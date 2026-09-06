import { WASocket } from "@whiskeysockets/baileys";
import { User } from "../../models/User.js";
import { DigitalStock } from "../../models/DigitalStock.js";
import { DigitalOrder } from "../../models/DigitalOrder.js";
import { TopupSession } from "../../models/TopupSession.js";
import { BalanceLog } from "../../models/BalanceLog.js";
import { formatIDR, bold, italic, mono, cleanJid } from "../formatter.js";

export class WaAdminController {
  /**
   * Memeriksa apakah nomor WhatsApp pengirim termasuk admin yang terdaftar.
   */
  static isAdmin(jid: string): boolean {
    const rawAdminNumbers = process.env["WHATSAPP_ADMIN_NUMBERS"] || "";
    const cleanSender = cleanJid(jid);

    const adminList = rawAdminNumbers
      .split(/[,;\s]+/)
      .map((s) => s.trim().replace(/[^0-9]/g, ""))
      .filter((s) => s.length > 0);

    return adminList.includes(cleanSender);
  }

  /**
   * Menampilkan ringkasan statistik bot (.stats).
   */
  static async handleStats(sock: WASocket, jid: string): Promise<void> {
    const [totalUsers, totalOrders, digitalStockCount, topupAgg] = await Promise.all([
      User.countDocuments(),
      DigitalOrder.countDocuments(),
      DigitalStock.countDocuments({ isSold: false }),
      TopupSession.aggregate<{ totalAmount: number; totalCount: number }>([
        { $match: { status: "SETTLED" } },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$amountIDR" },
            totalCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const firstAgg = topupAgg[0];
    const totalSettledTopups = firstAgg ? firstAgg.totalAmount : 0;
    const totalSettledCount = firstAgg ? firstAgg.totalCount : 0;

    const text =
      `📊 ${bold("RINGKASAN STATISTIK BOT (ADMIN)")}\n` +
      `${"─".repeat(28)}\n\n` +
      `👥 ${bold("Total Pengguna:")} ${totalUsers.toLocaleString("id-ID")}\n` +
      `📦 ${bold("Stok Produk Siap Jual:")} ${digitalStockCount.toLocaleString("id-ID")} item\n` +
      `🛒 ${bold("Total Order Selesai:")} ${totalOrders.toLocaleString("id-ID")} transaksi\n` +
      `💳 ${bold("Total Topup Terverifikasi:")} ${formatIDR(totalSettledTopups)} (${totalSettledCount}x)\n\n` +
      `💡 ${italic("Gunakan .addsaldo <nomor> <nominal> untuk inject saldo user.")}`;

    await sock.sendMessage(jid, { text });
  }

  /**
   * Menambahkan saldo ke user WhatsApp atau Telegram (.addsaldo <phone/id> <nominal>).
   */
  static async handleAddSaldo(
    sock: WASocket,
    jid: string,
    args: string[]
  ): Promise<void> {
    const targetArg = args[0];
    const amountArg = args[1];

    if (!targetArg || !amountArg) {
      await sock.sendMessage(jid, {
        text: `⚠️ Format salah. Gunakan: ${bold(".addsaldo <nomor/id> <nominal>")}\nContoh: .addsaldo 6281234567890 50000`,
      });
      return;
    }

    const targetInput = targetArg.trim().replace(/[^0-9]/g, "");
    const amount = parseInt(amountArg.replace(/[^0-9]/g, ""), 10);

    if (isNaN(amount) || amount <= 0) {
      await sock.sendMessage(jid, { text: "⚠️ Nominal saldo tidak valid." });
      return;
    }

    // Cari user berdasarkan nomor telepon, telegramId, atau wa identifier
    const targetUser = await User.findOne({
      $or: [
        { phoneNumber: targetInput },
        { telegramId: targetInput },
        { telegramId: `wa:${targetInput}` },
      ],
    });

    if (!targetUser) {
      await sock.sendMessage(jid, {
        text: `❌ User dengan nomor/ID ${bold(targetInput)} tidak ditemukan di database.`,
      });
      return;
    }

    targetUser.balance += amount;
    await targetUser.save();

    await BalanceLog.create({
      userId: targetUser.telegramId,
      adminId: `wa:${cleanJid(jid)}`,
      type: "CREDIT",
      amount,
      balanceBefore: targetUser.balance - amount,
      balanceAfter: targetUser.balance,
      reason: `Manual Admin Credit via WhatsApp (${cleanJid(jid)})`,
    });

    const successMsg =
      `✅ ${bold("SUKSES MENAMBAHKAN SALDO!")}\n` +
      `${"─".repeat(28)}\n` +
      `👤 Nama: ${targetUser.firstName}\n` +
      `🆔 ID: ${targetUser.telegramId}\n` +
      `💵 Nominal: +${formatIDR(amount)}\n` +
      `💰 Saldo Baru: ${bold(formatIDR(targetUser.balance))}`;

    await sock.sendMessage(jid, { text: successMsg });

    // Kirim notifikasi ke user tujuan jika memiliki WhatsApp JID
    if (targetUser.whatsappJid) {
      sock.sendMessage(targetUser.whatsappJid, {
        text:
          `🔔 ${bold("SALDO DITAMBAHKAN OLEH ADMIN")}\n\n` +
          `Akun kamu telah menerima penambahan saldo sebesar ${bold(formatIDR(amount))}.\n` +
          `Total saldo kamu saat ini: ${bold(formatIDR(targetUser.balance))}`,
      }).catch(() => {});
    }
  }
}
