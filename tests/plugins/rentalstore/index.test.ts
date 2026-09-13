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
import { calculateRentalRefund } from "../../rental/rental.service.js";

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
    listRentals: overrides.listRentals ?? (async (owner: string) => {
      const single = overrides.findRental ? await overrides.findRental(owner) : null;
      return single ? [single] : [];
    }),
    provision: async input => ({
      rentalId: RENTAL_ID,
      tenantId: RENTAL_ID,
      botUsername: "new_rental_bot",
      planId: input.planId,
      status: "pending",
    }),
    payBalance: async rentalId => ({
      status: "insufficient",
      rentalId,
      currentBalance: 0,
      requiredAmount: PLAN.price,
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

test("rental menu does not require QRIS payment configuration", async () => {
  let paymentCalls = 0;
  const paymentHarness = await createHarness({
    createInvoice: async () => {
      paymentCalls++;
      throw new Error("Payment platform belum dikonfigurasi. secret-value");
    },
  });
  await paymentHarness.bot.handleUpdate(messageUpdate(3, "/sewa"));
  const paymentReply = replyText(paymentHarness.apiCalls);
  assert.equal(paymentCalls, 0);
  assert.match(paymentReply, /Biaya dipotong otomatis dari saldo main bot/);
  assert.match(paymentReply, /Pilih paket/);
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
    payBalance: async rentalId => {
      events.push("balance");
      return {
        status: "insufficient",
        rentalId,
        currentBalance: 10_000,
        requiredAmount: PLAN.price,
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
  assert.deepEqual(events, ["delete", "provision", "balance", "invoice"]);
  assert.equal(harness.apiCalls.filter(call => call.method === "sendPhoto").length, 1);
  assert.match(replyText(harness.apiCalls), /Saldo saat ini Rp\s?10\.000/);
  assert.doesNotMatch(replyText(harness.apiCalls), new RegExp(TOKEN));
  assert.doesNotMatch(warnings.join("\n"), new RegExp(TOKEN));
});

test("sufficient main-bot balance activates a new rental without QRIS", async () => {
  let invoiceCalls = 0;
  const starts: string[] = [];
  const harness = await createHarness({
    payBalance: async rentalId => ({
      status: "paid",
      rentalId,
      remainingBalance: 75_000,
      rental: {
        ...OWNED_RENTAL,
        rentalId,
        tenantId: rentalId,
        ownerTelegramId: String(OWNER_ID),
        adminTelegramIds: [],
        plan: PLAN_ID,
        enabledFeatures: ["digital"],
        graceEndsAt: null,
      },
    }),
    createInvoice: async () => {
      invoiceCalls++;
      throw new Error("must not run");
    },
    startRental: async rentalId => { starts.push(rentalId); },
  });

  await harness.bot.handleUpdate(callbackUpdate(22, `rs_new_${PLAN_ID}`));
  await harness.bot.handleUpdate(messageUpdate(23, TOKEN));

  assert.equal(invoiceCalls, 0);
  assert.deepEqual(starts, [RENTAL_ID]);
  assert.equal(harness.apiCalls.filter(call => call.method === "sendPhoto").length, 0);
  assert.match(replyText(harness.apiCalls), /dipotong dari saldo main bot/);
  assert.match(replyText(harness.apiCalls), /Sisa saldo: Rp\s?75\.000/);
  assert.doesNotMatch(replyText(harness.apiCalls), new RegExp(TOKEN));
});

test("insufficient balance gives a top-up instruction when QRIS fallback is unavailable", async () => {
  const harness = await createHarness({
    createInvoice: async () => {
      throw new Error("Payment platform belum dikonfigurasi. secret-value");
    },
  });

  await harness.bot.handleUpdate(callbackUpdate(24, `rs_new_${PLAN_ID}`));
  await harness.bot.handleUpdate(messageUpdate(25, TOKEN));

  const reply = replyText(harness.apiCalls);
  assert.match(reply, /Saldo main bot belum cukup/);
  assert.match(reply, /Top up saldo main bot/);
  assert.doesNotMatch(reply, /secret-value/);
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

test("owner with existing active rental can open new rental menu and select plan for second bot", async () => {
  const harness = await createHarness({
    findRental: async () => OWNED_RENTAL,
  });

  await harness.bot.handleUpdate(messageUpdate(50, "/sewa"));
  assert.match(replyText(harness.apiCalls), /Rental Saya/);

  await harness.bot.handleUpdate(callbackUpdate(51, "rs_new_menu"));
  assert.match(replyText(harness.apiCalls), /Sewa Bot Baru/);

  await harness.bot.handleUpdate(callbackUpdate(52, `rs_new_${PLAN_ID}`));
  assert.match(replyText(harness.apiCalls), /Paket dipilih: Bulanan/);
  assert.match(replyText(harness.apiCalls), /Kirim token bot baru/);
});

test("owner with pending rental cannot start another new rental until completed", async () => {
  const harness = await createHarness({
    findRental: async () => ({ ...OWNED_RENTAL, status: "pending" }),
  });

  await harness.bot.handleUpdate(callbackUpdate(53, "rs_new_menu"));
  assert.match(replyText(harness.apiCalls), /menunggu pembayaran/);
});

test("owner with multiple rentals can view bot detail and see bot list", async () => {
  const SECOND_RENTAL_ID = "64b000000000000000000009";
  const harness = await createHarness({
    listRentals: async () => [
      OWNED_RENTAL,
      { ...OWNED_RENTAL, rentalId: SECOND_RENTAL_ID, botUsername: "second_bot" },
    ],
  });

  await harness.bot.handleUpdate(messageUpdate(60, "/sewa"));
  assert.match(replyText(harness.apiCalls), /2 Bot Terdaftar/);

  await harness.bot.handleUpdate(callbackUpdate(61, `rs_bot_${SECOND_RENTAL_ID}`));
  assert.match(replyText(harness.apiCalls), /Detail Rental @second_bot/);
});

test("owner can confirm and execute rental cancellation for their own bot", async () => {
  const cancelledIds: string[] = [];
  const harness = await createHarness({
    findRental: async () => OWNED_RENTAL,
    cancelRental: async (id: string) => { cancelledIds.push(id); },
  });

  await harness.bot.handleUpdate(callbackUpdate(70, `rs_cancel_${RENTAL_ID}`));
  assert.match(replyText(harness.apiCalls), /Konfirmasi Batalkan Rental/);

  await harness.bot.handleUpdate(callbackUpdate(71, `rs_cancelyes_${RENTAL_ID}`));
  assert.match(replyText(harness.apiCalls), /Rental Dibatalkan/);
  assert.deepEqual(cancelledIds, [RENTAL_ID]);
});

test("non-owner cannot cancel someone else's rental", async () => {
  let cancelCalls = 0;
  const harness = await createHarness({
    findRental: async () => OWNED_RENTAL,
    cancelRental: async () => { cancelCalls++; },
  });

  await harness.bot.handleUpdate(callbackUpdate(72, `rs_cancel_${FOREIGN_RENTAL_ID}`));
  assert.match(replyText(harness.apiCalls), /bukan milik kamu/);
  assert.equal(cancelCalls, 0);
});

test("calculateRentalRefund calculates prorated refund matching user formula (Plan A: 14k/7d, Day 3 -> 8k refund)", () => {
  const plan = { name: "Paket A", price: 14_000, durationDays: 7 };
  const baseTime = new Date("2026-09-01T00:00:00.000Z");
  const expiresAt = new Date("2026-09-08T00:00:00.000Z"); // 7 days later

  // Day 3: 2 days and 5 hours elapsed (entering day 3)
  const nowDay3 = new Date("2026-09-03T05:00:00.000Z");
  const resDay3 = calculateRentalRefund(
    { status: "active", startedAt: baseTime, expiresAt, plan: "plan_a" },
    plan,
    nowDay3,
  );

  assert.equal(resDay3.dailyRate, 2_000);
  assert.equal(resDay3.daysUsed, 3);
  assert.equal(resDay3.usedCost, 6_000);
  assert.equal(resDay3.daysRemaining, 4);
  assert.equal(resDay3.refundAmount, 8_000);

  // Day 1: 2 hours elapsed (entering day 1)
  const nowDay1 = new Date("2026-09-01T02:00:00.000Z");
  const resDay1 = calculateRentalRefund(
    { status: "active", startedAt: baseTime, expiresAt, plan: "plan_a" },
    plan,
    nowDay1,
  );
  assert.equal(resDay1.daysUsed, 1);
  assert.equal(resDay1.usedCost, 2_000);
  assert.equal(resDay1.daysRemaining, 6);
  assert.equal(resDay1.refundAmount, 12_000);

  // Day 7: 6 days and 20 hours elapsed (last day)
  const nowDay7 = new Date("2026-09-07T20:00:00.000Z");
  const resDay7 = calculateRentalRefund(
    { status: "active", startedAt: baseTime, expiresAt, plan: "plan_a" },
    plan,
    nowDay7,
  );
  assert.equal(resDay7.daysUsed, 7);
  assert.equal(resDay7.usedCost, 14_000);
  assert.equal(resDay7.daysRemaining, 0);
  assert.equal(resDay7.refundAmount, 0);

  // Expired
  const nowExpired = new Date("2026-09-08T01:00:00.000Z");
  const resExpired = calculateRentalRefund(
    { status: "active", startedAt: baseTime, expiresAt, plan: "plan_a" },
    plan,
    nowExpired,
  );
  assert.equal(resExpired.refundAmount, 0);

  // Non-active (pending)
  const resPending = calculateRentalRefund(
    { status: "pending", startedAt: null, expiresAt, plan: "plan_a" },
    plan,
    nowDay3,
  );
  assert.equal(resPending.refundAmount, 0);
});

test("owner cancellation displays refund calculation breakdown when refund is credited", async () => {
  const harness = await createHarness({
    findRental: async () => ({
      ...OWNED_RENTAL,
      planId: PLAN_ID,
    }),
    listPlans: async () => [PLAN],
    cancelRental: async () => ({
      status: "terminated",
      refund: {
        planName: PLAN.name,
        planPrice: PLAN.price,
        durationDays: PLAN.durationDays,
        dailyRate: 833,
        daysUsed: 3,
        daysRemaining: 27,
        usedCost: 2499,
        refundAmount: 22501,
        credited: true,
        newBalance: 32501,
        ownerTelegramId: String(OWNER_ID),
      },
    }),
  });

  // Confirmation preview
  await harness.bot.handleUpdate(callbackUpdate(80, `rs_cancel_${RENTAL_ID}`));
  assert.match(replyText(harness.apiCalls), /Estimasi pengembalian saldo/);
  assert.match(replyText(harness.apiCalls), /Kalkulasi Prorata/);

  // Execution breakdown
  await harness.bot.handleUpdate(callbackUpdate(81, `rs_cancelyes_${RENTAL_ID}`));
  const text = replyText(harness.apiCalls);
  assert.match(text, /Saldo Berhasil Dikembalikan/);
  assert.match(text, /22\.501/);
  assert.match(text, /Saldo Akun Kamu/);
  assert.match(text, /32\.501/);
});

test("owner with existing active rental can renew bot using balance directly without QRIS", async () => {
  let invoiceCalls = 0;
  let payBalanceCalls = 0;
  const harness = await createHarness({
    findRental: async () => OWNED_RENTAL,
    listRentals: async () => [OWNED_RENTAL],
    payBalance: async (rentalId, actorId, planId) => {
      payBalanceCalls++;
      return {
        status: "paid",
        rentalId,
        remainingBalance: 50_000,
        rental: {
          ...OWNED_RENTAL,
          rentalId,
          tenantId: rentalId,
          ownerTelegramId: String(OWNER_ID),
          adminTelegramIds: [],
          plan: planId,
          enabledFeatures: ["digital"],
          graceEndsAt: null,
          expiresAt: new Date("2030-02-01T00:00:00.000Z"),
        },
      };
    },
    createInvoice: async () => {
      invoiceCalls++;
      throw new Error("must not create QRIS when balance is paid");
    },
  });

  await harness.bot.handleUpdate(callbackUpdate(90, `rs_pay_${RENTAL_ID}_${PLAN_ID}`));
  assert.equal(payBalanceCalls, 1);
  assert.equal(invoiceCalls, 0);
  assert.match(replyText(harness.apiCalls), /Pembayaran dipotong dari saldo main bot/);
  assert.match(replyText(harness.apiCalls), /Sisa saldo:\s*Rp\s*50\.000/);
});



