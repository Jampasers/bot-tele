// ============================================================================
//  SMSBower API Wrapper
//  Base URL: https://smsbower.page/stubs/handler_api.php
//  Auth:     SMSBOWER_API_KEY environment variable
//
//  All methods throw on network failure or an unexpected API response so
//  callers can catch and surface errors to the user cleanly.
// ============================================================================

const BASE_URL = "https://smsbower.page/stubs/handler_api.php";

import { SmsConfig } from "../models/SmsConfig.js";


// ─────────────────────────────────────────────────────────────────────────────
//  Response shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Parsed result from `getNumberV2`. */
export interface GetNumberResult {
  activationId: string;
  phoneNumber: string;
  activationCost: number;
}

/**
 * Discriminated union of the possible `getStatus` outcomes.
 *
 * | variant       | meaning                                    |
 * |---------------|--------------------------------------------|
 * | WAIT_CODE     | Still waiting — keep polling               |
 * | OK            | OTP received; `code` contains the digits   |
 * | CANCEL        | Activation cancelled by provider or user   |
 */
export type ActivationStatus =
  | { kind: "WAIT_CODE" }
  | { kind: "OK"; code: string }
  | { kind: "CANCEL" };

/**
 * A country entry stored in the in-memory cache.
 * `id`   — SMSBower numeric country code (as a string).
 * `name` — Human-readable English name, e.g. "Indonesia".
 */
export interface CachedCountry {
  id:   string;
  name: string;
}

/**
 * A service entry stored in the in-memory cache.
 * `code` — SMSBower service code, e.g. "wa".
 * `name` — Human-readable label, e.g. "WhatsApp".
 */
export interface CachedService {
  code: string;
  name: string;
}

/**
 * Price+stock entry for a specific service/country pair.
 * Returned by `SMSBowerService.getPricesForCountry()`.
 */
export interface ServicePrice {
  /** Raw base cost from SMSBower (in their internal credit unit). */
  cost:  number;
  /** Number of available numbers in stock (may be 0). */
  count: number;
}

/**
 * Map of service code → price info for one country.
 * `Map<serviceCode, ServicePrice>`
 */
export type CountryPriceMap = Map<string, ServicePrice>;

// ─────────────────────────────────────────────────────────────────────────────
//  Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a URL with the shared `api_key` query param and any extra params.
 * Using URLSearchParams avoids manual percent-encoding bugs.
 */
function buildUrl(params: Record<string, string>): string {
  const apiKey = process.env["SMSBOWER_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "SMSBOWER_API_KEY is not set. Add it to your .env file."
    );
  }
  const qs = new URLSearchParams({ api_key: apiKey, ...params });
  return `${BASE_URL}?${qs.toString()}`;
}

/**
 * Performs a GET request and returns the raw response text.
 * Node 18+ ships `fetch` natively; no extra dependency needed.
 */
async function get(params: Record<string, string>): Promise<string> {
  const url = buildUrl(params);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `SMSBower HTTP error: ${res.status} ${res.statusText}`
    );
  }
  return res.text();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Service class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around the SMSBower virtual-number API.
 * Instantiate once and reuse across handlers (the class holds no mutable state).
 *
 * @example
 * const sms = new SMSBowerService();
 * const { activationId, phoneNumber, activationCost } = await sms.getNumber("wa");
 */
export class SMSBowerService {

  // ── In-memory cache — populated once at startup by loadData() ───────────────

  /**
   * All countries available on SMSBower.
   * Populated by `SMSBowerService.loadData()` at bot startup.
   * The plugin reads this array to build paginated country keyboards.
   */
  static cachedCountries: CachedCountry[] = [];

  /**
   * All services available on SMSBower.
   * Populated by `SMSBowerService.loadData()` at bot startup.
   * The plugin reads this array to build paginated service keyboards.
   */
  static cachedServices: CachedService[] = [];

  // ── Runtime whitelist mirrors ─────────────────────────────────────────────
  //
  // These are NOT config — they are mirrors of whatever `SmsConfig` has in
  // MongoDB at the last time `loadData()` ran. Admin commands update the DB
  // then call `loadData()` again, which refreshes both the cache AND these
  // mirrors atomically.
  //
  // Read them (e.g. in the plugin) to know the current whitelist at any time.

