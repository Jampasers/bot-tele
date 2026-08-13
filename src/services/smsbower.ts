// ============================================================================
//  SMSBower API Wrapper
//  Base URL: https://smsbower.page/stubs/handler_api.php
//  Auth:     SMSBOWER_API_KEY environment variable
//
//  All methods throw on network failure or an unexpected API response so
//  callers can catch and surface errors to the user cleanly.
// ============================================================================

const BASE_URL = "https://smsbower.page/stubs/handler_api.php";

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

  // ── Priority lists — controls "Best Seller" ordering ───────────────────────

  /**
   * Country IDs that appear first in the keyboard, in the exact order listed.
   * All other countries follow alphabetically.
   * Matches the `id` field of `CachedCountry`.
   */
  static readonly PRIORITY_COUNTRIES: readonly string[] = [
    "6",   // Indonesia
    "0",   // Russia
    "73",  // Brazil
    "12",  // USA
  ];

  /**
   * Service codes that appear first in the keyboard, in the exact order listed.
   * All other services follow alphabetically.
   * Matches the `code` field of `CachedService`.
   */
  static readonly PRIORITY_SERVICES: readonly string[] = [
    "wa",  // WhatsApp
    "tg",  // Telegram
    "ni",  // Gojek
    "fr",  // DANA
    "ig",  // Instagram
    "lf",  // TikTok
    "dr",  // OpenAI
  ];

  // ── loadData — fetches countries + services and fills the caches ─────────────

  // ── prioritySort — reusable sort comparator factory ──────────────────────────

  /**
   * Returns a comparator for `Array.prototype.sort()` that places items from
   * `priorityList` first (in the exact order they appear in the list) and
   * sorts all remaining items alphabetically by `nameOf(item)`.
   *
   * @param priorityList - Ordered list of keys that should appear first.
   * @param keyOf        - Extracts the key to look up in `priorityList`.
   * @param nameOf       - Extracts the display name used for A–Z fallback sort.
   *
   * @example
   * items.sort(SMSBowerService.prioritySort(
   *   ["wa", "tg"],
   *   (s) => s.code,
   *   (s) => s.name
   * ));
   * // Result: WhatsApp, Telegram, then every other service A–Z.
   */
  private static prioritySort<T>(
    priorityList: readonly string[],
    keyOf:        (item: T) => string,
    nameOf:       (item: T) => string
  ): (a: T, b: T) => number {
    return (a: T, b: T): number => {
      const idxA = priorityList.indexOf(keyOf(a));
      const idxB = priorityList.indexOf(keyOf(b));

      const isPriorityA = idxA !== -1;
      const isPriorityB = idxB !== -1;

      // Both are priority items — maintain the order defined in priorityList.
      if (isPriorityA && isPriorityB) return idxA - idxB;

      // Only A is a priority item — A comes first.
      if (isPriorityA) return -1;

      // Only B is a priority item — B comes first.
      if (isPriorityB) return 1;

      // Neither is a priority item — sort A–Z by display name.
      return nameOf(a).localeCompare(nameOf(b));
    };
  }


  /**
   * Normalises the raw JSON value returned by `getServicesList` into a flat
   * `CachedService[]`, regardless of which API response shape was received.
   *
   * Handles all known shapes:
   * - Shape A: `{ status:"success", data: { services: { "wa":"WhatsApp" } } }`
   * - Shape B: `{ status:"success", data: { services: [{code,name},...] } }`
   * - Shape C: `{ status:"success", data: [{code,name},...] }`
   * - Shape D: `[{code,name},...]`            (bare array of objects)
   * - Shape E: `{ "wa":"WhatsApp", ... }`     (bare code→name object)
   *
   * Returns `[]` (empty array) if none of the shapes match so the caller can
   * detect and warn rather than crashing.
   */
  private static parseServicesPayload(payload: unknown): CachedService[] {
    // ── Helpers ───────────────────────────────────────────────────────────────

    /** True when value looks like {code:string, name:string} */
    const isServiceObj = (v: unknown): v is CachedService =>
      typeof v === "object" && v !== null &&
      typeof (v as Record<string, unknown>)["code"] === "string" &&
      typeof (v as Record<string, unknown>)["name"] === "string";

    /** Converts a plain object whose values are strings (code→name) into an array. */
    const fromCodeNameMap = (obj: Record<string, unknown>): CachedService[] =>
      Object.entries(obj)
        .filter(([, v]) => typeof v === "string")
        .map(([code, name]) => ({ code, name: name as string }));

    // ── Shape D: bare array ────────────────────────────────────────────────────
    if (Array.isArray(payload)) {
      if (payload.every(isServiceObj)) return payload as CachedService[];
      // Array of unknown objects — try extracting code/name properties.
      return (payload as unknown[])
        .filter(isServiceObj)
        .map((v) => ({ code: v.code, name: v.name }));
    }

    if (typeof payload !== "object" || payload === null) return [];
    const root = payload as Record<string, unknown>;

    // ── Shape E: bare code→name object (no "status" key) ─────────────────────
    if (!("status" in root) && !("data" in root)) {
      return fromCodeNameMap(root);
    }

    // Shapes A / B / C all have a "data" key.
    const data = root["data"];

    // ── Shape C: data is an array ─────────────────────────────────────────────
    if (Array.isArray(data)) {
      return data.filter(isServiceObj).map((v) => ({ code: v.code, name: v.name }));
    }

    if (typeof data !== "object" || data === null) {
      console.error("parseServicesPayload: unrecognised payload shape:", JSON.stringify(payload).substring(0, 200));
      return [];
    }

    const dataObj  = data as Record<string, unknown>;
    const services = dataObj["services"];

    // ── Shape B: data.services is an array ────────────────────────────────────
    if (Array.isArray(services)) {
      return services.filter(isServiceObj).map((v) => ({ code: v.code, name: v.name }));
    }

    // ── Shape A: data.services is a code→name object ──────────────────────────
    if (typeof services === "object" && services !== null) {
      return fromCodeNameMap(services as Record<string, unknown>);
    }

    // data itself might be a code→name object (no nested "services" key)
    if (Object.values(dataObj).every((v) => typeof v === "string")) {
      return fromCodeNameMap(dataObj);
    }

    console.error("parseServicesPayload: unrecognised payload shape:", JSON.stringify(payload).substring(0, 200));
    return [];
  }

  /**
   * Fetches the full country and service lists from the SMSBower API and
   * stores them in the static cache properties.
   *
   * Call this **once** at bot startup (before `bot.start()`) so the keyboard
   * builders always have live data without making a network call per user.
   *
   * @example
   * await SMSBowerService.loadData();
   * await bot.start();
   */
  static async loadData(): Promise<void> {
    console.log("📡  SMSBower: fetching services & countries…");

    // ── Services ──────────────────────────────────────────────────────────────
    // SMSBower's getServicesList endpoint is inconsistent across API versions.
    // We handle every known shape so a surprise format change never silently
    // produces an empty list.
    //
    // Known shapes:
    //   A) { status:"success", data: { services: { "wa":"WhatsApp", ... } } }
    //   B) { status:"success", data: { services: [ {code,name}, ... ] } }
    //   C) { status:"success", data: [ {code,name}, ... ] }
    //   D) [ {code,name}, ... ]                    (bare array)
    //   E) { "wa": "WhatsApp", ... }               (bare object, code→name)
    try {
      const apiKey = process.env["SMSBOWER_API_KEY"];
      if (!apiKey) throw new Error("SMSBOWER_API_KEY is not set.");

      const svcUrl = `${BASE_URL}?` + new URLSearchParams({
        api_key: apiKey,
        action:  "getServicesList",
      }).toString();

      const svcRes  = await fetch(svcUrl);
      // Read as text first so we can log the raw response for debugging.
      const svcText = await svcRes.text();
      console.log(`   📄  Raw services response (first 200 chars): ${svcText.substring(0, 200)}`);

      const svcJson = JSON.parse(svcText) as unknown;

      // Normalise everything into CachedService[] regardless of shape.
      const raw: CachedService[] = SMSBowerService.parseServicesPayload(svcJson);

      if (raw.length === 0) {
        console.warn("   ⚠️  Services parsed but list is empty. Check the raw log above.");
      } else {
        raw.sort(SMSBowerService.prioritySort(
          SMSBowerService.PRIORITY_SERVICES,
          (s) => s.code,
          (s) => s.name
        ));
        SMSBowerService.cachedServices = raw;
      }

      console.log(`   ✅  Services loaded: ${SMSBowerService.cachedServices.length}`);
    } catch (err) {
      console.error("   ⚠️  Failed to load services:", err);
      // Leave cachedServices as [] — plugin will show a guard message.
    }

    // ── Countries ─────────────────────────────────────────────────────────────
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

      // Priority countries first (in defined order), rest A–Z by name.
      mapped.sort(SMSBowerService.prioritySort(
        SMSBowerService.PRIORITY_COUNTRIES,
        (c) => c.id,
        (c) => c.name
      ));
      SMSBowerService.cachedCountries = mapped;

      console.log(`   ✅  Countries loaded: ${SMSBowerService.cachedCountries.length}`);
    } catch (err) {
      console.error("   ⚠️  Failed to load countries:", err);
    }
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
