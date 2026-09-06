import { WASocket } from "@whiskeysockets/baileys";
import { IUser } from "../../models/User.js";
import { formatIDR, bold, italic, formatDateWIB, cleanJid } from "../formatter.js";
import { WaSessionManager } from "../session.js";
import { HydratedDocument } from "mongoose";

export class WaMenuController {
  static async showMainMenu(
    sock: WASocket,
    jid: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    WaSessionManager.setStep(jid, "MAIN_MENU");

    const phone = cleanJid(jid);
    const text =
      `🤖 ${bold("SELAMAT DATANG DI STORE BOT")}\n` +
      `${"─".repeat(28)}\n` +
      `👋 Halo, ${bold(user.firstName)}!\n` +
      `📱 Nomor: ${italic("+" + phone)}\n` +
      `💰 Saldo: ${bold(formatIDR(user.balance))}\n` +
      `🛒 Total Pesanan: ${bold(user.totalOrders)}\n` +
      `${"─".repeat(28)}\n\n` +
      `Silakan pilih menu dengan membalas angka:\n\n` +
      `1️⃣  ${bold("Katalog Produk Digital")} (Akun / Lisensi)\n` +
      `2️⃣  ${bold("Topup Saldo")} (QRIS Otomatis)\n` +
      `3️⃣  ${bold("Sewa Nomor Virtual SMS OTP")}\n` +
      `4️⃣  ${bold("Profil & Riwayat Akun")}\n` +
      `5️⃣  ${bold("Bantuan & Hubungi Admin")}\n\n` +
      `💡 ${italic("Balas dengan angka 1 - 5 atau ketik perintah (contoh: .menu, .topup, .saldo)")}`;

    await sock.sendMessage(jid, { text });
  }

  static async showProfile(
    sock: WASocket,
    jid: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    const phone = cleanJid(jid);
    const text =
      `👤 ${bold("INFORMASI PROFIL PENGGUNA")}\n` +
      `${"─".repeat(28)}\n\n` +
      `📛 ${bold("Nama:")} ${user.firstName}\n` +
      `📱 ${bold("Nomor WhatsApp:")} +${phone}\n` +
      `🆔 ${bold("User ID:")} ${user.telegramId}\n` +
      `💰 ${bold("Saldo Akun:")} ${formatIDR(user.balance)}\n` +
      `📦 ${bold("Total Pembelian:")} ${user.totalOrders} transaksi\n` +
      `📅 ${bold("Terdaftar Sejak:")} ${formatDateWIB(user.createdAt)}\n` +
      `🛡️ ${bold("Status Akun:")} ${user.accountStatus || "ACTIVE"}\n\n` +
      `💡 ${italic("Ketik 0 atau .menu untuk kembali ke Menu Utama.")}`;

    await sock.sendMessage(jid, { text });
  }

  static async showHelp(sock: WASocket, jid: string): Promise<void> {
    const text =
      `❓ ${bold("BANTUAN & LAYANAN PELANGGAN")}\n` +
      `${"─".repeat(28)}\n\n` +
      `Mengalami kendala saat transaksi atau butuh bantuan?\n\n` +
      `💬 ${bold("WhatsApp Admin:")} Hubungi nomor admin kami\n` +
      `🕐 ${bold("Jam Operasional:")} 09.00 - 22.00 WIB\n` +
      `⚡ ${bold("Sistem Otomatis:")} Top up QRIS & Pengiriman produk digital aktif 24 jam nonstop.\n\n` +
      `💡 ${italic("Ketik 0 atau .menu untuk kembali ke Menu Utama.")}`;

    await sock.sendMessage(jid, { text });
  }
}
