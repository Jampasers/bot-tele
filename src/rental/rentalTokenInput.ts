import type { Context } from "grammy";

export interface RentalTokenInputState {
  planId: string;
  expiresAt: number;
}

const tokenInputs = new Map<string, RentalTokenInputState>();
const deletedTokenContexts = new WeakSet<Context>();

export function getRentalTokenInput(ownerTelegramId: string): RentalTokenInputState | undefined {
  return tokenInputs.get(ownerTelegramId);
}

export function setRentalTokenInput(ownerTelegramId: string, state: RentalTokenInputState): void {
  tokenInputs.set(ownerTelegramId, state);
}

export function clearRentalTokenInput(ownerTelegramId: string): void {
  tokenInputs.delete(ownerTelegramId);
}

export function cleanupRentalTokenInputs(now: number): void {
  if (tokenInputs.size <= 1_000) return;
  for (const [owner, state] of tokenInputs) {
    if (state.expiresAt <= now) tokenInputs.delete(owner);
  }
}

export function markRentalTokenMessageDeleted(ctx: Context): void {
  deletedTokenContexts.add(ctx);
}

export function wasRentalTokenMessageDeleted(ctx: Context): boolean {
  return deletedTokenContexts.has(ctx);
}
