import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Plugin } from "../../types/Plugin.js";
import {
  assertSelfServiceRentalReady,
  findOwnedRental,
  listOwnedRentals,
  listSelfServiceRentalPlans,
  provisionSelfServiceRental,
  type OwnedRentalSummary,
  type SelfServiceRentalPlan,
} from "../../rental/rentalSelfService.service.js";
import {
  activatePendingRentalFromBalance,
  checkRentalPayment,
  createRentalInvoice,
  type RentalBalancePaymentResult,
  type RentalPaymentResult,
} from "../../rental/rentalPayment.service.js";
import {
  startProvisionedRental,
  terminateRental,
  calculateRentalRefund,
  type RentalRefundResult,
} from "../../rental/rental.service.js";
import {
  cleanupRentalTokenInputs,
  clearRentalTokenInput,
  getRentalTokenInput,
  setRentalTokenInput,
  wasRentalTokenMessageDeleted,
} from "../../rental/rentalTokenInput.js";

const TOKEN_INPUT_TTL_MS = 10 * 60_000;
const TOKEN_ATTEMPT_WINDOW_MS = 60 * 60_000;
const MAX_TOKEN_ATTEMPTS = 5;
const PAYMENT_CHECK_COOLDOWN_MS = 10_000;
const PAYMENT_SETUP_MESSAGE =
  "⚠️ Saldo main bot belum cukup dan pembayaran QRIS rental sedang tidak tersedia. Top up saldo main bot, lalu buka /sewa lagi.";
const ENCRYPTION_SETUP_MESSAGE =
  "⚠️ Kunci enkripsi rental belum valid. Admin harus memperbaiki CREDENTIAL_ENCRYPTION_KEY pada .env main bot, lalu restart.";

interface AttemptWindow {
  attempts: number;
  resetsAt: number;
}

interface ProvisionedRental {
  rentalId: string;
  tenantId: string;
  botUsername: string;
  planId: string;
  status: "active" | "pending";
}

type RentalInvoice = Awaited<ReturnType<typeof createRentalInvoice>>;

export interface RentalStoreDependencies {
  now(): number;
  assertReady(): void;
  listPlans(): Promise<SelfServiceRentalPlan[]>;
  findRental(ownerTelegramId: string): Promise<OwnedRentalSummary | null>;
  listRentals?(ownerTelegramId: string): Promise<OwnedRentalSummary[]>;
  provision(input: {
    ownerTelegramId: string;
    planId: string;
    botToken: string;
  }): Promise<ProvisionedRental>;
  createInvoice(
    rentalId: string,
    actorTelegramId: string,
    planId: string,
  ): Promise<RentalInvoice>;
  payBalance(
    rentalId: string,
    actorTelegramId: string,
    planId: string,
  ): Promise<RentalBalancePaymentResult>;
  checkPayment(
    providerReference: string,
    actorTelegramId: string,
  ): Promise<RentalPaymentResult>;
  startRental(rentalId: string): Promise<void>;
  cancelRental?(rentalId: string, actorTelegramId?: string | undefined): Promise<unknown>;
}

const defaults: RentalStoreDependencies = {
  now: Date.now,
  assertReady: assertSelfServiceRentalReady,
  listPlans: listSelfServiceRentalPlans,
  findRental: findOwnedRental,
  listRentals: listOwnedRentals,
  provision: provisionSelfServiceRental,
  payBalance: activatePendingRentalFromBalance,
  createInvoice: createRentalInvoice,
  checkPayment: (reference, actor) => checkRentalPayment(reference, actor),
  startRental: startProvisionedRental,
  cancelRental: (rentalId: string, actorTelegramId?: string | undefined) =>
    terminateRental(rentalId, { actorTelegramId, refundIfOwner: true }),
};

const formatPrice = (amount: number): string =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);

const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);

function botUrl(username: string): string | null {
  return /^[A-Za-z0-9_]{5,32}$/.test(username)
    ? `https://t.me/${username}`
    : null;
}

