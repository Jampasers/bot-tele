import type { Context, MiddlewareFn } from "grammy";
import { getTenantContext, PLATFORM_TENANT_ID } from "../../tenant/context.js";

interface PendingInput {
  expiresAt: number;
  secret: boolean;
  receive(ctx: Context, value: string): Promise<void>;
  cancel?(): void;
}
const inputs = new Map<string, PendingInput>();
const keyFor = (actor: string): string => `${getTenantContext().tenantId}:${actor}`;

/** Only callbacks and nonsecret wizard metadata belong in this registry. */
export function setVpsInput(actor: string, input: Omit<PendingInput, "expiresAt">): void {
  const now = Date.now();
  for (const [key, existing] of inputs) {
    if (existing.expiresAt <= now) { existing.cancel?.(); inputs.delete(key); }
  }
  inputs.set(keyFor(actor), { ...input, expiresAt: now + 10 * 60_000 });
}
export function clearVpsInput(actor: string): void {
  const key = keyFor(actor);
  inputs.get(key)?.cancel?.();
  inputs.delete(key);
}
export function clearAllVpsInputs(): void {
  for (const input of inputs.values()) input.cancel?.();
  inputs.clear();
}

/** Runs before generic admin text handlers: a token cannot become a broadcast or config value. */
export const vpsInputMiddleware: MiddlewareFn<Context> = async (ctx, next) => {
  if (!ctx.from || !ctx.message || !("text" in ctx.message)) return next();
  const tenant = getTenantContext();
  if (tenant.tenantId !== PLATFORM_TENANT_ID || tenant.rentalId) return next();
  const actor = String(ctx.from.id);
  const key = keyFor(actor);
  const pending = inputs.get(key);
  if (!pending) return next();
  const value = ctx.message.text;
  if (value.startsWith("/")) {
    clearVpsInput(actor);
    if (/^\/(batal|cancel)(?:@\w+)?(?:\s|$)/.test(value)) {
      await ctx.reply("Input VPS dibatalkan. Buka /vps atau /vpsadmin untuk melanjutkan.");
      return;
    }
    return next();
  }
  inputs.delete(key); // Duplicate updates cannot consume this input twice.
  if (ctx.chat?.type !== "private") {
    pending.cancel?.();
    await ctx.reply("Input VPS hanya diterima melalui chat pribadi.").catch(() => {});
    return;
  }
  if (pending.secret) {
    try { await ctx.deleteMessage(); }
    catch {
      pending.cancel?.();
      await ctx.reply("Pesan token gagal dihapus; token tidak diproses. Hapus pesan tersebut dan mulai kembali dari menu VPS.").catch(() => {});
      return;
    }
  }
  if (pending.expiresAt <= Date.now()) {
    pending.cancel?.();
    await ctx.reply("Waktu input VPS habis. Mulai kembali dari /vps atau /vpsadmin.");
    return;
  }
  try { await pending.receive(ctx, value); }
  catch {
    pending.cancel?.();
    // Never interpolate the input or thrown provider/request objects.
    await ctx.reply("Input belum dapat diproses. Periksa pilihan dan ulangi melalui /vps atau /vpsadmin.").catch(() => {});
  }
};
