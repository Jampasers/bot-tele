import { BotConfig, CloudflareZoneConfig, DEFAULT_CF_ZONES } from "../models/BotConfig.js";

// ============================================================================
//  Cloudflare Email Routing Service
// ============================================================================

export interface CloudflareRuleMatcher {
  type: "literal";
  field: "to";
  value: string;
}

export interface CloudflareRuleAction {
  type: "forward" | "worker" | "drop";
  value: string[];
}

export interface CloudflareRulePayload {
  name: string;
  enabled: boolean;
  matchers: CloudflareRuleMatcher[];
  actions: CloudflareRuleAction[];
}

export interface CloudflareRuleItem {
  id: string;
  name: string;
  enabled: boolean;
  matchers: CloudflareRuleMatcher[];
  actions: CloudflareRuleAction[];
  tag?: string;
  zoneId?: string;
  domain?: string;
  targetEmail?: string;
  destinationEmail?: string;
}

export interface CreateRuleResult {
  success: boolean;
  email?: string;
  domain?: string;
  zoneId?: string;
  ruleId?: string;
  destinationEmail?: string;
  error?: string;
}

export interface CreateRuleOptions {
  prefix?: string | undefined;
  domain?: string | undefined;
  zoneId?: string | undefined;
  destinationEmail?: string | undefined;
  name?: string | undefined;
}

export class CloudflareService {
  /**
   * Generates a pronounceable random string by alternating consonants and vowels.
   * e.g. "vabode", "kolemi", "dapisu"
   */
  static generateRandomPrefix(length: number = 6): string {
    const vowels = "aeiou";
    const consonants = "bcdfghjklmnpqrstvwxyz";
    let result = "";

    for (let i = 0; i < length; i++) {
      const characters = i % 2 === 0 ? consonants : vowels;
      const randomIndex = Math.floor(Math.random() * characters.length);
      result += characters.charAt(randomIndex);
    }

    return result;
  }

  /**
   * Retrieves active Cloudflare configuration from BotConfig singleton.
   */
  static async getConfig(): Promise<{
    cfEmail: string;
    cfApiKey: string;
    cfDestinationEmail: string;
    cfZones: CloudflareZoneConfig[];
  }> {
    const config = await BotConfig.getOrCreate();
    return {
      cfEmail: config.cfEmail || process.env.CF_EMAIL || "",
      cfApiKey: config.cfApiKey || process.env.CF_GLOBAL_API_KEY || process.env.CF_API_KEY || "",
      cfDestinationEmail: config.cfDestinationEmail || process.env.CF_DEST_EMAIL || "",
      cfZones: config.cfZones && config.cfZones.length > 0 ? config.cfZones : [...DEFAULT_CF_ZONES],
    };
  }

  /**
   * Returns headers required for Cloudflare API authentication.
   * Supports both Global API Key (X-Auth-Key) and Bearer Token.
   */
  private static getHeaders(cfEmail: string, cfApiKey: string): Record<string, string> {
    const isBearer = cfApiKey.startsWith("Bearer ") || (!cfApiKey.startsWith("cfk_") && cfApiKey.length > 30 && !cfEmail);
    if (isBearer) {
      const token = cfApiKey.replace(/^Bearer\s+/i, "");
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
    }

    return {
      "Content-Type": "application/json",
      "X-Auth-Email": cfEmail,
      "X-Auth-Key": cfApiKey,
    };
  }

  /**
   * Returns the list of configured Cloudflare zones (domains).
   */
  static async getZones(): Promise<CloudflareZoneConfig[]> {
    const { cfZones } = await this.getConfig();
    return cfZones;
  }

  /**
   * Selects a random zone from configured zones.
   */
  static async getRandomZone(): Promise<CloudflareZoneConfig | null> {
    const zones = await this.getZones();
    if (!zones || zones.length === 0) return null;
    const randomIndex = Math.floor(Math.random() * zones.length);
    return zones[randomIndex] ?? null;
  }

