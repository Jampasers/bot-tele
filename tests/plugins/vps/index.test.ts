import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { platformContext, runWithTenant, type TenantContext } from "../../../src/tenant/context.js";
import { SmsConfig } from "../../../src/models/SmsConfig.js";
import { buildCatalogKeyboard, buildCatalogText } from "../../../src/plugins/panel/index.js";
import { createVpsPlugin, vpsOrderText } from "../../../src/plugins/vps/index.js";
import { createVpsAdminPlugin, vpsCredentialText } from "../../../src/plugins/vpsadmin/index.js";
import { clearAllVpsInputs, vpsInputMiddleware } from "../../../src/plugins/vps/input.js";
import type { AvailabilityMap, VpsUiDependencies, VpsUiOrder, VpsUiPlan } from "../../../src/plugins/vps/contracts.js";
import { defaultVpsCatalog } from "../../../src/vps/catalog.js";
import { catalogPlans, planPrice } from "../../../src/vps/catalogPlans.js";
import { DigitalOceanError } from "../../../src/vps/digitalOcean.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const PLAN: VpsUiPlan = { id: "plan-1", name: "RAM 2 GB", serviceType: "install", sizeSlug: "s-1vcpu-2gb", regions: ["sgp1", "fra1"], osPrices: [{ os: "windows2022", label: "Windows Server 2022", price: 43_210 }], enabled: true };
const ORDER: VpsUiOrder = { _id: ORDER_ID, serviceType: "install", paymentStatus: "unpaid", stage: "queued", price: 43_210, planName: "RAM 2 GB", sizeSlug: "s-1vcpu-2gb", os: "windows2022", region: "sgp1" };
interface ApiCall { method: string; payload: Record<string, unknown> }
function update(id: number, input: string, callback = false, actor = 42, chatType = "private", media = false): never {
  const from = { id: actor, is_bot: false, first_name: "Test" };
  const message = { message_id: id, date: 1, chat: { id: actor, type: chatType, first_name: "Test" }, ...(media ? { photo: [] } : { text: callback ? "VPS" : input }), from };
  return callback
    ? { update_id: id, callback_query: { id: `callback-${id}`, from, chat_instance: "vps-test", data: input, message } } as never
    : { update_id: id, message: { ...message, ...(input.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: input.split(" ")[0]!.length }] } : {}) } } as never;
}
function replies(calls: ApiCall[]): string {
  return calls.filter(call => call.method === "sendMessage" || call.method === "editMessageText").map(call => String(call.payload["text"] ?? "")).join("\n");
}
function callback(calls: ApiCall[], prefix: string): string {
  for (const call of [...calls].reverse()) {
    const keyboard = call.payload["reply_markup"] as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    const match = keyboard?.inline_keyboard?.flat().find(button => button.callback_data?.startsWith(prefix));
    if (match?.callback_data) return match.callback_data;
  }
  throw new Error(`Missing callback ${prefix}`);
}
async function harness(overrides: Partial<VpsUiDependencies> = {}, options: { admin?: boolean; tenant?: TenantContext; failDelete?: number; staleHandler?: () => void } = {}): Promise<{ bot: Bot; calls: ApiCall[] }> {
  clearAllVpsInputs();
  const calls: ApiCall[] = [];
  const bot = new Bot("999:offline-vps-test", { botInfo: {
    id: 999, username: "vps_test_bot", is_bot: true, first_name: "VPS Test", can_join_groups: true,
    can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
    has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
  } });
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "deleteMessage" && (payload as { message_id?: number }).message_id === options.failDelete) throw new Error("Deletion failed");
    return { ok: true, result: true } as never;
  });
  bot.use((_ctx, next) => runWithTenant(options.tenant ?? platformContext(), next));
  bot.use(vpsInputMiddleware);
  if (options.staleHandler) bot.on("message:text", async (ctx, next) => {
    if (!ctx.message.text.startsWith("/")) { options.staleHandler!(); return; }
    return next();
  });
  const deps: Partial<VpsUiDependencies> = {
    enabled: () => true, listOs: () => [{ id: "windows2022", label: "Windows Server 2022" }],
    listPlans: async () => [PLAN], clearBuyerToken: () => {}, acceptBuyerToken: async () => ({ accountId: "team-test" }),
    checkout: async () => ORDER, getOwned: async () => ORDER, listOwned: async () => [ORDER],
    listCredentials: async () => [], ...overrides,
  };
  await (options.admin ? createVpsAdminPlugin(deps) : createVpsPlugin(deps)).register(bot);
  return { bot, calls };
}

