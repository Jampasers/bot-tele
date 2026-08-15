import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User } from "../../models/User.js";
import { Order } from "../../models/Order.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { TopupSession, ITopupSession } from "../../models/TopupSession.js";
import { smsBower, SMSBowerService, CachedCountry, CachedService, CountryPriceMap } from "../../services/smsbower.js";
import { TestimonialService } from "../../services/testimonial.js";
import { generateQris, checkSessionSettlement, getUniquePaymentAmount } from "../../services/payment/index.js";
import { CB_CATALOG, buildCatalogText, buildCatalogKeyboard } from "../panel/index.js";

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
const services  = (): readonly Service[]  => SMSBowerService.cachedServices;

// ============================================================================
//  PAGINATION
// ============================================================================

/** Maximum items to show per keyboard page. */
const ITEMS_PER_PAGE = 10;

interface PageResult<T> {
  items:      readonly T[];  // the slice for this page
  totalPages: number;        // total number of pages
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
  array:    readonly T[],
  page:     number,
  pageSize: number = ITEMS_PER_PAGE
): PageResult<T> {
  const totalPages = Math.max(1, Math.ceil(array.length / pageSize));
  const safePage   = Math.max(0, Math.min(page, totalPages - 1));
  const start      = safePage * pageSize;
  return {
    items:      array.slice(start, start + pageSize),
    totalPages,
  };
}

// ============================================================================
//  TIMING CONSTANTS
// ============================================================================

/** How often to ask SMSBower "did the OTP arrive yet?" */
const POLL_INTERVAL_MS = 10_000;           // 10 seconds

/** Auto-cancel the order after this much waiting. */
const ORDER_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes

/** How often to poll Midtrans for QRIS payment confirmation. */
const QRIS_POLL_INTERVAL_MS = 10_000;      // 10 seconds

/** Give up waiting for QRIS payment after this long (Midtrans QR = 15 min). */
const QRIS_TIMEOUT_MS = 14 * 60 * 1_000;  // 14 minutes

// ============================================================================
//  PRICING HELPER
// ============================================================================

/**
 * Calculates the final selling price the user will be charged.
 *
 * @param baseCost    The raw activation cost returned by SMSBower (in credits).
 * @param markupType  "fixed" | "percentage"
 * @param markupValue The markup amount (flat units or percent).
 * @returns           Final price, rounded to the nearest whole number.
 *
 * @example
 * applyMarkup(1000, "fixed",      500)  // → 1500
 * applyMarkup(1000, "percentage",  10)  // → 1100  (1000 + 10%)
 */
function applyMarkup(
  baseCost:    number,
  markupType:  "fixed" | "percentage",
  markupValue: number
): number {
  if (markupType === "percentage") {
    return Math.round(baseCost + baseCost * (markupValue / 100));
  }
  return Math.round(baseCost + markupValue); // "fixed"
}

/**
 * Formats a credit amount as a Rupiah string.
 * Credits are in IDR units (1 credit = Rp1).
 *
 * @example
 * formatPrice(3500)  // → "Rp3.500"
 * formatPrice(12000) // → "Rp12.000"
 */
function formatPrice(credits: number): string {
  // Indonesian locale uses period as thousands separator.
  return "Rp" + credits.toLocaleString("id-ID");
}

// ============================================================================
//  KEYBOARD BUILDERS
// ============================================================================

/**
 * Appends items to an InlineKeyboard in 2-column rows.
 * Returns the keyboard for chaining.
 */
