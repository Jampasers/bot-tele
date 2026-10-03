import assert from "node:assert/strict";
import test from "node:test";
import { SmsConfig } from "../src/models/SmsConfig.js";
import { SMSBowerService, smsBower } from "../src/services/smsbower.js";

test("SMSBower catalog recovery", async (t) => {
  const originalKey = process.env.SMSBOWER_API_KEY;
  process.env.SMSBOWER_API_KEY = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env.SMSBOWER_API_KEY;
    else process.env.SMSBOWER_API_KEY = originalKey;
  });
  const config = { allowedServices: ["tg", "wa"], allowedCountries: ["6"] };
  t.mock.method(SmsConfig, "getOrCreate", async () => config);
  t.mock.method(console, "log", () => {});
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
  const catalog = (action: string) => Response.json(action === "getServicesList"
    ? { status: "success", services: [{ code: "wa", name: "WhatsApp" }, { code: "tg", name: "Telegram" }] }
    : { "6": { id: 6, eng: "Indonesia" }, "0": { id: 0, eng: "Russia" } });

  await t.test("retries timeouts and loads catalogs in parallel", async (st) => {
    const calls = new Map<string, number>();
    const actions: string[] = [];
    st.mock.method(globalThis, "fetch", async (url: string) => {
      const action = new URL(url).searchParams.get("action")!;
      actions.push(action);
      calls.set(action, (calls.get(action) ?? 0) + 1);
      if (calls.get(action) === 1) throw new DOMException("timeout", "TimeoutError");
      return catalog(action);
    });
    await SMSBowerService.loadData();
    assert.deepEqual(actions.slice(0, 2), ["getServicesList", "getCountries"]);
    assert.equal(calls.get("getServicesList"), 2);
    assert.equal(calls.get("getCountries"), 2);
    assert.deepEqual(SMSBowerService.cachedServices.map(s => s.code), ["tg", "wa"]);
    assert.deepEqual(SMSBowerService.cachedCountries.map(c => c.id), ["6"]);
  });

  await t.test("retries temporary HTTP errors", async (st) => {
    let calls = 0;
    st.mock.method(globalThis, "fetch", async (url: string) => {
      calls++;
      if (calls <= 2) return new Response("unavailable", { status: 503 });
      return catalog(new URL(url).searchParams.get("action")!);
    });
    await SMSBowerService.loadData();
    assert.equal(calls, 4);
  });

  await t.test("stops after three failures and applies new whitelist to previous data", async (st) => {
    config.allowedServices = ["wa"];
    config.allowedCountries = ["0"];
    let calls = 0;
    st.mock.method(globalThis, "fetch", async () => {
      calls++;
      throw new DOMException("timeout", "TimeoutError");
    });
    await SMSBowerService.loadData();
    assert.equal(calls, 6);
    assert.equal(SMSBowerService.allServices.length, 2);
    assert.deepEqual(SMSBowerService.cachedServices.map(s => s.code), ["wa"]);
    assert.deepEqual(SMSBowerService.cachedCountries.map(c => c.id), ["0"]);
  });

  await t.test("rejects invalid catalogs without discarding previous data", async (st) => {
    st.mock.method(globalThis, "fetch", async (url: string) =>
      new URL(url).searchParams.get("action") === "getServicesList"
        ? new Response("not JSON") : Response.json({ error: "BAD_KEY" }));
    await SMSBowerService.loadData();
    assert.equal(SMSBowerService.allServices.length, 2);
    assert.equal(SMSBowerService.allCountries.length, 2);
  });

  await t.test("does not retry permanent HTTP errors or expose API keys", async (st) => {
    let calls = 0;
    st.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("forbidden", { status: 403 });
    });
    await SMSBowerService.loadData();
    assert.equal(calls, 2);
    assert.ok(warnings.every(w => !w.includes("test-key")));
  });

  await t.test("never retries number rentals after a timeout", async (st) => {
    let calls = 0;
    st.mock.method(globalThis, "fetch", async () => {
      calls++;
      throw new DOMException("timeout", "TimeoutError");
    });
    await assert.rejects(smsBower.getNumber("wa"), { name: "TimeoutError" });
    assert.equal(calls, 1);
  });
});
