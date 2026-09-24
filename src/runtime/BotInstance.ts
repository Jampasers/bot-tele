import type { Bot, Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { runWithTenant, type TenantContext } from "../tenant/context.js";
import { clearTenantMemory } from "../tenant/TenantMap.js";
import { stopTenantTimers } from "./tenantTimers.js";
import { emailRentalWorker } from "../email/runtime/mailboxConnectionManager.js";
import { ActivityLogService } from "../services/activityLog.js";

export class BotInstance {
  private runner: RunnerHandle | undefined;
  constructor(readonly bot: Bot<Context>, readonly context: TenantContext,
    private readonly startRunner: (bot: Bot<Context>) => RunnerHandle = bot => run(bot, { runner: { silent: true } })) {}

  get running(): boolean { return this.runner?.isRunning() ?? false; }

  start(): void {
    if (this.runner) return;
    ActivityLogService.setTenantApi(this.bot.api, this.context.tenantId);
    void runWithTenant(this.context, () => emailRentalWorker.start(this.bot.api)).catch(() => {
      console.warn(`[Tenant:${this.context.tenantId}] Email Rental worker did not start; bot remains available.`);
    });
    this.runner = runWithTenant(this.context, () => this.startRunner(this.bot));
    void this.runner.task()?.catch(() => {
      console.error(`[Rental:${this.context.rentalId ?? "platform"}] [Tenant:${this.context.tenantId}] Polling stopped; scheduler will retry.`);
    });
  }

  async stop(): Promise<void> {
    try {
      await runWithTenant(this.context, () => emailRentalWorker.stop());
      await this.runner?.stop();
    }
    finally {
      this.runner = undefined;
      await stopTenantTimers(this.context.tenantId);
      ActivityLogService.clearTenantApi(this.context.tenantId);
      clearTenantMemory(this.context.tenantId);
    }
  }
}
