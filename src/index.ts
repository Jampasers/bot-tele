import "dotenv/config";
import { createBot } from "./core/bot.js";
import { connectDatabase, disconnectDatabase } from "./core/db.js";
import { SMSBowerService } from "./services/smsbower.js";

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
  // Plugins that query the DB at registration time (rare but possible) are
  // safe to do so only after this line resolves.
  console.log("🔗  Connecting to MongoDB…");
  await connectDatabase();

  // Step 2: Pre-fetch SMSBower countries + services into the in-memory cache.
  // This runs once at startup so every keyboard render is instant (no API call
  // per user interaction). If the fetch fails the bot still starts — the plugin
  // will show empty lists rather than crashing.
  await SMSBowerService.loadData();

  // Step 3: Create the bot and load all plugins.
  // Plugins can import Mongoose models freely — the connection is already open.
  // The SMSBower cache is already populated — keyboards build correctly.
  const bot = await createBot(BOT_TOKEN as string);

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // Sequence: stop polling → close DB → exit.
  // Closing the DB after the bot ensures no in-flight handler is still
  // awaiting a database query when the connection is torn down.
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n⚡  Received ${signal}. Shutting down gracefully…`);

    // 1. Stop accepting new Telegram updates.
    await bot.stop();
    console.log("🛑  Bot stopped.");

    // 2. Flush pending Mongoose operations and close the connection pool.
    await disconnectDatabase();

    console.log("✅  Shutdown complete. Goodbye!");
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Gracefully log and survive transient network errors (e.g. Telegram TCP drops).
  // Without this, an unhandled error in an update handler crashes the whole process.
  bot.catch((err) => {
    const msg = err.message ?? String(err);
    // Suppress the noisy "stream reading error" / "connection aborted" logs —
    // grammY reconnects automatically; no action needed.
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

  // Step 3: Start long-polling.
  await bot.start({
    onStart: (botInfo) => {
      console.log(`✅  Bot @${botInfo.username} is online and polling!\n`);
    },
  });
}

main().catch((err) => {
  console.error("💥  Fatal error during startup:", err);
  process.exit(1);
});
