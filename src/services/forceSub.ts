import { Api, InlineKeyboard } from "grammy";
import { BotConfig, IBotConfig } from "../models/BotConfig.js";

// ---------------------------------------------------------------------------
// Force Sub Service
// ---------------------------------------------------------------------------

let cachedConfig: IBotConfig | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10_000; // Cache config for 10 seconds to minimize DB hits

interface MemberCacheEntry {
  isMember: boolean;
  expiresAt: number;
}

// In-memory member status cache to eliminate repetitive getChatMember calls
const memberCache = new Map<string, MemberCacheEntry>();
const MEMBER_CACHE_SUCCESS_TTL_MS = 180_000; // 3 minutes cache for verified members
const MEMBER_CACHE_FAIL_TTL_MS = 10_000;     // 10 seconds cache for non-members

export class ForceSubService {
  /**
   * Retrieves the current bot configuration from cache or MongoDB.
   */
  static async getConfig(): Promise<IBotConfig> {
    const now = Date.now();
    if (cachedConfig && now - lastCacheTime < CACHE_TTL_MS) {
      return cachedConfig;
    }
    cachedConfig = await BotConfig.getOrCreate();
    lastCacheTime = now;
    return cachedConfig;
  }

  /**
   * Updates bot configuration in DB and invalidates the in-memory cache.
   */
  static async updateConfig(updates: Partial<IBotConfig>): Promise<IBotConfig> {
    const config = await BotConfig.getOrCreate();
    Object.assign(config, updates);
    await config.save();
    cachedConfig = config;
    lastCacheTime = Date.now();
    // Clear member cache on config changes
    memberCache.clear();
    return config;
  }

  /**
   * Invalidates membership cache for a specific user.
   */
  static invalidateUserCache(userId: number | string): void {
    const numericUserId = Number(userId);
    for (const key of memberCache.keys()) {
      if (key.endsWith(`:${numericUserId}`)) {
        memberCache.delete(key);
      }
    }
  }

  /**
   * Checks if a user has joined the required Telegram channel.
   * Uses high-performance in-memory cache unless bypassCache is explicitly set.
   */
  static async checkUserJoined(
    api: Api,
    userId: number | string,
    bypassCache: boolean = false
  ): Promise<{
    isMember: boolean;
    channelName: string;
    channelLink: string;
    channelId: string;
    error?: string;
  }> {
    const config = await this.getConfig();

    // If force sub is disabled or channel is not configured, bypass check.
    if (!config.forceSubEnabled || !config.forceSubChannel || config.forceSubChannel.trim() === "") {
      return {
        isMember: true,
        channelName: config.forceSubName,
        channelLink: config.forceSubLink,
        channelId: config.forceSubChannel,
      };
    }

    const channelIdentifier = config.forceSubChannel.trim();
    const numericUserId = Number(userId);
    const cacheKey = `${channelIdentifier}:${numericUserId}`;
    const now = Date.now();

    // 1. Check in-memory membership cache (0ms instant lookup)
    if (!bypassCache) {
      const cached = memberCache.get(cacheKey);
      if (cached && now < cached.expiresAt) {
        return {
          isMember: cached.isMember,
          channelName: config.forceSubName,
          channelLink: config.forceSubLink,
          channelId: channelIdentifier,
        };
      }
    }

    // 2. Perform live check against Telegram API
    try {
      const member = await api.getChatMember(channelIdentifier, numericUserId);

      // Statuses that represent active membership
      const validStatuses = ["creator", "administrator", "member"];
      let isMember = validStatuses.includes(member.status);

      if (!isMember && member.status === "restricted") {
        isMember = (member as any).is_member !== false;
      }

      // Store in memory cache
      memberCache.set(cacheKey, {
        isMember,
        expiresAt: now + (isMember ? MEMBER_CACHE_SUCCESS_TTL_MS : MEMBER_CACHE_FAIL_TTL_MS),
      });

      return {
        isMember,
        channelName: config.forceSubName,
        channelLink: config.forceSubLink,
        channelId: channelIdentifier,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(
        `⚠️ [ForceSub] Failed to check chat member status for user ${userId} in ${channelIdentifier}:`,
        errMsg
      );

      if (
        errMsg.includes("CHAT_ADMIN_REQUIRED") ||
        errMsg.includes("chat not found") ||
        errMsg.includes("bot was kicked")
      ) {
        console.error(
          `❌ [ForceSub] CRITICAL: Ensure the bot is added as an Administrator in channel "${channelIdentifier}"!`
        );
      }

      return {
        isMember: false,
        channelName: config.forceSubName,
        channelLink: config.forceSubLink,
        channelId: channelIdentifier,
        error: errMsg,
      };
    }
  }

  /**
   * Generates the prompt text and inline keyboard for unjoined users.
   */
  static buildForceSubPrompt(
    channelName: string,
    channelLink: string
  ): { text: string; keyboard: InlineKeyboard } {
    const displayName = channelName || "Channel Resmi";
    const text =
      `📢 <b>Wajib Bergabung ke Channel</b>\n` +
      `${"─".repeat(28)}\n\n` +
      `Halo! Untuk dapat menggunakan layanan bot ini, Anda diwajibkan untuk bergabung ke channel resmi kami terlebih dahulu:\n\n` +
      `👉 <b>${displayName}</b>\n\n` +
      `<i>Setelah bergabung, silakan klik tombol <b>"Saya Sudah Bergabung"</b> di bawah untuk membuka akses bot.</i>`;

    const keyboard = new InlineKeyboard();
    if (channelLink && channelLink.trim() !== "") {
      keyboard.url("📢 Gabung Channel", channelLink).row();
    }
    keyboard.text("🔄 ✅ Saya Sudah Bergabung", "forcesub_check");

    return { text, keyboard };
  }
}
