// ============================================================================
//  Realtime Currency Exchange Service (USD ➔ IDR)
//  Uses free, reliable, no-key public API endpoints with automatic fallback
//  and in-memory caching (15-minute TTL).
// ============================================================================

export interface PricingCalculation {
  /** The base cost converted to IDR (rounded). */
  baseCostIdr: number;
  /** The final selling price in IDR including markup (rounded). */
  sellingPriceIdr: number;
  /**
   * The maximum acceptable base cost in USD to send to provider API.
   * Preserves at least 50% profit margin.
   */
  maxPriceUsd: number;
  /** The USD -> IDR exchange rate used for this calculation. */
  rateUsed: number;
}

export class CurrencyService {
  /** Default fallback rate if all external APIs are unreachable (1 USD = Rp16.500) */
  private static readonly FALLBACK_RATE = 16_500;

  /** Cache TTL: 15 minutes */
  private static readonly CACHE_TTL_MS = 15 * 60 * 1_000;

  /** In-memory cached USD to IDR exchange rate */
  private static cachedRate: number = CurrencyService.FALLBACK_RATE;

  /** Timestamp of the last successful fetch */
  private static lastFetchedAt: number = 0;

  /** Pending promise to prevent concurrent identical fetch requests */
  private static ongoingFetch: Promise<number> | null = null;

  /**
   * List of free, no-auth public endpoints to fetch exchange rate.
   * Tried sequentially until one succeeds.
   */
  private static readonly PROVIDERS: Array<{
    name: string;
    url: string;
    extractor: (json: any) => number | null;
  }> = [
    {
      name: "open.er-api.com",
      url: "https://open.er-api.com/v6/latest/USD",
      extractor: (json) => {
        const idr = json?.rates?.IDR;
        return typeof idr === "number" && idr > 0 ? idr : null;
      },
    },
    {
      name: "api.exchangerate-api.com",
      url: "https://api.exchangerate-api.com/v4/latest/USD",
      extractor: (json) => {
        const idr = json?.rates?.IDR;
        return typeof idr === "number" && idr > 0 ? idr : null;
      },
    },
    {
      name: "jsdelivr/fawazahmed0",
      url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
      extractor: (json) => {
        const idr = json?.usd?.idr;
        return typeof idr === "number" && idr > 0 ? idr : null;
      },
    },
  ];

  /**
   * Retrieves the current USD to IDR exchange rate.
   * Returns cached rate if within TTL, otherwise fetches fresh from APIs.
   *
   * @returns Exchange rate (e.g. 17833.5)
   */
  static async getUsdRate(): Promise<number> {
    const now = Date.now();
    if (this.lastFetchedAt > 0 && now - this.lastFetchedAt < this.CACHE_TTL_MS) {
      return this.cachedRate;
    }

    if (this.ongoingFetch) {
      return this.ongoingFetch;
    }

    this.ongoingFetch = this.fetchFreshRate()
      .then((rate) => {
        this.cachedRate = rate;
        this.lastFetchedAt = Date.now();
        return rate;
      })
      .catch((err) => {
        console.warn(`[CurrencyService] Gagal fetch kurs realtime, menggunakan cache/fallback (${this.cachedRate}):`, err);
        return this.cachedRate;
      })
      .finally(() => {
        this.ongoingFetch = null;
      });

    return this.ongoingFetch;
  }

  /**
   * Synchronously returns the last known USD to IDR exchange rate.
   */
  static getCachedRate(): number {
    return this.cachedRate;
  }

  /**
   * Fetches fresh exchange rate trying each provider in order.
   */
  private static async fetchFreshRate(): Promise<number> {
    for (const provider of this.PROVIDERS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6_000);

        const res = await fetch(provider.url, {
          signal: controller.signal,
          headers: { "User-Agent": "TelegramBot-CurrencyService/1.0" },
        });
        clearTimeout(timeoutId);

        if (!res.ok) continue;

        const data = await res.json();
        const rate = provider.extractor(data);
        if (rate && rate > 5_000 && rate < 50_000) {
          return rate;
        }
      } catch {
        // Try next provider
      }
    }

    // If all providers failed, retain previous cached rate if valid or fallback
    return this.cachedRate > 5_000 ? this.cachedRate : this.FALLBACK_RATE;
  }

  /**
   * Converts USD to IDR (rounded to nearest whole rupiah).
   *
   * @param usdAmount Amount in USD
   * @param customRate Optional custom rate (defaults to cached rate)
   */
  static usdToIdr(usdAmount: number, customRate?: number): number {
    const rate = customRate ?? this.cachedRate;
    return Math.round(usdAmount * rate);
  }

  /**
   * Converts IDR to USD.
   *
   * @param idrAmount Amount in IDR
   * @param customRate Optional custom rate (defaults to cached rate)
   */
  static idrToUsd(idrAmount: number, customRate?: number): number {
    const rate = customRate ?? this.cachedRate;
    if (rate <= 0) return 0;
    return idrAmount / rate;
  }

  /**
   * Calculates all price components for an SMS virtual number rental:
   * 1. baseCostIdr: Base cost converted from USD to IDR
   * 2. sellingPriceIdr: IDR price charged to user (base + markup)
   * 3. maxPriceUsd: Maximum base cost in USD passed to provider API (preserves 50% margin)
   *
   * @param baseCostUsd Raw cost from SMSBower API (in USD)
   * @param markupType "fixed" (in IDR) or "percentage"
   * @param markupValue Markup amount (IDR flat or percent)
   * @param rate USD to IDR exchange rate
   */
  static calculatePricing(
    baseCostUsd: number,
    markupType: "fixed" | "percentage",
    markupValue: number,
    rate?: number
  ): PricingCalculation {
    const activeRate = rate && rate > 0 ? rate : this.cachedRate;
    const baseCostIdr = Math.round(baseCostUsd * activeRate);

    let sellingPriceIdr: number;
    let maxPriceUsd: number;

    if (markupType === "percentage") {
      const marginPercent = Math.max(0, markupValue);
      sellingPriceIdr = Math.round(baseCostIdr * (1 + marginPercent / 100));
      // Allow provider to fluctuate up to 50% of the percentage margin
      maxPriceUsd = baseCostUsd * (1 + (0.5 * marginPercent) / 100);
    } else {
      // Fixed markup in IDR
      const marginIdr = Math.max(0, markupValue);
      sellingPriceIdr = baseCostIdr + marginIdr;
      const marginUsd = marginIdr / activeRate;
      // Allow provider to fluctuate up to 50% of the flat IDR margin converted to USD
      maxPriceUsd = baseCostUsd + 0.5 * marginUsd;
    }

    // Keep maxPriceUsd precise to 4 decimal places (e.g. 0.0652)
    const roundedMaxPriceUsd = parseFloat(maxPriceUsd.toFixed(4));

    return {
      baseCostIdr,
      sellingPriceIdr,
      maxPriceUsd: roundedMaxPriceUsd,
      rateUsed: activeRate,
    };
  }
}
