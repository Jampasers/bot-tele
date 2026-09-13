import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Context } from "grammy";
import { BotRental, type IBotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { User } from "../models/User.js";
import { DAY_MS, deriveRentalLifecycle, refreshRentalState, renewalExpiresAt, type RentalRuntimeState } from "./rental.service.js";
import { dueExpiryAlerts, notifyRentalExpiry } from "./rentalNotification.service.js";
import { rentalMiddleware, rentalCommand, isRentalAdministrator } from "./rental.middleware.js";
import { runWithTenant } from "../tenant/context.js";
import { parseRentalFeatures, validateProvisionIdentity } from "../scripts/rentalAdmin.js";
import { parseShopSetting } from "../plugins/rentaladmin/index.js";

const expiry = new Date("2026-10-06T00:00:00.000Z");

test("rental transitions exactly at expiry and after 24 hours; grace is derived from expiry", () => {
  const rental = { status: "active" as const, expiresAt: expiry, graceEndsAt: null };
  assert.deepEqual(deriveRentalLifecycle(rental, new Date(expiry.getTime() - 1)), { status: "active", graceEndsAt: null });
  const grace = deriveRentalLifecycle(rental, expiry);
  assert.equal(grace.status, "expired_grace");
  assert.equal(grace.graceEndsAt!.getTime(), expiry.getTime() + DAY_MS);
  assert.equal(deriveRentalLifecycle(rental, new Date(expiry.getTime() + DAY_MS - 1)).status, "expired_grace");
  assert.equal(deriveRentalLifecycle(rental, new Date(expiry.getTime() + DAY_MS)).status, "suspended");
  assert.equal(deriveRentalLifecycle({ ...rental, status: "pending" }, new Date(expiry.getTime() + 2 * DAY_MS)).status, "pending");
  assert.equal(deriveRentalLifecycle({ ...rental, status: "terminated" }, expiry).status, "terminated");
});

test("early renewal adds to existing expiry, overdue renewal adds to payment time", () => {
  assert.equal(renewalExpiresAt(expiry, 30, new Date("2026-09-20T00:00:00.000Z")).toISOString(), "2026-11-05T00:00:00.000Z");
  assert.equal(renewalExpiresAt(expiry, 30, new Date("2026-10-10T00:00:00.000Z")).toISOString(), "2026-11-09T00:00:00.000Z");
  for (const days of [0, -1, 1.1, NaN, Infinity, 3651]) assert.throws(() => renewalExpiresAt(expiry, days));
});

test("reminder milestones survive repeat ticks and catch up without a minute-by-minute backlog", () => {
  const rental: Pick<IBotRental, "status" | "expiresAt" | "sentExpiryAlerts"> = { status: "active", expiresAt: expiry, sentExpiryAlerts: [] };
  assert.deepEqual(dueExpiryAlerts(rental, new Date(expiry.getTime() - 3 * DAY_MS - 1)), []);
  assert.deepEqual(dueExpiryAlerts(rental, new Date(expiry.getTime() - 3 * DAY_MS)), ["h-3"]);
  rental.sentExpiryAlerts = ["h-3"];
  assert.deepEqual(dueExpiryAlerts(rental, new Date(expiry.getTime() - 2 * DAY_MS)), []);
  const catchup = dueExpiryAlerts(rental, new Date(expiry.getTime() + 13 * 60 * 60_000));
  assert.equal(catchup.at(-1), "expired+12h");
  assert.ok(catchup.includes("h-1"));
  rental.sentExpiryAlerts.push(...catchup);
  assert.deepEqual(dueExpiryAlerts(rental, new Date(expiry.getTime() + 13 * 60 * 60_000 + 60_000)), []);
  assert.equal(dueExpiryAlerts({ ...rental, sentExpiryAlerts: [] }, new Date(expiry.getTime() + 24 * 60 * 60_000)).at(-1), "expired+24h");
  assert.deepEqual(dueExpiryAlerts({ ...rental, status: "pending" }, expiry), []);
  assert.deepEqual(dueExpiryAlerts({ ...rental, status: "terminated" }, expiry), []);
});

test("concurrent reminder sends claim one persisted milestone and send one catch-up notice", async (t) => {
  const state = await primeState(t, "expired_grace");
  const now = new Date(state.expiresAt.getTime() + 13 * 60 * 60_000);
  const record = { _id: state.rentalId, expiresAt: state.expiresAt, status: state.status, sentExpiryAlerts: [] as string[] };
  t.mock.method(BotRental, "findOne", () => ({ lean: async () => record }));
  let claimed = false;
  let claimedMilestones: string[] = [];
  t.mock.method(BotRental, "updateOne", (_filter: unknown, update: { $addToSet: { sentExpiryAlerts: { $each: string[] } } }) => {
    if (claimed) return Promise.resolve({ modifiedCount: 0 });
    claimed = true;
    claimedMilestones = update.$addToSet.sentExpiryAlerts.$each;
    return Promise.resolve({ modifiedCount: 1 });
  });
  const recipients: string[] = [];
  const bot = { api: { sendMessage: async (recipient: string) => { recipients.push(recipient); } } } as unknown as import("grammy").Bot<Context>;
  await Promise.all([notifyRentalExpiry(bot, state, now), notifyRentalExpiry(bot, state, now)]);
  assert.deepEqual(recipients, [state.ownerTelegramId]);
  assert.equal(claimedMilestones.at(-1), "expired+12h");
  assert.ok(claimedMilestones.includes("h-3"));
});

let serial = 0;
async function primeState(t: TestContext, status: RentalRuntimeState["status"]): Promise<RentalRuntimeState> {
  const rentalId = (++serial).toString(16).padStart(24, "0");
  const expiresAt = new Date(Date.now() + (status === "active" ? DAY_MS : status === "suspended" ? -2 * DAY_MS : -60_000));
  const rental = {
    _id: rentalId, tenantId: `tenant_${serial}`, ownerTelegramId: "42", adminTelegramIds: ["43"],
    botUsername: "rental_test_bot", plan: "000000000000000000000100", enabledFeatures: ["digital"],
    status, expiresAt, graceEndsAt: null,
  };
  t.mock.method(BotRental, "findById", () => ({ lean: async () => rental }));
  const state = await refreshRentalState(rentalId);
  assert.ok(state);
  return state;
}

function update(actorId: number, text = "", options: { callback?: string; private?: boolean } = {}) {
  const replies: string[] = [];
  const answers: string[] = [];
  const commandLength = text.split(" ")[0]?.length ?? 0;
  const ctx = {
    from: { id: actorId }, chat: { id: actorId, type: options.private === false ? "group" : "private" },
    me: { username: "rental_test_bot" },
    ...(options.callback ? { callbackQuery: { data: options.callback } } : { message: { text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: commandLength }] : [] } }),
    reply: async (message: string) => { replies.push(message); },
    answerCallbackQuery: async (options?: { text?: string }) => { answers.push(options?.text ?? ""); },
  } as unknown as Context;
  return { ctx, replies, answers };
}

