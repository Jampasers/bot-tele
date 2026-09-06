import { getTenantContext, runWithTenant } from "../tenant/context.js";

interface TenantTimer {
  tenantId: string;
  pending: Promise<void> | undefined;
}
const timers = new Map<NodeJS.Timeout, TenantTimer>();

/** Track financial polling tasks so stopping a bot also drains its workers. */
export function setTenantInterval(callback: () => void | Promise<void>, delay: number): NodeJS.Timeout {
  const context = getTenantContext();
  const state: TenantTimer = { tenantId: context.tenantId, pending: undefined };
  const timer = setInterval(() => {
    if (state.pending) return;
    state.pending = runWithTenant(context, async () => {
      try { await callback(); }
      catch { console.warn(`[Tenant:${context.tenantId}] Background poll failed; next tick will retry.`); }
    }).finally(() => { state.pending = undefined; });
  }, delay);
  timers.set(timer, state);
  return timer;
}

export function clearTenantInterval(timer: NodeJS.Timeout | undefined): void {
  if (!timer) return;
  clearInterval(timer);
  const state = timers.get(timer);
  if (state?.pending) void state.pending.finally(() => timers.delete(timer));
  else timers.delete(timer);
}

export async function stopTenantTimers(tenantId: string): Promise<void> {
  // A currently completing financial poll may create a follow-up poll. Drain
  // again until no tracked work for this tenant remains.
  while ([...timers.values()].some(state => state.tenantId === tenantId)) {
  const pending: Promise<void>[] = [];
  for (const [timer, state] of timers) {
    if (state.tenantId !== tenantId) continue;
    clearInterval(timer);
    if (state.pending) pending.push(state.pending);
    timers.delete(timer);
  }
  await Promise.allSettled(pending);
  }
}
