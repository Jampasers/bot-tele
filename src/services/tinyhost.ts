import { randomBytes } from "node:crypto";

export interface TinyhostEmail {
  id: string | number;
  subject?: string;
  sender?: string;
  date?: string;
  body?: string;
  html_body?: string;
  has_attachments?: boolean;
}

export interface TinyhostInbox {
  emails: TinyhostEmail[];
  total?: number;
  page?: number;
  limit?: number;
  has_more?: boolean;
}

export interface TinyhostSignals {
  otps: string[];
  links: string[];
  text: string;
}

export interface TinyhostWatchResult {
  delivered: number;
  reason: "aborted" | "timeout";
}

export interface TinyhostWatchOptions {
  client: TinyhostClient;
  domain: string;
  user: string;
  initialIds?: Iterable<string | number>;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEmail(email: TinyhostEmail): void | Promise<void>;
  onPollError?(error: unknown, consecutiveErrors: number): void | Promise<void>;
}

export class TinyhostApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload?: unknown
  ) {
    super(message);
    this.name = "TinyhostApiError";
  }
}

export class TinyhostClient {
  private readonly baseUrl: string;
  private readonly domainToken: string | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: {
    baseUrl?: string;
    domainToken?: string;
    requestTimeoutMs?: number;
  } = {}) {
    this.baseUrl = (options.baseUrl ?? "https://tinyhost.shop").replace(/\/+$/u, "");
    this.domainToken = options.domainToken?.trim() || undefined;
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 10_000);
  }

  async getDomains(limit = 20): Promise<string[]> {
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit)));

    if (this.domainToken) {
      try {
        const payload = await this.requestJson<unknown>("/api/all-domains/", {
          headers: { "X-Domain-Token": this.domainToken }
        });
        const domains = normalizeDomains(payload);
        if (domains.length > 0) return domains.slice(0, safeLimit);
      } catch (error) {
        console.warn(
          `[TINYHOST] all-domains failed, falling back to random-domains: ${formatError(error)}`
        );
      }
    }

    const payload = await this.requestJson<unknown>(
      `/api/random-domains/?limit=${safeLimit}`
    );
    return normalizeDomains(payload).slice(0, safeLimit);
  }

  async getEmails(
    domain: string,
    user: string,
    page = 1,
    limit = 100
  ): Promise<TinyhostInbox> {
    const safePage = Math.max(1, Math.trunc(page));
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const payload = await this.requestJson<unknown>(
      `/api/email/${encodeURIComponent(domain)}/${encodeURIComponent(user)}/?page=${safePage}&limit=${safeLimit}`,
      { allowNotFound: true }
    );

    if (payload === null) return { emails: [] };
    if (!isRecord(payload)) return { emails: [] };

    const emails = Array.isArray(payload["emails"])
      ? payload["emails"].flatMap(normalizeEmail)
      : [];

    return {
      emails,
      total: readFiniteNumber(payload["total"]),
      page: readFiniteNumber(payload["page"]),
      limit: readFiniteNumber(payload["limit"]),
      has_more:
        typeof payload["has_more"] === "boolean" ? payload["has_more"] : undefined
    };
  }

  async getEmailDetail(
    domain: string,
    user: string,
    emailId: string | number
  ): Promise<TinyhostEmail> {
    const payload = await this.requestJson<unknown>(
      `/api/email/${encodeURIComponent(domain)}/${encodeURIComponent(user)}/${encodeURIComponent(String(emailId))}`
    );
    const [email] = normalizeEmail(payload);
    if (!email) {
      throw new Error("Tinyhost returned an invalid email detail payload");
    }
    return email;
  }

  async checkMx(domain: string): Promise<boolean> {
    const payload = await this.requestJson<unknown>(
      `/api/check-mx/${encodeURIComponent(domain)}`
    );
    return isRecord(payload) && payload["result"] === "online";
  }

  private async requestJson<T>(
    path: string,
    options: {
      headers?: Record<string, string>;
      allowNotFound?: boolean;
    } = {}
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: "application/json",
          ...options.headers
        },
        signal: controller.signal
      });

      if (options.allowNotFound && response.status === 404) {
        return null;
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new TinyhostApiError(
          `Tinyhost request failed with HTTP ${response.status}`,
          response.status,
          payload
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Tinyhost request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createTinyhostClientFromEnv(): TinyhostClient {
  return new TinyhostClient({
    baseUrl: process.env["TINYHOST_BASE_URL"] || undefined,
    domainToken: process.env["TINYHOST_DOMAIN_TOKEN"] || undefined,
    requestTimeoutMs: parseBoundedInteger(
      process.env["TINYHOST_REQUEST_TIMEOUT_MS"],
      10_000,
      1_000,
      30_000
    )
  });
}

export function getTinyhostPollingConfig(): {
  intervalMs: number;
  timeoutMs: number;
} {
  return {
    intervalMs: parseBoundedInteger(
      process.env["TINYHOST_POLL_INTERVAL_MS"],
      5_000,
      3_000,
      60_000
    ),
    timeoutMs: parseBoundedInteger(
      process.env["TINYHOST_WAIT_TIMEOUT_MS"],
      600_000,
      30_000,
      900_000
    )
  };
}

export function generateTinyhostUsername(): string {
  return `u${randomBytes(8).toString("hex")}`;
}

export function extractTinyhostSignals(email: TinyhostEmail): TinyhostSignals {
  const subject = email.subject ?? "";
  const body = email.body ?? "";
  const html = email.html_body ?? "";
  const text = normalizeWhitespace(
    [subject, body, htmlToText(html)].filter(Boolean).join("\n")
  );
  const otps = new Set<string>();

  const contextPatterns = [
    /\b(?:otp|one[- ]time(?: password| code)?|verification code|security code|login code|authentication code|auth code|kode(?: verifikasi)?|kode otp|pin|passcode)\b[^0-9]{0,48}\b(\d{4,8})\b/giu,
    /\b(\d{4,8})\b[^\n]{0,48}\b(?:otp|one[- ]time(?: password| code)?|verification code|security code|login code|authentication code|auth code|kode(?: verifikasi)?|kode otp|pin|passcode)\b/giu
  ];

  for (const pattern of contextPatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value) otps.add(value);
    }
  }

  if (
    otps.size === 0 &&
    /\b(?:otp|verify|verification|security code|login code|confirm|kode verifikasi)\b/iu.test(
      text
    )
  ) {
    for (const match of text.matchAll(/\b(\d{4,8})\b/gu)) {
      const value = match[1];
      if (!value) continue;
      const numeric = Number(value);
      if (value.length === 4 && numeric >= 1900 && numeric <= 2100) continue;
      otps.add(value);
      if (otps.size >= 5) break;
    }
  }

  const links = new Set<string>();
  const raw = [body, html].filter(Boolean).join("\n");
  for (const match of raw.matchAll(/https?:\/\/[^\s<>"']+/giu)) {
    const link = cleanUrl(decodeBasicEntities(match[0]));
    if (link) links.add(link);
    if (links.size >= 10) break;
  }

  return {
    otps: [...otps],
    links: [...links],
    text
  };
}

export async function watchTinyhostInbox(
  options: TinyhostWatchOptions
): Promise<TinyhostWatchResult> {
  const intervalMs = Math.max(3_000, options.intervalMs ?? 5_000);
  const timeoutMs = Math.max(30_000, options.timeoutMs ?? 600_000);
  const seen = new Set(
    [...(options.initialIds ?? [])].map((id) => String(id))
  );
  const deadline = Date.now() + timeoutMs;
  let delivered = 0;
  let consecutiveErrors = 0;

  while (!options.signal?.aborted && Date.now() < deadline) {
    const delayMs =
      consecutiveErrors === 0
        ? intervalMs
        : Math.min(30_000, intervalMs * 2 ** Math.min(consecutiveErrors, 3));
    const shouldContinue = await wait(delayMs, options.signal);
    if (!shouldContinue) {
      return { delivered, reason: "aborted" };
    }

    try {
      const inbox = await options.client.getEmails(options.domain, options.user);
      consecutiveErrors = 0;
      const fresh = inbox.emails
        .filter((email) => !seen.has(String(email.id)))
        .reverse();

      for (const summary of fresh) {
        if (options.signal?.aborted) {
          return { delivered, reason: "aborted" };
        }

        const detail = await options.client.getEmailDetail(
          options.domain,
          options.user,
          summary.id
        );
        seen.add(String(summary.id));
        delivered += 1;
        await options.onEmail(detail);
      }
    } catch (error) {
      consecutiveErrors += 1;
      await options.onPollError?.(error, consecutiveErrors);
    }
  }

  return {
    delivered,
    reason: options.signal?.aborted ? "aborted" : "timeout"
  };
}

export function formatTinyhostError(error: unknown): string {
  return formatError(error);
}

function normalizeDomains(payload: unknown): string[] {
  let candidates: unknown[] = [];

  if (Array.isArray(payload)) {
    candidates = payload;
  } else if (isRecord(payload) && Array.isArray(payload["domains"])) {
    candidates = payload["domains"];
  } else if (isRecord(payload) && Array.isArray(payload["data"])) {
    candidates = payload["data"];
  }

  const domains = candidates.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    if (!isRecord(candidate)) return [];

    for (const key of ["domain", "name", "host"]) {
      const value = candidate[key];
      if (typeof value === "string") return [value];
    }
    return [];
  });

  return [...new Set(
    domains
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(domain))
  )];
}

function normalizeEmail(value: unknown): TinyhostEmail[] {
  if (!isRecord(value)) return [];
  const id = value["id"];
  if (typeof id !== "string" && typeof id !== "number") return [];

  return [{
    id,
    subject: readString(value["subject"]),
    sender: readString(value["sender"]),
    date: readString(value["date"]),
    body: readString(value["body"]),
    html_body: readString(value["html_body"]),
    has_attachments:
      typeof value["has_attachments"] === "boolean"
        ? value["has_attachments"]
        : undefined
  }];
}

function htmlToText(html: string): string {
  return decodeBasicEntities(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/p\s*>/giu, "\n")
      .replace(/<[^>]+>/gu, " ")
  );
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/gu, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function cleanUrl(value: string): string {
  return value.replace(/[),.;\]}]+$/gu, "").trim();
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatError(error: unknown): string {
  if (error instanceof TinyhostApiError) {
    return `HTTP ${error.status}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