test("inactive customers cannot use business actions or forged renewal callbacks", async (t) => {
  const state = await primeState(t, "expired_grace");
  for (const action of [
    update(99, "/start"),
    update(99, "", { callback: "product_digital" }),
    update(99, "", { callback: "rental_plan_000000000000000000000100" }),
    update(99, "", { callback: "rental_bal_000000000000000000000100" }),
    update(99, "", { callback: "rental_qris_000000000000000000000100" }),
  ]) {
    let next = false;
    await runWithTenant({ ...state }, () => rentalMiddleware(action.ctx, async () => { next = true; }));
    assert.equal(next, false);
    assert.match([...action.replies, ...action.answers].join(" "), /tidak aktif|hanya.*owner/i);
  }
});

test("suspended owner and stored admin retain private renewal and status access", async (t) => {
  const state = await primeState(t, "suspended");
  t.mock.method(RentalPlan, "find", () => {
    const query = { sort: () => query, limit: () => query, lean: async () => [] };
    return query;
  });
  t.mock.method(User, "findOne", () => ({
    select: () => ({ lean: async () => ({ balance: 0 }) }),
  }));
  for (const actor of [42, 43]) {
    for (const text of ["/start", "/status", "/help", "/renew"]) {
      const action = update(actor, text);
      let next = false;
      await runWithTenant({ ...state }, () => rentalMiddleware(action.ctx, async () => { next = true; }));
      assert.equal(next, false);
      assert.match(action.replies.join(" "), /BOT DITANGGUHKAN/);
    }
  }
  assert.equal(isRentalAdministrator(state, "44"), false);
  const group = update(42, "/renew", { private: false });
  await runWithTenant({ ...state }, () => rentalMiddleware(group.ctx, async () => assert.fail("group renewal leaked through")));
  assert.match(group.replies.join(" "), /chat pribadi/);
});

