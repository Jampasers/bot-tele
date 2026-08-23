import "dotenv/config";
import { createBot } from "../src/core/bot.js";
import { connectDatabase, disconnectDatabase } from "../src/core/db.js";

async function testUpdate() {
  console.log("Connecting DB...");
  await connectDatabase();

  console.log("Creating bot...");
  const bot = await createBot(process.env.BOT_TOKEN as string);
  await bot.init();

  console.log("Testing update execution for /start...");
  const fakeUpdate = {
    update_id: 999999,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: 8753427044,
        type: "private" as const,
        first_name: "Admin",
      },
      from: {
        id: 8753427044,
        is_bot: false,
        first_name: "Admin",
        username: "adminuser",
      },
      text: "/start",
    },
  };

  try {
    console.log("Calling bot.handleUpdate...");
    await bot.handleUpdate(fakeUpdate);
    console.log("✅ bot.handleUpdate completed successfully for Admin!");
  } catch (err) {
    console.error("❌ bot.handleUpdate error for Admin:", err);
  }

  const fakeUserUpdate = {
    update_id: 999998,
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: 123456789,
        type: "private" as const,
        first_name: "RegularUser",
      },
      from: {
        id: 123456789,
        is_bot: false,
        first_name: "RegularUser",
        username: "reguser",
      },
      text: "/start",
    },
  };

  try {
    console.log("Calling bot.handleUpdate for Regular User...");
    await bot.handleUpdate(fakeUserUpdate);
    console.log("✅ bot.handleUpdate completed successfully for Regular User!");
  } catch (err) {
    console.error("❌ bot.handleUpdate error for Regular User:", err);
  }

  await disconnectDatabase();
  process.exit(0);
}

testUpdate().catch((e) => {
  console.error("Fatal test error:", e);
  process.exit(1);
});
