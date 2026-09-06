import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import { WaMessageHandler } from "./handler.js";
import { getTenantId, PLATFORM_TENANT_ID, platformContext, runWithTenant } from "../tenant/context.js";
import { stopTenantTimers } from "../runtime/tenantTimers.js";

let waSocketInstance: WASocket | null = null;
let isStopping = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pairingTimer: ReturnType<typeof setTimeout> | undefined;
let reconnecting: Promise<unknown> | undefined;
const pendingMessages = new Set<Promise<void>>();

export class WhatsAppBotService {
  static getSocket(): WASocket | null {
    return waSocketInstance;
  }

  /**
   * Initializes and starts the WhatsApp bot socket using Baileys.
   */
  static async start(): Promise<WASocket | null> {
    if (getTenantId() !== PLATFORM_TENANT_ID) throw new Error("WhatsApp is only available to the platform bot.");
    const authDir = process.env["WHATSAPP_AUTH_DIR"] || "./auth_baileys";
    const pairingPhone = process.env["WHATSAPP_PAIRING_PHONE"]?.trim();

    console.log("📱 [WhatsApp] Initializing WhatsApp bot engine…");

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 [WhatsApp] Using WA v${version.join(".")}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: !pairingPhone, // Gunakan QR terminal jika pairingPhone tidak diisi
      browser: ["StoreBot", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    waSocketInstance = sock;
    isStopping = false;

    // Handle Pairing Code jika nomor telepon dikonfigurasi dan belum terdaftar
    if (pairingPhone && !sock.authState.creds.registered) {
      pairingTimer = setTimeout(async () => {
        if (isStopping) return;
        try {
          const cleanPhone = pairingPhone.replace(/[^0-9]/g, "");
          console.log(`📱 [WhatsApp] Requesting Pairing Code for: +${cleanPhone}…`);
          const code = await sock.requestPairingCode(cleanPhone);
          console.log("\n" + "=".repeat(48));
          console.log(`🔑 WHATSAPP PAIRING CODE: ${code}`);
          console.log("=".repeat(48));
          console.log("Buka WhatsApp di HP > Perangkat Tertaut > Tautkan dengan nomor telepon > masukkan kode di atas.\n");
        } catch (err) {
          console.error("❌ [WhatsApp] Failed to request pairing code:", err);
        }
      }, 3000);
    }

    // Handle state save
    sock.ev.on("creds.update", saveCreds);

    // Handle connection updates
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !pairingPhone) {
        console.log("\n📱 [WhatsApp] Scan QR code berikut dengan aplikasi WhatsApp:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "close") {
        const shouldReconnect =
          !isStopping &&
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log(
          `⚠️ [WhatsApp] Connection closed. Reason:`,
          lastDisconnect?.error?.message ?? "unknown",
          `— Reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          reconnectTimer = setTimeout(() => {
            if (isStopping) return;
            reconnecting = runWithTenant(platformContext(), () => WhatsAppBotService.start()).catch(() =>
              console.error("❌ [WhatsApp] Reconnect failed.")
            ).finally(() => { reconnecting = undefined; });
          }, 5000);
        } else {
          console.log("🛑 [WhatsApp] Session logged out or stopped.");
          waSocketInstance = null;
        }
      } else if (connection === "open") {
        console.log("✅ [WhatsApp] WhatsApp Bot is connected and active! 🚀\n");
      }
    });

    // Handle incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" || isStopping) return;
      const pending = runWithTenant(platformContext(), async () => {

      for (const msg of messages) {
        try {
          await WaMessageHandler.handleMessage(sock, msg);
        } catch (msgErr) {
          console.error("[WhatsApp] Error processing message update:", msgErr);
        }
      }
      });
      pendingMessages.add(pending);
      void pending.finally(() => pendingMessages.delete(pending));
    });

    return sock;
  }

  /**
   * Gracefully closes the WhatsApp socket.
   */
  static async stop(): Promise<void> {
    isStopping = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pairingTimer) clearTimeout(pairingTimer);
    await reconnecting;
    // A reconnect already in flight can finish after the stop request.
    isStopping = true;
    if (waSocketInstance) {
      try {
        waSocketInstance.end(undefined);
        console.log("🛑 [WhatsApp] Bot socket closed.");
      } catch (err) {
        console.warn("[WhatsApp] Error closing socket:", err);
      } finally {
        waSocketInstance = null;
      }
    }
    await Promise.allSettled([...pendingMessages]);
    await stopTenantTimers(PLATFORM_TENANT_ID);
  }
}
