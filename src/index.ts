import "dotenv/config";
import type { Server } from "node:http";
import { createBot } from "./core/bot.js";
import { connectDatabase, disconnectDatabase } from "./core/db.js";
import { SMSBowerService } from "./services/smsbower.js";
import { scheduleDailyBackup } from "./services/backup.js";
import { ImapOtpService } from "./services/imapOtp.js";
import { CurrencyService } from "./services/currency.js";
import { WhatsAppBotService } from "./whatsapp/index.js";
import { ReceiptService } from "./services/receipt.js";
import { validateEncryptionKey } from "./services/crypto.js";
import { platformContext, runWithTenant } from "./tenant/context.js";
import { assertTenantMigrationReady } from "./tenant/migration.js";
import { BotManager } from "./runtime/BotManager.js";
import { BotInstance } from "./runtime/BotInstance.js";
import { RentalScheduler } from "./runtime/RentalScheduler.js";
import { createRentalWebhookServer } from "./rental/rentalWebhook.js";
import { installRentalLogContext } from "./runtime/logging.js";

installRentalLogContext();

async function main(): Promise<void> {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token || !process.env.MONGODB_URI?.trim()) throw new Error("BOT_TOKEN and MONGODB_URI are required.");
  const rentalEnabled = process.env.RENTAL_ENABLED === "true";
  if (rentalEnabled) validateEncryptionKey();
  const context = platformContext();
  let platform: BotInstance | undefined;
  let manager: BotManager | undefined;
  let scheduler: RentalScheduler | undefined;
  let webhook: Server | undefined;
  let stopBackup: (() => Promise<void>) | undefined;
  let shuttingDown: Promise<void> | undefined;
  let startup: Promise<void> | undefined;
  let stopRequested = false;
  const backgroundStarts: Promise<unknown>[] = [];

  const shutdown = (): Promise<void> => {
    if (shuttingDown) return shuttingDown;
    stopRequested = true;
    manager?.requestStop();
    shuttingDown = runWithTenant(context, async () => {
      await startup?.catch(() => {});
      await Promise.allSettled(backgroundStarts);
      // No new billing work while runtime instances are being drained.
      const failures: unknown[] = [];
      const stopSteps = [
        () => scheduler?.stop(),
        () => webhook ? new Promise<void>(resolve => { webhook!.close(() => resolve()); webhook!.closeIdleConnections(); }) : undefined,
        () => stopBackup?.(),
        () => manager?.stopAll(),
        () => platform?.stop(),
        () => WhatsAppBotService.stop(),
        () => ImapOtpService.stop(),
        () => ReceiptService.shutdown(),
        () => disconnectDatabase(),
      ];
      for (const stop of stopSteps) {
        try { await stop(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new Error("One or more resources failed to stop cleanly.");
      console.log("Shutdown complete: all bot runners and workers stopped.");
    });
    return shuttingDown;
  };

  const onSignal = () => {
    void shutdown().then(() => process.exit(0)).catch(() => { console.error("Shutdown failed; inspect worker state privately."); process.exit(1); });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    startup = (async () => {
    await connectDatabase();
    await assertTenantMigrationReady();
    if (stopRequested) return;
    await Promise.all([
      SMSBowerService.loadData(),
      CurrencyService.getUsdRate().catch(() => {}),
    ]);
    const bot = await createBot(token, context);
    if (stopRequested) return;
    platform = new BotInstance(bot, context);
    platform.start();
    stopBackup = scheduleDailyBackup(bot.api);
    backgroundStarts.push(ImapOtpService.start(bot.api).catch(() => console.warn("[Platform] IMAP startup failed.")));
    if (process.env.WHATSAPP_ENABLED === "true" || Boolean(process.env.WHATSAPP_PAIRING_PHONE)) {
      backgroundStarts.push(WhatsAppBotService.start().catch(() => console.warn("[Platform] WhatsApp startup failed.")));
    }

    if (rentalEnabled) {
      manager = new BotManager(String(bot.botInfo.id));
      await manager.startAllActiveRentals();
      if (stopRequested) return;
      scheduler = new RentalScheduler(manager);
      scheduler.start();
      const port = Number(process.env.RENTAL_WEBHOOK_PORT || "0");
      if (port !== 0) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid RENTAL_WEBHOOK_PORT.");
        webhook = createRentalWebhookServer(process.env.RENTAL_WEBHOOK_SECRET || "");
        await new Promise<void>((resolve, reject) => {
          webhook!.once("error", reject);
          webhook!.listen(port, "127.0.0.1", resolve);
        });
      }
    }
    console.log(`[Platform] @${bot.botInfo.username} ready. Rental runtime ${rentalEnabled ? "enabled" : "disabled"}.`);
    })();
    await startup;
  } catch (error) {
    await shutdown().catch(() => {});
    throw error;
  }
}

runWithTenant(platformContext(), main).catch((error: unknown) => {
  // Mongo/Telegram errors can contain credential-bearing request objects.
  const message = error instanceof Error ? error.message : "";
  console.error(message.startsWith("Tenant migration required") ? message : "Startup failed. Check environment, tenant migration and provider connectivity privately.");
  process.exitCode = 1;
});
