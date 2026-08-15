import { GobizAuthService } from "./gobiz-auth.js";
import type { PaymentTransaction, TransactionQuery } from "./types.js";

const DEFAULT_ENDPOINT =
  "https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions";

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  refreshAccessToken?(): Promise<string>;
}

export interface GopayMerchantOptions {
  accessToken?: string;
  accessTokenProvider?: AccessTokenProvider;
  email?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  merchantId: string;
  pageSize?: number;
  password?: string;
  timeoutMs?: number;
}

export class GopayMerchant {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly tokenProvider?: AccessTokenProvider;

  public constructor(private readonly options: GopayMerchantOptions) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 20;
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (options.email && options.password) {
      this.tokenProvider = new GobizAuthService({
        email: options.email,
        fetchImpl: this.fetchImpl,
        password: options.password,
        timeoutMs: this.timeoutMs,
      });
    } else {
      this.tokenProvider = options.accessTokenProvider;
    }
  }

  public async getQrisSettlements(query: TransactionQuery): Promise<PaymentTransaction[]> {
    const result: PaymentTransaction[] = [];
    for (let from = 0; ; from += this.pageSize) {
      const page = await this.fetchPage(query, from);
      result.push(...page.transactions);
      if (
        page.transactions.length < this.pageSize ||
        (page.total !== null && from + page.transactions.length >= page.total)
      ) {
        return result;
      }
    }
  }

  public async fetchSettlementTransactions(query: TransactionQuery): Promise<PaymentTransaction[]> {
    return this.getQrisSettlements(query);
  }

  private async fetchPage(query: TransactionQuery, from: number): Promise<Page> {
    return this.fetchPageWithToken(query, from, await this.token(), false);
  }

  private async fetchPageWithToken(
    query: TransactionQuery,
    from: number,
    token: string,
    refreshed: boolean,
  ): Promise<Page> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url(query, from), {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        method: "GET",
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        if (!refreshed && this.tokenProvider?.refreshAccessToken) {
          return this.fetchPageWithToken(query, from, await this.token(true), true);
        }
        throw new Error("GoPay Merchant API unauthorized.");
      }
      if (response.status === 429) throw new Error("GoPay Merchant API rate limited.");
      if (!response.ok) throw new Error(`GoPay Merchant API request failed: ${response.status}.`);

      const body: unknown = await response.json();
      return {
        total: readTotal(body),
        transactions: records(body)
          .map(normalize)
          .filter((value): value is PaymentTransaction => value !== null),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("GoPay Merchant API request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private url(query: TransactionQuery, from: number): string {
    const params = new URLSearchParams({
      end_time: query.endTime.toISOString(),
      from: from.toString(),
      merchant_ids: this.options.merchantId,
      payment_types: "QRIS",
      size: this.pageSize.toString(),
      start_time: query.startTime.toISOString(),
      statuses: "SETTLEMENT",
    });
    return `${this.endpoint}?${params.toString()}`;
  }

  private async token(refresh = false): Promise<string> {
    const provider = this.tokenProvider;
    const value = refresh && provider?.refreshAccessToken
      ? await provider.refreshAccessToken()
      : provider ? await provider.getAccessToken() : this.options.accessToken;
    const token = value?.trim();
    if (!token) throw new Error("GoPay Merchant/GoBiz login belum dikonfigurasi (masukkan email & password Gojek atau accessTokenProvider).");
    return token;
  }
}

interface Page {
  total: number | null;
  transactions: PaymentTransaction[];
}

type RecordValue = Record<string, unknown>;

function records(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!isRecord(body)) return [];
  if (Array.isArray(body.data)) return body.data;
  if (isRecord(body.data) && Array.isArray(body.data.transactions)) return body.data.transactions;
  if (isRecord(body.data) && Array.isArray(body.data.items)) return body.data.items;
  if (Array.isArray(body.transactions)) return body.transactions;
  return Array.isArray(body.items) ? body.items : [];
}

function readTotal(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.total === "number" && Number.isInteger(body.total) && body.total >= 0 ? body.total : null;
}

function normalize(value: unknown): PaymentTransaction | null {
  if (!isRecord(value)) return null;
  const transactionId = stringValue(value, ["transaction_id", "transactionId", "id", "payment_id", "paymentId"]);
  const merchantId = stringValue(value, ["merchant_id", "merchantId"]);
  const paymentType = stringValue(value, ["payment_type", "paymentType"]);
  const status = stringValue(value, ["status", "transaction_status"]);
  const amount = minorAmount(value, ["gross_amount", "grossAmount", "real_gross_amount", "realGrossAmount"]) ??
    amountValue(value, ["amount", "total_amount", "totalAmount", "payment_amount", "paymentAmount"]);
  const paidAt = timestamp(value, ["paid_at", "paidAt", "settlement_time", "settlementTime", "transaction_time", "transactionTime", "created_at", "createdAt"]);
  return transactionId && merchantId && paymentType && status && amount !== null && paidAt !== null
    ? { amount, merchantId, paidAt, paymentType, status, transactionId }
    : null;
}

function stringValue(record: RecordValue, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  return null;
}

function amountValue(record: RecordValue, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const amount = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value.replace(/[^\d]/g, ""), 10) : NaN;
    if (Number.isInteger(amount) && amount > 0) return amount;
  }
  return null;
}

function minorAmount(record: RecordValue, keys: readonly string[]): number | null {
  const amount = amountValue(record, keys);
  return amount !== null && amount % 100 === 0 ? amount / 100 : null;
}

function timestamp(record: RecordValue, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
