import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import {
  createRentalStorePlugin,
  type RentalStoreDependencies,
} from "./index.js";
import type {
  OwnedRentalSummary,
  SelfServiceRentalPlan,
} from "../../rental/rentalSelfService.service.js";

const OWNER_ID = 4242;
const PLAN_ID = "64b000000000000000000001";
const RENTAL_ID = "64b000000000000000000002";
const FOREIGN_RENTAL_ID = "64b000000000000000000003";
const TOKEN = "123456:abcdefghijklmnopqrstuvwxyzABCD";

const PLAN: SelfServiceRentalPlan = {
  id: PLAN_ID,
  code: "monthly",
  name: "Bulanan",
  durationDays: 30,
  price: 25_000,
  enabledFeatures: ["digital"],
};

const OWNED_RENTAL: OwnedRentalSummary = {
  rentalId: RENTAL_ID,
  botUsername: "owned_rental_bot",
  status: "active",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

interface Harness {
  bot: Bot;
  apiCalls: ApiCall[];
}

function defaultDependencies(
  overrides: Partial<RentalStoreDependencies> = {},
): RentalStoreDependencies {
  return {
    now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    assertReady: () => {},
    listPlans: async () => [PLAN],
    findRental: async () => null,
    provision: async input => ({
      rentalId: RENTAL_ID,
      tenantId: RENTAL_ID,
      botUsername: "new_rental_bot",
      planId: input.planId,
      status: "pending",
    }),
    createInvoice: async (_rentalId, _actorTelegramId, planId) => ({
      payment: {
        planId,
        durationDays: 30,
        amount: 25_001,
        expiresAt: new Date("2029-01-01T00:15:00.000Z"),
        providerReference: "invoice-reference",
      },
      qris: { buffer: Buffer.from("offline-qris") },
    }) as never,
    checkPayment: async () => ({ status: "pending", rentalId: RENTAL_ID }),
    startRental: async () => {},
    ...overrides,
  };
}

async function createHarness(
  dependencies: Partial<RentalStoreDependencies> = {},
  options: { failDelete?: boolean } = {},
): Promise<Harness> {
  const bot = new Bot("999:offline-rental-store-test-token", {
    botInfo: {
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
    },
  });
  const apiCalls: ApiCall[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    apiCalls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "deleteMessage" && options.failDelete) {
      throw new Error("offline delete failure");
    }
    return { ok: true, result: true } as never;
  });
  await createRentalStorePlugin(defaultDependencies(dependencies)).register(bot);
  return { bot, apiCalls };
}

function messageUpdate(
  updateId: number,
  text: string,
  chatType: "private" | "group" = "private",
  ownerId = OWNER_ID,
): never {
  const command = text.startsWith("/");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: chatType === "private"
        ? { id: ownerId, type: "private", first_name: "Owner" }
        : { id: -100, type: "group", title: "Public Group" },
      from: { id: ownerId, is_bot: false, first_name: "Owner" },
      text,
      ...(command ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}),
    },
  } as never;
}

function callbackUpdate(
  updateId: number,
  data: string,
  ownerId = OWNER_ID,
): never {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: ownerId, is_bot: false, first_name: "Owner" },
      chat_instance: "offline-test",
      data,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: ownerId, type: "private", first_name: "Owner" },
        text: "Rental",
      },
    },
  } as never;
}

