import type { GopayMerchant } from "./gopay-merchant.js";
import type { PaymentTransaction, TransactionQuery } from "./types.js";

const DEFAULT_INTERVAL_MS = 5_000;
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

export interface QrisWatchWindow {
  endTime: Date;
  startTime: Date;
}

export interface QrisTopupMatch {
  amount: number;
  transaction: PaymentTransaction;
}

export interface QrisWatcherOptions {
  gopayService: GopayMerchant;
  intervalMs?: number;
  logger?: Pick<Console, "error" | "info">;
  notifyMatch?: (match: QrisTopupMatch) => Promise<void>;
  now?: () => number;
  getWatchWindow?: () => Promise<QrisWatchWindow | null>;
  matchTransactions?: (transactions: readonly PaymentTransaction[]) => Promise<QrisTopupMatch[]>;
}

export interface QrisWatcherCheckResult {
  matchedCount?: number;
  skipped: boolean;
  skippedReason?: "already_checking" | "backoff" | "no_pending_topups";
}

export class QrisWatcher {
  private backoffMs = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private isChecking = false;
  private nextAllowedCheckAt = 0;
  private readonly intervalMs: number;
  private readonly logger: Pick<Console, "error" | "info">;
  private readonly now: () => number;

  public constructor(private readonly options: QrisWatcherOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.interval) return;

    this.interval = setInterval(() => {
      void this.checkOnce();
    }, this.intervalMs);
    this.interval.unref?.();
  }

  public stop(): void {
    if (!this.interval) return;

    clearInterval(this.interval);
    this.interval = null;
  }

  public async checkOnce(): Promise<QrisWatcherCheckResult> {
    if (this.isChecking) {
      return { skipped: true, skippedReason: "already_checking" };
    }

    if (this.nextAllowedCheckAt > this.now()) {
      return { skipped: true, skippedReason: "backoff" };
    }

    this.isChecking = true;
    try {
      const window = await this.options.getWatchWindow?.();
      if (!window) {
        return { skipped: true, skippedReason: "no_pending_topups" };
      }

      this.logger.info("[QRIS WATCHER] Checking GoPay QRIS transactions...");
      const transactions = await this.options.gopayService.getQrisSettlements({
        endTime: window.endTime,
        startTime: window.startTime,
      });

      this.logger.info(`[QRIS WATCHER] Found ${transactions.length} settlement transactions`);
      const matches = (await this.options.matchTransactions?.(transactions)) ?? [];

      for (const match of matches) {
        this.logger.info(
          `[QRIS WATCHER] Matched topup transaction ${match.transaction.transactionId} amount ${match.amount}`
        );
        await this.options.notifyMatch?.(match);
      }

      this.resetBackoff();
      return {
        matchedCount: matches.length,
        skipped: false,
      };
    } catch (error) {
      this.applyBackoff();
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.error(`[QRIS WATCHER] Check failed: ${message}`);
      return { skipped: true, skippedReason: "backoff" };
    } finally {
      this.isChecking = false;
    }
  }

  private applyBackoff(): void {
    this.backoffMs = this.backoffMs === 0 ? INITIAL_BACKOFF_MS : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.nextAllowedCheckAt = this.now() + this.backoffMs;
  }

  private resetBackoff(): void {
    this.backoffMs = 0;
    this.nextAllowedCheckAt = 0;
  }
}
