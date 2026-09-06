import { WASocket, proto } from "@whiskeysockets/baileys";
import { WaUserService } from "./userService.js";
import { WaSessionManager } from "./session.js";
import { WaMenuController } from "./controllers/menuController.js";
import { WaDigitalController } from "./controllers/digitalController.js";
import { WaTopupController } from "./controllers/topupController.js";
import { WaOtpController } from "./controllers/otpController.js";
import { WaAdminController } from "./controllers/adminController.js";

export class WaMessageHandler {
  /**
   * Main entry point for processing incoming WhatsApp messages.
   */
  static async handleMessage(sock: WASocket, msg: proto.IWebMessageInfo): Promise<void> {
    const key = msg.key;
    if (!key || key.fromMe || !key.remoteJid) return;

    const jid = key.remoteJid;

    // Abaikan status broadcast WA stories
    if (jid === "status@broadcast" || jid.includes("@broadcast")) return;

    // Abaikan pesan grup (bot fokus ke direct chat personal)
    if (jid.endsWith("@g.us")) return;

    // Ekstraksi isi teks pesan
    const messageContent = msg.message;
    if (!messageContent) return;

    const text =
      messageContent.conversation ||
      messageContent.extendedTextMessage?.text ||
      messageContent.imageMessage?.caption ||
      "";

    const cleanText = text.trim();
    if (!cleanText) return;

    const senderName = msg.pushName || "";

    try {
      // 1. Sinkronisasi data user WhatsApp di MongoDB
      const user = await WaUserService.findOrCreateUser(jid, senderName);

      // Cek apakah user diban
      if (user.isBanned) {
        await sock.sendMessage(jid, {
          text: `🚫 Akun kamu telah diblokir dari sistem. Alasan: ${user.banReason || "Pelanggaran aturan"}.`,
        });
        return;
      }

      const lowerText = cleanText.toLowerCase();

      // 2. Routing Global Commands
      if (
        lowerText === ".menu" ||
        lowerText === ".start" ||
        lowerText === "menu" ||
        lowerText === "start" ||
        lowerText === "halo" ||
        lowerText === "p"
      ) {
        await WaMenuController.showMainMenu(sock, jid, user);
        return;
      }

      if (lowerText === ".saldo" || lowerText === ".profile" || lowerText === ".profil") {
        await WaMenuController.showProfile(sock, jid, user);
        return;
      }

      if (lowerText === ".help" || lowerText === ".bantuan") {
        await WaMenuController.showHelp(sock, jid);
        return;
      }

      if (lowerText === ".topup" || lowerText.startsWith(".topup ")) {
        const parts = cleanText.split(" ");
        if (parts.length > 1 && parts[1]) {
          await WaTopupController.handleTopupAmount(sock, jid, parts[1], user);
        } else {
          await WaTopupController.promptTopupAmount(sock, jid);
        }
        return;
      }

      if (lowerText === ".katalog" || lowerText === ".produk") {
        await WaDigitalController.showCategories(sock, jid);
        return;
      }

      if (lowerText === ".otp") {
        await WaOtpController.showOtpMenu(sock, jid, user);
        return;
      }

      if (lowerText === ".batal" || lowerText === "batal") {
        WaSessionManager.resetSession(jid);
        await sock.sendMessage(jid, {
          text: "🔄 Sesi telah dibatalkan. Menampilkan Menu Utama…",
        });
        await WaMenuController.showMainMenu(sock, jid, user);
        return;
      }

      // 3. Routing Admin Commands
      if (lowerText.startsWith(".stats") && WaAdminController.isAdmin(jid)) {
        await WaAdminController.handleStats(sock, jid);
        return;
      }

      if (lowerText.startsWith(".addsaldo") && WaAdminController.isAdmin(jid)) {
        const args = cleanText.split(" ").slice(1);
        await WaAdminController.handleAddSaldo(sock, jid, args);
        return;
      }

      // 4. State Machine / Session Navigation
      const session = WaSessionManager.getSession(jid);

      switch (session.step) {
        case "MAIN_MENU": {
          if (cleanText === "1") {
            await WaDigitalController.showCategories(sock, jid);
          } else if (cleanText === "2") {
            await WaTopupController.promptTopupAmount(sock, jid);
          } else if (cleanText === "3") {
            await WaOtpController.showOtpMenu(sock, jid, user);
          } else if (cleanText === "4") {
            await WaMenuController.showProfile(sock, jid, user);
          } else if (cleanText === "5") {
            await WaMenuController.showHelp(sock, jid);
          } else {
            await sock.sendMessage(jid, {
              text: `⚠️ Pilihan tidak dikenal. Balas angka 1 - 5 atau ketik .menu untuk bantuan.`,
            });
          }
          break;
        }

        case "DIGITAL_CATEGORIES": {
          await WaDigitalController.handleCategoryChoice(sock, jid, cleanText);
          break;
        }

        case "DIGITAL_PRODUCTS": {
          await WaDigitalController.handleProductChoice(sock, jid, cleanText);
          break;
        }

        case "DIGITAL_INPUT_QTY": {
          await WaDigitalController.handleQuantityInput(sock, jid, cleanText, user);
          break;
        }

        case "DIGITAL_CONFIRM_PAY": {
          await WaDigitalController.handlePaymentChoice(sock, jid, cleanText, user);
          break;
        }

        case "TOPUP_INPUT_AMOUNT": {
          await WaTopupController.handleTopupAmount(sock, jid, cleanText, user);
          break;
        }

        case "OTP_SELECT_SERVICE": {
          await WaOtpController.handleSelectService(sock, jid, cleanText, user);
          break;
        }

        default: {
          await WaMenuController.showMainMenu(sock, jid, user);
          break;
        }
      }
    } catch (err) {
      console.error(`[WhatsApp] Error processing message from ${jid}:`, err);
      await sock.sendMessage(jid, {
        text: "❌ Terjadi kendala teknis saat memproses pesan. Silakan coba lagi.",
      }).catch(() => {});
    }
  }
}