  /** Country IDs currently whitelisted, in display order. Updated by loadData(). */
  static allowedCountries: string[] = [];

  /** Service codes currently whitelisted, in display order. Updated by loadData(). */
  static allowedServices: string[] = [];

  // ── Full raw API data — used by the admin panel ───────────────────────────
  //
  // These hold EVERY entry returned by the SMSBower API, regardless of the
  // whitelist. The admin UI reads these to show ✅/❌ status per item.
  // The public user UI reads cachedCountries / cachedServices (filtered).

  /** All countries from the API, sorted A-Z. Updated by loadData(). */
  static allCountries: CachedCountry[] = [];

  /** All services from the API, sorted A-Z. Updated by loadData(). */
  static allServices: CachedService[] = [];

  // ── Per-country price cache ──────────────────────────────────────────────────
  //
  // Keyed by countryId. Each value is a Map<serviceCode, {cost, count}>.
  // Populated lazily when a user first opens a country's service list.
  // Cleared by loadData() so stale data never persists after a cache reload.

  /** `Map<countryId, CountryPriceMap>` — lazily populated per country. */
  static priceCache: Map<string, CountryPriceMap> = new Map();

  // ── loadData — fetches countries + services and fills the caches ─────────────

  /**
   * Reads the whitelist from MongoDB, then fetches the full country and service
   * lists from the SMSBower API and stores the filtered, ordered results in the
   * static cache properties.
   *
   * Call this at bot startup and again after any admin whitelist change so the
   * in-memory cache stays in sync with the database without a restart.
   *
   * @example
   * await SMSBowerService.loadData(); // startup
   * await SMSBowerService.loadData(); // after /addservice or /addcountry
   */
  static async loadData(): Promise<void> {
    console.log("📡  SMSBower: refreshing cache from DB + API…");

    // ── Step 1: Load whitelist from MongoDB ────────────────────────────────────
    // getOrCreate() guarantees a document always exists (creates with defaults
    // on the very first run). This is the ONLY source of truth for the whitelist.
    const config = await SmsConfig.getOrCreate();
    const allowedSvc = config.allowedServices;
    const allowedCtr = config.allowedCountries;

    // Mirror into static properties so other code can read them without a DB hit.
    SMSBowerService.allowedServices  = [...allowedSvc];
    SMSBowerService.allowedCountries = [...allowedCtr];

    console.log(`   📋  Whitelist — services: [${allowedSvc.join(", ")}]`);
    console.log(`   📋  Whitelist — countries: [${allowedCtr.join(", ")}]`);

    // ── Step 2: Fetch + filter Services ───────────────────────────────────────
    // Actual API response: { "status": "success", "services": [{code, name}, ...] }
    // services[] sits directly at the root level — no nested "data" wrapper.
    try {
      const apiKey = process.env["SMSBOWER_API_KEY"];
      if (!apiKey) throw new Error("SMSBOWER_API_KEY is not set.");

      const svcUrl = `${BASE_URL}?` + new URLSearchParams({
        api_key: apiKey,
        action:  "getServicesList",
      }).toString();

      const svcRes  = await fetch(svcUrl);
      const svcText = await svcRes.text();
      console.log(`   📄  Raw services response (first 200 chars): ${svcText.substring(0, 200)}`);

      const parsed = JSON.parse(svcText) as Record<string, unknown>;

      let raw: CachedService[] = [];

      /** Type guard: checks an unknown value has {code:string, name:string} */
      const isSvcObj = (v: unknown): v is CachedService =>
        typeof v === "object" && v !== null &&
        typeof (v as Record<string, unknown>)["code"] === "string" &&
        typeof (v as Record<string, unknown>)["name"] === "string";

      // ─ Primary shape: { status:"success", services:[{code,name},...] } ───────
      if (parsed["status"] === "success" && Array.isArray(parsed["services"])) {
        raw = (parsed["services"] as unknown[])
          .filter(isSvcObj)
          .map((v) => ({ code: v.code, name: v.name }));

      // ─ Legacy shape: { status:"success", data:{ services:{code:name,...} } } ─
      } else if (
        parsed["status"] === "success" &&
        typeof parsed["data"] === "object" && parsed["data"] !== null
      ) {
        const data   = parsed["data"] as Record<string, unknown>;
        const svcMap = data["services"];

        if (Array.isArray(svcMap)) {
          raw = (svcMap as unknown[]).filter(isSvcObj).map((v) => ({ code: v.code, name: v.name }));
        } else if (typeof svcMap === "object" && svcMap !== null) {
          raw = Object.entries(svcMap as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([code, name]) => ({ code, name: name as string }));
        }

      // ─ Bare array fallback: [{code,name},...] ─────────────────────────────
      } else if (Array.isArray(parsed)) {
        raw = (parsed as unknown[]).filter(isSvcObj).map((v) => ({ code: v.code, name: v.name }));

      } else {
        console.error("   ⚠️  Services: unrecognised API response shape. Raw:", svcText.substring(0, 300));
      }

      // Store ALL services for the admin panel BEFORE whitelist filtering.
      SMSBowerService.allServices = [...raw].sort((a, b) => a.name.localeCompare(b.name));

      // Whitelist filter + DB-order sort (public user cache)
      SMSBowerService.cachedServices = raw
        .filter((s) => allowedSvc.includes(s.code))
        .sort((a, b) => allowedSvc.indexOf(a.code) - allowedSvc.indexOf(b.code));

      console.log(`   ✅  Services: ${SMSBowerService.cachedServices.length} active / ${raw.length} total from API`);
    } catch (err) {
      console.error("   ⚠️  Failed to load services:", err);
    }

    // ── Step 3: Fetch + filter Countries ──────────────────────────────────────
    // Expected response shape (object keyed by country code):
    // { "0": { "id": 0, "eng": "Russia", ... }, "6": { "id": 6, "eng": "Indonesia", ... }, ... }
    try {
      const apiKey = process.env["SMSBOWER_API_KEY"];
      if (!apiKey) throw new Error("SMSBOWER_API_KEY is not set.");

      const ctrUrl = `${BASE_URL}?` + new URLSearchParams({
        api_key: apiKey,
        action:  "getCountries",
      }).toString();

      const ctrRes  = await fetch(ctrUrl);
      const ctrJson = await ctrRes.json() as unknown;

      // The API returns either an object or an array — handle both.
      const entries: Array<[string, unknown]> =
        Array.isArray(ctrJson)
          ? ctrJson.map((item, i) => [String(i), item])
          : Object.entries(ctrJson as Record<string, unknown>);

      const mapped: CachedCountry[] = [];
      for (const [, value] of entries) {
        const v = value as Record<string, unknown>;
        if (
          (typeof v["id"]  === "number" || typeof v["id"]  === "string") &&
          typeof v["eng"] === "string"
        ) {
          mapped.push({ id: String(v["id"]), name: v["eng"] as string });
        }
      }

      // Store ALL countries for the admin panel BEFORE whitelist filtering.
      SMSBowerService.allCountries = [...mapped].sort((a, b) => a.name.localeCompare(b.name));

      // Whitelist filter + DB-order sort (public user cache)
      SMSBowerService.cachedCountries = mapped
        .filter((c) => allowedCtr.includes(c.id))
        .sort((a, b) => allowedCtr.indexOf(a.id) - allowedCtr.indexOf(b.id));

      console.log(`   ✅  Countries: ${SMSBowerService.cachedCountries.length} active / ${mapped.length} total from API`);
    } catch (err) {
      console.error("   ⚠️  Failed to load countries:", err);
    }

    // Clear price cache so stale per-country prices are refetched on next use.
    SMSBowerService.priceCache.clear();
    console.log("   🗑️  Price cache cleared.");
  }

