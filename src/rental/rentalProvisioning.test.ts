import test from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { BotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import {
  parseRentalPlanSetup,
  parseRentalProvisionSetup,
  provisionRental,
  validateProvisionIdentity,
} from "./rentalProvisioning.service.js";

test("main bot parses a configurable rental plan and rejects internal features", () => {
  assert.deepEqual(parseRentalPlanSetup("monthly | 30 | 25000 | Paket Bulanan | digital,affiliate"), {
    code: "monthly",
    durationDays: 30,
    price: 25000,
    name: "Paket Bulanan",
    enabledFeatures: ["digital", "affiliate"],
    enabled: true,
  });
  assert.throws(() => parseRentalPlanSetup("internal | 30 | 1 | Internal | smsbower"));
  assert.throws(() => parseRentalPlanSetup("bad | 0 | 25000 | Paket | digital"));
});

test("platform provisioning verifies identity and stores an encrypted token", async t => {
  const previousBotToken = process.env["BOT_TOKEN"];
  const previousKey = process.env["CREDENTIAL_ENCRYPTION_KEY"];
  process.env["BOT_TOKEN"] = "2000:abcdefghijklmnopqrstuvwxyz";
  process.env["CREDENTIAL_ENCRYPTION_KEY"] = "11".repeat(32);
  t.after(() => {
    if (previousBotToken === undefined) delete process.env["BOT_TOKEN"];
    else process.env["BOT_TOKEN"] = previousBotToken;
    if (previousKey === undefined) delete process.env["CREDENTIAL_ENCRYPTION_KEY"];
    else process.env["CREDENTIAL_ENCRYPTION_KEY"] = previousKey;
  });
  const planId = new Types.ObjectId();
  let stored: Record<string, unknown> | undefined;
  t.mock.method(RentalPlan, "findOne", () => ({ lean: async () => ({ _id: planId, durationDays: 30, enabledFeatures: ["digital"] }) }));
  t.mock.method(BotRental, "exists", async () => null);
  t.mock.method(BotRental, "createIndexes", async () => undefined);
  t.mock.method(BotRental, "create", async (input: unknown) => { stored = input as Record<string, unknown>; return input as never; });

  const token = "1000:abcdefghijklmnopqrstuvwxyz";
  const result = await runWithTenant(platformContext(), () => provisionRental(
    { ownerTelegramId: "42", planCode: "monthly", botToken: token, adminTelegramIds: ["51"], active: true },
    async () => ({ id: 1000, username: "rental_test_bot" }),
  ));

  assert.equal(result.botUsername, "rental_test_bot");
  assert.equal(result.status, "active");
  assert.equal(stored?.["ownerTelegramId"], "42");
  assert.equal(stored?.["status"], "active");
  assert.notEqual(stored?.["botTokenEncrypted"], token);
  assert.match(String(stored?.["botTokenEncrypted"]), /^v1\./);
});

test("main bot parses pending and active rental provisioning input", () => {
  const token = "1000:abcdefghijklmnopqrstuvwxyz";
  assert.deepEqual(parseRentalProvisionSetup(`42 | monthly | ${token} | 51,52 | active`), {
    ownerTelegramId: "42",
    planCode: "monthly",
    botToken: token,
    adminTelegramIds: ["51", "52"],
    active: true,
  });
  assert.deepEqual(parseRentalProvisionSetup(`42 | monthly | ${token} | - | pending`).adminTelegramIds, []);
  assert.throws(() => parseRentalProvisionSetup(`42 | monthly | ${token} | - | suspended`));
  assert.doesNotThrow(() => validateProvisionIdentity("42", token, "2000:abcdefghijklmnopqrstuvwxyz"));
  assert.throws(() => validateProvisionIdentity("42", token, token));
});
