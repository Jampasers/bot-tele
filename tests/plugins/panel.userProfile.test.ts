import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { User } from "../../src/models/User.js";
import panel, { findOrCreateUser } from "../../src/plugins/panel/index.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

const longName = "N" + "\u0301".repeat(45) + "\u{1d42c}".repeat(20);

test("install invitation deep links create the user and route to VPS without rental exposure", async t => {
  t.mock.method(console, "log", () => {});
  const enabled = process.env.VPS_ENABLED;
  process.env.VPS_ENABLED = "true";
  t.after(() => { if (enabled === undefined) delete process.env.VPS_ENABLED; else process.env.VPS_ENABLED = enabled; });
  let registered = 0;
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "create", (async (input: Record<string, unknown>) => { registered++; return new User(input); }) as never);
  const token = "a".repeat(32);
  for (const rental of [false, true]) {
    const calls: any[] = [];
    const bot = new Bot("999:offline", { botInfo: { id: 999, is_bot: true, username: "test_bot", first_name: "Test", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as never });
    bot.api.config.use(async (_prev, method, payload) => { calls.push({ method, payload }); return { ok: true, result: true } as never; });
    bot.use((_ctx, next) => runWithTenant(rental ? { tenantId: "rental", rentalId: "rental" } : platformContext(), next));
    await panel.register(bot);
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 42, type: "private", first_name: "Test" }, from: { id: 42, is_bot: false, first_name: "Test" },
      text: `/start install_${token}`, entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
    if (rental) {
      assert.match(JSON.stringify(calls), /bot utama/);
      assert.doesNotMatch(JSON.stringify(calls), /vps_invite_/);
    } else assert.match(JSON.stringify(calls), new RegExp(`vps_invite_${token}`));
  }
  assert.equal(registered, 2);
});

test("User accepts bounded display names with combining marks and astral characters", async () => {
  await runWithTenant(platformContext(), async () => {
    for (const firstName of [longName, "a".repeat(63) + "😀", "😀".repeat(40), "   "]) {
      const user = new User({ telegramId: "42", firstName });
      await user.validate();
      assert.ok(user.firstName.length > 0 && user.firstName.length <= 64);
      assert.doesNotMatch(user.firstName, /[\uD800-\uDBFF]$/u);
    }
    const ordinary = new User({ telegramId: "42", firstName: "  Rani 😀  " });
    assert.equal(ordinary.firstName, "Rani 😀");
    await assert.rejects(new User({ telegramId: "42" }).validate(), /firstName is required/);
  });
});

test("first registration validates a long Telegram name before persistence", async t => {
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "create", (async (input: Record<string, unknown>) => {
    const user = new User(input);
    await user.validate();
    return user;
  }) as never);
  await runWithTenant(platformContext(), async () => {
    const user = await findOrCreateUser("42", longName);
    assert.ok(user.firstName.length <= 64);
  });
});

test("profile updates normalize once without saving again on every menu visit", async t => {
  const existing = new User({ telegramId: "42", firstName: "Old name" });
  let saves = 0;
  t.mock.method(existing, "save", (async () => { saves++; await existing.validate(); return existing; }) as never);
  t.mock.method(User, "findOne", async () => existing);
  await runWithTenant(platformContext(), async () => {
    await findOrCreateUser("42", longName);
    await findOrCreateUser("42", longName);
    assert.ok(existing.firstName.length <= 64);
    assert.equal(saves, 1);
  });
});