test("active business messages pass through, owner help works, non-owner status is denied", async (t) => {
  const state = await primeState(t, "active");
  let passed = 0;
  const customer = update(99, "buy product");
  await runWithTenant({ ...state }, () => rentalMiddleware(customer.ctx, async () => { passed++; }));
  assert.equal(passed, 1);
  assert.deepEqual(customer.replies, []);
  const ownerHelp = update(42, "/help");
  await runWithTenant({ ...state }, () => rentalMiddleware(ownerHelp.ctx, async () => assert.fail("owner help leaked through")));
  assert.match(ownerHelp.replies.join(" "), /\/admin/);
  const status = update(99, "/status");
  await runWithTenant({ ...state }, () => rentalMiddleware(status.ctx, async () => assert.fail("customer status leaked through")));
  assert.match(status.replies.join(" "), /hanya.*owner/i);
});

test("expired cached active status is blocked immediately without waiting for scheduler", async (t) => {
  const state = await primeState(t, "active");
  state.expiresAt = new Date(Date.now() - 1000);
  const action = update(99, "buy product");
  await runWithTenant({ ...state }, () => rentalMiddleware(action.ctx, async () => assert.fail("expired business action passed")));
  assert.match(action.replies.join(" "), /tidak aktif/);
});

test("command parser respects Telegram entities and target bot usernames", () => {
  assert.equal(rentalCommand(update(42, "/renew@rental_test_bot").ctx), "renew");
  assert.equal(rentalCommand(update(42, "/renew@another_bot").ctx), "");
  assert.equal(rentalCommand(update(42, "hello /renew").ctx), "");
});

test("CLI feature and bot identity validation rejects internal services and platform tokens", () => {
  assert.deepEqual(parseRentalFeatures("digital,affiliate,digital"), ["digital", "affiliate"]);
  for (const features of ["smsbower", "imap", "whatsapp", "admin", "digital,whatsapp", ""]) assert.throws(() => parseRentalFeatures(features));
  const token = "1000:abcdefghijklmnopqrstuvwxyz";
  assert.doesNotThrow(() => validateProvisionIdentity("42", token, "2000:abcdefghijklmnopqrstuvwxyz"));
  assert.throws(() => validateProvisionIdentity("@owner", token, "2000:test"));
  assert.throws(() => validateProvisionIdentity("42", token, "1000:rotated_token_value"));
  assert.throws(() => validateProvisionIdentity("42", "bad-token", "2000:test"));
  assert.throws(() => validateProvisionIdentity("42", token, ""));
});

test("renter settings reject internal fields, unsafe links and HTML injection", () => {
  assert.deepEqual(parseShopSetting("forceSubChannel @my_channel"), { forceSubChannel: "@my_channel" });
  assert.deepEqual(parseShopSetting("maintenanceMessage <script>test</script>"), { maintenanceMessage: "&lt;script&gt;test&lt;/script&gt;" });
  for (const input of ["imapPass secret", "cfApiKey secret", "tenantId other", "forceSubLink javascript:alert(1)", "testimonialLink https://evil.example", "forceSubChannel 123"]) assert.throws(() => parseShopSetting(input));
});
