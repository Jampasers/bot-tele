import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { rateLimitMiddleware } from "../middlewares/rateLimit.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import {
  clearRentalTokenInput,
  setRentalTokenInput,
} from "./rentalTokenInput.js";
import { rentalTokenInputMiddleware } from "./rentalTokenInput.middleware.js";

const OWNER_ID = 880000042;
const TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCD";

function update(id: number, text: string): never {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      text,
    },
  } as never;
}

test("pending BotFather token is deleted before the rate limiter drops its update", async t => {
  const previousAdmins = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "";
  t.after(() => {
    clearRentalTokenInput(String(OWNER_ID));
    if (previousAdmins === undefined) delete process.env["ADMIN_ID"];
    else process.env["ADMIN_ID"] = previousAdmins;
  });

  const bot = new Bot("999:offline-sensitive-input-test-token", { botInfo: {
    id: 999,
    username: "platform_test_bot",
    is_bot: true,
    first_name: "Platform Test",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  } });
  const apiCalls: Array<{ method: string; payload: unknown }> = [];
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload });
    return { ok: true, result: true } as never;
  });
  let downstreamCalls = 0;
  bot.use((_ctx, next) => runWithTenant(platformContext(), next));
  bot.use(rentalTokenInputMiddleware);
  bot.use(rateLimitMiddleware);
  bot.use(() => { downstreamCalls++; });

  await bot.handleUpdate(update(1, "one"));
  await bot.handleUpdate(update(2, "two"));
  await bot.handleUpdate(update(3, "three"));
  setRentalTokenInput(String(OWNER_ID), { planId: "64b000000000000000000001", expiresAt: Date.now() + 60_000 });
  await bot.handleUpdate(update(4, TOKEN));

  assert.equal(downstreamCalls, 3, "the fourth update is dropped by rate limiting");
  assert.equal(apiCalls.filter(call => call.method === "deleteMessage").length, 1);
  assert.doesNotMatch(JSON.stringify(apiCalls), new RegExp(TOKEN));
});
