import assert from "node:assert/strict";
import test from "node:test";
import type { Bot, Context } from "grammy";
import { RentalScheduler, type RentalSchedulerDependencies } from "./RentalScheduler.js";
import type { RentalRuntimeState } from "../rental/rental.service.js";
import { getTenantContext } from "../tenant/context.js";

function state(rentalId: string, status: RentalRuntimeState["status"] = "active"): RentalRuntimeState {
  return { rentalId, tenantId: rentalId, ownerTelegramId: "42", adminTelegramIds: [], botUsername: `${rentalId}_bot`,
    plan: "plan", enabledFeatures: ["digital"], status, expiresAt: new Date(Date.now() + 86400_000), graceEndsAt: null };
}

test("scheduler keeps grace/suspended bots online, stops terminated bot and isolates a failed rental", async () => {
  const bots = new Map<string, Bot<Context>>();
  const placeholder = {} as Bot<Context>;
  bots.set("terminated", placeholder);
  const starts: string[] = [];
  const stops: string[] = [];
  const notices: string[] = [];
  const scheduler = new RentalScheduler({
    getRentalBot: id => bots.get(id),
    startRentalBot: async id => { starts.push(id); bots.set(id, placeholder); },
    stopRentalBot: async id => { stops.push(id); bots.delete(id); },
  }, 60_000, {
    async *rentalIds() { yield* ["bad", "grace", "suspended", "terminated", "active"]; },
    pollPayments: async () => { assert.equal(getTenantContext().tenantId, "platform"); throw new Error("provider unavailable"); },
    synchronize: async id => { if (id === "bad") throw new Error("one rental unavailable"); return state(id, id === "grace" ? "expired_grace" : id === "suspended" ? "suspended" : id === "terminated" ? "terminated" : "active"); },
    notify: async (_bot, rental) => { notices.push(rental.rentalId); },
  });
  await scheduler.tick();
  assert.deepEqual(starts, ["grace", "suspended", "active"]);
  assert.deepEqual(stops, ["terminated"]);
  assert.deepEqual(notices, ["grace", "suspended", "active"]);
  assert.equal(bots.has("grace"), true);
  assert.equal(bots.has("suspended"), true);
  await scheduler.stop();
});

test("overlapping scheduler ticks share one reconciliation and shutdown drains it", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let polls = 0;
  const dependencies: Partial<RentalSchedulerDependencies> = {
    pollPayments: async () => { polls++; await blocked; },
    async *rentalIds() {},
  };
  const scheduler = new RentalScheduler({ getRentalBot: () => undefined, startRentalBot: async () => {} }, 60_000, dependencies);
  const first = scheduler.tick();
  const second = scheduler.tick();
  assert.equal(first, second);
  assert.equal(polls, 1);
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  assert.equal(stopped, true);
  await scheduler.tick();
  assert.equal(polls, 2);
});
