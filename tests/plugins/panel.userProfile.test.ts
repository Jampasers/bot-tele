import assert from "node:assert/strict";
import test from "node:test";
import { User } from "../../src/models/User.js";
import { findOrCreateUser } from "../../src/plugins/panel/index.js";
import { platformContext, runWithTenant } from "../../src/tenant/context.js";

const longName = "N" + "\u0301".repeat(45) + "\u{1d42c}".repeat(20);

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
