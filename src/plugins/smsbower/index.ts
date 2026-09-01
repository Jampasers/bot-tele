import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User } from "../../models/User.js";
import { Order } from "../../models/Order.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { TopupSession, ITopupSession } from "../../models/TopupSession.js";
import {
  smsBower,
  SMSBowerService,
  CachedCountry,
  CachedService,
  CountryPriceMap,
} from "../../services/smsbower.js";
import { TestimonialService } from "../../services/testimonial.js";
import { ActivityLogService } from "../../services/activityLog.js";
import {
  generateQris,
  checkSessionSettlement,
  getUniquePaymentAmount,
} from "../../services/payment/index.js";
import {
  CB_CATALOG,
  buildCatalogText,
  buildCatalogKeyboard,
} from "../panel/index.js";
import { CurrencyService } from "../../services/currency.js";

// ============================================================================
//  CONFIGURATION
//  Countries and services are loaded dynamically from the SMSBower API at
//  startup by calling `SMSBowerService.loadData()` in src/index.ts.
//  The keyboard builders below read `SMSBowerService.cachedCountries` and
//  `SMSBowerService.cachedServices` at call-time, so they always reflect the
//  latest cached data without any code change here.
//
//  Type aliases so the rest of this file doesn't have to spell out the full
//  imported type names everywhere.
// ============================================================================

type Country = CachedCountry; // { id: string; name: string }
type Service = CachedService; // { code: string; name: string }

/** Live accessor — reads the in-memory cache populated by loadData(). */
const countries = (): readonly Country[] => SMSBowerService.cachedCountries;

/** Live accessor — reads the in-memory cache populated by loadData(). */
const services = (): readonly Service[] => SMSBowerService.cachedServices;

// ============================================================================
//  SEARCH STATE MANAGEMENT
// ============================================================================

export type UserSearchMode =
  | { type: "COUNTRY" }
  | { type: "SERVICE"; countryId: string };

/** Active prompt state for users currently waiting to type search keywords. */
const userSearchModeState = new Map<string, UserSearchMode>();

/** Stored active search query for country pagination per user. */
const userCtrySearchQuery = new Map<string, string>();

/** Stored active search query for service pagination per user. */
const userSrvSearchQuery = new Map<
  string,
  { countryId: string; query: string }
>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================
//  PAGINATION
// ============================================================================

/** Maximum items to show per keyboard page. */
const ITEMS_PER_PAGE = 10;

interface PageResult<T> {
  items: readonly T[]; // the slice for this page
  totalPages: number; // total number of pages
}

/**
 * Slices `array` for the requested `page` (0-indexed) at `pageSize` items.
 * Returns both the slice and the total page count so callers can build
 * Prev/Next navigation without recalculating.
 *
 * @example
 * const { items, totalPages } = paginate(countries, 0, ITEMS_PER_PAGE);
 */
