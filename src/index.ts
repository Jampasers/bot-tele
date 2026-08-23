import "dotenv/config";
import { run } from "@grammyjs/runner";
import { createBot } from "./core/bot.js";
import { connectDatabase, disconnectDatabase } from "./core/db.js";
import { SMSBowerService } from "./services/smsbower.js";
import { scheduleDailyBackup } from "./services/backup.js";
import { ImapOtpService } from "./services/imapOtp.js";
import { CurrencyService } from "./services/currency.js";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------
const { BOT_TOKEN, MONGODB_URI } = process.env;

if (!BOT_TOKEN || BOT_TOKEN.trim() === "") {
  console.error(
    "❌  BOT_TOKEN is not set.\n" +
      "    1. Copy .env.example to .env\n" +
      "    2. Fill in your token from @BotFather\n"
  );
  process.exit(1);
}

if (!MONGODB_URI || MONGODB_URI.trim() === "") {
  console.error(
    "❌  MONGODB_URI is not set.\n" +
      "    Add it to your .env file:\n" +
      "    MONGODB_URI=mongodb://localhost:27017/grammy-bot\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("═══════════════════════════════════════");
  console.log("  🤖  grammY Plugin Bot — Starting up  ");
  console.log("═══════════════════════════════════════\n");

  // Step 1: Connect to the database FIRST.
  console.log("🔗  Connecting to MongoDB…");
  await connectDatabase();

  // Step 2: Pre-fetch SMSBower countries + services and realtime currency rate.
  await Promise.all([
    SMSBowerService.loadData(),
    CurrencyService.getUsdRate().then((rate) => {
      console.log(`💱  Kurs Realtime aktif: 1 USD = Rp ${Math.round(rate).toLocaleString("id-ID")}`);
    }).catch(() => {}),
  ]);

  // Step 3: Create the bot and load all plugins.
  const bot = await createBot(BOT_TOKEN as string);

  // Gracefully log and survive transient network errors (e.g. Telegram TCP drops).
  bot.catch((err) => {
    const msg = err.message ?? String(err);
    if (
      msg.includes("stream reading error") ||
      msg.includes("connection was aborted") ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT")
    ) {
      console.warn("⚠️  Transient network error (auto-reconnecting):", msg.split("\n")[0]);
      return;
    }
    if (msg.includes("query is too old") || msg.includes("message is not modified")) {
      console.warn("⚠️  Benign Telegram update warning:", msg.split("\n")[0]);
      return;
    }
    console.error("❌  Unhandled bot error:", err);
  });

  // Step 4: Start IMAP OTP Child Process Worker.
  ImapOtpService.start(bot.api).catch((imapErr) => {
    console.warn("⚠️  IMAP service background start error:", imapErr);
  });

  // Step 5: Initialize bot info & start high-concurrency runner.
  await bot.init();
  const botInfo = bot.botInfo;
  console.log(`✅  Bot @${botInfo.username} is online and polling (Concurrent Runner active)! 🚀\n`);
  scheduleDailyBackup(bot.api);

  const runner = run(bot);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // Sequence: stop runner → stop IMAP child process → close DB → exit.
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n⚡  Received ${signal}. Shutting down gracefully…`);

    // 1. Stop runner if active.
    if (runner.isRunning()) {
      await runner.stop();
      console.log("🛑  Bot runner stopped.");
    }

    // 2. Stop IMAP worker process.
    await ImapOtpService.stop();

    // 3. Flush pending Mongoose operations and close the connection pool.
    await disconnectDatabase();

    console.log("✅  Shutdown complete. Goodbye!");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("💥  Fatal error during startup:", err);
  process.exit(1);
});
