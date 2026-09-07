import type { Bot, Context } from "grammy";
import { createBot } from "../core/bot.js";
import { BotRental } from "../models/BotRental.js";
import { decryptSecret } from "../services/crypto.js";
import { runWithTenant, type TenantContext } from "../tenant/context.js";
import { onRentalStateChange, refreshRentalState, setRentalRuntimeControls, type RentalRuntimeState } from "../rental/rental.service.js";
import { BotInstance } from "./BotInstance.js";

type RentalRecord = { botTokenEncrypted: string; botId: string };
const RUNNABLE_RENTAL_STATUSES = new Set<RentalRuntimeState["status"]>([
  "active",
  "expired_grace",
  "suspended",
]);

function canRunRentalBot(status: RentalRuntimeState["status"]): boolean {
  return RUNNABLE_RENTAL_STATUSES.has(status);
}

export interface BotManagerDependencies {
  loadRental(id: string): Promise<RentalRecord | null>;
  refreshState(id: string): Promise<RentalRuntimeState | null>;
  createBot(token: string, context: TenantContext): Promise<Bot<Context>>;
  createInstance(bot: Bot<Context>, context: TenantContext): BotInstance;
  decryptToken(encrypted: string, tenantId: string): string;
}

export class BotManager {
  private readonly instances = new Map<string, BotInstance>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private shuttingDown = false;
  private readonly unsubscribe: () => void;
  private readonly dependencies: BotManagerDependencies;

  constructor(private readonly platformBotId: string, dependencies: Partial<BotManagerDependencies> = {}) {
    this.dependencies = {
      loadRental: id => BotRental.findById(id).select("+botTokenEncrypted").lean().exec(),
      refreshState: refreshRentalState,
      createBot,
      createInstance: (bot, context) => new BotInstance(bot, context),
      decryptToken: (encrypted, tenantId) => decryptSecret(encrypted, `${tenantId}:botToken`),
      ...dependencies,
    };
    this.unsubscribe = onRentalStateChange(state => {
      const instance = this.instances.get(state.rentalId);
      if (!instance) return;
      if (!canRunRentalBot(state.status)) {
        void this.stopRentalBot(state.rentalId).catch(() => this.logFailure(state.rentalId));
        return;
      }
      // Identity is fixed for the lifetime of an update. Owner/admin changes
      // require a controlled restart; normal expiry/renewal is immediate.
      if (instance.context.ownerTelegramId !== state.ownerTelegramId ||
          JSON.stringify(instance.context.adminTelegramIds) !== JSON.stringify(state.adminTelegramIds)) {
        void this.restartRentalBot(state.rentalId).catch(() => this.logFailure(state.rentalId));
        return;
      }
      Object.assign(instance.context, { status: state.status, expiresAt: state.expiresAt,
        graceEndsAt: state.graceEndsAt, plan: state.plan, enabledFeatures: state.enabledFeatures });
    });
    setRentalRuntimeControls(this);
  }

  private logFailure(id: string): void { console.warn(`[Rental:${id}] Runtime operation failed; other bots continue.`); }

  private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.operations.get(id) ?? Promise.resolve();
    const operation = before.catch(() => {}).then(action);
    this.operations.set(id, operation);
    void operation.finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); }).catch(() => {});
    return operation;
  }

  getRentalBot(rentalId: string): Bot<Context> | undefined {
    const instance = this.instances.get(rentalId);
    return instance?.running ? instance.bot : undefined;
  }

  startRentalBot(rentalId: string): Promise<Bot<Context> | undefined> {
    return this.exclusive(rentalId, () => this.startInstance(rentalId));
  }

  private async startInstance(rentalId: string): Promise<Bot<Context> | undefined> {
    if (this.shuttingDown) return undefined;
    const current = this.instances.get(rentalId);
    const state = await this.dependencies.refreshState(rentalId);
    if (!state || !canRunRentalBot(state.status)) {
      if (current) { await current.stop(); this.instances.delete(rentalId); }
      return undefined;
    }
    if (current?.running) return current.bot;
    if (current) { await current.stop(); this.instances.delete(rentalId); }
    const record = await this.dependencies.loadRental(rentalId);
    if (!record || record.botId === this.platformBotId) throw new Error("Rental bot identity conflicts with the platform.");
    for (const instance of this.instances.values()) {
      if (String(instance.bot.botInfo.id) === record.botId) throw new Error("Bot token is already running.");
    }
    const context: TenantContext = { ...state, adminTelegramIds: [...state.adminTelegramIds], enabledFeatures: [...state.enabledFeatures] };
    const bot = await runWithTenant(context, () => this.dependencies.createBot(this.dependencies.decryptToken(record.botTokenEncrypted, state.tenantId), context));
    if (String(bot.botInfo.id) !== record.botId) throw new Error("Stored bot identity does not match its token.");
    if (this.shuttingDown) return undefined;
    const instance = this.dependencies.createInstance(bot, context);
    this.instances.set(rentalId, instance);
    instance.start();
    console.log(`[Rental:${rentalId}] [Tenant:${state.tenantId}] [@${state.botUsername}] Bot started (${state.status}).`);
    return bot;
  }

  private async stopInstance(rentalId: string): Promise<void> {
    const instance = this.instances.get(rentalId);
    if (!instance) return;
    await instance.stop();
    this.instances.delete(rentalId);
  }

  stopRentalBot(rentalId: string): Promise<void> { return this.exclusive(rentalId, () => this.stopInstance(rentalId)); }
  restartRentalBot(rentalId: string): Promise<Bot<Context> | undefined> {
    return this.exclusive(rentalId, async () => { await this.stopInstance(rentalId); return this.startInstance(rentalId); });
  }

  async startAllActiveRentals(): Promise<void> {
    const cursor = BotRental.find({ status: { $in: ["active", "expired_grace", "suspended"] } }).select("_id").lean().cursor();
    let batch: Promise<unknown>[] = [];
    for await (const rental of cursor) {
      const id = String(rental._id);
      batch.push(this.startRentalBot(id).catch(() => this.logFailure(id)));
      if (batch.length === 4) { await Promise.allSettled(batch); batch = []; }
    }
    await Promise.allSettled(batch);
  }

  async stopAll(): Promise<void> {
    this.requestStop();
    this.unsubscribe();
    await Promise.allSettled([...this.operations.values()]);
    const results = await Promise.allSettled([...this.instances.keys()].map(id => this.stopRentalBot(id)));
    if (results.some(result => result.status === "rejected")) throw new Error("A rental runner failed to stop.");
  }

  requestStop(): void { this.shuttingDown = true; }
}
