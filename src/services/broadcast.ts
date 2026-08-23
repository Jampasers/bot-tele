import { Api } from "grammy";
import { User } from "../models/User.js";

// ============================================================================
//  Smart Segmented Broadcast Service
// ============================================================================

export type BroadcastFilter =
  | "ALL"           // All registered users
  | "WITH_BALANCE"  // Users with balance > 0
  | "ACTIVE_BUYERS" // Users with totalOrders > 0
  | "NEW_BUYERS";   // Users who have never bought (totalOrders === 0)

export interface BroadcastProgress {
  sent: number;
  failed: number;
  blocked: number;
  total: number;
}

export type BroadcastProgressCallback = (progress: BroadcastProgress) => void | Promise<void>;

const SLEEP_MS = 35; // ~28 msg/sec, safely under Telegram's 30/sec limit

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a MongoDB query filter based on the broadcast segment type.
 */
function buildUserQuery(filter: BroadcastFilter): Record<string, unknown> {
  switch (filter) {
    case "WITH_BALANCE":   return { balance: { $gt: 0 } };
    case "ACTIVE_BUYERS":  return { totalOrders: { $gt: 0 } };
    case "NEW_BUYERS":     return { totalOrders: 0 };
    case "ALL":
    default:               return {};
  }
}

/**
 * Sends a text broadcast to a segmented list of users.
 *
 * - Sends messages with a ~35ms delay between each to respect Telegram rate limits.
 * - Tracks sent, failed, and blocked counts.
 * - Calls `onProgress` every 10 messages so the admin can see live progress.
 *
 * @param api          - grammY API instance
 * @param text         - HTML-formatted message text to broadcast
 * @param filter       - Segment to target
 * @param onProgress   - Optional callback for live progress updates
 * @returns Final progress summary
 */
export async function broadcastMessage(
  api: Api,
  text: string,
  filter: BroadcastFilter,
  onProgress?: BroadcastProgressCallback
): Promise<BroadcastProgress> {
  const query = buildUserQuery(filter);

  // Fetch only telegramIds (minimal data)
  const users = await User.find(query, { telegramId: 1 }).lean();
  const total = users.length;

  const progress: BroadcastProgress = { sent: 0, failed: 0, blocked: 0, total };

  for (let i = 0; i < users.length; i++) {
    const user = users[i]!;
    try {
      try {
        await api.sendMessage(user.telegramId, text, { parse_mode: "HTML" });
      } catch (htmlErr: any) {
        const desc = htmlErr?.description ?? htmlErr?.message ?? "";
        if (desc.includes("can't parse entities") || desc.includes("entity")) {
          await api.sendMessage(user.telegramId, text);
        } else {
          throw htmlErr;
        }
      }
      progress.sent++;
    } catch (err: any) {
      const errMsg = err?.description ?? err?.message ?? String(err);
      if (
        errMsg.includes("bot was blocked by the user") ||
        errMsg.includes("user is deactivated") ||
        errMsg.includes("chat not found")
      ) {
        progress.blocked++;
      } else {
        progress.failed++;
      }
    }

    // Report progress every 10 messages
    if (onProgress && (i + 1) % 10 === 0) {
      try {
        await onProgress({ ...progress });
      } catch {
        // Progress callback errors should never abort the broadcast
      }
    }

    await sleep(SLEEP_MS);
  }

  // Final progress call
  if (onProgress) {
    try {
      await onProgress({ ...progress });
    } catch { /* ignore */ }
  }

  return progress;
}

/**
 * Returns estimated user count for a filter segment (for preview before sending).
 */
export async function estimateBroadcastTarget(filter: BroadcastFilter): Promise<number> {
  const query = buildUserQuery(filter);
  return await User.countDocuments(query);
}

/**
 * Human-readable label for each broadcast filter.
 */
export function getBroadcastFilterLabel(filter: BroadcastFilter): string {
  switch (filter) {
    case "ALL":           return "Semua User";
    case "WITH_BALANCE":  return "User dengan Saldo > 0";
    case "ACTIVE_BUYERS": return "User Aktif Transaksi (pernah beli)";
    case "NEW_BUYERS":    return "User Belum Pernah Beli";
  }
}
