import { getTenantContext } from "../tenant/context.js";

/** Legacy plugins sometimes pass entire HTTP errors to console. Rental logs
 * retain the operation label, but never serialize provider errors or payloads. */
export function installRentalLogContext(): () => void {
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      let context;
      try { context = getTenantContext(); } catch { /* startup has no tenant */ }
      if (!context?.rentalId) { original[level](...args); return; }
      const label = typeof args[0] === "string" ? args[0]
        .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
        .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]") : "Runtime operation failed.";
      original[level](`[Rental:${context.rentalId}] [Tenant:${context.tenantId}] ${label}`);
    };
  }
  return () => { for (const level of ["log", "warn", "error"] as const) console[level] = original[level]; };
}