function rentalLine(rental: OwnedRentalSummary): string {
  const expiry =
    rental.status === "pending"
      ? "menunggu pembayaran"
      : `${formatDate(rental.expiresAt)} WIB`;
  return `Bot: @${rental.botUsername}\nStatus: ${rental.status}\nMasa aktif: ${expiry}`;
}

function planButton(plan: SelfServiceRentalPlan): string {
  return `${plan.name} · ${formatPrice(plan.price)}`.slice(0, 64);
}

function rentalSetupMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  if (message === "Rental belum diaktifkan.") {
    return "⚠️ Rental belum diaktifkan oleh admin platform.";
  }
  if (message.startsWith("CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes")) {
    return ENCRYPTION_SETUP_MESSAGE;
  }
  if (message.startsWith("Payment platform belum dikonfigurasi")) {
    return PAYMENT_SETUP_MESSAGE;
  }
  return null;
}

export function createRentalStorePlugin(
  overrides: Partial<RentalStoreDependencies> = {},
): Plugin {
  const dependencies: RentalStoreDependencies = { ...defaults, ...overrides };
  const tokenAttempts = new Map<string, AttemptWindow>();
  const lastPaymentChecks = new Map<string, number>();

  function cleanup(now: number): void {
    cleanupRentalTokenInputs(now);
    if (tokenAttempts.size > 10_000) {
      for (const [owner, state] of tokenAttempts)
        if (state.resetsAt <= now) tokenAttempts.delete(owner);
    }
    if (lastPaymentChecks.size > 10_000) lastPaymentChecks.clear();
  }

  function consumeTokenAttempt(ownerTelegramId: string, now: number): boolean {
    const current = tokenAttempts.get(ownerTelegramId);
    const window =
      !current || current.resetsAt <= now
        ? { attempts: 0, resetsAt: now + TOKEN_ATTEMPT_WINDOW_MS }
        : current;
    if (window.attempts >= MAX_TOKEN_ATTEMPTS) return false;
    window.attempts++;
    tokenAttempts.set(ownerTelegramId, window);
    return true;
  }

  async function rejectNonPrivate(ctx: Context): Promise<boolean> {
    if (ctx.chat?.type === "private") return false;
    if (ctx.callbackQuery) {
      await ctx
        .answerCallbackQuery({
          text: "Buka menu sewa melalui chat pribadi bot.",
          show_alert: true,
        })
        .catch(() => {});
    } else {
      await ctx
        .reply("🔒 Sewa bot hanya dapat diproses melalui chat pribadi.")
        .catch(() => {});
    }
    return true;
  }

  async function getRentals(ownerTelegramId: string): Promise<OwnedRentalSummary[]> {
    if (overrides.listRentals) {
      return overrides.listRentals(ownerTelegramId);
    }
    if (overrides.findRental) {
      const single = await overrides.findRental(ownerTelegramId);
      return single ? [single] : [];
    }
    if (dependencies.listRentals) {
      return dependencies.listRentals(ownerTelegramId);
    }
    const single = await dependencies.findRental(ownerTelegramId);
    return single ? [single] : [];
  }

  async function loadShop(ownerTelegramId: string): Promise<{
    rentals: OwnedRentalSummary[];
    plans: SelfServiceRentalPlan[];
  }> {
    dependencies.assertReady();
    const [rentals, plans] = await Promise.all([
      getRentals(ownerTelegramId),
      dependencies.listPlans(),
    ]);
    return { rentals, plans };
  }

  async function showShop(ctx: Context): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    clearRentalTokenInput(ownerTelegramId);
    try {
      const { rentals, plans } = await loadShop(ownerTelegramId);
      const keyboard = new InlineKeyboard();

      if (rentals.length === 0) {
        for (const plan of plans)
          keyboard.text(planButton(plan), `rs_new_${plan.id}`).row();
        await ctx.reply(
          "🤖 <b>Sewa Bot</b>\n\n" +
            "1. Pilih paket.\n" +
            "2. Kirim token bot baru dari @BotFather melalui chat ini.\n" +
            "3. Biaya dipotong otomatis dari saldo main bot.\n" +
            "4. Bot aktif otomatis setelah pembayaran terkonfirmasi.\n\n" +
            "Gunakan token khusus rental. Siapa pun yang memegang token dapat mengendalikan bot tersebut.\n\n" +
            (plans.length ? "Pilih paket:" : "Belum ada paket rental aktif."),
          { reply_markup: keyboard, parse_mode: "HTML" },
        );
        return;
      }

      if (rentals.length === 1) {
        const rental = rentals[0]!;
        const url = botUrl(rental.botUsername);
        if (url && rental.status !== "pending")
          keyboard.url("🤖 Buka Bot Saya", url).row();
        for (const plan of plans) {
          keyboard
            .text(planButton(plan), `rs_pay_${rental.rentalId}_${plan.id}`)
            .row();
        }
        keyboard.text("➕ Sewa Bot Baru", "rs_new_menu").row();
        keyboard.text("🛑 Batalkan Rental Ini", `rs_cancel_${rental.rentalId}`).row();
        await ctx.reply(
          `🤖 <b>Rental Saya</b>\n\n${rentalLine(rental)}\n\n` +
            (plans.length
              ? "Pilih paket untuk aktivasi atau memperpanjang masa sewa, atau klik tombol di bawah untuk menambah bot baru."
              : "Belum ada paket rental aktif."),
          { reply_markup: keyboard, parse_mode: "HTML" },
        );
        return;
      }

      const lines = rentals.map((r, i) => {
        const tag = r.status === "active" ? "🟢" : r.status === "pending" ? "⏳" : "⚠️";
        const exp = r.status === "pending" ? "menunggu pembayaran" : `${formatDate(r.expiresAt)} WIB`;
        return `${i + 1}. ${tag} <b>@${r.botUsername}</b> (${r.status})\n   Masa aktif: ${exp}`;
      });
      for (const r of rentals) {
        const tag = r.status === "active" ? "🟢" : r.status === "pending" ? "⏳" : "⚠️";
        keyboard.text(`${tag} @${r.botUsername}`, `rs_bot_${r.rentalId}`).row();
      }
      keyboard.text("➕ Sewa Bot Baru", "rs_new_menu").row();
      await ctx.reply(
        `🤖 <b>Rental Saya</b> (${rentals.length} Bot Terdaftar)\n\n` +
          lines.join("\n\n") +
          "\n\nPilih bot di bawah untuk kelola atau perpanjang masa sewa:",
        { reply_markup: keyboard, parse_mode: "HTML" },
      );
    } catch (error) {
      const setupMessage = rentalSetupMessage(error);
      console.warn(`[Platform] Self-service rental menu unavailable (${setupMessage ? "configuration" : "runtime"}).`);
      await ctx.reply(
        setupMessage
          ?? "⚠️ Sewa bot otomatis belum tersedia karena layanan sedang bermasalah. Coba kembali atau hubungi admin platform.",
      );
    }
  }

  async function showBotDetail(ctx: Context, rentalId: string): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    try {
      const { rentals, plans } = await loadShop(ownerTelegramId);
      const rental = rentals.find((r) => r.rentalId === rentalId);
      if (!rental) {
        await ctx.reply("⛔ Rental tidak ditemukan atau bukan milik kamu.");
        return;
      }
      const keyboard = new InlineKeyboard();
      const url = botUrl(rental.botUsername);
      if (url && rental.status !== "pending")
        keyboard.url("🤖 Buka Bot", url).row();
      for (const plan of plans) {
        keyboard
          .text(planButton(plan), `rs_pay_${rental.rentalId}_${plan.id}`)
          .row();
      }
      keyboard.text("🛑 Batalkan Rental Ini", `rs_cancel_${rental.rentalId}`).row();
      keyboard.text("🔙 Daftar Bot", "rs_home").row();
      await ctx.reply(
        `🤖 <b>Detail Rental @${rental.botUsername}</b>\n\n${rentalLine(rental)}\n\n` +
          "Pilih paket untuk aktivasi atau memperpanjang masa sewa:",
        { reply_markup: keyboard, parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply("Gagal memuat detail bot. Buka /sewa dan coba kembali.");
    }
  }

  async function showNewRentalMenu(ctx: Context): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    try {
      const { rentals, plans } = await loadShop(ownerTelegramId);
      const pending = rentals.find((r) => r.status === "pending");
      if (pending) {
        await ctx.reply(
          `⚠️ Kamu masih memiliki bot rental <b>@${pending.botUsername}</b> yang menunggu pembayaran.\nSelesaikan pembayaran bot tersebut terlebih dahulu sebelum menyewa bot baru.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Rental Saya", "rs_home"),
          },
        );
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const plan of plans)
        keyboard.text(planButton(plan), `rs_new_${plan.id}`).row();
      keyboard.text("🔙 Kembali", "rs_home").row();
      await ctx.reply(
        "🤖 <b>Sewa Bot Baru</b>\n\n" +
          "1. Pilih paket untuk bot baru.\n" +
          "2. Kirim token bot baru dari @BotFather melalui chat ini.\n" +
          "3. Biaya dipotong otomatis dari saldo main bot / via QRIS.\n" +
          "4. Bot aktif otomatis setelah pembayaran terkonfirmasi.\n\n" +
          (plans.length ? "Pilih paket:" : "Belum ada paket rental aktif."),
        { reply_markup: keyboard, parse_mode: "HTML" },
      );
    } catch {
      await ctx.reply("Gagal memuat daftar paket sewa. Buka /sewa dan coba kembali.");
    }
  }

  async function finishBalanceActivation(
    ctx: Context,
    result: Extract<RentalBalancePaymentResult, { status: "paid" }>,
    botUsername: string,
  ): Promise<void> {
    let runtimeReady = true;
    try {
      await dependencies.startRental(result.rentalId);
    } catch {
      runtimeReady = false;
      console.warn(
        `[Platform] Balance-paid rental ${result.rentalId} is waiting for runtime retry.`,
      );
    }
    const keyboard = new InlineKeyboard().text("🤖 Rental Saya", "rs_home");
    const url = botUrl(botUsername);
    if (url) keyboard.row().url("🚀 Buka Bot", url);
    await ctx.reply(
      runtimeReady
        ? `✅ Pembayaran dipotong dari saldo main bot. Bot rental sudah aktif.\nSisa saldo: ${formatPrice(result.remainingBalance)}\nBerlaku sampai: ${formatDate(result.rental.expiresAt)} WIB`
        : `✅ Pembayaran dipotong dari saldo main bot dan masa sewa sudah aktif.\nSisa saldo: ${formatPrice(result.remainingBalance)}\nRuntime bot sedang dicoba ulang otomatis.`,
      { reply_markup: keyboard },
    );
  }

  async function sendInvoice(
    ctx: Context,
    invoice: RentalInvoice,
    botUsername: string,
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("🔄 Cek Pembayaran", `rs_chk_${invoice.payment.providerReference}`)
      .row()
      .text("🔙 Rental Saya", "rs_home");
    const url = botUrl(botUsername);
    if (url) keyboard.row().url("🚀 Buka Bot Setelah Bayar", url);
    await ctx.replyWithPhoto(
      new InputFile(invoice.qris.buffer, "rental-qris.png"),
      {
        caption:
          `🤖 Invoice Sewa @${botUsername}\n\n` +
          `Durasi: ${invoice.payment.durationDays} hari\n` +
          `Total: ${formatPrice(invoice.payment.amount)}\n` +
          `Berlaku sampai: ${formatDate(invoice.payment.expiresAt)} WIB\n\n` +
          "Bayar tepat sesuai nominal QRIS. Sistem memeriksa pembayaran otomatis setiap sekitar 1 menit; tombol di bawah dapat mempercepat pemeriksaan.",
        reply_markup: keyboard,
      },
    );
  }

  async function selectNewPlan(ctx: Context, planId: string): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    try {
      dependencies.assertReady();
      const [rentals, plans] = await Promise.all([
        getRentals(ownerTelegramId),
        dependencies.listPlans(),
      ]);
      const pending = rentals.find((r) => r.status === "pending");
      if (pending) {
        await ctx.reply(
          `Kamu masih memiliki bot rental @${pending.botUsername} yang belum diselesaikan pembayarannya. Selesaikan pembayaran bot tersebut terlebih dahulu sebelum menyewa bot baru.`,
        );
        return;
      }
      const plan = plans.find((item) => item.id === planId);
      if (!plan) {
        await ctx.reply(
          "Paket sudah tidak tersedia. Buka /sewa untuk memuat daftar terbaru.",
        );
        return;
      }
      const now = dependencies.now();
      cleanup(now);
      setRentalTokenInput(ownerTelegramId, {
        planId: plan.id,
        expiresAt: now + TOKEN_INPUT_TTL_MS,
      });
      await ctx.reply(
        `Paket dipilih: ${plan.name} (${plan.durationDays} hari, ${formatPrice(plan.price)}).\n\n` +
          "Kirim token bot baru dari @BotFather sekarang. Pesan token akan langsung dihapus sebelum diverifikasi. " +
          "Jangan gunakan bot yang sedang dipakai di proses lain. Ketik /batal untuk membatalkan.",
      );
    } catch {
      console.warn("[Platform] Self-service rental plan selection failed.");
      await ctx.reply(
        "Paket belum dapat diproses. Buka /sewa dan coba kembali.",
      );
    }
  }

  async function createExistingInvoice(
    ctx: Context,
    rentalId: string,
    planId: string,
  ): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    let pendingActivation = false;
    try {
      dependencies.assertReady();
      const rentals = await getRentals(ownerTelegramId);
      const rental = rentals.find((r) => r.rentalId === rentalId);
      if (!rental) {
        await ctx.reply("⛔ Rental tidak ditemukan atau bukan milik kamu.");
        return;
      }
      pendingActivation = rental.status === "pending";
      const balanceResult = await dependencies.payBalance(
        rentalId,
        ownerTelegramId,
        planId,
      );
      if (balanceResult.status === "paid") {
        await finishBalanceActivation(ctx, balanceResult, rental.botUsername);
        return;
      }
      const invoice = await dependencies.createInvoice(
        rentalId,
        ownerTelegramId,
        planId,
      );
      if (invoice.payment.planId !== planId) {
        await ctx.reply(
          "Masih ada invoice sebelumnya yang aktif. Selesaikan invoice itu atau tunggu hingga kedaluwarsa.",
        );
      }
      await sendInvoice(ctx, invoice, rental.botUsername);
    } catch (error) {
      console.warn(
        `[Platform] Rental invoice creation failed for rental ${rentalId}.`,
      );
      const setupMessage = rentalSetupMessage(error);
      await ctx.reply(
        setupMessage === PAYMENT_SETUP_MESSAGE && !pendingActivation
          ? "⚠️ Pembayaran QRIS untuk perpanjangan rental sedang tidak tersedia. Hubungi admin platform."
          : setupMessage ?? "Invoice belum dapat dibuat. Coba kembali nanti.",
      );
    }
  }

  async function checkInvoice(
    ctx: Context,
    providerReference: string,
  ): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    const now = dependencies.now();
    const cooldownKey = `${ownerTelegramId}:${providerReference}`;
    const lastCheck = lastPaymentChecks.get(cooldownKey) ?? 0;
    if (lastCheck > 0 && now - lastCheck < PAYMENT_CHECK_COOLDOWN_MS) {
      await ctx.reply(
        "⏳ Pemeriksaan baru saja dilakukan. Tunggu sekitar 10 detik.",
      );
      return;
    }
    lastPaymentChecks.set(cooldownKey, now);
    try {
      const result = await dependencies.checkPayment(
        providerReference,
        ownerTelegramId,
      );
      if (result.status === "paid") {
        let runtimeReady = true;
        try {
          await dependencies.startRental(result.rentalId);
        } catch {
          runtimeReady = false;
          console.warn(
            `[Platform] Paid rental ${result.rentalId} is waiting for runtime retry.`,
          );
        }
        const rental = result.rental;
        const keyboard = new InlineKeyboard().text("🤖 Rental Saya", "rs_home");
        const url = rental ? botUrl(rental.botUsername) : null;
        if (url) keyboard.row().url("🚀 Buka Bot", url);
        await ctx.reply(
          runtimeReady
            ? `✅ Pembayaran berhasil. Bot rental sudah aktif.${rental ? `\nBerlaku sampai: ${formatDate(rental.expiresAt)} WIB` : ""}`
            : "✅ Pembayaran berhasil dan masa sewa sudah aktif. Runtime bot sedang dicoba ulang otomatis; buka Rental Saya beberapa saat lagi.",
          { reply_markup: keyboard },
        );
        return;
      }
      await ctx.reply(
        result.status === "expired"
          ? "Invoice sudah kedaluwarsa. Buka /sewa untuk membuat invoice baru."
          : "Pembayaran belum terkonfirmasi. Sistem tetap memeriksa secara otomatis.",
      );
    } catch {
      console.warn("[Platform] Self-service rental payment check failed.");
      await ctx.reply(
        "Pembayaran belum dapat diperiksa. Coba lagi nanti; pemeriksaan otomatis tetap berjalan.",
      );
    }
  }

  async function receiveToken(
    ctx: Context,
    next: () => Promise<void>,
  ): Promise<void> {
    if (!ctx.from) return next();
    const ownerTelegramId = String(ctx.from.id);
    const state = getRentalTokenInput(ownerTelegramId);
    if (!state) return next();
    const rawText = ctx.message?.text ?? "";
    if (rawText === "/batal" || rawText === "/cancel") {
      clearRentalTokenInput(ownerTelegramId);
      await ctx.reply("Proses sewa dibatalkan.");
      return;
    }
    if (rawText.startsWith("/")) {
      clearRentalTokenInput(ownerTelegramId);
      return next();
    }
    if (ctx.chat?.type !== "private") {
      clearRentalTokenInput(ownerTelegramId);
      await ctx.reply("🔒 Token hanya boleh dikirim melalui chat pribadi.");
      return;
    }
    if (!wasRentalTokenMessageDeleted(ctx)) {
      try {
        await ctx.deleteMessage();
      } catch {
        clearRentalTokenInput(ownerTelegramId);
        await ctx.reply(
          "⚠️ Pesan token tidak berhasil dihapus, jadi token tidak diproses. Hapus dan rotasi token di @BotFather, lalu mulai lagi melalui /sewa.",
        );
        return;
      }
    }
    clearRentalTokenInput(ownerTelegramId);
    const now = dependencies.now();
    cleanup(now);
    if (state.expiresAt <= now) {
      await ctx.reply(
        "Waktu pengiriman token sudah habis. Mulai kembali melalui /sewa.",
      );
      return;
    }
    if (!consumeTokenAttempt(ownerTelegramId, now)) {
      await ctx.reply(
        "Terlalu banyak percobaan verifikasi token. Tunggu hingga satu jam lalu coba lagi.",
      );
      return;
    }
    const botToken = rawText.trim();
    if (botToken.length > 256 || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
      await ctx.reply(
        "Format token tidak valid. Token tidak disimpan. Mulai kembali melalui /sewa.",
      );
      return;
    }
    let created: ProvisionedRental | undefined;
    try {
      created = await dependencies.provision({
        ownerTelegramId,
        planId: state.planId,
        botToken,
      });
      const balanceResult = await dependencies.payBalance(
        created.rentalId,
        ownerTelegramId,
        created.planId,
      );
      if (balanceResult.status === "paid") {
        await finishBalanceActivation(ctx, balanceResult, created.botUsername);
        return;
      }
      const invoice = await dependencies.createInvoice(
        created.rentalId,
        ownerTelegramId,
        created.planId,
      );
      await ctx.reply(
        balanceResult.status === "insufficient"
          ? `✅ Bot @${created.botUsername} berhasil diverifikasi. Saldo saat ini ${formatPrice(balanceResult.currentBalance)}, sedangkan harga paket ${formatPrice(balanceResult.requiredAmount)}. Lanjutkan melalui invoice QRIS berikut.`
          : `✅ Bot @${created.botUsername} berhasil diverifikasi. Invoice QRIS yang masih aktif ditampilkan kembali.`,
      );
      await sendInvoice(ctx, invoice, created.botUsername);
    } catch (error) {
      console.warn("[Platform] Self-service rental provisioning failed.");
      await ctx.reply(
        created
          ? rentalSetupMessage(error) ??
              "Data bot sudah tersimpan, tetapi pembayaran belum dapat diproses. Buka /sewa untuk mencoba kembali."
          : "Bot belum dapat didaftarkan. Pastikan token baru, bot tidak memakai webhook/proses lain, lalu mulai kembali melalui /sewa.",
      );
    }
  }

  async function cancelRentalConfirm(
    ctx: Context,
    rentalId: string,
  ): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    try {
      const rentals = await getRentals(ownerTelegramId);
      const rental = rentals.find((r) => r.rentalId === rentalId);
      if (!rental) {
        await ctx.reply("⛔ Rental tidak ditemukan atau bukan milik kamu.");
        return;
      }
      const keyboard = new InlineKeyboard()
        .text("✅ Ya, Batalkan Bot", `rs_cancelyes_${rental.rentalId}`)
        .text("❌ Tidak", rentals.length === 1 ? "rs_home" : `rs_bot_${rental.rentalId}`)
        .row()
        .text("🔙 Rental Saya", "rs_home");

      let refundNotice = "";
      if (rental.status === "active" && rental.planId) {
        const plans = await dependencies.listPlans();
        const plan = plans.find((p) => p.id === rental.planId || p.code === rental.planId);
        if (plan) {
          const preview = calculateRentalRefund(rental, plan);
          if (preview.refundAmount > 0) {
            refundNotice =
              `• Sisa masa aktif: <b>${preview.daysRemaining} hari</b>\n` +
              `• Estimasi pengembalian saldo: <b>${formatPrice(preview.refundAmount)}</b> (otomatis masuk ke saldo kamu)\n\n` +
              `<i>Kalkulasi Prorata:</i>\n` +
              `• Paket: ${plan.name} (${formatPrice(plan.price)} / ${plan.durationDays} hari)\n` +
              `• Tarif harian: ${formatPrice(preview.dailyRate)}/hari\n` +
              `• Terpakai: ${preview.daysUsed} hari (${formatPrice(preview.usedCost)})\n` +
              `• Sisa: ${preview.daysRemaining} hari (${formatPrice(preview.refundAmount)})\n\n`;
          } else {
            refundNotice = "• Sisa masa aktif hari ini habis (tidak ada pengembalian saldo).\n\n";
          }
        }
      } else {
        refundNotice = "• Invoice pembayaran yang pending akan dibatalkan.\n\n";
      }

      await ctx.reply(
        `⚠️ <b>Konfirmasi Batalkan Rental @${rental.botUsername}</b>\n\n` +
          "Apakah kamu yakin ingin membatalkan sewa bot ini?\n\n" +
          "• Bot akan langsung dinonaktifkan (status: terminated).\n" +
          refundNotice +
          "Tindakan ini tidak dapat diurungkan.",
        { parse_mode: "HTML", reply_markup: keyboard },
      );
    } catch {
      await ctx.reply("Gagal memproses pembatalan rental.");
    }
  }

  async function cancelRentalExecute(
    ctx: Context,
    rentalId: string,
  ): Promise<void> {
    if ((await rejectNonPrivate(ctx)) || !ctx.from) return;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    const ownerTelegramId = String(ctx.from.id);
    try {
      const rentals = await getRentals(ownerTelegramId);
      const rental = rentals.find((r) => r.rentalId === rentalId);
      if (!rental) {
        await ctx.reply("⛔ Rental tidak ditemukan atau bukan milik kamu.");
        return;
      }
      let cancelResult: unknown;
      if (dependencies.cancelRental) {
        cancelResult = await dependencies.cancelRental(rentalId, ownerTelegramId);
      }
      const refund = (cancelResult as { refund?: RentalRefundResult })?.refund;
      let refundMessage = "";
      if (refund?.credited && refund.refundAmount > 0) {
        refundMessage =
          `\n\n💰 <b>Saldo Berhasil Dikembalikan:</b> ${formatPrice(refund.refundAmount)}\n` +
          (refund.newBalance !== undefined ? `💳 <b>Saldo Akun Kamu:</b> ${formatPrice(refund.newBalance)}\n\n` : "\n") +
          `<i>Rincian Kalkulasi:</i>\n` +
          `• Paket: ${refund.planName} (${formatPrice(refund.planPrice)} / ${refund.durationDays} hari)\n` +
          `• Tarif harian: ${formatPrice(refund.dailyRate)}/hari\n` +
          `• Terpakai: ${refund.daysUsed} hari (${formatPrice(refund.usedCost)})\n` +
          `• Sisa hari: ${refund.daysRemaining} hari (${formatPrice(refund.refundAmount)})`;
      }
      await ctx.reply(
        `🛑 <b>Rental Dibatalkan</b>\n\n` +
          `Bot <b>@${rental.botUsername}</b> telah berhasil dibatalkan dan dinonaktifkan.` +
          refundMessage,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🤖 Rental Saya", "rs_home"),
        },
      );
    } catch {
      await ctx.reply("Gagal membatalkan bot rental. Coba lagi nanti.");
    }
  }

  return {
    name: "rentalstore",
    version: "1.0.0",
    internalOnly: true,
    commands: [{ command: "sewa", description: "Sewa bot otomatis" }],
    register(bot: Bot<Context>): void {
      bot.command("sewa", showShop);
      bot.command("sewabot", showShop);
      bot.hears("🤖 Sewa Bot", showShop);
      bot.callbackQuery("rs_home", showShop);
      bot.callbackQuery("rs_new_menu", showNewRentalMenu);
      bot.callbackQuery(/^rs_bot_([a-f0-9]{24})$/, (ctx) =>
        showBotDetail(ctx, ctx.match[1]!),
      );
      bot.callbackQuery(/^rs_new_([a-f0-9]{24})$/, (ctx) =>
        selectNewPlan(ctx, ctx.match[1]!),
      );
      bot.callbackQuery(/^rs_pay_([a-f0-9]{24})_([a-f0-9]{24})$/, (ctx) =>
        createExistingInvoice(ctx, ctx.match[1]!, ctx.match[2]!),
      );
      bot.callbackQuery(/^rs_chk_([A-Za-z0-9_-]{1,96})$/, (ctx) =>
        checkInvoice(ctx, ctx.match[1]!),
      );
      bot.callbackQuery(/^rs_cancel_([a-f0-9]{24})$/, (ctx) =>
        cancelRentalConfirm(ctx, ctx.match[1]!),
      );
      bot.callbackQuery(/^rs_cancelyes_([a-f0-9]{24})$/, (ctx) =>
        cancelRentalExecute(ctx, ctx.match[1]!),
      );
      bot.on("message:text", receiveToken);
    },
  };
}

export default createRentalStorePlugin();