test("VPS catalog is visible only when enabled on the platform", async t => {
  const previous = process.env["VPS_ENABLED"];
  t.after(() => { if (previous === undefined) delete process.env["VPS_ENABLED"]; else process.env["VPS_ENABLED"] = previous; });
  t.mock.method(SmsConfig, "getOrCreate", async () => ({ enabled: true }) as never);
  process.env["VPS_ENABLED"] = "true";
  await runWithTenant(platformContext(), async () => {
    assert.equal((JSON.stringify(await buildCatalogKeyboard()).match(/vps_home/g) ?? []).length, 1);
    assert.match(await buildCatalogText(), /<b>VPS<\/b>/);
  });
  await runWithTenant({ tenantId: "rental", rentalId: "rental-1", enabledFeatures: [] }, async () => {
    assert.doesNotMatch(JSON.stringify(await buildCatalogKeyboard()), /vps_home/);
    assert.doesNotMatch(await buildCatalogText(), /<b>VPS<\/b>/);
  });
  process.env["VPS_ENABLED"] = "false";
  await runWithTenant(platformContext(), async () => assert.doesNotMatch(JSON.stringify(await buildCatalogKeyboard()), /vps_home/));
});

test("jasa setup/install keeps both DigitalOcean and direct buyer VPS paths inside one menu", async () => {
  const { bot, calls } = await harness();
  await bot.handleUpdate(update(1, "/vps"));
  assert.match(JSON.stringify(calls), /vps_install/);
  assert.doesNotMatch(JSON.stringify(calls), /vps_install_direct/);

  await bot.handleUpdate(update(2, "vps_install", true));
  assert.match(replies(calls), /Pilih sumber VPS/);
  assert.match(JSON.stringify(calls), /vps_install_do/);
  assert.match(JSON.stringify(calls), /vps_install_direct/);
});

test("direct install collects buyer VPS connection and checks out Windows without a DO token", async () => {
  let checkoutInput: Parameters<VpsUiDependencies["checkout"]>[0] | undefined;
  let acceptedTokens = 0;
  const { bot, calls } = await harness({
    acceptBuyerToken: async () => { acceptedTokens++; return { accountId: "unexpected" }; },
    checkout: async input => { checkoutInput = input; return ORDER; },
  });
  await bot.handleUpdate(update(1, "vps_install", true));
  await bot.handleUpdate(update(2, "vps_install_direct", true));
  await bot.handleUpdate(update(3, "192.0.2.10"));
  await bot.handleUpdate(update(4, "ubuntu"));
  await bot.handleUpdate(update(5, "synthetic-source-password"));
  await bot.handleUpdate(update(6, callback(calls, "vps_plan_"), true));
  await bot.handleUpdate(update(7, callback(calls, "vps_chrome_"), true));

  assert.equal(acceptedTokens, 0);
  assert.deepEqual(checkoutInput?.direct, { ip: "192.0.2.10", username: "ubuntu", password: "synthetic-source-password" });
  assert.equal(checkoutInput?.os, "windows2022");
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-source-password/);
});

test("direct install order shows Windows access without a DigitalOcean token action", async () => {
  const directOrder: VpsUiOrder = { ...ORDER, sourceMode: "direct", paymentStatus: "paid", stage: "ready", ip: "192.0.2.10" };
  const { bot, calls } = await harness({ getOwned: async () => directOrder });
  await bot.handleUpdate(update(1, `vps_order_${ORDER_ID}`, true));
  assert.match(JSON.stringify(calls), /vps_access_/);
  assert.doesNotMatch(JSON.stringify(calls), /vps_token_/);
  assert.doesNotMatch(vpsOrderText(directOrder), /Biaya DigitalOcean/);
  assert.match(vpsOrderText(directOrder), /VPS milik buyer/);
});

