import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Bot } from "grammy";
import type { RunnerHandle } from "@grammyjs/runner";
import { BotManager } from "./BotManager.js";
import { BotInstance } from "./BotInstance.js";
import { getTenantId, runWithTenant, type TenantContext } from "../tenant/context.js";
import { TenantMap } from "../tenant/TenantMap.js";
import { clearTenantInterval, setTenantInterval, stopTenantTimers } from "./tenantTimers.js";
import type { RentalRuntimeState } from "../rental/rental.service.js";
import { installRentalLogContext } from "./logging.js";
import { loadPlugins } from "../core/pluginLoader.js";

function state(id: string, status: RentalRuntimeState["status"] = "active"): RentalRuntimeState {
  return { rentalId: id, tenantId: `tenant_${id}`, ownerTelegramId: "123", adminTelegramIds: [],
    botUsername: `test_${id}_bot`, plan: "test", enabledFeatures: ["digital"], status,
    expiresAt: new Date(Date.now() + 60_000), graceEndsAt: null };
}

test("legacy rental error logs cannot serialize credential-bearing HTTP payloads", t => {
  const lines: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args); });
  const restore = installRentalLogContext();
  try {
    runWithTenant({ tenantId: "log_a", rentalId: "rental_a" }, () => {
      console.error("[digital] Provider failed", { token: "test-secret-token", password: "test-secret-password" });
      console.error(new Error("credential-bearing request"));
    });
    const serialized = JSON.stringify(lines);
    assert.match(serialized, /Tenant:log_a/);
    assert.match(serialized, /digital/);
    assert.doesNotMatch(serialized, /test-secret|credential-bearing/);
  } finally { restore(); }
});

test("two bot instances retain independent async tenant context; start/restart/stop serialize and one failure is isolated", async () => {
  const created: string[] = [];
  const stopped: string[] = [];
  const contexts: string[] = [];
  const states = new Map([["a", state("a")], ["b", state("b", "suspended")], ["bad", state("bad")]]);
  const manager = new BotManager("999", {
    refreshState: async id => states.get(id) ?? null,
    loadRental: async id => ({ botId: id === "a" ? "1" : "2", botTokenEncrypted: id }),
    decryptToken: encrypted => encrypted,
    createBot: async (token, context) => {
      await delay(2);
      if (token === "bad") throw new Error("simulated startup failure");
      contexts.push(getTenantId());
      assert.equal(getTenantId(), context.tenantId);
      created.push(token);
      return new Bot(`${token === "a" ? 1 : 2}:fake-token-for-offline-test`, { botInfo: {
        id: token === "a" ? 1 : 2, username: `test_${token}_bot`, is_bot: true, first_name: "Test",
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
      } });
    },
    createInstance: (bot, context) => new BotInstance(bot, context, () => {
      let running = true;
      return { start: () => { running = true; }, stop: async () => { await delay(2); running = false; stopped.push(context.tenantId); },
        isRunning: () => running, size: () => 0, task: () => undefined } satisfies RunnerHandle;
    }),
  });
  try {
    const results = await Promise.allSettled([manager.startRentalBot("a"), manager.startRentalBot("a"), manager.startRentalBot("b"), manager.startRentalBot("bad")]);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.deepEqual(created.sort(), ["a", "b"]);
    assert.deepEqual(contexts.sort(), ["tenant_a", "tenant_b"]);
    assert.ok(manager.getRentalBot("a"));
    assert.ok(manager.getRentalBot("b"), "suspended bot keeps polling");
    await manager.restartRentalBot("a");
    assert.equal(created.filter(id => id === "a").length, 2);
    await manager.stopRentalBot("b");
    assert.equal(manager.getRentalBot("b"), undefined);
    assert.ok(manager.getRentalBot("a"));
  } finally { await manager.stopAll(); }
  assert.equal(manager.getRentalBot("a"), undefined);
  assert.equal(await manager.startRentalBot("a"), undefined, "shutdown cannot resurrect a bot");
  assert.deepEqual(stopped.sort(), ["tenant_a", "tenant_a", "tenant_b"]);
});

