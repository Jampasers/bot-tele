import { getAdminIds } from "../core/admin.js";
import { getTenantContext, PLATFORM_TENANT_ID } from "../tenant/context.js";

export function assertVpsPlatform(): void {
  const context = getTenantContext();
  if (context.tenantId !== PLATFORM_TENANT_ID || context.rentalId) throw new Error("VPS hanya tersedia di main bot.");
}
export function assertVpsAdmin(actor: string): void {
  assertVpsPlatform();
  if (!getAdminIds().includes(actor)) throw new Error("Akses admin ditolak.");
}
export function vpsEnabled(): boolean { assertVpsPlatform(); return process.env.VPS_ENABLED === "true"; }
export function assertVpsEnabled(): void { if (!vpsEnabled()) throw new Error("Layanan VPS sedang nonaktif."); }
export function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Konfigurasi ${name} tidak valid.`);
  return value;
}

/** Buyer credentials never leave this process; expiry is absolute, not extended on reads. */
export class BuyerTokenVault {
  readonly #entries = new Map<string, { token: string; accountId: string; expiresAt: number }>();
  constructor(private readonly ttlMs = 30 * 60_000, private readonly now = Date.now) {}
  private key(buyer: string, order: string): string { assertVpsPlatform(); return JSON.stringify([getTenantContext().tenantId, buyer, order]); }
  put(buyer: string, order: string, token: string, accountId: string): void {
    this.sweep();
    if (this.#entries.size >= 1000) throw new Error("Sesi token penuh; coba kembali nanti.");
    this.#entries.set(this.key(buyer, order), { token, accountId, expiresAt: this.now() + this.ttlMs });
  }
  get(buyer: string, order: string): { token: string; accountId: string } | undefined {
    this.sweep(); return this.#entries.get(this.key(buyer, order));
  }
  delete(buyer: string, order: string): void { this.#entries.delete(this.key(buyer, order)); }
  sweep(): void { for (const [key, entry] of this.#entries) if (entry.expiresAt <= this.now()) this.#entries.delete(key); }
  clear(): void { this.#entries.clear(); }
}
export const buyerTokens = new BuyerTokenVault();
