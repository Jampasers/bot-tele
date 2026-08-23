import { Context } from "grammy";

// ============================================================================
//  Admin Authorization Helper — Multi-Admin Support
// ============================================================================

/**
 * Returns an array of trimmed numeric/string admin IDs from process.env.ADMIN_ID.
 * Supports comma, space, semicolon, or newline separated values.
 * e.g. "123456789,987654321" or "123456789 987654321"
 */
export function getAdminIds(): string[] {
  const raw = process.env["ADMIN_ID"] ?? "";
  if (!raw.trim()) return [];

  return raw
    .split(/[,;\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * Checks if a given Telegram user ID (numeric or string) belongs to an authorized admin.
 */
export function isAdminId(id: string | number | undefined | null): boolean {
  if (id === undefined || id === null) return false;
  const adminIds = getAdminIds();
  if (adminIds.length === 0) return false;
  return adminIds.includes(String(id));
}

/**
 * Checks if the update context is initiated by an authorized admin.
 */
export function isAdmin(ctx: Context): boolean {
  return isAdminId(ctx.from?.id);
}