test("Chrome checkout can be retried with the same intent and memory-only VPS password", async t => {
  t.mock.method(console, "warn", () => {});
  const attempts: Parameters<VpsUiDependencies["checkout"]>[0][] = [];
  const { bot, calls } = await harness({ checkout: async input => {
    attempts.push(structuredClone(input));
    if (attempts.length === 1) throw new Error("synthetic database timeout");
    return ORDER;
  } });
  await bot.handleUpdate(update(1, "vps_install_direct", true));
  await bot.handleUpdate(update(2, "192.0.2.10"));
  await bot.handleUpdate(update(3, "root"));
  await bot.handleUpdate(update(4, "synthetic-source-password"));
  await bot.handleUpdate(update(5, callback(calls, "vps_plan_"), true));
  const chrome = callback(calls, "vps_chrome_").replace(/_no$/, "_yes");
  await bot.handleUpdate(update(6, chrome, true));
  await bot.handleUpdate(update(7, chrome, true));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1]?.requestId, attempts[0]?.requestId);
  assert.equal(attempts[1]?.direct?.password, "synthetic-source-password");
  assert.equal(attempts[1]?.installChrome, true);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-source-password|synthetic database timeout/);
});

test("expired VPS buttons explain session recovery separately from provider failure", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const { bot, calls } = await harness();
  await bot.handleUpdate(update(1, `vps_chrome_${ORDER_ID}_yes`, true));
  assert.match(replies(calls), /sesi.*kedaluwarsa.*\/vps/is);
  assert.match(replies(calls), /VPS_SESSION_EXPIRED/);
  assert.match(JSON.stringify(logs), /VPS_SESSION_EXPIRED/);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(ORDER_ID));
});

test("VPS failures expose safe cause and a matching reference without raw payloads", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const failure = Object.assign(new DigitalOceanError("permission", false, 403), {
    message: "provider echoed synthetic-secret", request: { token: "synthetic-secret" },
  });
  const { bot, calls } = await harness({ listPlans: async () => { throw failure; } });
  await bot.handleUpdate(update(1, "vps_buy", true));
  assert.match(replies(calls), /izin token/i);
  assert.match(replies(calls), /VPS_DO_PERMISSION/);
  const reference = /Referensi: ([a-f0-9-]{36})/.exec(replies(calls))?.[1];
  assert.ok(reference);
  assert.match(JSON.stringify(logs), new RegExp(reference));
  assert.doesNotMatch(JSON.stringify([calls, logs]), /synthetic-secret|provider echoed/);
});

test("unknown VPS errors log a code, not an arbitrary error message or callback", async t => {
  const logs: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args); });
  const { bot, calls } = await harness({ listPlans: async () => { throw new Error("synthetic-secret"); } });
  await bot.handleUpdate(update(1, "vps_buy", true));
  assert.match(replies(calls), /VPS_INTERNAL/);
  assert.doesNotMatch(JSON.stringify([calls, logs]), /synthetic-secret/);
});

test("buyer token is deleted before validation and cannot reach generic text handlers", async () => {
  let accepted = 0;
  let staleHandlerCalls = 0;
  const { bot, calls } = await harness({ acceptBuyerToken: async (actor, id, token) => {
    assert.equal(actor, "42"); assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(token, "synthetic-buyer-secret");
    assert.equal(calls.at(-1)?.method, "deleteMessage"); accepted++;
    return { accountId: "team-test" };
  } }, { staleHandler: () => { staleHandlerCalls++; } });
  await bot.handleUpdate(update(1, "vps_install", true));
  await bot.handleUpdate(update(2, "vps_install_do", true));
  await bot.handleUpdate(update(3, "synthetic-buyer-secret"));
  assert.equal(accepted, 1); assert.equal(staleHandlerCalls, 0);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-buyer-secret/);
  assert.match(replies(calls), /biaya jasa.*Biaya DigitalOcean/s);
});

test("failed token deletion clears pending input without validation", async () => {
  let accepted = 0;
  const { bot, calls } = await harness({ acceptBuyerToken: async () => { accepted++; return { accountId: "team" }; } }, { failDelete: 3 });
  await bot.handleUpdate(update(1, "vps_install", true));
  await bot.handleUpdate(update(2, "vps_install_do", true));
  await bot.handleUpdate(update(3, "synthetic-private-token"));
  assert.equal(accepted, 0);
  assert.match(replies(calls), /token tidak diproses/);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-private-token/);
});

