import type { Bot, Context } from "grammy";
import { BotRental } from "../models/BotRental.js";
import { synchronizeRentalLifecycle } from "../rental/rental.service.js";
import { notifyRentalExpiry } from "../rental/rentalNotification.service.js";
import { pollPendingRentalPayments } from "../rental/rentalPayment.service.js";
import { platformContext, runWithTenant } from "../tenant/context.js";
import { ThrottledWarningLogger } from "./retryLogger.js";

export interface RentalSchedulerManager {
  getRentalBot(rentalId: string): Bot<Context> | undefined;
  startRentalBot(rentalId: string): Promise<unknown>;
  stopRentalBot?(rentalId: string): Promise<unknown>;
}

export interface RentalSchedulerDependencies {
  rentalIds(): AsyncIterable<string>;
  synchronize: typeof synchronizeRentalLifecycle;
  notify: typeof notifyRentalExpiry;
  pollPayments: typeof pollPendingRentalPayments;
}

async function* rentalIds(): AsyncIterable<string> {
  const cursor = BotRental.find().select("_id").lean().cursor();
  for await (const rental of cursor) yield String(rental._id);
}

export class RentalScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly warnings = new ThrottledWarningLogger();
  private readonly dependencies: RentalSchedulerDependencies;
  constructor(private readonly manager: RentalSchedulerManager, private readonly intervalMs = 60_000, dependencies: Partial<RentalSchedulerDependencies> = {}) {
    this.dependencies = { rentalIds, synchronize: synchronizeRentalLifecycle, notify: notifyRentalExpiry, pollPayments: pollPendingRentalPayments, ...dependencies };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = runWithTenant(platformContext(), async () => {
      try { await this.dependencies.pollPayments(); }
      catch (error) { this.warnings.warn("payments", "[RentalScheduler] Payment reconciliation failed; retry on next tick", error); }
      for await (const rentalId of this.dependencies.rentalIds()) {
        try {
          const state = await this.dependencies.synchronize(rentalId);
          if (!state || state.status === "pending" || state.status === "terminated") {
            await this.manager.stopRentalBot?.(rentalId);
            continue;
          }
          let bot = this.manager.getRentalBot(rentalId);
          if (!bot) { await this.manager.startRentalBot(rentalId); bot = this.manager.getRentalBot(rentalId); }
          if (bot) await this.dependencies.notify(bot, state);
        } catch (error) { this.warnings.warn(`rental:${rentalId}`, `[Rental:${rentalId}] Scheduled reconciliation failed; other rentals continue`, error); }
      }
    }).catch(error => { this.warnings.warn("scheduler", "[RentalScheduler] Reconciliation failed; retry on next tick", error); }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
