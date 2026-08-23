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

export interface ProviderDetail {
  providerId: number | string;
  price: number;
  count: number;
}

/**
 * Price+stock entry for a specific service/country pair.
 * Returned by `SMSBowerService.getPricesForCountry()`.
 */
export interface ServicePrice {
  /** Raw base cost from SMSBower (lowest price available in USD). */
  cost:  number;
  /** Number of available numbers in stock across all providers. */
  count: number;
  /** Comma-separated list of top 3 cheapest provider IDs (e.g. "1329,2272,3178"). */
  providerIds?: string | undefined;
  /** Detailed provider breakdown sorted by price ascending. */
  providers?: ProviderDetail[] | undefined;
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
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error(
      `SMSBower HTTP error: ${res.status} ${res.statusText}`
    );
  }
  return res.text();
}

// ── Provider Data Parser for getPricesV3 ─────────────────────────────────────

/**
 * Parses provider pricing objects returned by getPricesV3.
 * Calculates:
 * - `cost`: lowest available price in USD
 * - `count`: total available stock across all providers
 * - `providerIds`: comma-separated string of the 3 cheapest provider IDs with stock
 * - `providers`: full list of providers sorted by price ascending
 */
export function parseProvidersData(providersObj: unknown): ServicePrice | null {
  if (!providersObj || typeof providersObj !== "object") return null;

  const directObj = providersObj as Record<string, unknown>;

  // Check if it's already a flat object { cost, count } or { price, count } without sub-providers
  const hasDirectCost = "cost" in directObj || "price" in directObj;
  const isDirectNumber = typeof directObj["cost"] === "number" || typeof directObj["price"] === "number";
  const keys = Object.keys(directObj);
  const isProviderMap = keys.some((k) => /^\d+$/.test(k) && typeof directObj[k] === "object");

  if (hasDirectCost && isDirectNumber && !isProviderMap) {
    const rawCost = directObj["price"] ?? directObj["cost"];
    const cost = typeof rawCost === "number" ? rawCost : parseFloat(String(rawCost ?? "0"));
    const count = typeof directObj["count"] === "number" ? directObj["count"] : parseInt(String(directObj["count"] ?? "0"), 10);
    const pid = directObj["provider_id"] ?? directObj["providerId"];
    const providerIds = pid !== undefined ? String(pid) : undefined;
    if (!isNaN(cost) && cost > 0) {
      return {
        cost,
        count: isNaN(count) || count < 0 ? 0 : count,
        providerIds,
      };
    }
  }

  const providerList: ProviderDetail[] = [];
  let totalStock = 0;

  for (const [key, val] of Object.entries(directObj)) {
    if (typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    const rawPrice = v["price"] ?? v["cost"];
    const rawCount = v["count"];
    const rawPid   = v["provider_id"] ?? v["providerId"] ?? key;

    const price = typeof rawPrice === "number" ? rawPrice : parseFloat(String(rawPrice ?? "0"));
    const count = typeof rawCount === "number" ? rawCount : parseInt(String(rawCount ?? "0"), 10);
    const pid   = typeof rawPid === "number" || typeof rawPid === "string" ? rawPid : key;

    if (!isNaN(price) && price > 0) {
      const validCount = isNaN(count) || count < 0 ? 0 : count;
      totalStock += validCount;
      providerList.push({
        providerId: pid,
        price,
        count: validCount,
      });
    }
  }

  if (providerList.length === 0) return null;

  // Filter providers that have stock (> 0)
  const withStock = providerList.filter((p) => p.count > 0);
  const candidates = withStock.length > 0 ? withStock : providerList;

  // Sort ascending by price (cheapest first)
  candidates.sort((a, b) => a.price - b.price);

  const cheapest = candidates[0];
  if (!cheapest) return null;

  const lowestPrice = cheapest.price;
  const top3Ids = candidates.slice(0, 3).map((p) => String(p.providerId)).join(",");

  return {
    cost: lowestPrice,
    count: totalStock,
    providerIds: top3Ids,
    providers: candidates,
  };
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

      const svcRes  = await fetch(svcUrl, { signal: AbortSignal.timeout(8000) });
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

      const ctrRes  = await fetch(ctrUrl, { signal: AbortSignal.timeout(8000) });
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
   * API action : `getPricesV3`
   * Response   : `{ [countryId]: { [serviceCode]: { [providerId]: { count, price, provider_id } } } }`
   *
   * The result is cached in `SMSBowerService.priceCache` keyed by countryId.
   * Call `priceCache.clear()` (done automatically by `loadData()`) to invalidate.
   *
   * @param countryId - SMSBower numeric country ID string, e.g. "6".
   * @returns `CountryPriceMap` — Map<serviceCode, {cost, count, providerIds, providers}>.
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
        action:  "getPricesV3",
        country: countryId,
      }).toString();

      const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

        // Shape A (getPricesV3 standard): { [countryId]: { [serviceCode]: { [providerId]: { count, price, provider_id } } } }
        if (root[countryId] && typeof root[countryId] === "object" && !Array.isArray(root[countryId])) {
          const servicesMap = root[countryId] as Record<string, unknown>;
          for (const [svcCode, entry] of Object.entries(servicesMap)) {
            if (typeof entry !== "object" || entry === null) continue;
            const parsed = parseProvidersData(entry);
            if (parsed && parsed.cost > 0) {
              priceMap.set(svcCode, parsed);
            }
          }
        }

        // Shape B fallback: { [serviceCode]: { [countryId]: ... } } or direct { [serviceCode]: ... }
        if (priceMap.size === 0) {
          for (const [svcCode, val] of Object.entries(root)) {
            if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
            const obj = val as Record<string, unknown>;

            if (obj[countryId] && typeof obj[countryId] === "object") {
              const parsed = parseProvidersData(obj[countryId]);
              if (parsed && parsed.cost > 0) {
                priceMap.set(svcCode, parsed);
              }
            } else {
              const parsed = parseProvidersData(obj);
              if (parsed && parsed.cost > 0) {
                priceMap.set(svcCode, parsed);
              }
            }
          }
        }

        console.log(`   💰  getPricesV3 loaded for country ${countryId}: ${priceMap.size} services.`);
      } else {
        console.warn(`   ⚠️  getPricesV3 for country ${countryId}: unexpected response — ${text.substring(0, 100)}`);
      }
    } catch (err) {
      console.error(`   ⚠️  getPricesForCountry(${countryId}) failed:`, err);
    }

    // Store in cache even if empty so we don’t retry on every page turn.
    SMSBowerService.priceCache.set(countryId, priceMap);
    return priceMap;
  }

  // ── getPricesByService ───────────────────────────────────────────────────

  /**
   * Fetches prices for a single service across all countries via getPricesV3.
   *
   * @param serviceCode - SMSBower service code, e.g. "wa".
   * @returns Map<countryId, ServicePrice>
   */
  static async getPricesByService(serviceCode: string): Promise<Map<string, ServicePrice>> {
    const resultMap = new Map<string, ServicePrice>();

    try {
      const apiKey = process.env["SMSBOWER_API_KEY"];
      if (!apiKey) throw new Error("SMSBOWER_API_KEY is not set.");

      const url = `${BASE_URL}?` + new URLSearchParams({
        api_key: apiKey,
        action:  "getPricesV3",
        service: serviceCode,
      }).toString();

      const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const text = await res.text();

      let data: unknown;
      try { data = JSON.parse(text); } catch { data = null; }

      if (data && typeof data === "object" && !Array.isArray(data)) {
        let root = data as Record<string, unknown>;
        if (root["data"] && typeof root["data"] === "object" && !Array.isArray(root["data"])) {
          root = root["data"] as Record<string, unknown>;
        } else if (root["prices"] && typeof root["prices"] === "object" && !Array.isArray(root["prices"])) {
          root = root["prices"] as Record<string, unknown>;
        }

        for (const [countryId, val] of Object.entries(root)) {
          if (typeof val !== "object" || val === null || Array.isArray(val)) continue;
          const obj = val as Record<string, unknown>;

          // Format 1: { [countryId]: { [serviceCode]: { [providerId]: ... } } }
          if (obj[serviceCode] && typeof obj[serviceCode] === "object") {
            const parsed = parseProvidersData(obj[serviceCode]);
            if (parsed && parsed.cost > 0) {
              resultMap.set(countryId, parsed);
            }
          }
          // Format 2: { [countryId]: { [providerId]: ... } }
          else {
            const parsed = parseProvidersData(obj);
            if (parsed && parsed.cost > 0) {
              resultMap.set(countryId, parsed);
            }
          }
        }
      }
    } catch (err) {
      console.error(`   ⚠️  getPricesByService(${serviceCode}) failed:`, err);
    }

    return resultMap;
  }

  // ── getServicePrice ──────────────────────────────────────────────────────

  /**
   * Returns price + stock for a specific service/country pair.
   */
  static async getServicePrice(serviceCode: string, countryId: string): Promise<ServicePrice | null> {
    const cached = SMSBowerService.priceCache.get(countryId)?.get(serviceCode);
    if (cached && cached.cost > 0) return cached;

    const prices = await SMSBowerService.getPricesForCountry(countryId);
    return prices.get(serviceCode) ?? null;
  }

  // ── Finders & Resolvers ──────────────────────────────────────────────────

  /**
   * Resolves a country by ID, full name, or partial name (case-insensitive).
   */
  static findCountry(query: string): CachedCountry | undefined {
    if (!query) return undefined;
    const q = query.trim().toLowerCase();

    // 1. Exact ID
    const byId = SMSBowerService.allCountries.find((c) => c.id === q);
    if (byId) return byId;

    // 2. Exact name
    const byName = SMSBowerService.allCountries.find((c) => c.name.toLowerCase() === q);
    if (byName) return byName;

    // 3. Partial name
    return SMSBowerService.allCountries.find((c) => c.name.toLowerCase().includes(q));
  }

  /**
   * Resolves a service by code, full name, or partial name (case-insensitive).
   */
  static findService(query: string): CachedService | undefined {
    if (!query) return undefined;
    const q = query.trim().toLowerCase();

    // 1. Exact Code
    const byCode = SMSBowerService.allServices.find((s) => s.code.toLowerCase() === q);
    if (byCode) return byCode;

    // 2. Exact name
    const byName = SMSBowerService.allServices.find((s) => s.name.toLowerCase() === q);
    if (byName) return byName;

    // 3. Partial name
    return SMSBowerService.allServices.find((s) => s.name.toLowerCase().includes(q));
  }


  // ── getBalance ─────────────────────────────────────────────────────────────

  /**
   * Returns the current account balance as a number.
   * API response format: `ACCESS_BALANCE:<amount>`
   */
  async getBalance(): Promise<number> {
    const raw = (await get({ action: "getBalance" })).trim();

    // Expected format: "ACCESS_BALANCE:123.45"
    const match = raw.match(/^ACCESS_BALANCE:(.+)$/);
    if (match && match[1]) {
      const balance = parseFloat(match[1].trim());
      if (!isNaN(balance)) {
        return balance;
      }
    }

    // Fallback: check if JSON format was returned
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed["balance"] === "number") return parsed["balance"];
      if (typeof parsed["balance"] === "string") {
        const num = parseFloat(parsed["balance"]);
        if (!isNaN(num)) return num;
      }
    } catch {
      // not json
    }

    throw new Error(`getBalance: unexpected response "${raw}"`);
  }

  // ── getNumber ──────────────────────────────────────────────────────────────

  /**
   * Requests a virtual number for the given service.
   *
   * @param service     - SMSBower service code (e.g. "wa", "tg", "ni", "fr").
   * @param country     - Country code string. Defaults to "6" (Indonesia).
   * @param maxPrice    - Optional maximum base cost willing to pay. If set,
   *                      passes `maxPrice` to `getNumberV2` so SMSBower will not
   *                      assign a number that exceeds this price threshold.
   * @param providerIds - Optional comma-separated provider IDs (e.g. "1329,2272,3178").
   *
   * **Success** — API returns a JSON object:
   * ```json
   * { "activationId": 561611085, "phoneNumber": "628xxx", "activationCost": "0.007" }
   * ```
   *
   * **Failure** — API returns a plain-text error code, e.g.:
   * - `NO_BALANCE`          — provider account has insufficient funds
   * - `NO_NUMBERS`          — no stock available for the requested service/country
   * - `MAX_PRICE_EXCEEDED`  — number price exceeds maxPrice threshold
   * - `BAD_KEY`             — the API key is invalid
   *
   * This method translates every known error code into a descriptive message
   * before attempting JSON parsing, so callers always receive a clean Error
   * instead of a confusing JSON parse crash.
   */
  async getNumber(
    service: string,
    country: string = "6",
    maxPrice?: number,
    providerIds?: string
  ): Promise<GetNumberResult> {
    // ── 1. Always read as text first ─────────────────────────────────────────
    const params: Record<string, string> = {
      action: "getNumberV2",
      service,
      country,
    };
    if (typeof maxPrice === "number" && maxPrice > 0) {
      params["maxPrice"] = String(maxPrice);
    }
    if (providerIds && providerIds.trim().length > 0) {
      params["providerIds"] = providerIds.trim();
    }

    const rawText = await get(params);
    const text = rawText.trim();

    // ── 2. Check for known plain-text error codes BEFORE touching JSON ────────
    //       Order matters: most specific checks go first.
    if (text === "NO_BALANCE") {
      throw new Error("Saldo pusat/provider tidak mencukupi.");
    }
    if (text === "NO_NUMBERS") {
      throw new Error("Stok nomor untuk layanan/negara ini sedang kosong.");
    }
    if (text === "MAX_PRICE_EXCEEDED" || text.includes("MAX_PRICE")) {
      throw new Error("Harga nomor dari provider melebihi batas harga maksimal (stok harga terdaftar habis).");
    }
    if (text === "BAD_KEY") {
      throw new Error("API Key SMSBower salah atau tidak valid.");
    }
    if (text === "BAD_ACTION") {
      throw new Error("Aksi API tidak valid.");
    }
    if (text === "BAD_SERVICE" || text === "WRONG_SERVICE") {
      throw new Error("Layanan tidak valid atau tidak tersedia.");
    }
    if (text === "NO_ACTIVATION") {
      throw new Error("Aktivasi tidak ditemukan.");
    }

    // Check if plain-text ACCESS_NUMBER format was returned (e.g. ACCESS_NUMBER:12345:628123456)
    if (text.startsWith("ACCESS_NUMBER:")) {
      const parts = text.split(":");
      if (parts.length >= 3 && parts[1] && parts[2]) {
        return {
          activationId: parts[1].trim(),
          phoneNumber: parts[2].trim(),
          activationCost: 0,
        };
      }
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

    // Check if API returned an error structure in JSON format
    if (data["status"] === "error" || data["error"]) {
      const errMsg = String(data["message"] || data["error"] || data["msg"] || JSON.stringify(data));
      throw new Error(`API Error: ${errMsg}`);
    }

    // ── 4. Validate the expected shape ────────────────────────────────────────
    // Handle both string and number representations from provider APIs
    const rawActivationId = data["activationId"] ?? data["id"];
    const rawPhoneNumber  = data["phoneNumber"] ?? data["phone"] ?? data["number"];
    const rawCost         = data["activationCost"] ?? data["cost"];

    if (
      (typeof rawActivationId !== "string" && typeof rawActivationId !== "number") ||
      (typeof rawPhoneNumber !== "string" && typeof rawPhoneNumber !== "number")
    ) {
      throw new Error(
        `getNumber: unexpected response shape: ${JSON.stringify(data)}`
      );
    }

    const activationId = String(rawActivationId).trim();
    const phoneNumber  = String(rawPhoneNumber).trim();
    const parsedCost   = parseFloat(rawCost !== undefined && rawCost !== null ? String(rawCost) : "0");
    const activationCost = isNaN(parsedCost) ? 0 : parsedCost;

    if (!activationId || !phoneNumber) {
      throw new Error(
        `getNumber: unexpected response shape: ${JSON.stringify(data)}`
      );
    }

    // Extra safety guard: If maxPrice is set and returned activationCost exceeds it
    if (typeof maxPrice === "number" && maxPrice > 0 && activationCost > maxPrice + 0.001) {
      await this.setStatus(activationId, "8").catch(() => {});
      throw new Error("Harga nomor dari provider melebihi batas harga maksimal, aktivasi dibatalkan otomatis.");
    }

    return {
      activationId,
      phoneNumber,
      activationCost,
    };
  }

  // ── getStatus ──────────────────────────────────────────────────────────────

  /**
   * Polls the status of an activation.
   *
   * Possible raw API responses:
   * - `"STATUS_WAIT_CODE"`        → waiting for SMS
   * - `"STATUS_WAIT_RETRY"`       → waiting for SMS retry
   * - `"STATUS_WAIT_RESEND"`      → waiting for resend
   * - `"STATUS_OK:<code>"`        → OTP received
   * - `"STATUS_CANCEL"`           → activation cancelled
   */
  async getStatus(activationId: string): Promise<ActivationStatus> {
    const raw = (await get({
      action: "getStatus",
      id:     activationId,
    })).trim();

    if (
      raw === "STATUS_WAIT_CODE" ||
      raw === "STATUS_WAIT_RETRY" ||
      raw === "STATUS_WAIT_RESEND"
    ) {
      return { kind: "WAIT_CODE" };
    }

    if (raw === "STATUS_CANCEL") {
      return { kind: "CANCEL" };
    }

    const okMatch = raw.match(/^STATUS_OK:(.+)$/);
    if (okMatch?.[1]) {
      return { kind: "OK", code: okMatch[1].trim() };
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
   * - `"6"` — complete activation
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
    return raw.trim();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Singleton export
//  Import this instance in your plugin — avoids creating a new object per
//  handler invocation while keeping the constructor testable.
// ─────────────────────────────────────────────────────────────────────────────

/** Ready-to-use singleton. Import this instead of `new SMSBowerService()`. */
export const smsBower = new SMSBowerService();