  /**
   * Creates a Cloudflare Email Routing forward rule.
   */
  static async createEmailRule(options: CreateRuleOptions = {}): Promise<CreateRuleResult> {
    const config = await this.getConfig();
    const { cfEmail, cfApiKey, cfDestinationEmail, cfZones } = config;

    if (!cfApiKey) {
      return { success: false, error: "Cloudflare API Key belum dikonfigurasi." };
    }

    // Determine Zone
    let selectedZone: CloudflareZoneConfig | null = null;
    if (options.zoneId) {
      selectedZone = cfZones.find((z) => z.id.toLowerCase() === options.zoneId!.toLowerCase()) ?? {
        id: options.zoneId,
        domain: options.domain || options.zoneId,
      };
    } else if (options.domain) {
      selectedZone = cfZones.find((z) => z.domain.toLowerCase() === options.domain!.toLowerCase()) ?? null;
      if (!selectedZone) {
        return {
          success: false,
          error: `Domain "${options.domain}" tidak ditemukan dalam daftar Zone terkonfigurasi.`,
        };
      }
    } else {
      selectedZone = await this.getRandomZone();
    }

    if (!selectedZone) {
      return { success: false, error: "Tidak ada Zone / Domain Cloudflare yang tersedia." };
    }

    // Determine Prefix & Target Email
    const rawPrefix = options.prefix?.trim() || this.generateRandomPrefix(6);
    // Sanitize prefix (lowercase, alphanumeric, dots, dashes, underscores)
    const cleanPrefix = rawPrefix.toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (!cleanPrefix) {
      return { success: false, error: "Prefix email tidak valid." };
    }

    const targetEmail = cleanPrefix.includes("@")
      ? cleanPrefix
      : `${cleanPrefix}@${selectedZone.domain}`;

    const destEmail = (options.destinationEmail?.trim() || cfDestinationEmail).trim();
    if (!destEmail) {
      return { success: false, error: "Email tujuan (forward destination) belum ditentukan." };
    }

    const ruleName = options.name?.trim() || `Forward ${cleanPrefix} to ${destEmail}`;

    const payload: CloudflareRulePayload = {
      name: ruleName,
      enabled: true,
      matchers: [
        {
          type: "literal",
          field: "to",
          value: targetEmail,
        },
      ],
      actions: [
        {
          type: "forward",
          value: [destEmail],
        },
      ],
    };

    const endpoint = `https://api.cloudflare.com/client/v4/zones/${selectedZone.id}/email/routing/rules`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: this.getHeaders(cfEmail, cfApiKey),
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        return {
          success: false,
          error: `Respons API Cloudflare bukan JSON: ${rawText.slice(0, 150)}`,
        };
      }

      if (!response.ok || !data.success) {
        const errorMsg = data.errors && data.errors.length > 0
          ? data.errors.map((e: any) => e.message || JSON.stringify(e)).join(", ")
          : (data.messages?.join(", ") || `HTTP ${response.status}: ${response.statusText}`);
        return {
          success: false,
          error: errorMsg,
        };
      }

      const ruleId = data.result?.id || "unknown";