test("navigating away clears a pending token input so later text is not interpreted as a token", async () => {
  let accepted = 0;
  let ordinaryMessages = 0;
  const { bot, calls } = await harness({ acceptBuyerToken: async () => { accepted++; return { accountId: "team" }; } }, { staleHandler: () => { ordinaryMessages++; } });
  await bot.handleUpdate(update(1, `vps_token_${ORDER_ID}`, true));
  await bot.handleUpdate(update(2, `vps_order_${ORDER_ID}`, true));
  await bot.handleUpdate(update(3, "ordinary chat"));
  assert.equal(accepted, 0); assert.equal(ordinaryMessages, 1);
  assert.equal(calls.filter(call => call.method === "deleteMessage").length, 0);
});

test("callbacks are acknowledged before service work and tenant/private checks prevent access", async () => {
  let callsToService = 0;
  const first = await harness({ getOwned: async () => {
    callsToService++;
    assert.equal(first.calls[0]?.method, "answerCallbackQuery");
    return ORDER;
  } });
  await first.bot.handleUpdate(update(1, `vps_order_${ORDER_ID}`, true));
  assert.equal(callsToService, 1);
  const rental = await harness({ getOwned: async () => { callsToService++; return ORDER; } }, { tenant: { tenantId: "rental", rentalId: "rental-1" } });
  await rental.bot.handleUpdate(update(2, `vps_order_${ORDER_ID}`, true));
  const group = await harness({ getOwned: async () => { callsToService++; return ORDER; } });
  await group.bot.handleUpdate(update(3, `vps_order_${ORDER_ID}`, true, 42, "group"));
  assert.equal(callsToService, 1);
});

test("selection snapshots configured price and duplicate checkout uses the same promise", async () => {
  let checkoutCalls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { bot, calls } = await harness({ checkout: async input => {
    checkoutCalls++;
    assert.equal(input.actorTelegramId, "42"); assert.equal(input.planId, PLAN.id);
    assert.equal(input.os, "windows2022"); assert.equal(input.region, "sgp1");
    assert.equal(input.buyerSessionId, input.requestId);
    assert.doesNotMatch(JSON.stringify(input), /synthetic-private-token/);
    await pending;
    return ORDER;
  } });
  await bot.handleUpdate(update(1, "vps_install", true));
  await bot.handleUpdate(update(2, "vps_install_do", true));
  await bot.handleUpdate(update(3, "synthetic-private-token"));
  await bot.handleUpdate(update(4, callback(calls, "vps_plan_"), true));
  await bot.handleUpdate(update(5, callback(calls, "vps_region_"), true));
  assert.match(JSON.stringify(calls), /43\.210/);
  const os = callback(calls, "vps_os_");
  await bot.handleUpdate(update(6, os, true));
  const chrome = callback(calls, "vps_chrome_");
  const one = bot.handleUpdate(update(7, chrome, true));
  const two = bot.handleUpdate(update(8, chrome, true));
  await new Promise(resolve => setImmediate(resolve));
  release!();
  await Promise.all([one, two]);
  assert.equal(checkoutCalls, 1);
  assert.match(replies(calls), /Harga checkout: Rp\s*43\.210/);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-private-token/);
});