function rowsOf2(
  kb:    InlineKeyboard,
  items: ReadonlyArray<{ label: string; data: string }>
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
  kb:         InlineKeyboard,
  page:       number,
  totalPages: number,
  prevCb:     string,
  nextCb:     string
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
//  pagination callback_data : ctry_pg_<page>
//  Back button              : menu_catalog  (CB_CATALOG)
// ─────────────────────────────────────────────────────────────────────────────

function buildCountryKeyboard(page: number): InlineKeyboard {
  const { items, totalPages } = paginate(countries(), page);
  const kb = new InlineKeyboard();

  rowsOf2(
    kb,
    items.map((c) => ({ label: c.name, data: `setcountry_${c.id}` }))
  );

  appendPaginationRow(
    kb, page, totalPages,
    `ctry_pg_${page - 1}`,
    `ctry_pg_${page + 1}`
  );

  kb.text("🔙 Back to Catalog", CB_CATALOG);
  return kb;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Service keyboard  (Step 2)
//  callback_data per button : buy_<countryId>_<serviceCode>
//  pagination callback_data : srv_pg_<countryId>_<page>
//  Back button              : ctry_pg_0  (return to country list page 0)
//
//  Each button label: "<Service Name> - <FinalPrice>"  e.g. "WhatsApp - Rp3.500"
//  Prices are fetched once per country from the API then cached in memory.
// ─────────────────────────────────────────────────────────────────────────────

async function buildServiceKeyboard(
  countryId:  string,
  page:       number
): Promise<InlineKeyboard> {
  const allServices = services();
  const totalPages  = Math.max(1, Math.ceil(allServices.length / ITEMS_PER_PAGE));
  const safePage    = Math.max(0, Math.min(page, totalPages - 1));
  const start       = safePage * ITEMS_PER_PAGE;
  const end         = start + ITEMS_PER_PAGE;
  const chunk       = allServices.slice(start, end);

  // ─ Fetch prices (cached after first call) + markup config in parallel.
  const [priceMap, config] = await Promise.all([
    SMSBowerService.getPricesForCountry(countryId),
    SmsConfig.getOrCreate(),
  ]);

  const kb = new InlineKeyboard();

  // Build 1-button-per-row layout when prices are shown — the label is too
  // wide for 2 columns on most phones. Falls back gracefully if no price found.
  for (const svc of chunk) {
    const priceEntry = priceMap.get(svc.code);

    let label: string;
    if (priceEntry && priceEntry.cost > 0) {
      const selling = applyMarkup(priceEntry.cost, config.markupType, config.markupValue);
      const stock   = priceEntry.count > 0 ? "" : " ⚠️";
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
    if (hasPrev) kb.text("⬅️ Prev", `srv_pg_${countryId}_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `srv_pg_${countryId}_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Back to Countries", "ctry_pg_0");
  return kb;
}

/** Active-order keyboard — only a Cancel button. */
function buildCancelKeyboard(activationId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("❌ Cancel Order", `cancel_${activationId}`);
}

// ============================================================================
//  MESSAGE BUILDERS — pure functions, no side-effects
// ============================================================================

function buildCountryText(page: number, totalPages: number): string {
  const pageInfo = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : "";
  return (
    `🌍 <b>Select a Country</b>${pageInfo}\n` +
    `${"─".repeat(28)}\n\n` +
    `Choose the country you want to receive an OTP from:\n\n` +
    `<i>Powered by SMSBower</i>`
  );
}

function buildServiceText(
  countryName: string,
  page:        number,
  totalPages:  number
): string {
  const pageInfo = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : "";
  return (
    `📱 <b>Select a Service</b>${pageInfo}\n` +
    `${"─".repeat(28)}\n\n` +
    `🌍 Country: <b>${countryName}</b>\n\n` +
    `<i>Select the app you need an OTP for.</i>`
  );
}

function buildPendingText(
  phoneNumber:  string,
  serviceName:  string,
  countryName:  string,
  sellingPrice: number,
  baseCost:     number,
  markupType:   "fixed" | "percentage",
  markupValue:  number
): string {
  const markupLine =
    markupType === "percentage"
      ? `+${markupValue}% markup`
      : `+${markupValue} markup`;
  return (
    `⏳ <b>Waiting for OTP</b>\n` +
    `${"\u2500".repeat(28)}\n\n` +
    `📱 <b>Number:</b>   <code>+${phoneNumber}</code>\n` +
    `🔧 <b>Service:</b>  ${serviceName}\n` +
    `🌍 <b>Country:</b>  ${countryName}\n` +
    `💰 <b>Cost:</b>     <b>${sellingPrice}</b> credits ` +
    `<i>(base ${baseCost} + ${markupLine})</i>\n\n` +
    `Use the number above to request your OTP.\n` +
    `I'll send the code here automatically within <b>10 minutes</b>.\n\n` +
    `<i>Checking every 10 seconds…</i>`
  );
}

function buildSuccessText(
  phoneNumber: string,
  serviceName: string,
  code:        string
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
  reason:      "user" | "timeout"
): string {
  const why =
    reason === "timeout"
      ? "⏰ Order timed out after 10 minutes."
      : "❌ You cancelled the order.";
  return (
    `🚫 <b>Order Cancelled</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `📱 <b>Number:</b> <code>+${phoneNumber}</code>\n\n` +
    `${why}\n` +
    `Your balance has been refunded.\n\n` +
    `<i>Use /start to return to the main menu.</i>`
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
  bot:         Bot<Context>,
  sessionId:   string,
  orderId:     string,
  telegramId:  string,
  chatId:      number,
  messageId:   number,
  amountIDR:   number,
  serviceCode: string,
  countryId:   string,
  serviceName: string,
  countryName: string
): void {
  const startedAt = Date.now();

  const handle = setInterval(async () => {
    try {
      // ── Timeout guard ────────────────────────────────────────────────────
      if (Date.now() - startedAt >= QRIS_TIMEOUT_MS) {
        clearQrisPoll(orderId);
        await TopupSession.findByIdAndUpdate(sessionId, { status: "EXPIRED" });
        try {
          await bot.api.editMessageCaption(chatId, messageId, {
            caption:
              `⌛ <b>QRIS Kedaluwarsa</b>\n\n` +
              `QR code untuk pembayaran <b>${formatPrice(amountIDR)}</b> sudah tidak berlaku.\n\n` +
              `<i>Silakan klik tombol beli lagi untuk mendapatkan QR baru.</i>`,
            parse_mode: "HTML",
          });
        } catch {
          await bot.api.editMessageText(
            chatId, messageId,
            `⌛ <b>QRIS Kedaluwarsa</b>\n\n` +
            `QR code untuk pembayaran <b>${formatPrice(amountIDR)}</b> sudah tidak berlaku.\n\n` +
            `<i>Silakan klik tombol beli lagi untuk mendapatkan QR baru.</i>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
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
        await User.findOneAndUpdate(
          { telegramId },
          { $inc: { balance: amountIDR } }
        );
        await TopupSession.findByIdAndUpdate(sessionId, {
          status: "SETTLED",
          matchedTransactionId: matchedTx.transactionId,
        });

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
          await bot.api.editMessageText(
            chatId, messageId,
            `✅ <b>Pembayaran Diterima!</b>\n\n` +
            `💰 <b>${formatPrice(amountIDR)}</b> telah ditambahkan ke saldo kamu.\n\n` +
            `⏳ Sedang memproses pembelian <b>${serviceName}</b> otomatis…`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }

        // Auto-execute the pending purchase
        await executePurchase(bot, chatId, messageId, telegramId, serviceCode, countryId);
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
  bot:         Bot<Context>,
  chatId:      number,
  messageId:   number,
  telegramId:  string,
  serviceCode: string,
  countryId:   string
): Promise<void> {
  const service = findService(serviceCode);
  const country = findCountry(countryId);

  // Re-fetch the user to get the current (post-credit) balance and validate.
  const dbUser = await User.findOne({ telegramId }).lean();
  if (!dbUser || !service || !country) {
    await bot.api.sendMessage(
      chatId,
      `❌ <b>Gagal memproses pembelian.</b>\n<i>Data pengguna atau layanan tidak ditemukan.</i>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  const config       = await SmsConfig.getOrCreate();
  const sellingPrice = applyMarkup(
    SMSBowerService.priceCache.get(countryId)?.get(serviceCode)?.cost ?? 0,
    config.markupType,
    config.markupValue
  );

  if (dbUser.balance < sellingPrice) {
    await bot.api.sendMessage(
      chatId,
      `⚠️ <b>Saldo masih kurang.</b>\n\n` +
      `Saldo: <b>${formatPrice(dbUser.balance)}</b>\n` +
      `Harga: <b>${formatPrice(sellingPrice)}</b>\n\n` +
      `<i>Silakan top up saldo terlebih dahulu.</i>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  // Deduct balance atomically.
  await User.findOneAndUpdate(
    { telegramId },
    { $inc: { balance: -sellingPrice } }
  );

  let activationId = "";
  let phoneNumber  = "";
  let baseCost     = 0;

  try {
    const result = await smsBower.getNumber(serviceCode, countryId);
    activationId  = result.activationId;
    phoneNumber   = result.phoneNumber;
    baseCost      = result.activationCost;
  } catch (err) {
    // Provider failed — refund balance immediately
    await User.findOneAndUpdate(
      { telegramId },
      { $inc: { balance: sellingPrice } }
    );
    const reason = err instanceof Error ? err.message : "Layanan tidak tersedia.";
    await bot.api.sendMessage(
      chatId,
      `❌ <b>Stok kosong/gagal, saldo telah dikembalikan ke akun lu.</b>\n\n` +
      `<i>Alasan: ${reason}</i>\n` +
      `💰 Saldo <b>${formatPrice(sellingPrice)}</b> aman di akun kamu.`,
      {
        parse_mode:   "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔙 Kembali ke Layanan", `setcountry_${countryId}`),
      }
    ).catch(() => {});
    return;
  }

  // Save order.
  await Order.create({
    userId:       parseInt(telegramId, 10),
    activationId,
    service:      serviceCode,
    country:      Number(countryId),
    phoneNumber,
    cost:         sellingPrice,
    status:       "PENDING",
  });

  // Show the pending OTP screen.
  const sentMsg = await bot.api.sendMessage(
    chatId,
    buildPendingText(
      phoneNumber, service.name, country.name,
      sellingPrice, baseCost, config.markupType, config.markupValue
    ),
    {
      parse_mode:   "HTML",
      reply_markup: buildCancelKeyboard(activationId),
    }
  );

  startPolling(bot, chatId, sentMsg.message_id, activationId, phoneNumber, service.name);
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
  bot:          Bot<Context>,
  chatId:       number,
  messageId:    number,
  activationId: string,
  phoneNumber:  string,
  serviceName:  string
): void {
  const startedAt = Date.now();

  const handle = setInterval(async () => {
    try {
      // ── Timeout guard ──────────────────────────────────────────────────────
      if (Date.now() - startedAt >= ORDER_TIMEOUT_MS) {
        clearPoll(activationId);
        await smsBower.setStatus(activationId, "8");
        await Order.findOneAndUpdate({ activationId }, { status: "CANCELED" });
        await bot.api.editMessageText(
          chatId, messageId,
          buildCanceledText(phoneNumber, "timeout"),
          { parse_mode: "HTML" }
        );
        return;
      }

      // ── Status check ───────────────────────────────────────────────────────
      const status = await smsBower.getStatus(activationId);

      if (status.kind === "OK") {
        clearPoll(activationId);

        await Order.findOneAndUpdate(
          { activationId },
          { status: "COMPLETED", code: status.code }
        );

        const order = await Order.findOne({ activationId }).lean();
        if (order) {
          const user = await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { totalOrders: 1 } },
            { new: true }
          ).lean();

          // Broadcast testimonial to channel
          const countryName =
            SMSBowerService.allCountries.find((c) => c.id === String(order.country))?.name ||
            String(order.country);

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
          }).catch((err) => console.error("[smsbower] Testimonial broadcast error:", err));
        }

        await bot.api.editMessageText(
          chatId, messageId,
          buildSuccessText(phoneNumber, serviceName, status.code),
          { parse_mode: "HTML" }
        );
        return;
      }

      if (status.kind === "CANCEL") {
        clearPoll(activationId);
        await Order.findOneAndUpdate({ activationId }, { status: "CANCELED" });
        await bot.api.editMessageText(
          chatId, messageId,
          buildCanceledText(phoneNumber, "user"),
          { parse_mode: "HTML" }
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
  }
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
    if (desc.includes("there is no text in the message to edit") || desc.includes("message to edit not found")) {
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
  name:    "smsbower",
  version: "3.0.0",
  // No slash commands — entirely callback-query driven.

  register(bot: Bot<Context>): void {

    // ── product_otp — Country picker page 0 ──────────────────────────────────
    bot.callbackQuery("product_otp", async (ctx) => {
      await ctx.answerCallbackQuery();
      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Layanan OTP SMS Nonaktif</b>\n\n` +
          `Mohon maaf, layanan sewa nomor virtual OTP SMS saat ini sedang dinonaktifkan oleh admin untuk pemeliharaan / maintenance.\n\n` +
          `<i>Silakan cek kembali nanti atau gunakan produk lainnya di katalog kami.</i>`,
          {
            parse_mode:   "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali ke Katalog", CB_CATALOG),
          }
        );
        return;
      }

      const { totalPages } = paginate(countries(), 0);
      try {
        await safeEditOrReply(ctx, buildCountryText(0, totalPages), {
          parse_mode:   "HTML",
          reply_markup: buildCountryKeyboard(0),
        });
      } catch (err) {
        console.error("[smsbower] product_otp error:", err);
      }
    });

    // ── ctry_pg_<page> — Country list pagination ──────────────────────────────
    bot.callbackQuery(/^ctry_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
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
          parse_mode:   "HTML",
          reply_markup: buildCountryKeyboard(page),
        });
      } catch (err) {
        console.error(`[smsbower] ctry_pg_${page} error:`, err);
      }
    });

    // ── Back to Catalog ───────────────────────────────────────────────────────
    bot.callbackQuery(CB_CATALOG, async (ctx) => {
      await ctx.answerCallbackQuery();
      try {
        await safeEditOrReply(ctx, await buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: await buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[smsbower] back-to-catalog error:", err);
      }
    });

    // ── setcountry_<countryId> — Service picker page 0 ───────────────────────
    bot.callbackQuery(/^setcountry_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId = ctx.match[1]!;
      const country   = findCountry(countryId);

      if (!country) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Unknown country. Please try again.", show_alert: true,
        });
        return;
      }

      // Guard: if loadData() failed at startup, the cache is empty.
      if (SMSBowerService.cachedServices.length === 0) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
          `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          { parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Back to Countries", "ctry_pg_0") }
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(services().length / ITEMS_PER_PAGE));
      try {
        // Show a brief loading state while we fetch prices (only on first open
        // per country — subsequent opens use the in-memory cache instantly).
        const needsPriceFetch = !SMSBowerService.priceCache.has(countryId);
        if (needsPriceFetch && ctx.msg && "text" in ctx.msg && ctx.msg.text) {
          await ctx.editMessageText(
            `💲 <b>Memuat harga untuk ${country.name}…</b>\n<i>Sebentar ya, hanya satu kali per sesi.</i>`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }

        const replyMarkup = await buildServiceKeyboard(countryId, 0);
        await safeEditOrReply(ctx, buildServiceText(country.name, 0, totalPages), {
          parse_mode:   "HTML",
          reply_markup: replyMarkup,
        });
      } catch (err) {
        console.error(`[smsbower] setcountry_${countryId} error:`, err);
      }
    });

    // ── srv_pg_<countryId>_<page> — Service list pagination ───────────────────
    bot.callbackQuery(/^srv_pg_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId = ctx.match[1]!;
      const page      = parseInt(ctx.match[2]!, 10);
      const country   = findCountry(countryId);

      if (!country) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Unknown country. Please try again.", show_alert: true,
        });
        return;
      }

      // Guard: if loadData() failed at startup, the cache is empty.
      if (SMSBowerService.cachedServices.length === 0) {
        await safeEditOrReply(
          ctx,
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
          `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          { parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Back to Countries", "ctry_pg_0") }
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(services().length / ITEMS_PER_PAGE));
      try {
        const replyMarkup = await buildServiceKeyboard(countryId, page);
        await safeEditOrReply(ctx, buildServiceText(country.name, page, totalPages), {
          parse_mode:   "HTML",
          reply_markup: replyMarkup,
        });
      } catch (err) {
        console.error(`[smsbower] srv_pg_${countryId}_${page} error:`, err);
      }
    });

    // ── buy_<countryId>_<serviceCode> — Purchase flow ────────────────────────
    bot.callbackQuery(/^buy_(\d+)_([a-z]+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const from = ctx.from;
      if (!from) return;

      const config = await SmsConfig.getOrCreate();
      if (config.enabled === false) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan OTP SMS sedang dinonaktifkan / maintenance.",
          show_alert: true,
        });
        return;
      }

      const countryId   = ctx.match[1]!;
      const serviceCode = ctx.match[2]!;
      const country     = findCountry(countryId);
      const service     = findService(serviceCode);

      if (!country || !service) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Layanan ini sudah tidak tersedia.", show_alert: true,
        });
        return;
      }

      const telegramId = String(from.id);
      const chatId     = ctx.chat?.id ?? from.id;

      try {
        // ── 1. Verify registration ─────────────────────────────────────────────
        const dbUser = await User.findOne({ telegramId }).lean();
        if (!dbUser) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Silakan /register terlebih dahulu.", show_alert: true,
          });
          return;
        }

        // ── 2. Calculate selling price from cached price + markup ──────────────
        const config         = await SmsConfig.getOrCreate();
        const cachedBaseCost = SMSBowerService.priceCache.get(countryId)?.get(serviceCode)?.cost ?? 0;
        const sellingPrice   = applyMarkup(cachedBaseCost, config.markupType, config.markupValue);

        // ── 3A. Sufficient balance → execute immediately ───────────────────────
        if (dbUser.balance >= sellingPrice && sellingPrice > 0) {
          await safeEditOrReply(
            ctx,
            `⏳ <b>Memproses nomor…</b>\n\n` +
            `🔧 Layanan: <b>${service.name}</b>\n` +
            `🌍 Negara: <b>${country.name}</b>\n\n` +
            `<i>Menghubungi provider SMS, mohon tunggu sebentar.</i>`,
            { parse_mode: "HTML" }
          );

          const msgId = ctx.msgId;
          if (!msgId) throw new Error("Could not resolve message ID.");

          await executePurchase(bot, chatId, msgId, telegramId, serviceCode, countryId);
          return;
        }

        // ── 3B. Insufficient balance → generate dynamic GoPay QRIS ─────────────
        if (sellingPrice <= 0) {
          await safeEditOrReply(
            ctx,
            `⚠️ <b>Harga tidak tersedia.</b>\n\n` +
            `<i>Silakan kembali ke daftar layanan dan coba lagi.</i>`,
            {
              parse_mode:   "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔙 Kembali ke Layanan", `setcountry_${countryId}`),
            }
          );
          return;
        }

        const shortage = sellingPrice - dbUser.balance;

        // Show a brief loading state
        await safeEditOrReply(
          ctx,
          `💳 <b>Menyiapkan QRIS GoPay…</b>\n\n` +
          `<i>Sedang men-generate QRIS dinamis + kode unik pembayaran…</i>`,
          { parse_mode: "HTML" }
        );

        // Generate unique code & total payment amount to uniquely identify this transaction
        const { baseAmount, uniqueCode, totalAmount } = await getUniquePaymentAmount(shortage);

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
          amountIDR:          totalAmount,
          pendingServiceCode: serviceCode,
          pendingCountryId:   countryId,
          status:             "PENDING",
        });

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
          { caption, parse_mode: "HTML", reply_markup: checkBtn }
        );

        // Update session with sent message ID
        await TopupSession.findByIdAndUpdate(session._id, {
          messageId: sentQrisMsg.message_id,
        });

        // Delete the loading message
        try { await ctx.deleteMessage(); } catch { /* non-critical */ }

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
          country.name
        );

      } catch (err) {
        console.error(`[smsbower] buy_${countryId}_${serviceCode} error:`, err);
        try {
          await safeEditOrReply(
            ctx,
            `❌ <b>Gagal membuat QRIS.</b>\n\n` +
            `<i>${err instanceof Error ? err.message : "Terjadi kesalahan sistem."}</i>`,
            {
              parse_mode:   "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔙 Kembali ke Layanan", `setcountry_${countryId}`),
            }
          );
        } catch { /* ignore */ }
      }
    });

    // ── chkpay_<orderId> — Manual payment check ──────────────────────────────
    bot.callbackQuery(/^chkpay_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: "🔄 Mengecek mutasi pembayaran GoPay…" });

      const orderId = ctx.match[1]!;
      const from = ctx.from;
      if (!from) return;

      const telegramId = String(from.id);
      const chatId     = ctx.chat?.id ?? from.id;

      try {
        const session = await TopupSession.findOne({ orderId });

        if (!session) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Sesi pembayaran tidak ditemukan.", show_alert: true,
          });
          return;
        }

        if (session.telegramId !== telegramId) {
          await ctx.answerCallbackQuery({
            text: "⛔ Kamu bukan pemilik invoice ini.", show_alert: true,
          });
          return;
        }

        if (session.status !== "PENDING") {
          await ctx.answerCallbackQuery({
            text: session.status === "SETTLED"
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
          await User.findOneAndUpdate(
            { telegramId },
            { $inc: { balance: session.amountIDR } }
          );
          await TopupSession.findByIdAndUpdate(session._id, {
            status: "SETTLED",
            matchedTransactionId: matchedTx.transactionId,
          });

          await ctx.editMessageCaption({
            caption:
              `✅ <b>Pembayaran Dikonfirmasi!</b>\n\n` +
              `💰 <b>${formatPrice(session.amountIDR)}</b> telah ditambahkan ke saldo kamu.\n\n` +
              `⏳ Sedang memproses pembelian otomatis…`,
            parse_mode:   "HTML",
            reply_markup: new InlineKeyboard(),
          });

          // Auto-execute pending purchase
          await executePurchase(
            bot,
            chatId,
            ctx.msgId!,
            telegramId,
            session.pendingServiceCode ?? "",
            session.pendingCountryId   ?? ""
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

      const orderId   = ctx.match[1]!;
      const countryId = ctx.match[2]!;

      clearQrisPoll(orderId);
      await TopupSession.findOneAndUpdate({ orderId }, { status: "CANCELLED" });

      try {
        await ctx.deleteMessage();
      } catch { /* ignore */ }

      const country = findCountry(countryId);
      const totalPages = Math.max(1, Math.ceil(services().length / ITEMS_PER_PAGE));
      const replyMarkup = await buildServiceKeyboard(countryId, 0);
      await ctx.reply(buildServiceText(country?.name ?? "Services", 0, totalPages), {
        parse_mode:   "HTML",
        reply_markup: replyMarkup,
      });
    });

    // ── cancel_<activationId> — Manual cancellation ───────────────────────────
    bot.callbackQuery(/^cancel_(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const activationId = ctx.match[1]!;

      try {
        // Stop the poller first — prevents a race between setStatus and DB update.
        clearPoll(activationId);

        const order = await Order.findOne({ activationId }).lean();
        if (!order) {
          await safeEditOrReply(
            ctx,
            "⚠️ Order not found — it may have already been processed.",
            { parse_mode: "HTML" }
          );
          return;
        }

        if (order.status !== "PENDING") {
          await ctx.answerCallbackQuery({
            text: `Order is already ${order.status}.`, show_alert: true,
          });
          return;
        }

        // Status 8 = cancel / refund the number.
        await smsBower.setStatus(activationId, "8");
        await Order.findOneAndUpdate({ activationId }, { status: "CANCELED" });

        await safeEditOrReply(
          ctx,
          buildCanceledText(order.phoneNumber, "user"),
          { parse_mode: "HTML" }
        );

      } catch (err) {
        console.error(`[smsbower] cancel error for ${activationId}:`, err);
        await safeEditOrReply(
          ctx,
          "❌ Failed to cancel. Please try again or contact support.",
          { parse_mode: "HTML" }
        );
      }
    });

    console.log(
      "   → product_otp | ctry_pg_<n> | setcountry_<id> | srv_pg_<id>_<n> | buy_<c>_<s> | chkpay_<id> | cncltopup_<id> | cancel_<id> registered"
    );

  },
};

export default smsBowerPlugin;