      return {
        success: true,
        email: targetEmail,
        domain: selectedZone.domain,
        zoneId: selectedZone.id,
        ruleId,
        destinationEmail: destEmail,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error?.message ?? "Terjadi kesalahan jaringan saat menghubungi Cloudflare.",
      };
    }
  }

  /**
   * Lists active email routing rules for a specific zone or across all zones.
   */
  static async listEmailRules(zoneId?: string): Promise<{
    success: boolean;
    rules: CloudflareRuleItem[];
    error?: string;
  }> {
    const config = await this.getConfig();
    const { cfEmail, cfApiKey, cfZones } = config;

    const targetZones = zoneId
      ? cfZones.filter((z) => z.id.toLowerCase() === zoneId.toLowerCase())
      : cfZones;

    if (targetZones.length === 0 && zoneId) {
      targetZones.push({ id: zoneId, domain: zoneId });
    }

    const allRules: CloudflareRuleItem[] = [];

    for (const zone of targetZones) {
      const endpoint = `https://api.cloudflare.com/client/v4/zones/${zone.id}/email/routing/rules?page=1&per_page=50`;
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: this.getHeaders(cfEmail, cfApiKey),
        });

        const data: any = await response.json();
        if (response.ok && data.success && Array.isArray(data.result)) {
          for (const item of data.result) {
            const matcher = item.matchers?.find((m: any) => m.field === "to");
            const action = item.actions?.find((a: any) => a.type === "forward");
            allRules.push({
              id: item.id || item.tag,
              name: item.name || "Rule",
              enabled: item.enabled ?? true,
              matchers: item.matchers || [],
              actions: item.actions || [],
              tag: item.tag,
              zoneId: zone.id,
              domain: zone.domain,
              targetEmail: matcher?.value || item.name || "-",
              destinationEmail: action?.value?.[0] || "-",
            });
          }
        }
      } catch (err) {
        console.error(`[cloudflare] Error fetching rules for zone ${zone.domain}:`, err);
      }
    }

    return {
      success: true,
      rules: allRules,
    };
  }

  /**
   * Deletes an email routing rule from a specific Cloudflare zone.
   */
  static async deleteEmailRule(zoneId: string, ruleId: string): Promise<{ success: boolean; error?: string }> {
    const { cfEmail, cfApiKey } = await this.getConfig();
    const endpoint = `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules/${ruleId}`;

    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: this.getHeaders(cfEmail, cfApiKey),
      });

      const data: any = await response.json();
      if (!response.ok || !data.success) {
        const errorMsg = data.errors?.map((e: any) => e.message).join(", ") || `HTTP ${response.status}`;
        return { success: false, error: errorMsg };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? "Gagal menghubungi Cloudflare API." };
    }
  }

  /**
   * Automatically discovers and fetches all active zones for the configured Cloudflare account.
   */
  static async fetchAccountZones(): Promise<{
    success: boolean;
    zones?: CloudflareZoneConfig[];
    error?: string;
  }> {
    const { cfEmail, cfApiKey } = await this.getConfig();
    const endpoint = `https://api.cloudflare.com/client/v4/zones?status=active&per_page=50`;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: this.getHeaders(cfEmail, cfApiKey),
      });

      const data: any = await response.json();
      if (!response.ok || !data.success || !Array.isArray(data.result)) {
        const errorMsg = data.errors?.map((e: any) => e.message).join(", ") || `HTTP ${response.status}`;
        return { success: false, error: errorMsg };
      }

      const fetchedZones: CloudflareZoneConfig[] = data.result.map((z: any) => ({
        id: z.id,
        domain: z.name,
      }));

      return { success: true, zones: fetchedZones };
    } catch (error: any) {
      return { success: false, error: error?.message ?? "Gagal mengambil daftar zone dari Cloudflare." };
    }
  }

  /**
   * Updates Cloudflare settings in the database.
   */
  static async updateConfig(updates: Partial<{
    cfEmail: string;
    cfApiKey: string;
    cfDestinationEmail: string;
    cfZones: CloudflareZoneConfig[];
  }>): Promise<void> {
    const config = await BotConfig.getOrCreate();
    if (updates.cfEmail !== undefined) config.cfEmail = updates.cfEmail.trim();
    if (updates.cfApiKey !== undefined) config.cfApiKey = updates.cfApiKey.trim();
    if (updates.cfDestinationEmail !== undefined) config.cfDestinationEmail = updates.cfDestinationEmail.trim();
    if (updates.cfZones !== undefined) config.cfZones = updates.cfZones;
    await config.save();
  }

  /**
   * Adds a new zone to the configuration.
   */
  static async addZone(zone: CloudflareZoneConfig): Promise<boolean> {
    const config = await BotConfig.getOrCreate();
    const existing = config.cfZones.find(
      (z) => z.id === zone.id || z.domain.toLowerCase() === zone.domain.toLowerCase()
    );
    if (existing) return false;
    config.cfZones.push({ id: zone.id.trim(), domain: zone.domain.trim().toLowerCase() });
    await config.save();
    return true;
  }

  /**
   * Removes a zone by ID or domain.
   */
  static async removeZone(identifier: string): Promise<boolean> {
    const config = await BotConfig.getOrCreate();
    const cleanId = identifier.trim().toLowerCase();
    const initialLen = config.cfZones.length;
    config.cfZones = config.cfZones.filter(
      (z) => z.id.toLowerCase() !== cleanId && z.domain.toLowerCase() !== cleanId
    );
    if (config.cfZones.length !== initialLen) {
      await config.save();
      return true;
    }
    return false;
  }
}
