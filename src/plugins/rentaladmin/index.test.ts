import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { QrisGenerator } from "../../services/payment/qris.js";
import { runWithTenant, type TenantContext } from "../../tenant/context.js";
import {
  createRentalAdminPlugin,
  type RentalAdminDependencies,
} from "./index.js";

const OWNER_ID = 4242;
const TENANT: TenantContext = {
  tenantId: "rental-wizard-test",
  rentalId: "64b000000000000000000002",
  ownerTelegramId: String(OWNER_ID),
  adminTelegramIds: [],
  enabledFeatures: ["digital"],
};
const RAW_QRIS = "00020101021126190015ID.CO.GOPAY.WWW53033605802ID5904TEST6007JAKARTA";

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function textUpdate(updateId: number, text: string): never {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      text,
      ...(text.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] }
        : {}),
    },
  } as never;
}

function photoUpdate(updateId: number): never {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      photo: [{ file_id: "qris-photo", file_unique_id: "qris-unique", width: 512, height: 512, file_size: 24 }],
    },
  } as never;
}

function callbackUpdate(updateId: number, data: string): never {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: OWNER_ID, is_bot: false, first_name: "Owner" },
      chat_instance: "rental-admin-test",
      data,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: OWNER_ID, type: "private", first_name: "Owner" },
        text: "Payment",
      },
    },
  } as never;
}

function replyText(calls: ApiCall[]): string {
  return calls
    .filter(call => call.method === "sendMessage")
    .map(call => call.payload["text"])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

async function createHarness(
  overrides: Partial<RentalAdminDependencies> = {},
  failDeleteMessageId?: number,
): Promise<{ bot: Bot; calls: ApiCall[]; saved: unknown[]; payload: string }> {
  const payload = await new QrisGenerator({ qrisStaticPayload: RAW_QRIS }).getDynamicPayload(1);
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(512, 16);
  image.writeUInt32BE(512, 20);
  const calls: ApiCall[] = [];
  const saved: unknown[] = [];
  const dependencies: RentalAdminDependencies = {
    getPaymentSummary: async () => ({ configured: false, qrisEnabled: false, gopayEnabled: false }),
    savePayment: async (_actor, input) => { saved.push(input); },
    readQrisPayload: async () => payload,
    downloadTelegramFile: async () => image,
    now: () => Date.parse("2029-01-01T00:00:00.000Z"),
    ...overrides,
  };
  const bot = new Bot("999:offline-rental-admin-test-token", {
    botInfo: {
      id: 999,
      username: "rental_admin_test_bot",
      is_bot: true,
      first_name: "Rental Admin Test",
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
  bot.api.config.use(async (_previous, method, apiPayload) => {
    calls.push({ method, payload: apiPayload as Record<string, unknown> });
    if (method === "deleteMessage" && (apiPayload as { message_id?: number }).message_id === failDeleteMessageId) {
      throw new Error("offline delete failure");
    }
    return { ok: true, result: true } as never;
  });
  bot.use((_ctx, next) => runWithTenant({ ...TENANT, adminTelegramIds: [] }, next));
  await createRentalAdminPlugin(dependencies).register(bot);
  return { bot, calls, saved, payload };
}

test("setpayment wizard asks one field at a time and saves payload decoded from the QRIS image", async () => {
  const { bot, calls, saved, payload } = await createHarness();
  await bot.handleUpdate(textUpdate(1, "/setpayment"));
  await bot.handleUpdate(photoUpdate(2));
  await bot.handleUpdate(textUpdate(3, "merchant-123"));
  await bot.handleUpdate(textUpdate(4, "owner@example.com"));
  await bot.handleUpdate(textUpdate(5, "private-password"));

  assert.deepEqual(saved, [{
    qris: { enabled: true, payload },
    gopayMerchant: {
      enabled: true,
      merchantId: "merchant-123",
      email: "owner@example.com",
      password: "private-password",
    },
  }]);
  assert.equal(calls.filter(call => call.method === "deleteMessage").length, 4);
  const replies = replyText(calls);
  assert.match(replies, /\(1\/4\).*Kirim foto/s);
  assert.match(replies, /\(2\/4\).*Merchant ID/s);
  assert.match(replies, /\(3\/4\).*email/s);
  assert.match(replies, /\(4\/4\).*password/s);
  assert.match(replies, /berhasil disimpan/);
  assert.doesNotMatch(replies, /merchant-123|owner@example\.com|private-password/);
});

test("payment menu points admins to the wizard without showing JSON", async () => {
  const { bot, calls } = await createHarness();
  await bot.handleUpdate(textUpdate(7, "/payment"));

  const reply = replyText(calls);
  assert.match(reply, /Ketik \/setpayment.*langkah demi langkah/s);
  assert.doesNotMatch(reply, /PAYLOAD_QRIS|\{\"qris\"/);
  assert.match(JSON.stringify(calls), /radmin_setpayment/);

  await bot.handleUpdate(callbackUpdate(8, "radmin_setpayment"));
  assert.match(replyText(calls), /Pengaturan Payment \(1\/4\)/);
});

test("legacy JSON input is deleted and starts the image wizard instead of being parsed", async () => {
  const { bot, calls, saved } = await createHarness();
  await bot.handleUpdate(textUpdate(10, "/setpayment {\"password\":\"legacy-secret\"}"));

  assert.equal(saved.length, 0);
  assert.equal(calls.filter(call => call.method === "deleteMessage").length, 1);
  assert.match(replyText(calls), /Kirim foto atau file PNG\/JPEG QRIS/);
  assert.doesNotMatch(replyText(calls), /legacy-secret/);
});

test("wizard clears credential state when Telegram cannot delete an input", async () => {
  const { bot, calls, saved } = await createHarness({}, 5);
  await bot.handleUpdate(textUpdate(1, "/setpayment"));
  await bot.handleUpdate(photoUpdate(2));
  await bot.handleUpdate(textUpdate(3, "merchant-123"));
  await bot.handleUpdate(textUpdate(4, "owner@example.com"));
  await bot.handleUpdate(textUpdate(5, "private-password"));
  await bot.handleUpdate(textUpdate(6, "second-password"));

  assert.equal(saved.length, 0);
  assert.match(replyText(calls), /tidak berhasil dihapus/);
  assert.doesNotMatch(replyText(calls), /private-password|second-password/);
});