function paginate<T>(
  array: readonly T[],
  page: number,
  pageSize: number = ITEMS_PER_PAGE,
): PageResult<T> {
  const totalPages = Math.max(1, Math.ceil(array.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  return {
    items: array.slice(start, start + pageSize),
    totalPages,
  };
}

// ============================================================================
//  TIMING CONSTANTS
// ============================================================================

/** How often to ask SMSBower "did the OTP arrive yet?" */
const POLL_INTERVAL_MS = 10_000; // 10 seconds

/** Auto-cancel the order after this much waiting. */
const ORDER_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/** How often to poll Midtrans for QRIS payment confirmation. */
const QRIS_POLL_INTERVAL_MS = 10_000; // 10 seconds

/** Give up waiting for QRIS payment after this long (Midtrans QR = 15 min). */
const QRIS_TIMEOUT_MS = 14 * 60 * 1_000; // 14 minutes

// ============================================================================
//  PRICING HELPERS
//  SMSBower returns base costs in USD (e.g. 0.05, 0.12).
//  CurrencyService converts USD -> IDR with realtime exchange rates and
//  calculates:
//  1. sellingPriceIdr : IDR price charged to user (base IDR + markup)
//  2. maxPriceUsd     : USD maximum price threshold sent to SMSBower API
// ============================================================================

/**
 * Calculates the final selling price in IDR the user will be charged.
 *
 * @param baseCostUsd The raw activation cost returned by SMSBower in USD (e.g. 0.05).
 * @param markupType  "fixed" (in IDR) | "percentage"
 * @param markupValue The markup amount (IDR flat units or percent).
 * @param usdRate     Realtime USD to IDR rate.
 * @returns           Final price in IDR, rounded to the nearest Rupiah.
 */
function applyMarkup(
  baseCostUsd: number,
  markupType: "fixed" | "percentage",
  markupValue: number,
  usdRate?: number,
): number {
  return CurrencyService.calculatePricing(
    baseCostUsd,
    markupType,
    markupValue,
    usdRate,
  ).sellingPriceIdr;
}

/**
 * Calculates the maximum base price in USD we are willing to accept from SMSBower API.
 * Formula: baseCostUsd + (0.5 * markupUsd)
 * Preserves at least 50% profit margin while tolerating minor upstream price adjustments.
 */
function calculateMaxPrice(
  baseCostUsd: number,
  markupType: "fixed" | "percentage",
  markupValue: number,
  usdRate?: number,
): number {
  return CurrencyService.calculatePricing(
    baseCostUsd,
    markupType,
    markupValue,
    usdRate,
  ).maxPriceUsd;
}

/**
 * Formats a credit/rupiah amount as an Indonesian Rupiah string.
 *
 * @example
 * formatPrice(3500)  // → "Rp3.500"
 * formatPrice(12000) // → "Rp12.000"
 */
function formatPrice(amount: number): string {
  // Indonesian locale uses period as thousands separator.
  return "Rp" + Math.round(amount).toLocaleString("id-ID");
}

// ============================================================================
//  KEYBOARD BUILDERS
// ============================================================================

/**
 * Appends items to an InlineKeyboard in 2-column rows.
 * Returns the keyboard for chaining.
 */
function rowsOf2(
  kb: InlineKeyboard,
  items: ReadonlyArray<{ label: string; data: string }>,
): InlineKeyboard {
  items.forEach(({ label, data }, i) => {
    kb.text(label, data);
    if ((i + 1) % 2 === 0) kb.row();
  });
  if (items.length % 2 !== 0) kb.row(); // trailing row-break for odd counts
  return kb;
}

/**
 * Appends a Prev / Next pagination row to an existing keyboard.
 *
 * @param kb          Keyboard to append to (mutated in place).
 * @param page        Current 0-indexed page number.
 * @param totalPages  Total number of pages (from `paginate()`).
 * @param prevCb      callback_data for the Prev button.
 * @param nextCb      callback_data for the Next button.
 */
function appendPaginationRow(
  kb: InlineKeyboard,
  page: number,
  totalPages: number,
  prevCb: string,
  nextCb: string,
): void {
  const hasPrev = page > 0;
  const hasNext = page < totalPages - 1;

  if (!hasPrev && !hasNext) return; // only one page — no row needed

  if (hasPrev) kb.text("⬅️ Prev", prevCb);
  if (hasNext) kb.text("Next ➡️", nextCb);
  kb.row();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Country keyboard  (Step 1)
//  callback_data per button : setcountry_<countryId>
//  pagination callback_data : ctry_pg_<page> / ctry_spg_<page>
//  Back button              : menu_catalog  (CB_CATALOG)
// ─────────────────────────────────────────────────────────────────────────────

function buildCountryKeyboard(
  page: number,
  customList?: readonly Country[],
): InlineKeyboard {
  const list = customList ?? countries();
  const { items, totalPages } = paginate(list, page);
  const kb = new InlineKeyboard();

  rowsOf2(
    kb,
    items.map((c) => ({ label: c.name, data: `setcountry_${c.id}` })),
  );

  appendPaginationRow(
    kb,
    page,
    totalPages,
    customList ? `ctry_spg_${page - 1}` : `ctry_pg_${page - 1}`,
    customList ? `ctry_spg_${page + 1}` : `ctry_pg_${page + 1}`,
  );

  if (customList) {
    kb.text("🔍 Cari Ulang", "ctry_search")
      .text("🌍 Semua Negara", "ctry_pg_0")
      .row();
  } else {
    kb.text("🔍 Cari Negara", "ctry_search").row();
  }

  kb.text("🔙 Back to Catalog", CB_CATALOG);
  return kb;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Service keyboard  (Step 2)
//  callback_data per button : buy_<countryId>_<serviceCode>
//  pagination callback_data : srv_pg_<countryId>_<page> / srv_spg_<countryId>_<page>
//  Back button              : ctry_pg_0  (return to country list page 0)
//
//  Each button label: "<Service Name> - <FinalPrice>"  e.g. "WhatsApp - Rp3.500"
//  Prices are fetched once per country from the API then cached in memory.
// ─────────────────────────────────────────────────────────────────────────────

async function buildServiceKeyboard(
  countryId: string,
  page: number,
  customList?: readonly Service[],
): Promise<InlineKeyboard> {
  const allServices = customList ?? services();
  const totalPages = Math.max(
    1,
    Math.ceil(allServices.length / ITEMS_PER_PAGE),
  );
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const chunk = allServices.slice(start, end);

  // ─ Fetch prices (cached after first call) + markup config + realtime USD rate in parallel.
  const [priceMap, config, usdRate] = await Promise.all([
    SMSBowerService.getPricesForCountry(countryId),
    SmsConfig.getOrCreate(),
    CurrencyService.getUsdRate(),
  ]);

  const kb = new InlineKeyboard();

  // Build 1-button-per-row layout when prices are shown — the label is too
  // wide for 2 columns on most phones. Falls back gracefully if no price found.
  for (const svc of chunk) {
    const priceEntry = priceMap.get(svc.code);

    let label: string;
    if (priceEntry && priceEntry.cost > 0) {
      const selling = applyMarkup(
        priceEntry.cost,
        config.markupType,
        config.markupValue,
        usdRate,
      );
      const stock = priceEntry.count > 0 ? "" : " ⚠️";
      label = `${svc.name}${stock} • ${formatPrice(selling)}`;
    } else {
      // No price data — show name only, price will be shown on confirmation.
      label = svc.name;
    }

    kb.text(label, `buy_${countryId}_${svc.code}`).row();
  }

  // Pagination controls
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    const prevCb = customList
      ? `srv_spg_${countryId}_${safePage - 1}`
      : `srv_pg_${countryId}_${safePage - 1}`;
    const nextCb = customList
      ? `srv_spg_${countryId}_${safePage + 1}`
      : `srv_pg_${countryId}_${safePage + 1}`;
    if (hasPrev) kb.text("⬅️ Prev", prevCb);
    if (hasNext) kb.text("Next ➡️", nextCb);
    kb.row();
  }

  if (customList) {
    kb.text("🔍 Cari Ulang", `srv_search_${countryId}`)
      .text("📱 Semua Layanan", `setcountry_${countryId}`)
      .row();
  } else {
    kb.text("🔍 Cari Layanan", `srv_search_${countryId}`).row();
  }

  kb.text("🔙 Back to Countries", "ctry_pg_0");
  return kb;
}

/** Active-order keyboard — only a Cancel button. */
function buildCancelKeyboard(activationId: string): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel Order", `cancel_${activationId}`);
}

// ============================================================================
//  MESSAGE BUILDERS — pure functions, no side-effects
// ============================================================================

function buildCountryText(
  page: number,
  totalPages: number,
  searchQuery?: string,
  totalFound?: number,
): string {
  const pageInfo = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : "";
  if (searchQuery) {
    return (
      `🔍 <b>Hasil Pencarian Negara</b>${pageInfo}\n` +
      `${"─".repeat(28)}\n\n` +
      `Kata kunci: <code>${escapeHtml(searchQuery)}</code>\n` +
      `Ditemukan: <b>${totalFound ?? 0}</b> negara\n\n` +
      `<i>Pilih negara yang Anda inginkan:</i>`
    );
  }
  return (
    `🌍 <b>Select a Country</b>${pageInfo}\n` +
    `${"─".repeat(28)}\n\n` +
    `Choose the country you want to receive an OTP from:\n\n`
  );
}

function buildServiceText(
  countryName: string,
  page: number,
  totalPages: number,
  searchQuery?: string,
  totalFound?: number,
): string {
  const pageInfo = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : "";
  if (searchQuery) {
    return (
      `🔍 <b>Hasil Pencarian Layanan</b>${pageInfo}\n` +
      `${"─".repeat(28)}\n\n` +
      `🌍 Country: <b>${countryName}</b>\n` +
      `Kata kunci: <code>${escapeHtml(searchQuery)}</code>\n` +
      `Ditemukan: <b>${totalFound ?? 0}</b> layanan\n\n` +
      `<i>Pilih layanan yang Anda inginkan:</i>`
    );
  }
  return (
    `📱 <b>Select a Service</b>${pageInfo}\n` +
    `${"─".repeat(28)}\n\n` +
    `🌍 Country: <b>${countryName}</b>\n\n` +
    `<i>Select the app you need an OTP for.</i>`
  );
}

function buildPendingText(
  phoneNumber: string,
  serviceName: string,
  countryName: string,
  sellingPrice: number,
): string {
  return (
    `⏳ <b>Waiting for OTP</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `📱 <b>Number:</b>   <code>+${phoneNumber}</code>\n` +
    `🔧 <b>Service:</b>  ${serviceName}\n` +
    `🌍 <b>Country:</b>  ${countryName}\n` +
    `💰 <b>Cost:</b>     <b>${formatPrice(sellingPrice)}</b>\n\n` +
    `Use the number above to request your OTP.\n` +
    `I'll send the code here automatically within <b>10 minutes</b>.\n\n` +
    `<i>Checking every 10 seconds…</i>`
  );
}

function buildSuccessText(
  phoneNumber: string,
  serviceName: string,
  code: string,
): string {
  return (
    `✅ <b>OTP Received!</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `📱 <b>Number:</b>   <code>+${phoneNumber}</code>\n` +
    `🔧 <b>Service:</b>  ${serviceName}\n\n` +
    `🔑 <b>Your OTP Code:</b>\n` +
    `<code>${code}</code>\n\n` +
    `<i>Enter this code in the app to verify your number.</i>`
  );
}

function buildCanceledText(
  phoneNumber: string,
  reason: "user" | "timeout",
): string {
  const why =
    reason === "timeout"
      ? "⏰ Waktu sewa habis (timeout 10 menit tidak ada SMS masuk)."
      : "❌ Pesanan telah dibatalkan.";
  return (
    `🚫 <b>Pesanan Dibatalkan</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `📱 <b>Nomor:</b> <code>+${phoneNumber}</code>\n\n` +
    `${why}\n` +
    `💰 <b>Saldo kamu telah dikembalikan otomatis.</b>\n\n` +
    `<i>Gunakan /start atau menu utama untuk bertransaksi kembali.</i>`
  );
}

// ============================================================================
//  CONFIG LOOKUP HELPERS
// ============================================================================

function findCountry(id: string): Country | undefined {
  return countries().find((c) => c.id === id);
}

function findService(code: string): Service | undefined {
  return services().find((s) => s.code === code);
}

// ============================================================================
//  QRIS PAYMENT POLLER
//  Runs outside grammY context, uses bot.api directly.
//  Started after a QRIS invoice is sent to the user.
//  On settlement: credits balance + executes the pending SMS purchase.
// ============================================================================

const activeQrisPolls = new Map<string, ReturnType<typeof setInterval>>();

function clearQrisPoll(orderId: string): void {
  const h = activeQrisPolls.get(orderId);
  if (h !== undefined) {
    clearInterval(h);
    activeQrisPolls.delete(orderId);
  }
}

/**
 * Polls GoPay Merchant settlements every QRIS_POLL_INTERVAL_MS for payment confirmation.
 * On settlement: credits user balance → auto-executes the pending purchase.
 * On expiry/timeout: marks session EXPIRED and notifies the user.
 */
function startQrisPolling(
  bot: Bot<Context>,
  sessionId: string,
  orderId: string,
  telegramId: string,
  chatId: number,
  messageId: number,
  amountIDR: number,
  serviceCode: string,
  countryId: string,
  serviceName: string,
  countryName: string,
): void {
  const startedAt = Date.now();

  const handle = setInterval(async () => {
    try {
      // ── Timeout guard ────────────────────────────────────────────────────
      if (Date.now() - startedAt >= QRIS_TIMEOUT_MS) {
        clearQrisPoll(orderId);
        const expiredSession = await TopupSession.findByIdAndUpdate(
          sessionId,
          { status: "EXPIRED" },
          { returnDocument: "after" },
        );
        if (expiredSession) {
          ActivityLogService.logTopupCancelled(bot.api, {
            session: expiredSession,
            reason: "Waktu Pembayaran QRIS Habis (14 Menit)",
            user: { telegramId },
          }).catch((err) =>
            console.error("[smsbower] ActivityLog topup expired error:", err),
          );
        }

        try {
          await bot.api.editMessageCaption(chatId, messageId, {
            caption:
              `⌛ <b>QRIS Kedaluwarsa</b>\n\n` +
              `QR code untuk pembayaran <b>${formatPrice(amountIDR)}</b> sudah tidak berlaku.\n\n` +
              `<i>Silakan klik tombol beli lagi untuk mendapatkan QR baru.</i>`,
            parse_mode: "HTML",
          });
        } catch {
          await bot.api
            .editMessageText(
              chatId,
              messageId,
              `⌛ <b>QRIS Kedaluwarsa</b>\n\n` +
                `QR code untuk pembayaran <b>${formatPrice(amountIDR)}</b> sudah tidak berlaku.\n\n` +
                `<i>Silakan klik tombol beli lagi untuk mendapatkan QR baru.</i>`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
        return;
      }

      // ── Check settlement ──────────────────────────────────────────────────
      const session = await TopupSession.findById(sessionId);
      if (!session || session.status !== "PENDING") {
        clearQrisPoll(orderId);
        return;
      }

      const matchedTx = await checkSessionSettlement(session);

      if (matchedTx) {
        clearQrisPoll(orderId);

        // Credit the exact amount to the user's balance
        const updatedUser = await User.findOneAndUpdate(
          { telegramId },
          { $inc: { balance: amountIDR } },
          { returnDocument: "after" },
        ).lean();

        const settledSession = await TopupSession.findByIdAndUpdate(
          sessionId,
          {
            status: "SETTLED",
            matchedTransactionId: matchedTx.transactionId,
          },
          { returnDocument: "after" },
        );

        if (settledSession) {
          ActivityLogService.logTopupSettled(bot.api, {
            session: settledSession,
            txId: matchedTx.transactionId,
            user: {
              telegramId,
              firstName: updatedUser?.firstName,
              username: updatedUser?.username,
            },
            newBalance: updatedUser?.balance,
          }).catch((err) =>
            console.error("[smsbower] ActivityLog topup settled error:", err),
          );
        }

        // Notify user
        try {
          await bot.api.editMessageCaption(chatId, messageId, {
            caption:
              `✅ <b>Pembayaran Diterima!</b>\n\n` +
              `💰 <b>${formatPrice(amountIDR)}</b> telah ditambahkan ke saldo kamu.\n\n` +
              `⏳ Sedang memproses pembelian <b>${serviceName}</b> otomatis…`,
            parse_mode: "HTML",
          });
        } catch {
          await bot.api
            .editMessageText(
              chatId,
              messageId,
              `✅ <b>Pembayaran Diterima!</b>\n\n` +
                `💰 <b>${formatPrice(amountIDR)}</b> telah ditambahkan ke saldo kamu.\n\n` +
                `⏳ Sedang memproses pembelian <b>${serviceName}</b> otomatis…`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }

        // Auto-execute the pending purchase
        await executePurchase(
          bot,
          chatId,
          messageId,
          telegramId,
          serviceCode,
          countryId,
        );
      }
    } catch (err) {
      console.error(`[smsbower] QRIS poll error for ${orderId}:`, err);
    }
  }, QRIS_POLL_INTERVAL_MS);

  activeQrisPolls.set(orderId, handle);
}

// ============================================================================
//  PURCHASE EXECUTOR
//  Shared by: (a) direct buy with sufficient balance,
//             (b) auto-execute after QRIS payment settles.
// ============================================================================

/**
 * Fetches a number from SMSBower, saves the order, and starts OTP polling.
 * Refunds the selling price if the provider API fails.
 */
async function executePurchase(
  bot: Bot<Context>,
  chatId: number,
  messageId: number,
  telegramId: string,
  serviceCode: string,
  countryId: string,
): Promise<void> {
  const service = findService(serviceCode);
  const country = findCountry(countryId);

  // Re-fetch the user to get the current (post-credit) balance and validate.
  const dbUser = await User.findOne({ telegramId }).lean();
  if (!dbUser || !service || !country) {
    await bot.api
      .sendMessage(
        chatId,
        `❌ <b>Gagal memproses pembelian.</b>\n<i>Data pengguna atau layanan tidak ditemukan.</i>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  // Get base cost in USD and providerIds from cache, or fetch fresh from API if not yet cached or 0
  let priceEntry = SMSBowerService.priceCache.get(countryId)?.get(serviceCode);
  if (!priceEntry || priceEntry.cost <= 0) {
    const freshPrices = await SMSBowerService.getPricesForCountry(countryId);
    priceEntry = freshPrices.get(serviceCode);
  }

  const baseCostUsd = priceEntry?.cost ?? 0;
  const providerIds = priceEntry?.providerIds;

  const [config, usdRate] = await Promise.all([
    SmsConfig.getOrCreate(),
    CurrencyService.getUsdRate(),
  ]);

  const pricing = CurrencyService.calculatePricing(
    baseCostUsd,
    config.markupType,
    config.markupValue,
    usdRate,
  );
  const sellingPrice = pricing.sellingPriceIdr;
  const maxPriceUsd = pricing.maxPriceUsd;

  if (baseCostUsd <= 0 || sellingPrice <= 0) {
    await bot.api
      .sendMessage(
        chatId,
        `⚠️ <b>Harga/stok layanan tidak tersedia saat ini.</b>\n\n` +
          `<i>Silakan coba beberapa saat lagi atau pilih layanan/negara lain.</i>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  if (dbUser.balance < sellingPrice) {
    await bot.api
      .sendMessage(
        chatId,
        `⚠️ <b>Saldo masih kurang.</b>\n\n` +
          `Saldo: <b>${formatPrice(dbUser.balance)}</b>\n` +
          `Harga: <b>${formatPrice(sellingPrice)}</b>\n\n` +
          `<i>Silakan top up saldo terlebih dahulu.</i>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  // Deduct balance atomically.
  await User.findOneAndUpdate(
    { telegramId },
    { $inc: { balance: -sellingPrice } },
  );

  let activationId = "";
  let phoneNumber = "";

  try {
    // Pass maxPriceUsd (in USD) and providerIds (top 3 cheapest providers)
    const result = await smsBower.getNumber(
      serviceCode,
      countryId,
      maxPriceUsd > 0 ? maxPriceUsd : undefined,
      providerIds,
    );
    activationId = result.activationId;
    phoneNumber = result.phoneNumber;
  } catch (err) {
    // Provider failed — refund balance immediately
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { balance: sellingPrice } },
    );
    const reason =
      err instanceof Error ? err.message : "Layanan tidak tersedia.";

    ActivityLogService.logOtpCancelled(bot.api, {
      activationId: `FAIL-${Date.now()}`,
      serviceName: service.name,
      countryName: country.name,
      reason: `Gagal Sewa: ${reason}`,
      cost: sellingPrice,
      buyer: {
        telegramId,
        firstName: dbUser.firstName,
        username: dbUser.username,
      },
    }).catch((logErr) =>
      console.error("[smsbower] ActivityLog OTP fail error:", logErr),
    );

    await bot.api
      .sendMessage(
        chatId,
        `❌ <b>Gagal memproses nomor / stok sedang tidak tersedia.</b>\n\n` +
          `💰 Saldo <b>${formatPrice(sellingPrice)}</b> telah dikembalikan ke akun kamu.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            "🔙 Kembali ke Layanan",
            `setcountry_${countryId}`,
          ),
        },
      )
      .catch(() => {});
    return;
  }

  // Save order.
  await Order.create({
    userId: parseInt(telegramId, 10),
    activationId,
    service: serviceCode,
    country: Number(countryId),
    phoneNumber,
    cost: sellingPrice,
    status: "PENDING",
  });

  // Broadcast audit log: OTP rental order created
  ActivityLogService.logOtpOrder(bot.api, {
    activationId,
    serviceName: service.name,
    countryName: country.name,
    phoneNumber,
    cost: sellingPrice,
    buyer: {
      telegramId,
      firstName: dbUser.firstName,
      username: dbUser.username,
    },
  }).catch((err) =>
    console.error("[smsbower] ActivityLog OTP order error:", err),
  );

  // Show the pending OTP screen.
  const sentMsg = await bot.api.sendMessage(
    chatId,
    buildPendingText(phoneNumber, service.name, country.name, sellingPrice),
    {
      parse_mode: "HTML",
      reply_markup: buildCancelKeyboard(activationId),
    },
  );

  startPolling(
    bot,
    chatId,
    sentMsg.message_id,
    activationId,
    phoneNumber,
    service.name,
  );
}

const activePolls = new Map<string, ReturnType<typeof setInterval>>();

function clearPoll(activationId: string): void {
  const handle = activePolls.get(activationId);
  if (handle !== undefined) {
    clearInterval(handle);
    activePolls.delete(activationId);
  }
}

// ============================================================================
//  POLL STARTER — runs outside grammY context, uses bot.api directly
// ============================================================================

function startPolling(
  bot: Bot<Context>,
  chatId: number,
  messageId: number,
  activationId: string,
  phoneNumber: string,
  serviceName: string,
): void {
  const startedAt = Date.now();

  const handle = setInterval(async () => {
    try {
      // ── Timeout guard ──────────────────────────────────────────────────────
      if (Date.now() - startedAt >= ORDER_TIMEOUT_MS) {
        clearPoll(activationId);
        await smsBower.setStatus(activationId, "8");
        const order = await Order.findOneAndUpdate(
          { activationId },
          { status: "CANCELED" },
          { returnDocument: "after" },
        );
        if (order) {
          await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { balance: order.cost } },
          );
          const user = await User.findOne({
            telegramId: String(order.userId),
          }).lean();
          ActivityLogService.logOtpCancelled(bot.api, {
            activationId,
            serviceName,
            phoneNumber,
            reason: "timeout",
            cost: order.cost,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName,
              username: user?.username,
            },
          }).catch((err) =>
            console.error("[smsbower] ActivityLog OTP timeout error:", err),
          );
        }

        await bot.api.editMessageText(
          chatId,
          messageId,
          buildCanceledText(phoneNumber, "timeout"),
          { parse_mode: "HTML" },
        );
        return;
      }

      // ── Status check ───────────────────────────────────────────────────────
      const status = await smsBower.getStatus(activationId);

      if (status.kind === "OK") {
        clearPoll(activationId);

        await Order.findOneAndUpdate(
          { activationId },
          { status: "COMPLETED", code: status.code },
        );

        const order = await Order.findOne({ activationId }).lean();
        if (order) {
          const user = await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { totalOrders: 1 } },
            { returnDocument: "after" },
          ).lean();

          // Broadcast testimonial to channel
          const countryName =
            SMSBowerService.allCountries.find(
              (c) => c.id === String(order.country),
            )?.name || String(order.country);

          TestimonialService.sendOtpPurchaseTestimonial(bot.api, {
            activationId,
            serviceName,
            countryName,
            phoneNumber,
            cost: order.cost,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName,
              username: user?.username,
            },
            date: new Date(),
          }).catch((err) =>
            console.error("[smsbower] Testimonial broadcast error:", err),
          );

          // Broadcast audit log to dedicated channel
          ActivityLogService.logOtpSuccess(bot.api, {
            activationId,
            serviceName,
            countryName,
            phoneNumber,
            code: status.code,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName,
              username: user?.username,
            },
          }).catch((err) =>
            console.error("[smsbower] ActivityLog OTP success error:", err),
          );
        }

        await bot.api.editMessageText(
          chatId,
          messageId,
          buildSuccessText(phoneNumber, serviceName, status.code),
          { parse_mode: "HTML" },
        );
        return;
      }

      if (status.kind === "CANCEL") {
        clearPoll(activationId);
        const order = await Order.findOneAndUpdate(
          { activationId },
          { status: "CANCELED" },
          { returnDocument: "after" },
        );
        if (order) {
          await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { balance: order.cost } },
          );
          const user = await User.findOne({
            telegramId: String(order.userId),
          }).lean();
          ActivityLogService.logOtpCancelled(bot.api, {
            activationId,
            serviceName,
            phoneNumber,
            reason: "Dibatalkan oleh Provider SMS",
            cost: order.cost,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName,
              username: user?.username,
            },
          }).catch((err) =>
            console.error("[smsbower] ActivityLog OTP cancel error:", err),
          );
        }

        await bot.api.editMessageText(
          chatId,
          messageId,
          buildCanceledText(phoneNumber, "user"),
          { parse_mode: "HTML" },
        );
      }

      // status.kind === "WAIT_CODE" → keep polling silently
    } catch (err) {
      console.error(`[smsbower] poll error for ${activationId}:`, err);
    }
  }, POLL_INTERVAL_MS);

  activePolls.set(activationId, handle);
}