test("Windows checkout can opt into the free Chrome installer", async () => {
  let checkoutInput: Record<string, unknown> | undefined;
  const { bot, calls } = await harness({ checkout: async input => { checkoutInput = input; return { ...ORDER, installChrome: true }; } });
  await bot.handleUpdate(update(1, "vps_buy", true));
  await bot.handleUpdate(update(2, callback(calls, "vps_plan_"), true));
  await bot.handleUpdate(update(3, callback(calls, "vps_region_"), true));
  await bot.handleUpdate(update(4, callback(calls, "vps_os_"), true));
  const chrome = (calls.at(-1)?.payload["reply_markup"] as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard?.flat().find(button => button.callback_data?.endsWith("_yes"))?.callback_data;
  assert.ok(chrome);
  await bot.handleUpdate(update(5, chrome, true));
  assert.equal(checkoutInput?.installChrome, true);
});

test("draft callback from another buyer cannot checkout", async () => {
  let checkoutCalls = 0;
  const { bot, calls } = await harness({ checkout: async () => { checkoutCalls++; return ORDER; } });
  await bot.handleUpdate(update(1, "vps_buy", true));
  await bot.handleUpdate(update(2, callback(calls, "vps_plan_"), true, 77));
  assert.equal(checkoutCalls, 0);
  assert.match(replies(calls), /VPS_SESSION_EXPIRED/);
});

test("a locked payment remains recoverable with only the selected method", async () => {
  const balance = await harness({ getOwned: async () => ({ ...ORDER, paymentStatus: "paying", paymentMethod: "balance" }) });
  await balance.bot.handleUpdate(update(1, `vps_order_${ORDER_ID}`, true));
  assert.match(JSON.stringify(balance.calls), /vps_balance_/);
  assert.doesNotMatch(JSON.stringify(balance.calls), /vps_qris_/);
  assert.match(JSON.stringify(balance.calls), /vps_check_/);
  const qris = await harness({ getOwned: async () => ({ ...ORDER, paymentStatus: "paying", paymentMethod: "qris" }) });
  await qris.bot.handleUpdate(update(2, `vps_order_${ORDER_ID}`, true));
  assert.match(JSON.stringify(qris.calls), /vps_qris_/);
  assert.doesNotMatch(JSON.stringify(qris.calls), /vps_balance_/);
});

test("paid precreate cancellation is confirmed before the service refund transition", async () => {
  let cancelled = 0;
  const { bot, calls } = await harness({ getOwned: async () => ({ ...ORDER, paymentStatus: "paid", stage: "needs_token" }), cancel: async (actor, id) => { assert.equal(actor, "42"); assert.equal(id, ORDER_ID); cancelled++; } });
  await bot.handleUpdate(update(1, `vps_order_${ORDER_ID}`, true));
  await bot.handleUpdate(update(2, callback(calls, "vps_cancel_"), true));
  assert.equal(cancelled, 0);
  assert.match(replies(calls), /Pembatalan dan refund/);
  await bot.handleUpdate(update(3, callback(calls, "vps_canceldo_"), true));
  assert.equal(cancelled, 1);
});

test("token recovery addresses the same owned order and private access responses remain copyable", async () => {
  const seen: string[] = [];
  const { bot, calls } = await harness({ acceptBuyerToken: async (actor, orderId) => { seen.push(actor, orderId); return { accountId: "same-team" }; }, credentials: async () => ({ ip: "192.0.2.1", username: "administrator", password: "synthetic-password", evidence: "Port RDP terbuka; login Windows belum diverifikasi." }) });
  await bot.handleUpdate(update(1, `vps_token_${ORDER_ID}`, true));
  await bot.handleUpdate(update(2, "temporary-token"));
  assert.deepEqual(seen, ["42", ORDER_ID]);
  await bot.handleUpdate(update(3, `vps_access_${ORDER_ID}`, true));
  const access = calls.find(call => String(call.payload["text"]).includes("synthetic-password"));
  assert.notEqual(access?.payload["protect_content"], true);
  assert.match(String(access?.payload["text"]), /login Windows belum diverifikasi/);
});

test("reboot requires a confirmation view and media menu uses a safe text reply", async () => {
  let reboots = 0;
  const { bot, calls } = await harness({ getOwned: async () => ({ ...ORDER, serviceType: "purchase", paymentStatus: "paid", stage: "ready", dropletId: 123, ip: "192.0.2.1" }), reboot: async (actor, id) => { assert.equal(actor, "42"); assert.equal(id, ORDER_ID); reboots++; return { status: "pending" }; } });
  await bot.handleUpdate(update(1, `vps_reboot_${ORDER_ID}`, true, 42, "private", true));
  assert.equal(reboots, 0); assert.match(replies(calls), /Konfirmasi Reboot/);
  assert.equal(calls.some(call => call.method === "editMessageText"), false);
  await bot.handleUpdate(update(2, callback(calls, "vps_restart_"), true));
  assert.equal(reboots, 1);
});

test("another buyer cannot open a reboot confirmation for an unowned order", async () => {
  let reboots = 0;
  const { bot, calls } = await harness({ getOwned: async (actor, id) => { assert.equal(actor, "77"); assert.equal(id, ORDER_ID); return null; }, reboot: async () => { reboots++; return { status: "pending" }; } });
  await bot.handleUpdate(update(1, `vps_reboot_${ORDER_ID}`, true, 77));
  assert.equal(reboots, 0);
  assert.doesNotMatch(JSON.stringify(calls), /vps_restart_/);
});

test("admin token wizard captures one field at a time and deletes token before save", async t => {
  const old = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "42";
  t.after(() => { if (old === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = old; });
  let saved = 0;
  const credential = { id: "credential-1", label: "Team Utama", enabled: true, priority: 2 };
  const { bot, calls } = await harness({ addCredential: async (actor, input) => {
    assert.equal(calls.at(-1)?.method, "deleteMessage");
    assert.equal(actor, "42"); assert.deepEqual(input, { label: "Team Utama", priority: 2, token: "synthetic-store-token" }); saved++;
    return credential;
  }, getCredential: async () => credential }, { admin: true });
  await bot.handleUpdate(update(1, "vpa_addtoken", true));
  await bot.handleUpdate(update(2, "Team Utama"));
  await bot.handleUpdate(update(3, "2"));
  await bot.handleUpdate(update(4, "synthetic-store-token"));
  assert.equal(saved, 1); assert.doesNotMatch(JSON.stringify(calls), /synthetic-store-token/);
  assert.match(replies(calls), /\(1\/3\)/); assert.match(replies(calls), /\(2\/3\)/); assert.match(replies(calls), /\(3\/3\)/);
});

test("admin token wizard never saves a token when message deletion fails", async t => {
  const old = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "42";
  t.after(() => { if (old === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = old; });
  let saved = 0;
  const { bot, calls } = await harness({ addCredential: async () => { saved++; throw new Error("Should not save"); } }, { admin: true, failDelete: 4 });
  await bot.handleUpdate(update(1, "vpa_addtoken", true));
  await bot.handleUpdate(update(2, "Team"));
  await bot.handleUpdate(update(3, "1"));
  await bot.handleUpdate(update(4, "synthetic-store-token"));
  assert.equal(saved, 0);
  assert.match(replies(calls), /token tidak diproses/);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-store-token/);
});

test("nonadmin callbacks cannot inspect platform DigitalOcean credentials", async t => {
  const old = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "42";
  t.after(() => { if (old === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = old; });
  let inspected = 0;
  const { bot, calls } = await harness({ listCredentials: async () => { inspected++; return []; } }, { admin: true });
  await bot.handleUpdate(update(1, "vpa_tokens_all_0", true, 77));
  assert.equal(inspected, 0);
  assert.equal(calls[0]?.method, "answerCallbackQuery");
  assert.match(replies(calls), /Hanya admin/);
});

test("admin prices a single service/spec/region/OS from the full catalog without creating a named package", async t => {
  const old = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "42";
  t.after(() => { if (old === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = old; });
  const plans = catalogPlans(defaultVpsCatalog(), "install");
  const plan = plans[0]!;
  const sgpIndex = plan.regions.indexOf("sgp1"), winIndex = plan.osPrices.findIndex(os => os.os === "windows2022");
  let saved: Parameters<VpsUiDependencies["updatePlan"]>[2] | undefined;
  const { bot, calls } = await harness({ listPlans: async () => plans, updatePlan: async (actor, id, input) => {
    assert.equal(actor, "42"); assert.equal(id, plan.id); saved = input;
    plan.priceMatrix!.push({ region: input.region!, os: input.os!, price: input.price! });
  } }, { admin: true });
  await bot.handleUpdate(update(1, "vpa_plans_0", true));
  await bot.handleUpdate(update(2, `vpa_plan_${plan.id}`, true));
  await bot.handleUpdate(update(3, `vpa_os_${plan.id}_${sgpIndex}_10`, true));
  assert.match(replies(calls), /Pilih OS/);
  assert.match(JSON.stringify(calls), /Windows Server 2022/);
  await bot.handleUpdate(update(4, `vpa_set_${plan.id}_${sgpIndex}_${winIndex}`, true));
  await bot.handleUpdate(update(5, "43210"));
  assert.deepEqual(saved, { region: "sgp1", os: "windows2022", price: 43210 });
  assert.equal(planPrice(plan, "sgp1", "windows2022"), 43210);
  assert.equal(planPrice(plan, "fra1", "windows2022"), undefined);
  for (const call of calls) {
    const buttons = (call.payload.reply_markup as { inline_keyboard?: { callback_data?: string }[][] })?.inline_keyboard?.flat() ?? [];
    assert.ok(buttons.every(button => !button.callback_data || Buffer.byteLength(button.callback_data) <= 64));
  }
});

test("admin adds a custom size one field at a time and legacy add-package buttons lead to catalog", async t => {
  const old = process.env["ADMIN_ID"];
  process.env["ADMIN_ID"] = "42";
  t.after(() => { if (old === undefined) delete process.env["ADMIN_ID"]; else process.env["ADMIN_ID"] = old; });
  let saved: Parameters<NonNullable<VpsUiDependencies["addCatalogEntry"]>>[1] | undefined;
  const { bot, calls } = await harness({
    listCatalog: async () => ({ regions: [], sizes: [], os: [] }),
    addCatalogEntry: async (actor, input) => { assert.equal(actor, "42"); saved = input; },
  }, { admin: true });
  await bot.handleUpdate(update(1, "vpa_addplan", true));
  assert.match(JSON.stringify(calls), /vpa_addsize/);
  await bot.handleUpdate(update(2, "vpa_addsize", true));
  for (const [index, text] of ["s-custom", "12", "24 GB", "500 GB", "8 TB", "$120/month"].entries()) await bot.handleUpdate(update(index + 3, text));
  assert.deepEqual(saved, { kind: "size", value: ["s-custom", "12", "24 GB", "500 GB", "8 TB", "$120/month"] });
});

test("direct install lists all seven catalog sizes, all regions and each Windows version; unset price cannot checkout", async () => {
  const plans = catalogPlans(defaultVpsCatalog(), "install");
  let checkouts = 0;
  const { bot, calls } = await harness({ listPlans: async () => plans, checkout: async () => { checkouts++; return ORDER; } });
  await bot.handleUpdate(update(1, "vps_install_direct", true));
  await bot.handleUpdate(update(2, "192.0.2.10"));
  await bot.handleUpdate(update(3, "root"));
  await bot.handleUpdate(update(4, "synthetic-source-password"));
  for (const plan of plans) assert.ok(JSON.stringify(calls).includes(plan.sizeLabel!));
  await bot.handleUpdate(update(5, callback(calls, "vps_plan_"), true));
  assert.match(JSON.stringify(calls), /Richmond, USA \(ric1\)/);
  assert.match(JSON.stringify(calls), /Memphis/);
  await bot.handleUpdate(update(6, callback(calls, "vps_region_"), true));
  const last = calls.at(-1)!;
  assert.match(JSON.stringify(last), /Windows Server 2012 R2/);
  assert.match(JSON.stringify(last), /Windows Server 2022/);
  assert.doesNotMatch(JSON.stringify(last), /Ubuntu/);
  assert.match(JSON.stringify(last), /Harga belum diatur/);
  await bot.handleUpdate(update(7, callback(calls, "vps_os_"), true));
  await bot.handleUpdate(update(8, callback(calls, "vps_chrome_"), true));
  assert.equal(checkouts, 0);
  assert.match(replies(calls), /Belum ada tagihan/);
});

test("unreadable account metrics remain unknown and status text does not invent RDP login success", () => {
  const text = vpsCredentialText({ id: "test", label: "Test", priority: 0, enabled: true, tokenStatus: "permission_denied" });
  assert.match(text, /Limit droplet: belum diketahui/); assert.match(text, /Terpakai di seluruh akun: belum diketahui/);
  assert.match(text, /Status akun: belum diketahui/); assert.doesNotMatch(text, /Status akun: locked/);
  assert.match(vpsOrderText({ ...ORDER, stage: "monitoring", evidence: "Port RDP terbuka; login Windows belum diverifikasi." }), /login Windows belum diverifikasi/);
  assert.match(vpsCredentialText({ id: "test", label: "Test", priority: 0, enabled: true, tokenStatus: "ok", accountStatus: "active", available: 1 }), /Kesiapan: Siap dicoba/);
});

test("buyer DO install flow fetches availability and filters regions to only supported ones", async () => {
  const plan: VpsUiPlan = {
    id: "plan-filtered", name: "2 vCPU · 4 GB", serviceType: "install", sizeSlug: "s-2vcpu-4gb",
    regions: ["nyc1", "sgp1", "atl1"],
    regionLabels: { nyc1: "New York 1 (nyc1)", sgp1: "Singapore (sgp1)", atl1: "Atlanta (atl1)" },
    osPrices: [{ os: "ubuntu24", label: "Ubuntu 24.04", price: 50000, family: "linux" }],
    enabled: true,
  };
  const availability: AvailabilityMap = new Map([
    ["s-2vcpu-4gb", new Set(["nyc1", "sgp1"])], // atl1 is NOT supported by buyer DO
  ]);
  let fetchedBuyer = false;
  const { bot, calls } = await harness({
    listPlans: async () => [plan],
    acceptBuyerToken: async () => ({ accountId: "team-custom" }),
    fetchBuyerAvailability: async () => { fetchedBuyer = true; return availability; },
  });
  await bot.handleUpdate(update(1, "vps_install_do", true));
  await bot.handleUpdate(update(2, "synthetic-buyer-token-1234567890"));
  assert.ok(fetchedBuyer, "should fetch buyer availability after token entry");
  // Select plan
  await bot.handleUpdate(update(3, callback(calls, "vps_plan_"), true));
  const regionStep = calls.at(-1)!;
  assert.match(JSON.stringify(regionStep), /New York 1 \(nyc1\)/);
  assert.match(JSON.stringify(regionStep), /Singapore \(sgp1\)/);
  assert.doesNotMatch(JSON.stringify(regionStep), /Atlanta \(atl1\)/);
});

test("buyer DO selection informs buyer when a spec has no supported regions in their account", async () => {
  const plan: VpsUiPlan = {
    id: "plan-unsupported", name: "8 vCPU · 16 GB", serviceType: "install", sizeSlug: "s-8vcpu-16gb",
    regions: ["atl1", "ric1"],
    osPrices: [{ os: "ubuntu24", label: "Ubuntu 24.04", price: 100000, family: "linux" }],
    enabled: true,
  };
  const availability: AvailabilityMap = new Map(); // empty: no regions support this spec
  const { bot, calls } = await harness({
    listPlans: async () => [plan],
    acceptBuyerToken: async () => ({ accountId: "team-small" }),
    fetchBuyerAvailability: async () => availability,
  });
  await bot.handleUpdate(update(1, "vps_install_do", true));
  await bot.handleUpdate(update(2, "synthetic-buyer-token-1234567890"));
  await bot.handleUpdate(update(3, callback(calls, "vps_plan_"), true));
  assert.match(replies(calls), /tidak tersedia di region mana pun untuk akun Anda/);
  assert.match(JSON.stringify(calls.at(-1)), /vps_page_/);
});

test("purchase flow uses platform availability to filter regions", async () => {
  const plan: VpsUiPlan = {
    id: "plan-purchase", name: "2 vCPU · 4 GB", serviceType: "purchase", sizeSlug: "s-2vcpu-4gb",
    regions: ["nyc1", "sgp1", "mem1"],
    regionLabels: { nyc1: "New York 1 (nyc1)", sgp1: "Singapore (sgp1)", mem1: "Memphis (mem1)" },
    osPrices: [{ os: "ubuntu24", label: "Ubuntu 24.04", price: 150000, family: "linux" }],
    enabled: true,
  };
  const availability: AvailabilityMap = new Map([
    ["s-2vcpu-4gb", new Set(["nyc1", "sgp1"])], // mem1 is NOT supported on platform account
  ]);
  const { bot, calls } = await harness({
    listPlans: async () => [plan],
    fetchPlatformAvailability: async () => availability,
  });
  await bot.handleUpdate(update(1, "vps_buy", true));
  await bot.handleUpdate(update(2, callback(calls, "vps_plan_"), true));
  const regionStep = calls.at(-1)!;
  assert.match(JSON.stringify(regionStep), /New York 1 \(nyc1\)/);
  assert.match(JSON.stringify(regionStep), /Singapore \(sgp1\)/);
  assert.doesNotMatch(JSON.stringify(regionStep), /Memphis \(mem1\)/);
});

