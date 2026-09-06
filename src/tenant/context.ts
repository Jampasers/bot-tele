import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  readonly tenantId: string;
  readonly rentalId?: string;
  readonly ownerTelegramId?: string;
  readonly adminTelegramIds?: string[];
  plan?: string;
  status?: "pending" | "active" | "expired_grace" | "suspended" | "terminated";
  expiresAt?: Date | null;
  graceEndsAt?: Date | null;
  enabledFeatures?: string[];
}

export const PLATFORM_TENANT_ID = "platform";
const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function platformContext(): TenantContext {
  return { tenantId: PLATFORM_TENANT_ID };
}

/** Establish context at a trusted bot, worker or service entry point only. */
export function runWithTenant<T>(context: TenantContext, fn: () => PromiseLike<T>): Promise<T>;
export function runWithTenant<T>(context: TenantContext, fn: () => T): T;
export function runWithTenant(context: TenantContext, fn: () => unknown): unknown {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(context.tenantId)) {
    throw new Error("Invalid tenant identity");
  }
  // Identity cannot change while async work is in flight. Lifecycle fields remain mutable.
  for (const key of ["tenantId", "rentalId", "ownerTelegramId", "adminTelegramIds"] as const) {
    if (Object.hasOwn(context, key)) {
      Object.defineProperty(context, key, { writable: false, configurable: false });
    }
  }
  if (context.adminTelegramIds) Object.freeze(context.adminTelegramIds);
  return tenantStorage.run(context, () => {
    const result = fn();
    // Mongoose queries are lazy thenables: assimilate while the context is active,
    // otherwise `await runWithTenant(ctx, () => Model.find())` executes outside ALS.
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && "then" in result && typeof result.then === "function") {
      return Promise.resolve(result);
    }
    return result;
  });
}

export function getTenantContext(): TenantContext {
  const context = tenantStorage.getStore();
  if (!context) throw new Error("Tenant context is required for tenant data access");
  return context;
}

export function getTenantId(): string {
  return getTenantContext().tenantId;
}

/** Environment configuration belongs exclusively to the owner/platform tenant. */
export function tenantEnvironment(): NodeJS.ProcessEnv {
  return getTenantId() === PLATFORM_TENANT_ID ? process.env : {};
}