// ============================================================================
//  MESSAGE EDIT HELPER
// ============================================================================

/**
 * Safely edits the message text if the original message is a text message,
 * or deletes the original message (e.g. if it was a photo/media message) and replies with a new text message.
 */
async function safeEditOrReply(
  ctx: Context,
  text: string,
  extra?: {
    parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
    reply_markup?: InlineKeyboard;
  },
): Promise<void> {
  const isMedia = ctx.msg && (!("text" in ctx.msg) || !ctx.msg.text);
  if (isMedia) {
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore delete failures */
    }
    await ctx.reply(text, extra as Parameters<Context["reply"]>[1]);
    return;
  }

  try {
    await ctx.editMessageText(text, extra);
  } catch (err: any) {
    const desc: string = err?.description ?? "";
    if (desc.includes("message is not modified")) {
      return;
    }
    if (
      desc.includes("there is no text in the message to edit") ||
      desc.includes("message to edit not found")
    ) {
      try {
        await ctx.deleteMessage();
      } catch {
        /* ignore delete failures */
      }
      await ctx.reply(text, extra as Parameters<Context["reply"]>[1]);
    } else {
      throw err;
    }
  }
}

// ============================================================================
//  PLUGIN
// ============================================================================

const smsBowerPlugin: Plugin = {
  name: "smsbower",
  version: "3.1.0",
  commands: [
    {
      command: "carinegara",
      description: "Cari negara untuk sewa nomor OTP SMS",
    },
    {
      command: "carilayanan",
      description: "Cari layanan/aplikasi sewa nomor OTP SMS",
    },
  ],

  register(bot: Bot<Context>): void {
    // ── /carinegara & /searchcountry — Search Country Command ─────────────────
    bot.command(["carinegara", "searchcountry"], async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.reply(
          "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
        );
        return;
      }

      const raw = ctx.message?.text ?? "";
      const query = raw
        .replace(/^\/(?:carinegara|searchcountry)(?:@\S+)?\s*/i, "")
        .trim();

      if (!query) {
        userSearchModeState.set(telegramId, { type: "COUNTRY" });
        await ctx.reply(
          `🔍 <b>Pencarian Negara OTP</b>\n` +
            `${"─".repeat(28)}\n\n` +
            `Silakan ketik nama negara yang ingin Anda cari:\n` +
            `<i>Contoh: <code>Indonesia</code>, <code>Malaysia</code>, <code>United States</code></i>\n\n` +
            `<i>Ketik /batal atau klik tombol di bawah untuk membatalkan.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              "🔙 Batal Cari",
              "ctry_cancel_search",
            ),
          },
        );
        return;
      }

      const qLower = query.toLowerCase();
      const matches = countries().filter(
        (c) => c.name.toLowerCase().includes(qLower) || c.id === query,
      );

      if (matches.length === 0) {
        await ctx.reply(
          `❌ <b>Negara Tidak Ditemukan</b>\n\n` +
            `Tidak ditemukan negara dengan kata kunci: <code>${escapeHtml(query)}</code>.\n\n` +
            `<i>Silakan cari dengan kata kunci lain atau buka daftar lengkap semua negara.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🔍 Cari Ulang", "ctry_search")
              .text("🌍 Semua Negara", "ctry_pg_0"),
          },
        );
        return;
      }

      userCtrySearchQuery.set(telegramId, query);
      const { totalPages } = paginate(matches, 0);
      await ctx.reply(buildCountryText(0, totalPages, query, matches.length), {
        parse_mode: "HTML",
        reply_markup: buildCountryKeyboard(0, matches),
      });
    });

    // ── /carilayanan & /searchservice — Search Service Command ────────────────
    bot.command(["carilayanan", "searchservice"], async (ctx) => {
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.reply(
          "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
        );
        return;
      }

      const raw = ctx.message?.text ?? "";
      const query = raw
        .replace(/^\/(?:carilayanan|searchservice)(?:@\S+)?\s*/i, "")
        .trim();

      const lastSrv = userSrvSearchQuery.get(telegramId);
      const defaultCountryId =
        lastSrv?.countryId ||
        (countries().some((c) => c.id === "6") ? "6" : countries()[0]?.id);

      if (!query) {
        if (defaultCountryId) {
          const country = findCountry(defaultCountryId);
          userSearchModeState.set(telegramId, {
            type: "SERVICE",
            countryId: defaultCountryId,
          });
          await ctx.reply(
            `🔍 <b>Pencarian Layanan OTP</b>\n` +
              `${"─".repeat(28)}\n\n` +
              `🌍 Negara: <b>${country?.name ?? defaultCountryId}</b>\n\n` +
              `Silakan ketik nama aplikasi atau layanan yang ingin dicari:\n` +
              `<i>Contoh: <code>WhatsApp</code>, <code>Telegram</code>, <code>TikTok</code>, <code>Shopee</code></i>\n\n` +
              `<i>Ketik /batal atau klik tombol di bawah untuk membatalkan.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔙 Batal Cari", `srv_cancel_search_${defaultCountryId}`)
                .row()
                .text("🌍 Ganti Negara", "product_otp"),
            },
          );
        } else {
          await ctx.reply(
            `🔍 <b>Pencarian Layanan OTP</b>\n\n` +
              `Silakan pilih negara terlebih dahulu untuk melihat ketersediaan layanan dan harga.`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text(
                "🌍 Pilih Negara",
                "product_otp",
              ),
            },
          );
        }
        return;
      }

      const countryId = defaultCountryId ?? "6";
      const country = findCountry(countryId);
      const qLower = query.toLowerCase();
      const matches = services().filter(
        (s) =>
          s.name.toLowerCase().includes(qLower) ||
          s.code.toLowerCase() === qLower,
      );

      if (matches.length === 0) {
        await ctx.reply(
          `❌ <b>Layanan Tidak Ditemukan</b>\n\n` +
            `Tidak ditemukan layanan dengan kata kunci: <code>${escapeHtml(query)}</code> di negara <b>${country?.name ?? countryId}</b>.\n\n` +
            `<i>Silakan cari kata kunci lain atau pilih negara lain.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🔍 Cari Ulang", `srv_search_${countryId}`)
              .text("🌍 Pilih Negara", "product_otp"),
          },
        );
        return;
      }

      userSrvSearchQuery.set(telegramId, { countryId, query });
      const totalPages = Math.max(
        1,
        Math.ceil(matches.length / ITEMS_PER_PAGE),
      );
      const replyMarkup = await buildServiceKeyboard(countryId, 0, matches);
      await ctx.reply(
        buildServiceText(
          country?.name ?? "Services",
          0,
          totalPages,
          query,
          matches.length,
        ),
        {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        },
      );
    });

    // ── product_otp — Country picker page 0 ──────────────────────────────────
    bot.callbackQuery("product_otp", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userSearchModeState.delete(String(ctx.from.id));

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Layanan OTP SMS Nonaktif</b>\n\n` +
            `Mohon maaf, layanan sewa nomor virtual OTP SMS saat ini sedang dinonaktifkan oleh admin untuk pemeliharaan / maintenance.\n\n` +
            `<i>Silakan cek kembali nanti atau gunakan produk lainnya di katalog kami.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              "🔙 Kembali ke Katalog",
              CB_CATALOG,
            ),
          },
        );
        return;
      }

      const { totalPages } = paginate(countries(), 0);
      try {
        await safeEditOrReply(ctx, buildCountryText(0, totalPages), {
          parse_mode: "HTML",
          reply_markup: buildCountryKeyboard(0),
        });
      } catch (err) {
        console.error("[smsbower] product_otp error:", err);
      }
    });

    // ── ctry_pg_<page> — Country list pagination ──────────────────────────────
    bot.callbackQuery(/^ctry_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userSearchModeState.delete(String(ctx.from.id));

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const page = parseInt(ctx.match[1]!, 10);
      const { totalPages } = paginate(countries(), page);
      try {
        await safeEditOrReply(ctx, buildCountryText(page, totalPages), {
          parse_mode: "HTML",
          reply_markup: buildCountryKeyboard(page),
        });
      } catch (err) {
        console.error(`[smsbower] ctry_pg_${page} error:`, err);
      }
    });

    // ── ctry_search — Prompt for country search ──────────────────────────────
    bot.callbackQuery("ctry_search", async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);

      userSearchModeState.set(telegramId, { type: "COUNTRY" });

      await safeEditOrReply(
        ctx,
        `🔍 <b>Pencarian Negara OTP</b>\n` +
          `${"─".repeat(28)}\n\n` +
          `Silakan ketik nama negara atau kode ID yang ingin dicari:\n` +
          `<i>Contoh: <code>Indonesia</code>, <code>Malaysia</code>, <code>United States</code></i>\n\n` +
          `<i>Ketik /batal atau klik tombol di bawah untuk membatalkan.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            "🔙 Batal Cari",
            "ctry_cancel_search",
          ),
        },
      );
    });

    // ── ctry_cancel_search — Cancel country search ───────────────────────────
    bot.callbackQuery("ctry_cancel_search", async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (from) userSearchModeState.delete(String(from.id));

      const { totalPages } = paginate(countries(), 0);
      try {
        await safeEditOrReply(ctx, buildCountryText(0, totalPages), {
          parse_mode: "HTML",
          reply_markup: buildCountryKeyboard(0),
        });
      } catch (err) {
        console.error("[smsbower] ctry_cancel_search error:", err);
      }
    });

    // ── ctry_spg_<page> — Country search pagination ──────────────────────────
    bot.callbackQuery(/^ctry_spg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);
      userSearchModeState.delete(telegramId);

      const query = userCtrySearchQuery.get(telegramId);
      if (!query) {
        const { totalPages } = paginate(countries(), 0);
        await safeEditOrReply(ctx, buildCountryText(0, totalPages), {
          parse_mode: "HTML",
          reply_markup: buildCountryKeyboard(0),
        });
        return;
      }

      const qLower = query.toLowerCase();
      const matches = countries().filter(
        (c) => c.name.toLowerCase().includes(qLower) || c.id === query,
      );
      const page = parseInt(ctx.match[1]!, 10);
      const { totalPages } = paginate(matches, page);

      try {
        await safeEditOrReply(
          ctx,
          buildCountryText(page, totalPages, query, matches.length),
          {
            parse_mode: "HTML",
            reply_markup: buildCountryKeyboard(page, matches),
          },
        );
      } catch (err) {
        console.error(`[smsbower] ctry_spg_${page} error:`, err);
      }
    });

    // ── Back to Catalog ───────────────────────────────────────────────────────
    bot.callbackQuery(CB_CATALOG, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userSearchModeState.delete(String(ctx.from.id));
      try {
        await safeEditOrReply(ctx, await buildCatalogText(), {
          parse_mode: "HTML",
          reply_markup: await buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[smsbower] back-to-catalog error:", err);
      }
    });

    // ── setcountry_<countryId> — Service picker page 0 ───────────────────────
    bot.callbackQuery(/^setcountry_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userSearchModeState.delete(String(ctx.from.id));

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId = ctx.match[1]!;
      const country = findCountry(countryId);

      if (!country) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Unknown country. Please try again.",
          show_alert: true,
        });
        return;
      }

      // Guard: if loadData() failed at startup, the cache is empty.
      if (SMSBowerService.cachedServices.length === 0) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
            `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              "🔙 Back to Countries",
              "ctry_pg_0",
            ),
          },
        );
        return;
      }

      const totalPages = Math.max(
        1,
        Math.ceil(services().length / ITEMS_PER_PAGE),
      );
      try {
        // Show a brief loading state while we fetch prices (only on first open
        // per country — subsequent opens use the in-memory cache instantly).
        const needsPriceFetch = !SMSBowerService.priceCache.has(countryId);
        if (needsPriceFetch && ctx.msg && "text" in ctx.msg && ctx.msg.text) {
          await ctx
            .editMessageText(
              `💲 <b>Memuat harga untuk ${country.name}…</b>\n<i>Sebentar ya, hanya satu kali per sesi.</i>`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }

        const replyMarkup = await buildServiceKeyboard(countryId, 0);
        await safeEditOrReply(
          ctx,
          buildServiceText(country.name, 0, totalPages),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
      } catch (err) {
        console.error(`[smsbower] setcountry_${countryId} error:`, err);
      }
    });

    // ── srv_pg_<countryId>_<page> — Service list pagination ───────────────────
    bot.callbackQuery(/^srv_pg_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (ctx.from) userSearchModeState.delete(String(ctx.from.id));

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);
      const country = findCountry(countryId);

      if (!country) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Unknown country. Please try again.",
          show_alert: true,
        });
        return;
      }

      // Guard: if loadData() failed at startup, the cache is empty.
      if (SMSBowerService.cachedServices.length === 0) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
            `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text(
              "🔙 Back to Countries",
              "ctry_pg_0",
            ),
          },
        );
        return;
      }

      const totalPages = Math.max(
        1,
        Math.ceil(services().length / ITEMS_PER_PAGE),
      );
      try {
        const replyMarkup = await buildServiceKeyboard(countryId, page);
        await safeEditOrReply(
          ctx,
          buildServiceText(country.name, page, totalPages),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
      } catch (err) {
        console.error(`[smsbower] srv_pg_${countryId}_${page} error:`, err);
      }
    });

    // ── srv_search_<countryId> — Prompt for service search ───────────────────
    bot.callbackQuery(/^srv_search_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const countryId = ctx.match[1]!;
      const country = findCountry(countryId);
      const telegramId = String(from.id);

      userSearchModeState.set(telegramId, { type: "SERVICE", countryId });

      await safeEditOrReply(
        ctx,
        `🔍 <b>Pencarian Layanan OTP</b>\n` +
          `${"─".repeat(28)}\n\n` +
          `🌍 Negara: <b>${country?.name ?? countryId}</b>\n\n` +
          `Silakan ketik nama aplikasi atau kode layanan yang ingin dicari:\n` +
          `<i>Contoh: <code>WhatsApp</code>, <code>Telegram</code>, <code>TikTok</code>, <code>Shopee</code></i>\n\n` +
          `<i>Ketik /batal atau klik tombol di bawah untuk membatalkan.</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            "🔙 Batal Cari",
            `srv_cancel_search_${countryId}`,
          ),
        },
      );
    });

    // ── srv_cancel_search_<countryId> — Cancel service search ─────────────────
    bot.callbackQuery(/^srv_cancel_search_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (from) userSearchModeState.delete(String(from.id));

      const countryId = ctx.match[1]!;
      const country = findCountry(countryId);
      const totalPages = Math.max(
        1,
        Math.ceil(services().length / ITEMS_PER_PAGE),
      );
      try {
        const replyMarkup = await buildServiceKeyboard(countryId, 0);
        await safeEditOrReply(
          ctx,
          buildServiceText(country?.name ?? "Services", 0, totalPages),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
      } catch (err) {
        console.error(`[smsbower] srv_cancel_search_${countryId} error:`, err);
      }
    });

    // ── srv_spg_<countryId>_<page> — Service search pagination ────────────────
    bot.callbackQuery(/^srv_spg_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const from = ctx.from;
      if (!from) return;
      const telegramId = String(from.id);
      userSearchModeState.delete(telegramId);

      const countryId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);
      const country = findCountry(countryId);

      const srvSession = userSrvSearchQuery.get(telegramId);
      if (!srvSession || srvSession.countryId !== countryId) {
        const totalPages = Math.max(
          1,
          Math.ceil(services().length / ITEMS_PER_PAGE),
        );
        const replyMarkup = await buildServiceKeyboard(countryId, 0);
        await safeEditOrReply(
          ctx,
          buildServiceText(country?.name ?? "Services", 0, totalPages),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
        return;
      }

      const qLower = srvSession.query.toLowerCase();
      const matches = services().filter(
        (s) =>
          s.name.toLowerCase().includes(qLower) ||
          s.code.toLowerCase() === qLower,
      );
      const totalPages = Math.max(
        1,
        Math.ceil(matches.length / ITEMS_PER_PAGE),
      );

      try {
        const replyMarkup = await buildServiceKeyboard(
          countryId,
          page,
          matches,
        );
        await safeEditOrReply(
          ctx,
          buildServiceText(
            country?.name ?? "Services",
            page,
            totalPages,
            srvSession.query,
            matches.length,
          ),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
      } catch (err) {
        console.error(`[smsbower] srv_spg_${countryId}_${page} error:`, err);
      }
    });

    // ── buy_<countryId>_<serviceCode> — Purchase flow ────────────────────────
    bot.callbackQuery(/^buy_(\d+)_([a-z]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const from = ctx.from;
      if (!from) return;
      userSearchModeState.delete(String(from.id));

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId = ctx.match[1]!;
      const serviceCode = ctx.match[2]!;
      const country = findCountry(countryId);
      const service = findService(serviceCode);

      if (!country || !service) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan ini sudah tidak tersedia.",
          show_alert: true,
        });
        return;
      }

      const telegramId = String(from.id);
      const chatId = ctx.chat?.id ?? from.id;

      try {
        // ── 1. Verify registration ─────────────────────────────────────────────
        const dbUser = await User.findOne({ telegramId }).lean();
        if (!dbUser) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Silakan /register terlebih dahulu.",
            show_alert: true,
          });
          return;
        }

        // ── 2. Calculate selling price from cached price + markup ──────────────
        const [config, usdRate] = await Promise.all([
          SmsConfig.getOrCreate(),
          CurrencyService.getUsdRate(),
        ]);
        let cachedBaseCost =
          SMSBowerService.priceCache.get(countryId)?.get(serviceCode)?.cost ??
          0;
        if (cachedBaseCost <= 0) {
          const freshPrices =
            await SMSBowerService.getPricesForCountry(countryId);
          cachedBaseCost = freshPrices.get(serviceCode)?.cost ?? 0;
        }
        const sellingPrice = applyMarkup(
          cachedBaseCost,
          config.markupType,
          config.markupValue,
          usdRate,
        );

        // ── 3A. Sufficient balance → execute immediately ───────────────────────
        if (dbUser.balance >= sellingPrice && sellingPrice > 0) {
          await safeEditOrReply(
            ctx,
            `⏳ <b>Memproses nomor…</b>\n\n` +
              `🔧 Layanan: <b>${service.name}</b>\n` +
              `🌍 Negara: <b>${country.name}</b>\n\n` +
              `<i>Menghubungi provider SMS, mohon tunggu sebentar.</i>`,
            { parse_mode: "HTML" },
          );

          const msgId = ctx.msgId;
          if (!msgId) throw new Error("Could not resolve message ID.");

          await executePurchase(
            bot,
            chatId,
            msgId,
            telegramId,
            serviceCode,
            countryId,
          );
          return;
        }

        // ── 3B. Insufficient balance → generate dynamic GoPay QRIS ─────────────
        if (sellingPrice <= 0) {
          await safeEditOrReply(
            ctx,
            `⚠️ <b>Harga tidak tersedia.</b>\n\n` +
              `<i>Silakan kembali ke daftar layanan dan coba lagi.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text(
                "🔙 Kembali ke Layanan",
                `setcountry_${countryId}`,
              ),
            },
          );
          return;
        }

        const shortage = sellingPrice - dbUser.balance;

        // Show a brief loading state
        await safeEditOrReply(
          ctx,
          `💳 <b>Menyiapkan QRIS GoPay…</b>\n\n` +
            `<i>Sedang men-generate QRIS dinamis + kode unik pembayaran…</i>`,
          { parse_mode: "HTML" },
        );

        // Generate unique code & total payment amount to uniquely identify this transaction
        const { baseAmount, uniqueCode, totalAmount } =
          await getUniquePaymentAmount(shortage);

        // Generate unique order ID
        const orderId = `topup-${telegramId}-${Date.now()}`;

        // Generate dynamic QRIS with exact total amount
        const qrisResult = await generateQris(totalAmount);

        // Persist session in MongoDB with baseAmount & uniqueCode
        const session = await TopupSession.create({
          telegramId,
          chatId,
          messageId: ctx.msgId ?? 0,
          orderId,
          baseAmount,
          uniqueCode,
          amountIDR: totalAmount,
          pendingServiceCode: serviceCode,
          pendingCountryId: countryId,
          status: "PENDING",
        });

        // Broadcast audit log: Topup created
        ActivityLogService.logTopupCreated(ctx.api, {
          session,
          user: {
            telegramId,
            firstName: dbUser.firstName,
            username: dbUser.username,
          },
        }).catch((err) =>
          console.error("[smsbower] ActivityLog topup created error:", err),
        );

        // Build invoice caption with clear unique code explanation
        const caption =
          `💳 <b>Pembayaran QRIS — GoPay</b>\n` +
          `${"─".repeat(30)}\n\n` +
          `Saldo lu kurang! Silakan scan QRIS di atas untuk melanjutkan pembelian <b>${service.name}</b> (${country.name}).\n\n` +
          `💰 <b>Saldo kamu saat ini:</b> ${formatPrice(dbUser.balance)}\n` +
          `🏷️ <b>Harga layanan:</b>       ${formatPrice(sellingPrice)}\n` +
          `📉 <b>Kekurangan saldo:</b>    ${formatPrice(baseAmount)}\n` +
          `🔢 <b>Kode Unik:</b>           +${formatPrice(uniqueCode)}\n` +
          `${"─".repeat(30)}\n` +
          `💳 <b>TOTAL TRANSFER: <code>${formatPrice(totalAmount)}</code></b>\n` +
          `${"─".repeat(30)}\n\n` +
          `⚠️ <b>PENTING:</b>\n` +
          `Pastikan transfer dengan nominal <b>TEPAT ${formatPrice(totalAmount)}</b> (termasuk kode unik) agar mutasi otomatis terdeteksi.\n` +
          `<i>*Kelebihan kode unik (+${formatPrice(uniqueCode)}) otomatis masuk ke saldo akun kamu!</i>\n\n` +
          `<i>⏱ QR berlaku 15 menit. Setelah bayar, saldo otomatis masuk dan nomor langsung diproses.</i>`;

        const checkBtn = new InlineKeyboard()
          .text("✅ Saya Sudah Bayar", `chkpay_${orderId}`)
          .row()
          .text("❌ Batal", `cncltopup_${orderId}_${countryId}`);

        // Send QRIS image as photo
        const sentQrisMsg = await ctx.replyWithPhoto(
          new InputFile(qrisResult.buffer, "qris.png"),
          { caption, parse_mode: "HTML", reply_markup: checkBtn },
        );

        // Update session with sent message ID
        await TopupSession.findByIdAndUpdate(session._id, {
          messageId: sentQrisMsg.message_id,
        });

        // Delete the loading message
        try {
          await ctx.deleteMessage();
        } catch {
          /* non-critical */
        }

        // Start background polling for GoPay settlements
        startQrisPolling(
          bot,
          String(session._id),
          orderId,
          telegramId,
          chatId,
          sentQrisMsg.message_id,
          totalAmount,
          serviceCode,
          countryId,
          service.name,
          country.name,
        );
      } catch (err) {
        console.error(`[smsbower] buy_${countryId}_${serviceCode} error:`, err);
        try {
          await safeEditOrReply(
            ctx,
            `❌ <b>Gagal membuat QRIS.</b>\n\n` +
              `<i>${err instanceof Error ? err.message : "Terjadi kesalahan sistem."}</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text(
                "🔙 Kembali ke Layanan",
                `setcountry_${countryId}`,
              ),
            },
          );
        } catch {
          /* ignore */
        }
      }
    });

    // ── chkpay_<orderId> — Manual payment check ──────────────────────────────
    bot.callbackQuery(/^chkpay_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({
        text: "🔄 Mengecek mutasi pembayaran GoPay…",
      });

      const orderId = ctx.match[1]!;
      const from = ctx.from;
      if (!from) return;

      const telegramId = String(from.id);
      const chatId = ctx.chat?.id ?? from.id;

      try {
        const session = await TopupSession.findOne({ orderId });

        if (!session) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Sesi pembayaran tidak ditemukan.",
            show_alert: true,
          });
          return;
        }

        if (session.telegramId !== telegramId) {
          await ctx.answerCallbackQuery({
            text: "⛔ Kamu bukan pemilik invoice ini.",
            show_alert: true,
          });
          return;
        }

        if (session.status !== "PENDING") {
          await ctx.answerCallbackQuery({
            text:
              session.status === "SETTLED"
                ? "✅ Pembayaran sudah dikonfirmasi!"
                : "❌ Sesi ini sudah tidak aktif.",
            show_alert: true,
          });
          return;
        }

        const matchedTx = await checkSessionSettlement(session);

        if (matchedTx) {
          clearQrisPoll(orderId);

          // Credit balance
          const updatedUser = await User.findOneAndUpdate(
            { telegramId },
            { $inc: { balance: session.amountIDR } },
            { returnDocument: "after" },
          ).lean();

          const settledSession = await TopupSession.findByIdAndUpdate(
            session._id,
            {
              status: "SETTLED",
              matchedTransactionId: matchedTx.transactionId,
            },
            { returnDocument: "after" },
          );

          if (settledSession) {
            ActivityLogService.logTopupSettled(ctx.api, {
              session: settledSession,
              txId: matchedTx.transactionId,
              user: {
                telegramId,
                firstName: updatedUser?.firstName || ctx.from?.first_name,
                username: updatedUser?.username || ctx.from?.username,
              },
              newBalance: updatedUser?.balance,
            }).catch((err) =>
              console.error("[smsbower] ActivityLog topup settled error:", err),
            );
          }

          await ctx.editMessageCaption({
            caption:
              `✅ <b>Pembayaran Dikonfirmasi!</b>\n\n` +
              `💰 <b>${formatPrice(session.amountIDR)}</b> telah ditambahkan ke saldo kamu.\n\n` +
              `⏳ Sedang memproses pembelian otomatis…`,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard(),
          });

          // Auto-execute pending purchase
          await executePurchase(
            bot,
            chatId,
            ctx.msgId!,
            telegramId,
            session.pendingServiceCode ?? "",
            session.pendingCountryId ?? "",
          );
          return;
        }

        // Still pending
        await ctx.answerCallbackQuery({
          text: "⏳ Pembayaran belum terdeteksi. Silakan transfer terlebih dahulu atau coba lagi dalam beberapa detik.",
          show_alert: true,
        });
      } catch (err) {
        console.error(`[smsbower] chkpay error for ${orderId}:`, err);
        await ctx.answerCallbackQuery({
          text: "❌ Gagal mengecek status. Coba lagi.",
          show_alert: true,
        });
      }
    });

    // ── cncltopup_<orderId>_<countryId> — Cancel Topup Invoice ───────────────
    bot.callbackQuery(/^cncltopup_(.+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Invoice dibatalkan." });

      const orderId = ctx.match[1]!;
      const countryId = ctx.match[2]!;

      clearQrisPoll(orderId);
      const session = await TopupSession.findOneAndUpdate(
        { orderId },
        { status: "CANCELLED" },
        { returnDocument: "after" },
      );
      if (session) {
        ActivityLogService.logTopupCancelled(ctx.api, {
          session,
          reason: "Dibatalkan oleh Pengguna",
          user: {
            telegramId: String(ctx.from?.id),
            firstName: ctx.from?.first_name,
            username: ctx.from?.username,
          },
        }).catch((err) =>
          console.error("[smsbower] ActivityLog topup cancel error:", err),
        );
      }

      try {
        await ctx.deleteMessage();
      } catch {
        /* ignore */
      }

      const country = findCountry(countryId);
      const totalPages = Math.max(
        1,
        Math.ceil(services().length / ITEMS_PER_PAGE),
      );
      const replyMarkup = await buildServiceKeyboard(countryId, 0);
      await ctx.reply(
        buildServiceText(country?.name ?? "Services", 0, totalPages),
        {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        },
      );
    });

    // ── cancel_<activationId> — Manual cancellation ───────────────────────────
    bot.callbackQuery(/^cancel_(.+)$/, async (ctx) => {
      const activationId = ctx.match[1]!;

      try {
        const order = await Order.findOne({ activationId }).lean();
        if (!order) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Pesanan tidak ditemukan atau sudah selesai.",
            show_alert: true,
          });
          return;
        }

        if (order.status !== "PENDING") {
          await ctx.answerCallbackQuery({
            text: `Pesanan sudah ${order.status === "COMPLETED" ? "selesai (OTP sudah masuk)" : "dibatalkan"}.`,
            show_alert: true,
          });
          return;
        }

        // Check if OTP arrived right before user clicked cancel
        const currentStatus = await smsBower
          .getStatus(activationId)
          .catch(() => ({ kind: "WAIT_CODE" }) as const);
        if (currentStatus.kind === "OK") {
          clearPoll(activationId);
          await Order.findOneAndUpdate(
            { activationId },
            { status: "COMPLETED", code: currentStatus.code },
          );

          const user = await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { totalOrders: 1 } },
            { returnDocument: "after" },
          ).lean();

          // Broadcast audit log to dedicated channel
          const countryName =
            SMSBowerService.allCountries.find(
              (c) => c.id === String(order.country),
            )?.name || String(order.country);

          TestimonialService.sendOtpPurchaseTestimonial(ctx.api, {
            activationId,
            serviceName: order.service,
            countryName,
            phoneNumber: order.phoneNumber,
            cost: order.cost,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName || ctx.from?.first_name,
              username: user?.username || ctx.from?.username,
            },
            date: new Date(),
          }).catch((err) =>
            console.error("[smsbower] Testimonial broadcast error:", err),
          );

          ActivityLogService.logOtpSuccess(ctx.api, {
            activationId,
            serviceName: order.service,
            countryName,
            phoneNumber: order.phoneNumber,
            code: currentStatus.code,
            buyer: {
              telegramId: String(order.userId),
              firstName: user?.firstName || ctx.from?.first_name,
              username: user?.username || ctx.from?.username,
            },
          }).catch((err) =>
            console.error("[smsbower] ActivityLog OTP success error:", err),
          );

          await ctx.answerCallbackQuery({
            text: "⚠️ Kode OTP sudah masuk! Pesanan tidak dapat dibatalkan.",
            show_alert: true,
          });

          await safeEditOrReply(
            ctx,
            buildSuccessText(
              order.phoneNumber,
              order.service,
              currentStatus.code,
            ),
            { parse_mode: "HTML" },
          );
          return;
        }

        // Stop the poller first — prevents a race between setStatus and DB update.
        clearPoll(activationId);

        // Status 8 = cancel / refund the number on SMSBower
        await smsBower.setStatus(activationId, "8");
        await Order.findOneAndUpdate({ activationId }, { status: "CANCELED" });

        // Refund user balance
        await User.findOneAndUpdate(
          { telegramId: String(order.userId) },
          { $inc: { balance: order.cost } },
        );

        await ctx.answerCallbackQuery({
          text: "✅ Pesanan berhasil dibatalkan dan saldo telah dikembalikan.",
        });

        const user = await User.findOne({
          telegramId: String(order.userId),
        }).lean();
        ActivityLogService.logOtpCancelled(ctx.api, {
          activationId,
          serviceName: order.service,
          phoneNumber: order.phoneNumber,
          reason: "Dibatalkan oleh Pengguna",
          cost: order.cost,
          buyer: {
            telegramId: String(order.userId),
            firstName: user?.firstName || ctx.from?.first_name,
            username: user?.username || ctx.from?.username,
          },
        }).catch((err) =>
          console.error("[smsbower] ActivityLog OTP cancel error:", err),
        );

        await safeEditOrReply(
          ctx,
          buildCanceledText(order.phoneNumber, "user"),
          { parse_mode: "HTML" },
        );
      } catch (err) {
        console.error(`[smsbower] cancel error for ${activationId}:`, err);
        await ctx.answerCallbackQuery({
          text: "❌ Gagal membatalkan pesanan. Silakan coba lagi.",
          show_alert: true,
        });
      }
    });

    // ── Interactive Text Listener for Country / Service Search ──────────────
    bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (!from) return next();

      const telegramId = String(from.id);
      const searchMode = userSearchModeState.get(telegramId);
      if (!searchMode) return next();

      const rawText = ctx.message.text.trim();

      // Handle cancellation
      if (
        rawText === "/batal" ||
        rawText === "/cancel" ||
        rawText.toLowerCase() === "batal"
      ) {
        userSearchModeState.delete(telegramId);
        if (searchMode.type === "COUNTRY") {
          const { totalPages } = paginate(countries(), 0);
          await ctx.reply("❌ Pencarian negara dibatalkan.", {
            reply_markup: buildCountryKeyboard(0),
          });
        } else {
          const country = findCountry(searchMode.countryId);
          const replyMarkup = await buildServiceKeyboard(
            searchMode.countryId,
            0,
          );
          await ctx.reply(
            `❌ Pencarian layanan untuk <b>${country?.name ?? "Negara"}</b> dibatalkan.`,
            {
              parse_mode: "HTML",
              reply_markup: replyMarkup,
            },
          );
        }
        return;
      }

      // If user typed another command, release search state and pass through
      if (rawText.startsWith("/")) {
        userSearchModeState.delete(telegramId);
        return next();
      }

      const query = rawText;
      const qLower = query.toLowerCase();

      if (searchMode.type === "COUNTRY") {
        userSearchModeState.delete(telegramId);
        const matches = countries().filter(
          (c) => c.name.toLowerCase().includes(qLower) || c.id === query,
        );

        if (matches.length === 0) {
          await ctx.reply(
            `❌ <b>Negara Tidak Ditemukan</b>\n\n` +
              `Tidak ditemukan negara dengan kata kunci: <code>${escapeHtml(query)}</code>.\n\n` +
              `<i>Silakan cari dengan kata kunci lain atau buka daftar lengkap semua negara.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔍 Cari Ulang", "ctry_search")
                .text("🌍 Semua Negara", "ctry_pg_0"),
            },
          );
          return;
        }

        userCtrySearchQuery.set(telegramId, query);
        const { totalPages } = paginate(matches, 0);
        await ctx.reply(
          buildCountryText(0, totalPages, query, matches.length),
          {
            parse_mode: "HTML",
            reply_markup: buildCountryKeyboard(0, matches),
          },
        );
        return;
      }

      if (searchMode.type === "SERVICE") {
        userSearchModeState.delete(telegramId);
        const countryId = searchMode.countryId;
        const country = findCountry(countryId);
        const matches = services().filter(
          (s) =>
            s.name.toLowerCase().includes(qLower) ||
            s.code.toLowerCase() === qLower,
        );

        if (matches.length === 0) {
          await ctx.reply(
            `❌ <b>Layanan Tidak Ditemukan</b>\n\n` +
              `Tidak ditemukan layanan dengan kata kunci: <code>${escapeHtml(query)}</code> di negara <b>${country?.name ?? countryId}</b>.\n\n` +
              `<i>Silakan cari dengan kata kunci lain atau buka semua daftar layanan.</i>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔍 Cari Ulang", `srv_search_${countryId}`)
                .text("📱 Semua Layanan", `setcountry_${countryId}`),
            },
          );
          return;
        }

        userSrvSearchQuery.set(telegramId, { countryId, query });
        const totalPages = Math.max(
          1,
          Math.ceil(matches.length / ITEMS_PER_PAGE),
        );
        const replyMarkup = await buildServiceKeyboard(countryId, 0, matches);
        await ctx.reply(
          buildServiceText(
            country?.name ?? "Services",
            0,
            totalPages,
            query,
            matches.length,
          ),
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
        return;
      }

      return next();
    });

    console.log(
      "   → product_otp | ctry_pg_<n> | ctry_search | ctry_spg_<n> | setcountry_<id> | srv_pg_<id>_<n> | srv_search_<id> | srv_spg_<id>_<n> | buy_<c>_<s> | chkpay_<id> | cncltopup_<id> | cancel_<id> registered",
    );
  },
};

export default smsBowerPlugin;