test("same user conversational state is tenant-specific, including clear and iteration", async () => {
  const values = new TenantMap<string, string>();
  const a: TenantContext = { tenantId: "a" };
  const b: TenantContext = { tenantId: "b" };
  await Promise.all([runWithTenant(a, async () => { values.set("user", "A"); await delay(1); assert.equal(values.get("user"), "A"); }),
    runWithTenant(b, async () => { values.set("user", "B"); await delay(1); assert.equal(values.get("user"), "B"); })]);
  runWithTenant(a, () => values.clear());
  runWithTenant(b, () => { assert.equal(values.get("user"), "B"); assert.deepEqual([...values.entries()], [["user", "B"]]); });
  assert.throws(() => values.get("user"), /Tenant context/);
});

test("real plugin loader excludes internal handlers and dynamically gates rental plan features", async () => {
  const context: TenantContext = { tenantId: "loader_test", rentalId: "loader_test", ownerTelegramId: "100", enabledFeatures: [] };
  const bot = new Bot("100:offline-plugin-test-token", { botInfo: {
    id: 100, username: "loader_test_bot", is_bot: true, first_name: "Test", can_join_groups: true,
    can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
    can_manage_bots: false, supports_join_request_queries: false,
  } });
  const commands: string[] = [];
  const replies: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "setMyCommands") commands.push(...(payload as { commands: { command: string }[] }).commands.map(item => item.command));
    if (method === "sendMessage") replies.push((payload as { text: string }).text);
    return { ok: true, result: true } as never;
  });
  bot.use((_ctx, next) => runWithTenant(context, next));
  await runWithTenant(context, () => loadPlugins(bot));
  let unhandled = 0;
  bot.use(() => { unhandled++; });
  assert.ok(commands.includes("renew"));
  assert.ok(commands.includes("settings"));
  for (const command of ["carinegara", "cf", "backup", "rollback", "info", "digiadmin"]) assert.equal(commands.includes(command), false);
  for (const [id, text] of ["/carinegara", "/cf", "/digiadmin", "/ping"].entries()) {
    await bot.handleUpdate({ update_id: id, message: { message_id: id, date: 1,
      chat: { id: 100, type: "private", first_name: "Test" }, from: { id: 100, is_bot: false, first_name: "Test" },
      text, entities: [{ type: "bot_command", offset: 0, length: text.length }] } });
  }
  assert.equal(unhandled, 3);
  assert.ok(replies.some(reply => reply.includes("Pong")));
  context.enabledFeatures = ["digital"];
  // Enabling the feature takes effect in the existing registered handler. A
  // non-admin reaches its authorization response before any database access.
  await bot.handleUpdate({ update_id: 5, message: { message_id: 5, date: 1,
    chat: { id: 999, type: "private", first_name: "Test" }, from: { id: 999, is_bot: false, first_name: "Test" },
    text: "/digiadmin", entities: [{ type: "bot_command", offset: 0, length: 10 }] } });
  assert.match(replies.at(-1)!, /hanya untuk admin/);
  assert.equal(unhandled, 3);
});

test("tenant timer shutdown waits for active polling and does not stop another bot", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let aCalls = 0;
  let bCalls = 0;
  runWithTenant({ tenantId: "timer_a" }, () => setTenantInterval(async () => {
    assert.equal(getTenantId(), "timer_a"); aCalls++; started(); await held;
    setTenantInterval(() => { aCalls++; }, 1);
  }, 1));
  const bTimer = runWithTenant({ tenantId: "timer_b" }, () => setTenantInterval(() => { assert.equal(getTenantId(), "timer_b"); bCalls++; }, 1));
  try {
    await startedPromise;
    let stopped = false;
    const stopping = stopTenantTimers("timer_a").then(() => { stopped = true; });
    await delay(15);
    assert.equal(stopped, false);
    assert.equal(aCalls, 1, "polling cannot overlap");
    assert.ok(bCalls > 0);
    release();
    await stopping;
    const before = bCalls;
    await delay(15);
    assert.ok(bCalls > before);
    assert.equal(aCalls, 1, "a follow-up poll created during drain must also be stopped");
  } finally { release(); clearTenantInterval(bTimer); await stopTenantTimers("timer_a"); await stopTenantTimers("timer_b"); }
});
