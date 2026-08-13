import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { User } from "../../models/User.js";
import { Order } from "../../models/Order.js";
import { smsBower, SMSBowerService, CachedCountry, CachedService } from "../../services/smsbower.js";
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
// ─────────────────────────────────────────────────────────────────────────────

function buildServiceKeyboard(countryId: string, page: number): InlineKeyboard {
  const allServices = services();
  const totalPages  = Math.max(1, Math.ceil(allServices.length / ITEMS_PER_PAGE));
  const safePage    = Math.max(0, Math.min(page, totalPages - 1));
  const start       = safePage * ITEMS_PER_PAGE;
  const end         = start + ITEMS_PER_PAGE;
  const chunk       = allServices.slice(start, end);

  const kb = new InlineKeyboard();

  // Build 2-column rows explicitly — avoids the rowsOf2 row-break edge cases
  // that can leave a trailing empty row or misplace the last odd button.
  for (let i = 0; i < chunk.length; i += 2) {
    const left  = chunk[i]!;
    const right = chunk[i + 1]; // may be undefined on the last odd item

    kb.text(left.name, `buy_${countryId}_${left.code}`);
    if (right) kb.text(right.name, `buy_${countryId}_${right.code}`);
    kb.row();
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
  phoneNumber: string,
  serviceName: string,
  countryName: string,
  cost:        number
): string {
  return (
    `⏳ <b>Waiting for OTP</b>\n` +
    `${"─".repeat(28)}\n\n` +
    `📱 <b>Number:</b>   <code>+${phoneNumber}</code>\n` +
    `🔧 <b>Service:</b>  ${serviceName}\n` +
    `🌍 <b>Country:</b>  ${countryName}\n` +
    `💰 <b>Cost:</b>     ${cost} credits\n\n` +
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
//  POLL MANAGER
//  Keyed by activationId.  Every exit path calls clearPoll() — no leaks.
// ============================================================================

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
          await User.findOneAndUpdate(
            { telegramId: String(order.userId) },
            { $inc: { totalOrders: 1 } }
          );
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
      const { totalPages } = paginate(countries(), 0);
      try {
        await ctx.editMessageText(buildCountryText(0, totalPages), {
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
      const page = parseInt(ctx.match[1]!, 10);
      const { totalPages } = paginate(countries(), page);
      try {
        await ctx.editMessageText(buildCountryText(page, totalPages), {
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
        await ctx.editMessageText(buildCatalogText(), {
          parse_mode:   "HTML",
          reply_markup: buildCatalogKeyboard(),
        });
      } catch (err) {
        console.error("[smsbower] back-to-catalog error:", err);
      }
    });

    // ── setcountry_<countryId> — Service picker page 0 ───────────────────────
    bot.callbackQuery(/^setcountry_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

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
        await ctx.editMessageText(
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
          `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          { parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Back to Countries", "ctry_pg_0") }
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(services().length / ITEMS_PER_PAGE));
      try {
        await ctx.editMessageText(buildServiceText(country.name, 0, totalPages), {
          parse_mode:   "HTML",
          reply_markup: buildServiceKeyboard(countryId, 0),
        });
      } catch (err) {
        console.error(`[smsbower] setcountry_${countryId} error:`, err);
      }
    });

    // ── srv_pg_<countryId>_<page> — Service list pagination ───────────────────
    bot.callbackQuery(/^srv_pg_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();

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
        await ctx.editMessageText(
          `⚠️ <b>Data layanan belum ter-load dari API.</b>\n\n` +
          `<i>Coba ketik /start dan ulangi, atau hubungi admin jika masalah berlanjut.</i>`,
          { parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Back to Countries", "ctry_pg_0") }
        );
        return;
      }

      const totalPages = Math.max(1, Math.ceil(services().length / ITEMS_PER_PAGE));
      try {
        await ctx.editMessageText(buildServiceText(country.name, page, totalPages), {
          parse_mode:   "HTML",
          reply_markup: buildServiceKeyboard(countryId, page),
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

      const countryId   = ctx.match[1]!;
      const serviceCode = ctx.match[2]!;
      const country     = findCountry(countryId);
      const service     = findService(serviceCode);

      // Guard against stale buttons after a config change.
      if (!country || !service) {
        await ctx.answerCallbackQuery({
          text: "⚠️ This option is no longer available.", show_alert: true,
        });
        return;
      }

      const telegramId = String(from.id);

      try {
        // ── 1. Verify the user is registered ──────────────────────────────────
        const dbUser = await User.findOne({ telegramId }).lean();
        if (!dbUser) {
          await ctx.answerCallbackQuery({
            text: "⚠️ Please /register first before buying.", show_alert: true,
          });
          return;
        }

        // ── 2. Loading state while hitting the API ─────────────────────────────
        await ctx.editMessageText(
          `⏳ <b>Requesting number…</b>\n\n` +
          `🔧 Service: <b>${service.name}</b>\n` +
          `🌍 Country: <b>${country.name}</b>\n\n` +
          `<i>Contacting SMSBower API, please wait.</i>`,
          { parse_mode: "HTML" }
        );

        // ── 3. Call the SMSBower API ───────────────────────────────────────────
        const { activationId, phoneNumber, activationCost } =
          await smsBower.getNumber(serviceCode, countryId);

        // ── 4. Persist the order ───────────────────────────────────────────────
        await Order.create({
          userId:       from.id,
          activationId,
          service:      serviceCode,
          country:      Number(countryId),
          phoneNumber,
          cost:         activationCost,
          status:       "PENDING",
        });

        // ── 5. Show phone number + cancel button ───────────────────────────────
        const sentMsg = await ctx.editMessageText(
          buildPendingText(phoneNumber, service.name, country.name, activationCost),
          {
            parse_mode:   "HTML",
            reply_markup: buildCancelKeyboard(activationId),
          }
        );

        // editMessageText returns Message | true — narrow away `true`.
        const chatId    = ctx.chat?.id ?? from.id;
        const messageId =
          sentMsg !== true && sentMsg !== undefined
            ? sentMsg.message_id
            : ctx.msgId;

        if (!messageId) throw new Error("Could not determine messageId for polling.");

        // ── 6. Start non-blocking polling ─────────────────────────────────────
        startPolling(bot, chatId, messageId, activationId, phoneNumber, service.name);

      } catch (err) {
        console.error(`[smsbower] buy_${countryId}_${serviceCode} error:`, err);
        await ctx.editMessageText(
          `❌ <b>Failed to get a number.</b>\n\n` +
          `<i>${err instanceof Error ? err.message : "The API may be temporarily unavailable."}</i>`,
          {
            parse_mode:   "HTML",
            reply_markup: new InlineKeyboard()
              .text("🔙 Back to Services", `setcountry_${countryId}`),
          }
        );
      }
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
          await ctx.editMessageText(
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

        await ctx.editMessageText(
          buildCanceledText(order.phoneNumber, "user"),
          { parse_mode: "HTML" }
        );

      } catch (err) {
        console.error(`[smsbower] cancel error for ${activationId}:`, err);
        await ctx.editMessageText(
          "❌ Failed to cancel. Please try again or contact support.",
          { parse_mode: "HTML" }
        );
      }
    });

    console.log(
      "   → product_otp | ctry_pg_<n> | setcountry_<id> | srv_pg_<id>_<n> | buy_<c>_<s> | cancel_<id> registered"
    );
  },
};

export default smsBowerPlugin;