  // ── getPricesForCountry ──────────────────────────────────────────────────

  /**
   * Returns price + stock info for every service in the given country,
   * using an in-memory cache so pagination is instant after the first load.
   *
   * API action : `getPrices`
   * Response   : `{ [serviceCode]: { [countryId]: { cost: number, count: number } } }`
   *
   * The result is cached in `SMSBowerService.priceCache` keyed by countryId.
   * Call `priceCache.clear()` (done automatically by `loadData()`) to invalidate.
   *
   * @param countryId - SMSBower numeric country ID string, e.g. "6".
   * @returns `CountryPriceMap` — Map<serviceCode, {cost, count}>.
   */
  static async getPricesForCountry(countryId: string): Promise<CountryPriceMap> {
    // Cache hit — return immediately without any network call.
    const cached = SMSBowerService.priceCache.get(countryId);
    if (cached) return cached;

    const priceMap: CountryPriceMap = new Map();

    try {
      const apiKey = process.env["SMSBOWER_API_KEY"];
      if (!apiKey) throw new Error("SMSBOWER_API_KEY is not set.");

      const url = `${BASE_URL}?` + new URLSearchParams({
        api_key: apiKey,
        action:  "getPrices",
        country: countryId,
      }).toString();

      const res  = await fetch(url);
      const text = await res.text();

      // Attempt JSON parse. SMSBower may return plain-text on error.
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = null; }

      if (data && typeof data === "object" && !Array.isArray(data)) {
        let root = data as Record<string, unknown>;
        if (root["data"] && typeof root["data"] === "object" && !Array.isArray(root["data"])) {
          root = root["data"] as Record<string, unknown>;
        } else if (root["prices"] && typeof root["prices"] === "object" && !Array.isArray(root["prices"])) {
          root = root["prices"] as Record<string, unknown>;
        }

        // Shape A (SMS-Activate / SMSBower standard): { [countryId]: { [serviceCode]: { cost, count } } }
        if (root[countryId] && typeof root[countryId] === "object" && !Array.isArray(root[countryId])) {
          const servicesMap = root[countryId] as Record<string, unknown>;
          for (const [svcCode, entry] of Object.entries(servicesMap)) {
            if (typeof entry !== "object" || entry === null) continue;
            const e = entry as Record<string, unknown>;
            const cost  = typeof e["cost"]  === "number" ? e["cost"]  : parseFloat(String(e["cost"]  ?? "0"));
            const count = typeof e["count"] === "number" ? e["count"] : parseInt(String(e["count"] ?? "0"), 10);
            if (!isNaN(cost)) {
              priceMap.set(svcCode, { cost, count });
            }
          }
        }

        // Shape B fallback: { [serviceCode]: { [countryId]: { cost, count } } } or direct { [serviceCode]: { cost, count } }
        if (priceMap.size === 0) {
          for (const [svcCode, val] of Object.entries(root)) {
            if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
            const obj = val as Record<string, unknown>;

            // Subshape B1: nested by country
            if (obj[countryId] && typeof obj[countryId] === "object") {
              const e = obj[countryId] as Record<string, unknown>;
              const cost  = typeof e["cost"]  === "number" ? e["cost"]  : parseFloat(String(e["cost"]  ?? "0"));
              const count = typeof e["count"] === "number" ? e["count"] : parseInt(String(e["count"] ?? "0"), 10);
              if (!isNaN(cost)) {
                priceMap.set(svcCode, { cost, count });
              }
            }
            // Subshape B2: direct { cost, count }
            else if ("cost" in obj || "count" in obj) {
              const cost  = typeof obj["cost"]  === "number" ? obj["cost"]  : parseFloat(String(obj["cost"]  ?? "0"));
              const count = typeof obj["count"] === "number" ? obj["count"] : parseInt(String(obj["count"] ?? "0"), 10);
              if (!isNaN(cost)) {
                priceMap.set(svcCode, { cost, count });
              }
            }
          }
        }

        console.log(`   💰  Prices loaded for country ${countryId}: ${priceMap.size} services.`);
      } else {
        console.warn(`   ⚠️  getPrices for country ${countryId}: unexpected response — ${text.substring(0, 100)}`);
      }
    } catch (err) {
      console.error(`   ⚠️  getPricesForCountry(${countryId}) failed:`, err);
    }

