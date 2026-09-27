import { randomBytes } from "node:crypto";
import { Bot, Context, InlineKeyboard } from "grammy";
import { isAdmin } from "../../core/admin.js";
import {
  createTinyhostClientFromEnv,
  extractTinyhostSignals,
  formatTinyhostError,
  generateTinyhostUsername,
  getTinyhostPollingConfig,
  watchTinyhostInbox,
  type TinyhostEmail
} from "../../services/tinyhost.js";
import type { Plugin } from "../../types/Plugin.js";

interface DomainMenuState {
  token: string;
  domains: string[];
  createdAt: number;
}

const DOMAIN_MENU_TTL_MS = 5 * 60_000;
const domainMenus = new Map<string, DomainMenuState>();
const activeWatchers = new Map<string, AbortController>();

const tinyhostPlugin: Plugin = {
  internalOnly: true,
  name: "tinyhost-temp-mail",
  version: "1.0.0",
  commands: [
    {
      command: "thost",
      description: "Buat temp mail Tinyhost dan pantau inbox"
    }
  ],

  register(bot: Bot<Context>): void {
    bot.command("thost", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Admin only.");
        return;
      }

      if (ctx.chat?.type !== "private" || !ctx.from) {
        await ctx.reply("⛔ /thost hanya bisa digunakan admin lewat chat pribadi.");
        return;
      }

      const adminId = String(ctx.from.id);
      activeWatchers.get(adminId)?.abort();
      activeWatchers.delete(adminId);

      const client = createTinyhostClientFromEnv();
      let domains: string[];
      try {
        domains = await client.getDomains(20);
      } catch (error) {
        await ctx.reply(
          `❌ Gagal mengambil domain Tinyhost: ${escapeHtml(formatTinyhostError(error))}`,
          { parse_mode: "HTML" }
        );
        return;
      }

      if (domains.length === 0) {
        await ctx.reply("❌ Tinyhost tidak mengembalikan domain yang tersedia.");
        return;
      }

      const token = randomBytes(3).toString("hex");
      domainMenus.set(adminId, {
        token,
        domains,
        createdAt: Date.now()
      });

      const keyboard = new InlineKeyboard();
      domains.forEach((domain, index) => {
        keyboard.text(domain, `thost_pick:${token}:${index}`);
        if (index % 2 === 1) keyboard.row();
      });

      await ctx.reply(
        "📧 <b>Tinyhost Temp Mail</b>\n\nPilih domain yang mau dipakai:",
        {
          parse_mode: "HTML",
          reply_markup: keyboard
        }
      );
    });

    bot.callbackQuery(/^thost_pick:([a-f0-9]{6}):(\d{1,2})$/, async (ctx) => {
      if (!isAdmin(ctx) || !ctx.from || ctx.chat?.type !== "private") {
        await ctx.answerCallbackQuery({
          text: "Admin only.",
          show_alert: true
        });
        return;
      }

      const adminId = String(ctx.from.id);
      const state = domainMenus.get(adminId);
      const token = ctx.match[1]!;
      const index = Number(ctx.match[2]);

      if (
        !state ||
        state.token !== token ||
        Date.now() - state.createdAt > DOMAIN_MENU_TTL_MS ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= state.domains.length
      ) {
        await ctx.answerCallbackQuery({
          text: "Daftar domain sudah kedaluwarsa. Jalankan /thost lagi.",
          show_alert: true
        });
        return;
      }

      const domain = state.domains[index]!;
      domainMenus.delete(adminId);
      await ctx.answerCallbackQuery({ text: `Domain dipilih: ${domain}` });

      const client = createTinyhostClientFromEnv();
      const user = generateTinyhostUsername();
      const address = `${user}@${domain}`;

      let initialIds: Array<string | number> = [];
      try {
        const inbox = await client.getEmails(domain, user);
        initialIds = inbox.emails.map((email) => email.id);
      } catch (error) {
        await ctx.reply(
          `❌ Gagal menyiapkan inbox: ${escapeHtml(formatTinyhostError(error))}`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const previous = activeWatchers.get(adminId);
      previous?.abort();

      const controller = new AbortController();
      activeWatchers.set(adminId, controller);
      const polling = getTinyhostPollingConfig();

      const readyText =
        `📬 <b>Tinyhost siap</b>\n\n` +
        `Domain: <code>${escapeHtml(domain)}</code>\n` +
        `Email: <code>${escapeHtml(address)}</code>\n\n` +
        `Bot akan cek inbox tiap ~${Math.round(polling.intervalMs / 1000)} detik selama ` +
        `${Math.round(polling.timeoutMs / 60_000)} menit. Jalankan /thost lagi untuk mengganti inbox.`;

      try {
        await ctx.editMessageText(readyText, { parse_mode: "HTML" });
      } catch {
        await ctx.reply(readyText, { parse_mode: "HTML" });
      }

      const chatId = ctx.chat.id;
      void watchTinyhostInbox({
        client,
        domain,
        user,
        initialIds,
        intervalMs: polling.intervalMs,
        timeoutMs: polling.timeoutMs,
        signal: controller.signal,
        async onEmail(email) {
          const message = buildTelegramEmailMessage(address, email);
          await bot.api.sendMessage(chatId, message, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true }
          });
        },
        onPollError(error, consecutiveErrors) {
          console.warn(
            `[TINYHOST] poll error admin=${adminId} consecutive=${consecutiveErrors} error=${formatTinyhostError(error)}`
          );
        }
      })
        .then(async (result) => {
          if (activeWatchers.get(adminId) === controller) {
            activeWatchers.delete(adminId);
          }
          if (result.reason === "timeout" && !controller.signal.aborted) {
            await bot.api.sendMessage(
              chatId,
              `⏱️ Watcher Tinyhost selesai. Total email diterima: <b>${result.delivered}</b>. Jalankan /thost untuk membuat inbox baru.`,
              { parse_mode: "HTML" }
            ).catch(() => undefined);
          }
        })
        .catch(async (error) => {
          if (activeWatchers.get(adminId) === controller) {
            activeWatchers.delete(adminId);
          }
          if (controller.signal.aborted) return;
          console.error("[TINYHOST] watcher failed:", error);
          await bot.api.sendMessage(
            chatId,
            `❌ Watcher Tinyhost berhenti: ${escapeHtml(formatTinyhostError(error))}`,
            { parse_mode: "HTML" }
          ).catch(() => undefined);
        });
    });

    console.log("   → /thost, callbackQuery: thost_pick:*");
  }
};