function replyText(apiCalls: ApiCall[]): string {
  return apiCalls
    .filter(call => call.method === "sendMessage" || call.method === "sendPhoto")
    .flatMap(call => [call.payload["text"], call.payload["caption"]])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

test("private /sewa lists plans while group /sewa is rejected before shop access", async () => {
  let shopReads = 0;
  const privateHarness = await createHarness({
    listPlans: async () => { shopReads++; return [PLAN]; },
  });
  await privateHarness.bot.handleUpdate(messageUpdate(1, "/sewa"));
  assert.equal(shopReads, 1);
  assert.match(replyText(privateHarness.apiCalls), /Sewa Bot/);
  assert.match(replyText(privateHarness.apiCalls), /Pilih paket/);

  let groupShopReads = 0;
  const groupHarness = await createHarness({
    listPlans: async () => { groupShopReads++; return [PLAN]; },
  });
  await groupHarness.bot.handleUpdate(messageUpdate(2, "/sewa", "group"));
  assert.equal(groupShopReads, 0);
  assert.match(replyText(groupHarness.apiCalls), /chat pribadi/);
});

test("rental menu reports missing platform payment configuration without exposing error details", async () => {
  const paymentHarness = await createHarness({
    assertReady: () => {
      throw new Error("Payment platform belum dikonfigurasi (merchant dan login GoBiz wajib tersedia). secret-value");
    },
  });
  await paymentHarness.bot.handleUpdate(messageUpdate(3, "/sewa"));
  const paymentReply = replyText(paymentHarness.apiCalls);
  assert.match(paymentReply, /GOPAY_MERCHANT_ID/);
  assert.match(paymentReply, /GOJEK_EMAIL\/GOJEK_PASSWORD/);
  assert.doesNotMatch(paymentReply, /secret-value/);

  const runtimeHarness = await createHarness({
    assertReady: () => { throw new Error("database failure with secret-value"); },
  });
  await runtimeHarness.bot.handleUpdate(messageUpdate(4, "/sewa"));
  const runtimeReply = replyText(runtimeHarness.apiCalls);
  assert.match(runtimeReply, /layanan sedang bermasalah/);
  assert.doesNotMatch(runtimeReply, /secret-value/);
});

test("token is never provisioned when Telegram cannot delete its message", async () => {
  let provisionCalls = 0;
  let invoiceCalls = 0;
  const harness = await createHarness({
    provision: async () => {
      provisionCalls++;
      throw new Error("must not run");
    },
    createInvoice: async () => {
      invoiceCalls++;
      throw new Error("must not run");
    },
  }, { failDelete: true });

  await harness.bot.handleUpdate(callbackUpdate(10, `rs_new_${PLAN_ID}`));
  await harness.bot.handleUpdate(messageUpdate(11, TOKEN));

  assert.equal(provisionCalls, 0);
  assert.equal(invoiceCalls, 0);
  assert.equal(harness.apiCalls.filter(call => call.method === "deleteMessage").length, 1);
  assert.match(replyText(harness.apiCalls), /tidak berhasil dihapus/);
});

test("successful token flow uses ctx.from owner, creates one invoice, and never echoes the token", async t => {
  const events: string[] = [];
  const provisionInputs: Array<{ ownerTelegramId: string; planId: string; botToken: string }> = [];
  const invoiceInputs: Array<[string, string, string]> = [];
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });

  const harness = await createHarness({
    provision: async input => {
      events.push("provision");
      provisionInputs.push(input);
      return {
        rentalId: RENTAL_ID,
        tenantId: RENTAL_ID,
        botUsername: "new_rental_bot",
        planId: input.planId,
        status: "pending",
      };
    },
    createInvoice: async (rentalId, actorTelegramId, planId) => {
      events.push("invoice");
      invoiceInputs.push([rentalId, actorTelegramId, planId]);
      return {
        payment: {
          planId,
          durationDays: 30,
          amount: 25_001,
          expiresAt: new Date("2029-01-01T00:15:00.000Z"),
          providerReference: "invoice-reference",
        },
        qris: { buffer: Buffer.from("offline-qris") },
      } as never;
    },
  });
  harness.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "deleteMessage") events.push("delete");
    return previous(method, payload, signal);
  });

  await harness.bot.handleUpdate(callbackUpdate(20, `rs_new_${PLAN_ID}`));
  await harness.bot.handleUpdate(messageUpdate(21, TOKEN));

  assert.deepEqual(provisionInputs, [{ ownerTelegramId: String(OWNER_ID), planId: PLAN_ID, botToken: TOKEN }]);
  assert.deepEqual(invoiceInputs, [[RENTAL_ID, String(OWNER_ID), PLAN_ID]]);
  assert.deepEqual(events, ["delete", "provision", "invoice"]);
  assert.equal(harness.apiCalls.filter(call => call.method === "sendPhoto").length, 1);
  assert.doesNotMatch(replyText(harness.apiCalls), new RegExp(TOKEN));
  assert.doesNotMatch(warnings.join("\n"), new RegExp(TOKEN));
});

test("foreign existing-rental callback is denied before invoice creation", async () => {
  let invoiceCalls = 0;
  const harness = await createHarness({
    findRental: async () => OWNED_RENTAL,
    createInvoice: async () => {
      invoiceCalls++;
      throw new Error("must not run");
    },
  });

  await harness.bot.handleUpdate(callbackUpdate(30, `rs_pay_${FOREIGN_RENTAL_ID}_${PLAN_ID}`));

  assert.equal(invoiceCalls, 0);
  assert.match(replyText(harness.apiCalls), /bukan milik kamu/);
});

test("payment check passes ctx.from actor and starts runtime only for paid status", async () => {
  const checks: Array<[string, string]> = [];
  const starts: string[] = [];
  const harness = await createHarness({
    checkPayment: async (reference, actorTelegramId) => {
      checks.push([reference, actorTelegramId]);
      if (reference === "paid-reference") {
        return {
          status: "paid",
          rentalId: RENTAL_ID,
          rental: {
            ...OWNED_RENTAL,
            tenantId: RENTAL_ID,
            ownerTelegramId: String(OWNER_ID),
            adminTelegramIds: [],
            enabledFeatures: ["digital"],
            graceEndsAt: null,
          },
        } as never;
      }
      return { status: "pending", rentalId: RENTAL_ID };
    },
    startRental: async rentalId => { starts.push(rentalId); },
  });

  await harness.bot.handleUpdate(callbackUpdate(40, "rs_chk_pending-reference"));
  await harness.bot.handleUpdate(callbackUpdate(41, "rs_chk_paid-reference"));

  assert.deepEqual(checks, [
    ["pending-reference", String(OWNER_ID)],
    ["paid-reference", String(OWNER_ID)],
  ]);
  assert.deepEqual(starts, [RENTAL_ID]);
  assert.match(replyText(harness.apiCalls), /belum terkonfirmasi/);
  assert.match(replyText(harness.apiCalls), /Bot rental sudah aktif/);
});