    // Store in cache even if empty so we don’t retry on every page turn.
    SMSBowerService.priceCache.set(countryId, priceMap);
    return priceMap;
  }

  // ── getBalance ─────────────────────────────────────────────────────────────

  /**
   * Returns the current account balance as a number.
   * API response format: `ACCESS_BALANCE:<amount>`
   */
  async getBalance(): Promise<number> {
    const raw = await get({ action: "getBalance" });

    // Expected format: "ACCESS_BALANCE:123.45"
    const match = raw.match(/^ACCESS_BALANCE:(.+)$/);
    if (!match || !match[1]) {
      throw new Error(`getBalance: unexpected response "${raw}"`);
    }

    const balance = parseFloat(match[1]);
    if (isNaN(balance)) {
      throw new Error(`getBalance: non-numeric balance value "${match[1]}"`);
    }

    return balance;
  }

  // ── getNumber ──────────────────────────────────────────────────────────────

  /**
   * Requests a virtual number for the given service.
   *
   * @param service - SMSBower service code (e.g. "wa", "tg", "ni", "fr").
   * @param country - Country code string. Defaults to "6" (Indonesia).
   *
   * **Success** — API returns a JSON object:
   * ```json
   * { "activationId": "123", "phoneNumber": "628xxx", "activationCost": "500" }
   * ```
   *
   * **Failure** — API returns a plain-text error code, e.g.:
   * - `NO_BALANCE`  — provider account has insufficient funds
   * - `NO_NUMBERS`  — no stock available for the requested service/country
   * - `BAD_KEY`     — the API key is invalid
   *
   * This method translates every known error code into a descriptive message
   * before attempting JSON parsing, so callers always receive a clean Error
   * instead of a confusing JSON parse crash.
   */
  async getNumber(
    service: string,
    country: string = "6"
  ): Promise<GetNumberResult> {
    // ── 1. Always read as text first ─────────────────────────────────────────
    const text = await get({
      action: "getNumberV2",
      service,
      country,
    });

    // ── 2. Check for known plain-text error codes BEFORE touching JSON ────────
    //       Order matters: most specific checks go first.
    if (text === "NO_BALANCE") {
      throw new Error("Saldo pusat/provider tidak mencukupi.");
    }
    if (text === "NO_NUMBERS") {
      throw new Error("Stok nomor untuk layanan/negara ini sedang kosong.");
    }
    if (text === "BAD_KEY") {
      throw new Error("API Key SMSBower salah atau tidak valid.");
    }

    // ── 3. Attempt JSON parsing ───────────────────────────────────────────────
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError("Parsed value is not a plain object.");
      }
      data = parsed as Record<string, unknown>;
    } catch {
      // The response was plain text but didn't match any known error code.
      throw new Error(`API Error: ${text}`);
    }

    // ── 4. Validate the expected shape ────────────────────────────────────────
    if (
      typeof data["activationId"]  !== "string" ||
      typeof data["phoneNumber"]   !== "string"
    ) {
      throw new Error(
        `getNumber: unexpected response shape: ${JSON.stringify(data)}`
      );
    }

    return {
      activationId:   data["activationId"]  as string,
      phoneNumber:    data["phoneNumber"]   as string,
      activationCost: parseFloat((data["activationCost"] as string | number | undefined)?.toString() ?? "0"),
    };
  }


  // ── getStatus ──────────────────────────────────────────────────────────────

  /**
   * Polls the status of an activation.
   *
   * Possible raw API responses:
   * - `"STATUS_WAIT_CODE"`        → waiting for SMS
   * - `"STATUS_OK:<code>"`        → OTP received
   * - `"STATUS_CANCEL"`           → activation cancelled
   */
  async getStatus(activationId: string): Promise<ActivationStatus> {
    const raw = await get({
      action: "getStatus",
      id:     activationId,
    });

    if (raw === "STATUS_WAIT_CODE") {
      return { kind: "WAIT_CODE" };
    }

    if (raw === "STATUS_CANCEL") {
      return { kind: "CANCEL" };
    }

    const okMatch = raw.match(/^STATUS_OK:(.+)$/);
    if (okMatch?.[1]) {
      return { kind: "OK", code: okMatch[1] };
    }

    throw new Error(`getStatus: unknown response "${raw}"`);
  }

  // ── setStatus ──────────────────────────────────────────────────────────────

  /**
   * Changes the status of an activation.
   *
   * Common status values:
   * - `"8"` — cancel the activation (refund the number)
   * - `"3"` — manually mark the SMS as received (rarely needed)
   *
   * @param activationId - The activation to update.
   * @param status       - Numeric status code as a string.
   */
  async setStatus(activationId: string, status: string): Promise<string> {
    const raw = await get({
      action: "setStatus",
      id:     activationId,
      status,
    });
    // Return the raw response so callers can inspect it if needed.
    return raw;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Singleton export
//  Import this instance in your plugin — avoids creating a new object per
//  handler invocation while keeping the constructor testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Ready-to-use singleton. Import this instead of `new SMSBowerService()`. */
export const smsBower = new SMSBowerService();