function buildTelegramEmailMessage(
  address: string,
  email: TinyhostEmail
): string {
  const signals = extractTinyhostSignals(email);
  const sender = escapeHtml(truncate(email.sender || "-", 300));
  const subject = escapeHtml(truncate(email.subject || "(tanpa subject)", 300));
  const date = escapeHtml(truncate(email.date || "-", 100));

  let content =
    `📩 <b>Email masuk</b>\n` +
    `Ke: <code>${escapeHtml(truncate(address, 200))}</code>\n` +
    `Dari: <code>${sender}</code>\n` +
    `Subject: <b>${subject}</b>\n` +
    `Tanggal: <code>${date}</code>\n\n`;

  if (signals.otps.length > 0) {
    content +=
      `🔐 <b>OTP/Kode:</b>\n` +
      signals.otps.map((otp) => `<code>${escapeHtml(otp)}</code>`).join("\n") +
      "\n\n";
  }

  if (signals.links.length > 0) {
    content +=
      `🔗 <b>Link:</b>\n` +
      signals.links
        .slice(0, 5)
        .map((link) => `<code>${escapeHtml(truncate(link, 500))}</code>`)
        .join("\n") +
      "\n";
  }

  if (signals.otps.length === 0 && signals.links.length === 0) {
    const detail = truncate(signals.text || "(isi email kosong)", 2_800);
    content += `📄 <b>Detail email:</b>\n<pre>${escapeHtml(detail)}</pre>`;
  }

  return content;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 20))}\n…(dipotong)`;
}

export default tinyhostPlugin;
