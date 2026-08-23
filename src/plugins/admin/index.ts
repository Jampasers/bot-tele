import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { BotConfig } from "../../models/BotConfig.js";
import { User } from "../../models/User.js";
import { SMSBowerService, smsBower } from "../../services/smsbower.js";
import { ForceSubService } from "../../services/forceSub.js";
import { TestimonialService } from "../../services/testimonial.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { BotStatsService } from "../../services/stats.js";
import { adjustBalance, getUserBalanceLogs } from "../../services/balance.js";
import { createPromo, listAllPromos } from "../../services/promo.js";
import {
  broadcastMessage,
  estimateBroadcastTarget,
  getBroadcastFilterLabel,
  BroadcastFilter,
} from "../../services/broadcast.js";
import {
  createAndSendBackup,
  inspectBackupZip,
  executeRollback,
  InspectedCollection,
} from "../../services/backup.js";
import { clearMaintenanceCache } from "../../middlewares/maintenance.js";
import { CurrencyService } from "../../services/currency.js";
import { ImapOtpService } from "../../services/imapOtp.js";
import { CloudflareService } from "../../services/cloudflare.js";
import { isAdmin } from "../../core/admin.js";

// ============================================================================
//  ADMIN PLUGIN — Interactive Whitelist & Platform Manager
//
//  All interactions are gated behind ADMIN_ID from process.env.
// ============================================================================

const ITEMS_PER_PAGE = 20;

interface FsubAdminState {
  action:
    | "SET_CHAN"
    | "SET_LINK"
    | "SET_NAME"
    | "SET_TESTI_CHAN"
    | "SET_TESTI_LINK"
    | "SET_LOG_CHAN"
    | "SET_LOG_LINK"
    | "SET_MAINTENANCE_MSG"
    | "BC_TEXT"
    | "SET_OTP_CHAN"
    | "SET_OTP_LINK"
    | "SET_OTP_CHAN_PP"
    | "SET_OTP_LINK_PP"
    | "SET_OTP_CHAN_NF"
    | "SET_OTP_LINK_NF"
    | "SET_OTP_CHAN_DC"
    | "SET_OTP_LINK_DC"
    | "SET_IMAP_HOST"
    | "SET_IMAP_PORT"
    | "SET_IMAP_USER"
    | "SET_IMAP_PASS"
    | "SET_IMAP_SENDER"
    | "SET_IMAP_MAILBOX"
    | "SET_CF_EMAIL"
    | "SET_CF_KEY"
    | "SET_CF_DEST"
    | "SET_CF_CUSTOM"
    | "ADD_CF_ZONE"
    | "WAIT_ROLLBACK_FILE";
  broadcastFilter?: BroadcastFilter;
}

const fsubInputState = new Map<string, FsubAdminState>();

interface PendingRollbackSession {
  collections: InspectedCollection[];
  totalDocs: number;
  fileName: string;
  timestamp: number;
}

const pendingRollbackSessions = new Map<string, PendingRollbackSession>();

function formatDateWIB(date: Date = new Date()): string {
  return (
    new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date) + " WIB"
  );
}

// ── UI Builders ───────────────────────────────────────────────────────────────

/** Returns the main admin panel text. */
async function buildHomeText(): Promise<string> {
  const config     = await SmsConfig.getOrCreate();
  const botConfig  = await ForceSubService.getConfig();
  const cfConfig   = await CloudflareService.getConfig();
  const usdRate    = await CurrencyService.getUsdRate();
  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}% (persentase)`
    : `+Rp ${config.markupValue.toLocaleString("id-ID")} (flat)`;

  const otpStatus = config.enabled !== false
    ? `🟢 Aktif`
    : `🔴 Nonaktif (Maintenance)`;

  const fsubStatus = botConfig.forceSubEnabled && botConfig.forceSubChannel
    ? `🟢 Aktif (<code>${botConfig.forceSubChannel}</code>)`
    : botConfig.forceSubEnabled
    ? `⚠️ Aktif (Channel belum diatur)`
    : `🔴 Nonaktif`;

  const testiStatus = botConfig.testimonialEnabled && botConfig.testimonialChannel
    ? `🟢 Aktif (<code>${botConfig.testimonialChannel}</code>)`
    : botConfig.testimonialEnabled
    ? `⚠️ Aktif (Channel belum diatur)`
    : `🔴 Nonaktif`;

  const logStatus = botConfig.logChannelEnabled && botConfig.logChannel
    ? `🟢 Aktif (<code>${botConfig.logChannel}</code>)`
    : botConfig.logChannelEnabled
    ? `⚠️ Aktif (Channel belum diatur)`
    : `🔴 Nonaktif`;

  const otpChanStatus = botConfig.otpChannelEnabled && botConfig.otpChannel
    ? `🟢 Aktif (<code>${botConfig.otpChannel}</code>)`
    : botConfig.otpChannelEnabled
    ? `⚠️ Aktif (Channel belum diatur)`
    : `🔴 Nonaktif`;

  const maintenanceStatus = botConfig.isMaintenance
    ? `🔴 <b>MAINTENANCE ON</b> — Semua user diblokir`
    : `🟢 Normal — Bot berjalan`;

  return (
    `🛠 <b>Admin Panel Utama</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `<b>Status Maintenance:</b>   ${maintenanceStatus}\n` +
    `<b>Layanan OTP SMS:</b>       ${otpStatus}\n` +
    `<b>Active services:</b>       ${SMSBowerService.cachedServices.length} / ${SMSBowerService.allServices.length}\n` +
    `<b>Active countries:</b>      ${SMSBowerService.cachedCountries.length} / ${SMSBowerService.allCountries.length}\n` +
    `<b>Kurs USD/IDR:</b>          <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code> (Realtime)\n` +
    `<b>Markup aktif:</b>          <code>${markupLine}</code>\n` +
    `<b>Wajib Join Channel:</b>    ${fsubStatus}\n` +
    `<b>Channel Testimoni:</b>     ${testiStatus}\n` +
    `<b>Channel Log Aktivitas:</b> ${logStatus}\n` +
    `<b>Forwarder OTP IMAP:</b>    ${otpChanStatus}\n` +
    `<b>Cloudflare Routing:</b>   🟢 ${cfConfig.cfZones.length} Domain (Forward: <code>${cfConfig.cfDestinationEmail}</code>)\n\n` +
    `Pilih menu yang ingin dikelola:`
  );
}

async function buildHomeKeyboard(): Promise<InlineKeyboard> {
  const config = await SmsConfig.getOrCreate();
  const otpLabel = config.enabled !== false
    ? "💬 Layanan OTP SMS (🟢 ON)"
    : "💬 Layanan OTP SMS (🔴 OFF)";

  return new InlineKeyboard()
    .text("📊 Statistik & Analisis Bot", "adm_stats_overview")
    .row()
    .text("📢 Wajib Join Channel (Force Sub)", "adm_forcesub")
    .row()
    .text("🌟 Channel Testimoni Pembelian", "adm_testi")
    .row()
    .text("📜 Channel Log Aktivitas (Audit)", "adm_log")
    .row()
    .text("📬 Channel Forwarder OTP (IMAP)", "adm_otpchan")
    .row()
    .text("☁️ Cloudflare Email Routing", "adm_cf_menu")
    .row()
    .text(otpLabel, "adm_otp_menu")
    .row()
    .text(`🌍 Kelola Negara (${SMSBowerService.cachedCountries.length}/${SMSBowerService.allCountries.length})`, "adm_c_pg_0")
    .row()
    .text(`📱 Kelola Layanan (${SMSBowerService.cachedServices.length}/${SMSBowerService.allServices.length})`, "adm_s_pg_0")
    .row()
    .text("💰 Pricing & Markup", "adm_pricing")
    .row()
    .text("📦 Kelola Produk Digital & Stok", "dga_home")
    .row()
    .text("🔧 Mode Maintenance", "adm_maintenance")
    .row()
    .text("💳 Manajemen Saldo User", "adm_balance_menu")
    .row()
    .text("🎟️ Kelola Promo & Voucher", "adm_promo_menu")
    .row()
    .text("📢 Broadcast ke User", "adm_broadcast")
    .row()
    .text("🖴 Backup Database", "adm_backup")
    .text("♻️ Rollback Database", "adm_rollback");
}

// ── Cloudflare Email Routing UI Builders ─────────────────────────────────────

async function buildCloudflareAdminText(): Promise<string> {
  const config = await CloudflareService.getConfig();
  const domains = config.cfZones
    .map((z) => `• <code>${z.domain}</code> (ID: <code>${z.id.slice(0, 8)}...</code>)`)
    .join("\n") || "<i>Belum ada domain terdaftar.</i>";

  const apiKeyMasked = config.cfApiKey
    ? `${config.cfApiKey.slice(0, 6)}••••••••${config.cfApiKey.slice(-4)}`
    : "(Belum diatur)";

  return (
    `☁️ <b>Cloudflare Email Routing Manager</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `📧 <b>Email Cloudflare:</b>  <code>${config.cfEmail || "(Belum diatur)"}</code>\n` +
    `🔑 <b>API Key:</b>           <code>${apiKeyMasked}</code>\n` +
    `🎯 <b>Forward Target:</b>    <code>${config.cfDestinationEmail || "(Belum diatur)"}</code>\n\n` +
    `🌐 <b>Daftar Domain / Zone (${config.cfZones.length}):</b>\n${domains}\n\n` +
    `⚡ <b>Quick Commands:</b>\n` +
    `• <code>/cfcreate</code> — Buat email forward acak instan\n` +
    `• <code>/cfcreate &lt;prefix&gt;</code> — Buat email dengan prefix custom\n` +
    `• <code>/cfcreate &lt;prefix&gt; &lt;domain&gt;</code> — Buat email custom domain\n` +
    `• <code>/cflist</code> — Lihat daftar rule email aktif\n` +
    `• <code>/cfzones</code> — Lihat info domain terdaftar`
  );
}

function buildCloudflareAdminKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Buat Email Baru (Random)", "adm_cf_quick_random")
    .row()
    .text("✏️ Buat Email Custom (Prefix/Domain)", "adm_cf_create_prompt")
    .row()
    .text("📋 Daftar Rule Email", "adm_cf_rules")
    .text("🌐 Kelola Domain / Zones", "adm_cf_zones")
    .row()
    .text("🎯 Ubah Target Forward", "adm_cf_set_dest")
    .text("🔑 Ubah Kredensial CF", "adm_cf_set_cred")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildCloudflareRulesText(): Promise<string> {
  const result = await CloudflareService.listEmailRules();
  if (!result.success || result.rules.length === 0) {
    return (
      `📋 <b>Daftar Rule Cloudflare Email Routing</b>\n` +
      `${"─".repeat(34)}\n\n` +
      `<i>Tidak ada rule email routing aktif yang ditemukan atau gagal terhubung ke Cloudflare API.</i>\n\n` +
      `<i>Klik tombol di bawah untuk membuat rule email baru.</i>`
    );
  }

  const items = result.rules
    .slice(0, 15)
    .map((r, idx) => {
      return (
        `<b>${idx + 1}.</b> <code>${r.targetEmail}</code>\n` +
        `   ↳ ➡️ <code>${r.destinationEmail}</code>\n` +
        `   ↳ Domain: <code>${r.domain || "-"}</code> | ID: <code>${r.id}</code>`
      );
    })
    .join("\n\n");

  return (
    `📋 <b>Daftar Rule Cloudflare Email Routing (${result.rules.length})</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `${items}\n\n` +
    `<i>💡 Untuk menghapus rule tertentu, jalankan perintah:</i>\n<code>/cfdel &lt;zoneId&gt; &lt;ruleId&gt;</code>`
  );
}

function buildCloudflareRulesKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Buat Email Baru", "adm_cf_quick_random")
    .text("🔄 Refresh", "adm_cf_rules")
    .row()
    .text("🔙 Kembali ke Cloudflare", "adm_cf_menu");
}

async function buildCloudflareZonesText(): Promise<string> {
  const zones = await CloudflareService.getZones();
  const list = zones
    .map((z, i) => `<b>${i + 1}.</b> <code>${z.domain}</code>\n   Zone ID: <code>${z.id}</code>`)
    .join("\n\n") || "<i>Belum ada domain terdaftar.</i>";

  return (
    `🌐 <b>Daftar Domain & Zone Cloudflare</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `${list}\n\n` +
    `<i>Gunakan tombol di bawah untuk menambah domain baru atau melakukan sinkronisasi otomatis dari akun Cloudflare Anda.</i>`
  );
}

function buildCloudflareZonesKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Tambah Domain Manual", "adm_cf_add_zone_prompt")
    .row()
    .text("🔄 Sinkronkan Dari Akun CF", "adm_cf_sync_zones")
    .row()
    .text("🔙 Kembali ke Cloudflare", "adm_cf_menu");
}

async function buildOtpChannelAdminText(): Promise<string> {
  const botConfig = await BotConfig.getOrCreate();
  const imapStatus = await ImapOtpService.getStatus();

  const ppStatus = botConfig.otpChannelEnabled && botConfig.otpChannel
    ? `🟢 <b>Aktif</b> (<code>${botConfig.otpChannel}</code>)`
    : botConfig.otpChannelEnabled
    ? `⚠️ <b>Aktif</b> (Channel belum diatur)`
    : `🔴 <b>Nonaktif</b>`;

  const nfStatus = botConfig.otpNetflixChannelEnabled && botConfig.otpNetflixChannel
    ? `🟢 <b>Aktif</b> (<code>${botConfig.otpNetflixChannel}</code>)`
    : botConfig.otpNetflixChannelEnabled
    ? `⚠️ <b>Aktif</b> (Channel belum diatur)`
    : `🔴 <b>Nonaktif</b>`;

  const dcStatus = botConfig.otpDiscordChannelEnabled && botConfig.otpDiscordChannel
    ? `🟢 <b>Aktif</b> (<code>${botConfig.otpDiscordChannel}</code>)`
    : botConfig.otpDiscordChannelEnabled
    ? `⚠️ <b>Aktif</b> (Channel belum diatur)`
    : `🔴 <b>Nonaktif</b>`;

  let imapConnStatus = "🔴 Terputus / Belum Aktif";
  if (!imapStatus.configured) {
    imapConnStatus = "⚠️ Kredensial Belum Dikonfigurasi";
  } else if (imapStatus.listening) {
    imapConnStatus = "🟢 Terhubung & Standby IDLE (Mendengarkan Email)";
  } else if (imapStatus.connected) {
    imapConnStatus = "🟡 Terhubung (Inisialisasi)";
  }

  const lastReceived = imapStatus.lastReceivedAt
    ? formatDateWIB(imapStatus.lastReceivedAt)
    : "-";

  const lastOtp = imapStatus.lastReceivedOtp
    ? `<code>${imapStatus.lastReceivedOtp}</code> (${escapeHtml(imapStatus.lastRecipientName || "User")})`
    : "-";

  const errorLine = imapStatus.lastError
    ? `\n⚠️ <i>Info Error: ${escapeHtml(imapStatus.lastError.slice(0, 120))}</i>`
    : "";

  return (
    `📬 <b>Pengaturan Channel Forwarder OTP (IMAP)</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `🅿️ <b>Channel OTP PayPal:</b>\n` +
    `• Status: ${ppStatus}\n` +
    `• Target: <code>${botConfig.otpChannel || "(Belum diatur)"}</code>\n` +
    `• Link: ${botConfig.otpChannelLink ? `<a href="${botConfig.otpChannelLink}">${botConfig.otpChannelLink}</a>` : "<code>(Belum diatur)</code>"}\n\n` +
    `🎬 <b>Channel OTP Netflix:</b>\n` +
    `• Status: ${nfStatus}\n` +
    `• Target: <code>${botConfig.otpNetflixChannel || "(Belum diatur)"}</code>\n` +
    `• Link: ${botConfig.otpNetflixChannelLink ? `<a href="${botConfig.otpNetflixChannelLink}">${botConfig.otpNetflixChannelLink}</a>` : "<code>(Belum diatur)</code>"}\n\n` +
    `🎮 <b>Channel OTP Discord:</b>\n` +
    `• Status: ${dcStatus}\n` +
    `• Target: <code>${botConfig.otpDiscordChannel || "(Belum diatur)"}</code>\n` +
    `• Link: ${botConfig.otpDiscordChannelLink ? `<a href="${botConfig.otpDiscordChannelLink}">${botConfig.otpDiscordChannelLink}</a>` : "<code>(Belum diatur)</code>"}\n\n` +
    `📡 <b>Status Koneksi IMAP:</b> <b>${imapConnStatus}</b>\n` +
    `🌐 <b>Host IMAP:</b>          <code>${botConfig.imapHost || "-"}</code>:<code>${botConfig.imapPort || 993}</code>\n` +
    `👤 <b>Akun IMAP:</b>          <code>${botConfig.imapUser ? `${botConfig.imapUser.slice(0, 3)}***` : "(Belum diatur)"}</code>\n` +
    `🎯 <b>Target Pengirim:</b>    <code>${botConfig.imapTargetSender || "service@intl.paypal.com"}</code>\n` +
    `📥 <b>Folder Mailbox:</b>     <code>${botConfig.imapMailbox || "INBOX"}</code>\n\n` +
    `📊 <b>Statistik Realtime:</b>\n` +
    `• Total OTP Terkirim: <b>${imapStatus.totalOtpForwarded}</b>\n` +
    `• OTP Terakhir: ${lastOtp}\n` +
    `• Waktu Terakhir: <b>${lastReceived}</b>${errorLine}\n\n` +
    `<i>💡 Catatan: Pastikan bot telah ditambahkan sebagai <b>Administrator</b> di channel target (PayPal, Netflix & Discord) dengan izin <b>Post Messages (Kirim Pesan)</b>!</i>`
  );
}

async function buildOtpChannelAdminKeyboard(): Promise<InlineKeyboard> {
  const botConfig = await BotConfig.getOrCreate();
  const togglePp = botConfig.otpChannelEnabled ? "🔴 Matikan PayPal" : "🟢 Aktifkan PayPal";
  const toggleNf = botConfig.otpNetflixChannelEnabled ? "🔴 Matikan Netflix" : "🟢 Aktifkan Netflix";
  const toggleDc = botConfig.otpDiscordChannelEnabled ? "🔴 Matikan Discord" : "🟢 Aktifkan Discord";

  return new InlineKeyboard()
    .text(togglePp, "adm_otpchan_toggle_pp")
    .text(toggleNf, "adm_otpchan_toggle_nf")
    .text(toggleDc, "adm_otpchan_toggle_dc")
    .row()
    .text("🅿️ Target PayPal", "adm_otpchan_setchan_pp")
    .text("🔗 Link PayPal", "adm_otpchan_setlink_pp")
    .row()
    .text("🎬 Target Netflix", "adm_otpchan_setchan_nf")
    .text("🔗 Link Netflix", "adm_otpchan_setlink_nf")
    .row()
    .text("🎮 Target Discord", "adm_otpchan_setchan_dc")
    .text("🔗 Link Discord", "adm_otpchan_setlink_dc")
    .row()
    .text("🧪 Tes PayPal", "adm_otpchan_test_pp")
    .text("🧪 Tes Netflix", "adm_otpchan_test_nf")
    .text("🧪 Tes Discord", "adm_otpchan_test_dc")
    .row()
    .text("⚙️ Konfigurasi IMAP", "adm_imap_config")
    .text("🔄 Restart IMAP", "adm_imap_restart")
    .row()
    .text("📥 Cek Email Terbaru", "adm_imap_fetch")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildImapConfigAdminText(): Promise<string> {
  const config = await BotConfig.getOrCreate();
  const passMasked = config.imapPass ? "••••••••••••" : "(Belum diatur)";
  const status = config.imapEnabled ? "🟢 <b>Aktif</b>" : "🔴 <b>Nonaktif</b>";

  return (
    `⚙️ <b>Konfigurasi Server Email IMAP</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `⚙️ <b>Status IMAP:</b>        ${status}\n` +
    `🌐 <b>Host Server:</b>        <code>${config.imapHost || "(Belum diatur)"}</code>\n` +
    `🔌 <b>Port Server:</b>        <code>${config.imapPort || 993}</code> (SSL/TLS: <code>${config.imapSecure ? "Ya" : "Tidak"}</code>)\n` +
    `👤 <b>Email Akun:</b>         <code>${config.imapUser || "(Belum diatur)"}</code>\n` +
    `🔑 <b>Password / App Pass:</b> <code>${passMasked}</code>\n` +
    `🎯 <b>Target Pengirim:</b>    <code>${config.imapTargetSender || "service@intl.paypal.com"}</code>\n` +
    `📁 <b>Folder Mailbox:</b>     <code>${config.imapMailbox || "INBOX"}</code>\n\n` +
    `<i>💡 Untuk Gmail / Google Workspace, buat <b>App Password 16 digit</b> di Keamanan Akun Google (bukan password login biasa).</i>`
  );
}

async function buildImapConfigAdminKeyboard(): Promise<InlineKeyboard> {
  const config = await BotConfig.getOrCreate();
  const toggleLabel = config.imapEnabled ? "🔴 Nonaktifkan IMAP" : "🟢 Aktifkan IMAP";

  return new InlineKeyboard()
    .text(toggleLabel, "adm_imap_toggle")
    .row()
    .text("✏️ Ubah Host", "adm_imap_sethost")
    .text("✏️ Ubah Port", "adm_imap_setport")
    .row()
    .text("✏️ Ubah Email", "adm_imap_setuser")
    .text("✏️ Ubah Password", "adm_imap_setpass")
    .row()
    .text("✏️ Ubah Target Sender", "adm_imap_setsender")
    .text("✏️ Ubah Mailbox", "adm_imap_setmbox")
    .row()
    .text("🔙 Kembali ke Channel OTP", "adm_otpchan");
}

async function buildOtpAdminText(): Promise<string> {
  const config  = await SmsConfig.getOrCreate();
  const usdRate = await CurrencyService.getUsdRate();
  const status = config.enabled !== false
    ? "🟢 <b>Aktif</b> (User dapat memilih negara dan menyewa nomor OTP virtual)"
    : "🔴 <b>Nonaktif</b> (Layanan dinonaktifkan / mode maintenance)";

  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}% (persentase)`
    : `+Rp ${config.markupValue.toLocaleString("id-ID")} (flat)`;

  return (
    `💬 <b>Pengaturan Layanan OTP SMS (Virtual Number)</b>\n` +
    `${"─".repeat(36)}\n\n` +
    `⚙️ <b>Status Layanan:</b>   ${status}\n` +
    `🌍 <b>Negara Aktif:</b>     ${SMSBowerService.cachedCountries.length} / ${SMSBowerService.allCountries.length}\n` +
    `📱 <b>Layanan Aktif:</b>    ${SMSBowerService.cachedServices.length} / ${SMSBowerService.allServices.length}\n` +
    `💱 <b>Kurs Realtime:</b>    <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code>\n` +
    `💰 <b>Markup Harga:</b>     <code>${markupLine}</code>\n\n` +
    `<i>💡 Catatan: Menonaktifkan fitur ini akan menyembunyikan/mengunci pemesanan nomor OTP dari katalog user.</i>`
  );
}

async function buildOtpAdminKeyboard(): Promise<InlineKeyboard> {
  const config = await SmsConfig.getOrCreate();
  const toggleLabel = config.enabled !== false ? "🔴 Nonaktifkan Fitur OTP" : "🟢 Aktifkan Fitur OTP";

  return new InlineKeyboard()
    .text(toggleLabel, "adm_otp_toggle")
    .row()
    .text("🔍 Cek Harga Asli SMSBower (USD & IDR)", "adm_check_price")
    .row()
    .text(`🌍 Kelola Negara (${SMSBowerService.cachedCountries.length}/${SMSBowerService.allCountries.length})`, "adm_c_pg_0")
    .row()
    .text(`📱 Kelola Layanan (${SMSBowerService.cachedServices.length}/${SMSBowerService.allServices.length})`, "adm_s_pg_0")
    .row()
    .text("💰 Pricing & Markup", "adm_pricing")
    .row()
    .text("🔄 Reload Cache SMS", "adm_sms_reload")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildLogAdminText(): Promise<string> {
  const config = await ActivityLogService.getConfig();
  const status = config.logChannelEnabled
    ? "🟢 <b>Aktif</b> (Otomatis posting log audit & aktivitas ke channel)"
    : "🔴 <b>Nonaktif</b> (Tidak mengirimkan log ke channel)";

  return (
    `📜 <b>Pengaturan Channel Log Aktivitas (Audit Log)</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `⚙️ <b>Status Fitur:</b>      ${status}\n` +
    `🆔 <b>Target Channel:</b>    <code>${config.logChannel || "(Belum diatur)"}</code>\n` +
    `🔗 <b>Link Channel:</b>      ${config.logChannelLink ? `<a href="${config.logChannelLink}">${config.logChannelLink}</a>` : "<code>(Belum diatur)</code>"}\n\n` +
    `<i>💡 Catatan: Pastikan bot telah ditambahkan sebagai <b>Administrator</b> di channel target dengan izin <b>Post Messages (Kirim Pesan)</b>!</i>`
  );
}

async function buildLogAdminKeyboard(): Promise<InlineKeyboard> {
  const config = await ActivityLogService.getConfig();
  const toggleLabel = config.logChannelEnabled ? "🔴 Nonaktifkan Fitur" : "🟢 Aktifkan Fitur";

  return new InlineKeyboard()
    .text(toggleLabel, "adm_log_toggle")
    .row()
    .text("✏️ Ubah Target Channel", "adm_log_setchan")
    .text("✏️ Ubah Link Invite", "adm_log_setlink")
    .row()
    .text("🧪 Kirim Log Uji Coba", "adm_log_test")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildTestimonialAdminText(): Promise<string> {
  const config = await TestimonialService.getConfig();
  const status = config.testimonialEnabled
    ? "🟢 <b>Aktif</b> (Otomatis posting bukti transaksi / testimoni ke channel)"
    : "🔴 <b>Nonaktif</b> (Tidak mengirimkan testimoni ke channel)";

  return (
    `🌟 <b>Pengaturan Channel Testimoni Pembelian</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `⚙️ <b>Status Fitur:</b>      ${status}\n` +
    `🆔 <b>Target Channel:</b>    <code>${config.testimonialChannel || "(Belum diatur)"}</code>\n` +
    `🔗 <b>Link Channel:</b>      ${config.testimonialLink ? `<a href="${config.testimonialLink}">${config.testimonialLink}</a>` : "<code>(Belum diatur)</code>"}\n\n` +
    `<i>💡 Catatan: Pastikan bot telah ditambahkan sebagai <b>Administrator</b> di channel target dengan izin <b>Post Messages (Kirim Pesan)</b>!</i>`
  );
}

async function buildTestimonialAdminKeyboard(): Promise<InlineKeyboard> {
  const config = await TestimonialService.getConfig();
  const toggleLabel = config.testimonialEnabled ? "🔴 Nonaktifkan Fitur" : "🟢 Aktifkan Fitur";

  return new InlineKeyboard()
    .text(toggleLabel, "adm_testi_toggle")
    .row()
    .text("✏️ Ubah Target Channel", "adm_testi_setchan")
    .text("✏️ Ubah Link Invite", "adm_testi_setlink")
    .row()
    .text("🧪 Kirim Testimoni Uji Coba", "adm_testi_test")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildForceSubAdminText(): Promise<string> {
  const config = await ForceSubService.getConfig();
  const status = config.forceSubEnabled
    ? "🟢 <b>Aktif</b> (User wajib join channel sebelum memakai bot)"
    : "🔴 <b>Nonaktif</b> (Semua user bebas menggunakan bot)";

  return (
    `📢 <b>Pengaturan Wajib Join Channel (Force Sub)</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `⚙️ <b>Status Fitur:</b>    ${status}\n` +
    `🆔 <b>Channel Target:</b>  <code>${config.forceSubChannel || "(Belum diatur)"}</code>\n` +
    `🔗 <b>Link Channel:</b>    ${config.forceSubLink ? `<a href="${config.forceSubLink}">${config.forceSubLink}</a>` : "<code>(Belum diatur)</code>"}\n` +
    `📛 <b>Nama Tampilan:</b>   <b>${config.forceSubName || "Channel Resmi"}</b>\n\n` +
    `<i>💡 Catatan: Pastikan bot telah ditambahkan sebagai Administrator di channel target agar dapat memeriksa keanggotaan user secara otomatis!</i>`
  );
}

async function buildForceSubAdminKeyboard(): Promise<InlineKeyboard> {
  const config = await ForceSubService.getConfig();
  const toggleLabel = config.forceSubEnabled ? "🔴 Nonaktifkan Fitur" : "🟢 Aktifkan Fitur";

  return new InlineKeyboard()
    .text(toggleLabel, "adm_fsub_toggle")
    .row()
    .text("✏️ Ubah Target Channel", "adm_fsub_setchan")
    .text("✏️ Ubah Link Invite", "adm_fsub_setlink")
    .row()
    .text("✏️ Ubah Nama Tampilan", "adm_fsub_setname")
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

/** Builds the paginated country list with ✅/❌ toggle buttons. */
async function buildCountryPage(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const all        = SMSBowerService.allCountries;
  const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
  const safePage   = Math.max(0, Math.min(page, totalPages - 1));
  const chunk      = all.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  // Fresh DB read so the ✅/❌ status is always current after a toggle.
  const config   = await SmsConfig.getOrCreate();
  const allowed  = new Set(config.allowedCountries);

  const kb = new InlineKeyboard();
  for (const country of chunk) {
    const icon = allowed.has(country.id) ? "✅" : "❌";
    kb.text(`${icon} ${country.name}`, `tgl_c_${country.id}_${safePage}`).row();
  }

  // Pagination row
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_c_pg_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_c_pg_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali", "adm_home");

  const text =
    `🌍 <b>Kelola Negara</b> — Halaman ${safePage + 1}/${totalPages}\n` +
    `${"─".repeat(30)}\n` +
    `✅ = Aktif  |  ❌ = Tidak aktif\n` +
    `Klik untuk toggle on/off.\n\n` +
    `<i>${allowed.size} dari ${all.length} negara aktif.</i>`;

  return { text, keyboard: kb };
}

/** Builds the paginated service list with ✅/❌ toggle buttons. */
async function buildServicePage(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const all        = SMSBowerService.allServices;
  const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
  const safePage   = Math.max(0, Math.min(page, totalPages - 1));
  const chunk      = all.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const config  = await SmsConfig.getOrCreate();
  const allowed = new Set(config.allowedServices);

  const kb = new InlineKeyboard();
  for (const svc of chunk) {
    const icon = allowed.has(svc.code) ? "✅" : "❌";
    kb.text(`${icon} ${svc.name}`, `tgl_s_${svc.code}_${safePage}`).row();
  }

  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_s_pg_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_s_pg_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali", "adm_home");

  const text =
    `📱 <b>Kelola Layanan</b> — Halaman ${safePage + 1}/${totalPages}\n` +
    `${"─".repeat(30)}\n` +
    `✅ = Aktif  |  ❌ = Tidak aktif\n` +
    `Klik untuk toggle on/off.\n\n` +
    `<i>${allowed.size} dari ${all.length} layanan aktif.</i>`;

  return { text, keyboard: kb };
}

/** Formats the pricing info card shown in /markup and /smsadmin → Pricing. */
async function buildPricingText(
  markupType:  "fixed" | "percentage",
  markupValue: number
): Promise<string> {
  const usdRate = await CurrencyService.getUsdRate();
  const rule =
    markupType === "percentage"
      ? `Harga Jual = (Modal USD × Kurs) + <b>${markupValue}%</b>`
      : `Harga Jual = (Modal USD × Kurs) + <b>Rp ${markupValue.toLocaleString("id-ID")}</b>`;

  const usdExamples = [0.03, 0.05, 0.10, 0.25];
  const examples = usdExamples.map((usd) => {
    const pricing = CurrencyService.calculatePricing(usd, markupType, markupValue, usdRate);
    return `  • $${usd} USD (~Rp ${pricing.baseCostIdr.toLocaleString("id-ID")}) ➔ Jual <b>Rp ${pricing.sellingPriceIdr.toLocaleString("id-ID")}</b> (MaxPrice $${pricing.maxPriceUsd})`;
  });

  return (
    `💰 <b>Pengaturan Harga & Kurs Aktif</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `💱 <b>Kurs Realtime:</b>   <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code> (Auto)\n` +
    `📊 <b>Tipe Markup:</b>     <code>${markupType}</code>\n` +
    `📈 <b>Nilai Markup:</b>    <code>${markupValue}${markupType === "percentage" ? "%" : " IDR"}</code>\n\n` +
    `📐 <b>Rumus:</b> ${rule}\n\n` +
    `💡 <b>Simulasi Harga Jual & MaxPrice Provider:</b>\n` +
    examples.join("\n") + "\n\n" +
    `<i>Ubah dengan: /setmarkup &lt;fixed|percentage&gt; &lt;nilai&gt;</i>\n` +
    `<i>(Contoh: /setmarkup fixed 1000 atau /setmarkup percentage 20)</i>`
  );
}

// ── Price Explorer Helpers ───────────────────────────────────────────────────

async function buildCheckPriceMenuText(): Promise<string> {
  const [usdRate, smsConfig] = await Promise.all([
    CurrencyService.getUsdRate(),
    SmsConfig.getOrCreate(),
  ]);

  let balanceText = "Memuat…";
  try {
    const bal = await smsBower.getBalance();
    balanceText = `$${bal.toFixed(2)} USD (~Rp ${Math.round(bal * usdRate).toLocaleString("id-ID")})`;
  } catch {
    balanceText = "⚠️ Gagal memuat saldo provider";
  }

  const markupLine = smsConfig.markupType === "percentage"
    ? `+${smsConfig.markupValue}% (persentase)`
    : `+Rp ${smsConfig.markupValue.toLocaleString("id-ID")} (flat)`;

  return (
    `🔍 <b>Penjelajah Harga Asli SMSBower (USD & IDR)</b>\n` +
    `${"─".repeat(36)}\n\n` +
    `💵 <b>Saldo Provider SMSBower:</b> <code>${balanceText}</code>\n` +
    `💱 <b>Kurs Realtime (USD➔IDR):</b>  <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code> (Auto)\n` +
    `📊 <b>Pengaturan Markup:</b>       <code>${markupLine}</code>\n` +
    `🌍 <b>Negara Aktif / Total:</b>    <code>${SMSBowerService.cachedCountries.length} / ${SMSBowerService.allCountries.length}</code>\n` +
    `📱 <b>Layanan Aktif / Total:</b>   <code>${SMSBowerService.cachedServices.length} / ${SMSBowerService.allServices.length}</code>\n\n` +
    `💡 <i>Gunakan tombol di bawah untuk eksplorasi harga atau ketik command:</i>\n` +
    `• <code>/cekharga &lt;layanan&gt; &lt;negara&gt;</code> (Contoh: <code>/cekharga wa 6</code>)\n` +
    `• <code>/cekharga &lt;layanan&gt;</code> (Contoh: <code>/cekharga telegram</code>)\n` +
    `• <code>/cekharga &lt;negara&gt;</code> (Contoh: <code>/cekharga indonesia</code>)`
  );
}

function buildCheckPriceMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🌍 Cek Harga per Negara", "adm_cp_ctry_pg_0")
    .row()
    .text("📱 Cek Harga per Layanan", "adm_cp_svc_pg_0")
    .row()
    .text("🔄 Refresh Kurs & Cache", "adm_cp_refresh")
    .row()
    .text("🔙 Kembali ke Pricing", "adm_pricing");
}

async function buildCheckPriceCountryKeyboard(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const all = SMSBowerService.allCountries;
  const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = all.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const config = await SmsConfig.getOrCreate();
  const allowed = new Set(config.allowedCountries);

  const kb = new InlineKeyboard();
  chunk.forEach((c, idx) => {
    const isWhitelisted = allowed.has(c.id) ? "🟢" : "⚪";
    kb.text(`${isWhitelisted} ${c.name} (${c.id})`, `adm_cp_c_${c.id}_0`);
    if (idx % 2 === 1 || idx === chunk.length - 1) kb.row();
  });

  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_cp_ctry_pg_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_cp_ctry_pg_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali", "adm_check_price");

  const text =
    `🌍 <b>Pilih Negara untuk Cek Harga</b> (Hal ${safePage + 1}/${totalPages})\n` +
    `${"─".repeat(34)}\n` +
    `<i>🟢 = Whitelisted di bot | ⚪ = Non-whitelist</i>\n\n` +
    `Pilih negara untuk melihat daftar seluruh layanan beserta harga modal USD & IDR:`;

  return { text, keyboard: kb };
}

async function buildCountryServicesPriceView(countryId: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const country = SMSBowerService.allCountries.find((c) => c.id === countryId) || { id: countryId, name: `Country #${countryId}` };
  const [priceMap, config, usdRate] = await Promise.all([
    SMSBowerService.getPricesForCountry(countryId),
    SmsConfig.getOrCreate(),
    CurrencyService.getUsdRate(),
  ]);

  const servicesList: Array<{ code: string; name: string; cost: number; count: number }> = [];

  for (const svc of SMSBowerService.allServices) {
    const p = priceMap.get(svc.code);
    if (p && p.cost > 0) {
      servicesList.push({ code: svc.code, name: svc.name, cost: p.cost, count: p.count });
    }
  }

  for (const [code, p] of priceMap.entries()) {
    if (!servicesList.some((s) => s.code === code) && p.cost > 0) {
      const known = SMSBowerService.findService(code);
      servicesList.push({ code, name: known?.name || code, cost: p.cost, count: p.count });
    }
  }

  servicesList.sort((a, b) => {
    if (a.count > 0 && b.count <= 0) return -1;
    if (a.count <= 0 && b.count > 0) return 1;
    return a.name.localeCompare(b.name);
  });

  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(servicesList.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = servicesList.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}%`
    : `+Rp ${config.markupValue.toLocaleString("id-ID")}`;

  let listText = "";
  if (chunk.length === 0) {
    listText = `<i>⚠️ Tidak ada data harga layanan yang ditemukan dari provider untuk negara ini saat ini.</i>\n`;
  } else {
    listText = chunk.map((s, i) => {
      const num = safePage * PAGE_SIZE + i + 1;
      const pricing = CurrencyService.calculatePricing(s.cost, config.markupType, config.markupValue, usdRate);
      const profit = pricing.sellingPriceIdr - pricing.baseCostIdr;
      const stockBadge = s.count > 0 ? `📦 ${s.count.toLocaleString("id-ID")}` : "❌ Stok 0";

      return (
        `${num}. <b>${escapeHtml(s.name)}</b> (<code>${s.code}</code>)\n` +
        `   • ${stockBadge} | 💵 <b>$${s.cost.toFixed(4)} USD</b> (~Rp ${pricing.baseCostIdr.toLocaleString("id-ID")})\n` +
        `   • 🏷️ Jual: <b>Rp ${pricing.sellingPriceIdr.toLocaleString("id-ID")}</b> (Profit: <code>+Rp ${profit.toLocaleString("id-ID")}</code>)`
      );
    }).join("\n\n");
  }

  const text =
    `📊 <b>Daftar Harga Asli SMSBower — ${escapeHtml(country.name)} (ID: ${country.id})</b>\n` +
    `${"─".repeat(36)}\n` +
    `💱 <b>Kurs Realtime:</b> <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code>\n` +
    `📈 <b>Markup Bot:</b>    <code>${markupLine}</code>\n` +
    `📄 <b>Halaman:</b>       <b>${safePage + 1} / ${totalPages}</b> (${servicesList.length} Layanan)\n\n` +
    listText;

  const kb = new InlineKeyboard();
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_cp_c_${countryId}_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_cp_c_${countryId}_${safePage + 1}`);
    kb.row();
  }

  kb.text("🌍 Pilih Negara Lain", "adm_cp_ctry_pg_0")
    .row()
    .text("🔙 Kembali ke Cek Harga", "adm_check_price");

  return { text, keyboard: kb };
}

async function buildCheckPriceServiceKeyboard(page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const all = SMSBowerService.allServices;
  const totalPages = Math.max(1, Math.ceil(all.length / ITEMS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = all.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

  const config = await SmsConfig.getOrCreate();
  const allowed = new Set(config.allowedServices);

  const kb = new InlineKeyboard();
  chunk.forEach((s, idx) => {
    const isWhitelisted = allowed.has(s.code) ? "🟢" : "⚪";
    kb.text(`${isWhitelisted} ${s.name}`, `adm_cp_s_${s.code}_0`);
    if (idx % 2 === 1 || idx === chunk.length - 1) kb.row();
  });

  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_cp_svc_pg_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_cp_svc_pg_${safePage + 1}`);
    kb.row();
  }

  kb.text("🔙 Kembali", "adm_check_price");

  const text =
    `📱 <b>Pilih Layanan untuk Cek Harga</b> (Hal ${safePage + 1}/${totalPages})\n` +
    `${"─".repeat(34)}\n` +
    `<i>🟢 = Whitelisted di bot | ⚪ = Non-whitelist</i>\n\n` +
    `Pilih layanan untuk melihat perbandingan harga di berbagai negara:`;

  return { text, keyboard: kb };
}

async function buildServiceCountriesPriceView(serviceCode: string, page: number): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const service = SMSBowerService.findService(serviceCode) || { code: serviceCode, name: serviceCode };
  const [pricesMap, config, usdRate] = await Promise.all([
    SMSBowerService.getPricesByService(serviceCode),
    SmsConfig.getOrCreate(),
    CurrencyService.getUsdRate(),
  ]);

  const countriesList: Array<{ countryId: string; countryName: string; cost: number; count: number }> = [];

  for (const [countryId, price] of pricesMap.entries()) {
    if (price.cost > 0) {
      const country = SMSBowerService.findCountry(countryId);
      countriesList.push({
        countryId,
        countryName: country?.name || `Country #${countryId}`,
        cost: price.cost,
        count: price.count,
      });
    }
  }

  if (countriesList.length === 0) {
    for (const c of SMSBowerService.cachedCountries) {
      const p = await SMSBowerService.getServicePrice(serviceCode, c.id);
      if (p && p.cost > 0) {
        countriesList.push({
          countryId: c.id,
          countryName: c.name,
          cost: p.cost,
          count: p.count,
        });
      }
    }
  }

  countriesList.sort((a, b) => {
    if (a.count > 0 && b.count <= 0) return -1;
    if (a.count <= 0 && b.count > 0) return 1;
    return a.countryName.localeCompare(b.countryName);
  });

  const PAGE_SIZE = 8;
  const totalPages = Math.max(1, Math.ceil(countriesList.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const chunk = countriesList.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}%`
    : `+Rp ${config.markupValue.toLocaleString("id-ID")}`;

  let listText = "";
  if (chunk.length === 0) {
    listText = `<i>⚠️ Tidak ada data harga dari provider untuk layanan ini saat ini.</i>\n`;
  } else {
    listText = chunk.map((c, i) => {
      const num = safePage * PAGE_SIZE + i + 1;
      const pricing = CurrencyService.calculatePricing(c.cost, config.markupType, config.markupValue, usdRate);
      const profit = pricing.sellingPriceIdr - pricing.baseCostIdr;
      const stockBadge = c.count > 0 ? `📦 ${c.count.toLocaleString("id-ID")}` : "❌ Stok 0";

      return (
        `${num}. <b>${escapeHtml(c.countryName)}</b> (ID: <code>${c.countryId}</code>)\n` +
        `   • ${stockBadge} | 💵 <b>$${c.cost.toFixed(4)} USD</b> (~Rp ${pricing.baseCostIdr.toLocaleString("id-ID")})\n` +
        `   • 🏷️ Jual: <b>Rp ${pricing.sellingPriceIdr.toLocaleString("id-ID")}</b> (Profit: <code>+Rp ${profit.toLocaleString("id-ID")}</code>)`
      );
    }).join("\n\n");
  }

  const text =
    `📊 <b>Perbandingan Harga Asli SMSBower — ${escapeHtml(service.name)} (<code>${service.code}</code>)</b>\n` +
    `${"─".repeat(36)}\n` +
    `💱 <b>Kurs Realtime:</b> <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code>\n` +
    `📈 <b>Markup Bot:</b>    <code>${markupLine}</code>\n` +
    `📄 <b>Halaman:</b>       <b>${safePage + 1} / ${totalPages}</b> (${countriesList.length} Negara)\n\n` +
    listText;

  const kb = new InlineKeyboard();
  const hasPrev = safePage > 0;
  const hasNext = safePage < totalPages - 1;
  if (hasPrev || hasNext) {
    if (hasPrev) kb.text("⬅️ Prev", `adm_cp_s_${serviceCode}_${safePage - 1}`);
    if (hasNext) kb.text("Next ➡️", `adm_cp_s_${serviceCode}_${safePage + 1}`);
    kb.row();
  }

  kb.text("📱 Pilih Layanan Lain", "adm_cp_svc_pg_0")
    .row()
    .text("🔙 Kembali ke Cek Harga", "adm_check_price");

  return { text, keyboard: kb };
}

function buildSinglePriceDetailText(
  service: { code: string; name: string },
  country: { id: string; name: string },
  costUsd: number,
  count: number,
  usdRate: number,
  config: { markupType: "fixed" | "percentage"; markupValue: number },
  providerIds?: string,
  providers?: Array<{ providerId: number | string; price: number; count: number }>
): string {
  const pricing = CurrencyService.calculatePricing(costUsd, config.markupType, config.markupValue, usdRate);
  const profit = pricing.sellingPriceIdr - pricing.baseCostIdr;
  const profitPercent = pricing.baseCostIdr > 0 ? (profit / pricing.baseCostIdr) * 100 : 0;
  const stockText = count > 0 ? `<b>${count.toLocaleString("id-ID")} nomor</b>` : "⚠️ <b>Kosong / 0 nomor</b>";

  const markupDisplay = config.markupType === "percentage"
    ? `+${config.markupValue}% (persentase)`
    : `+Rp ${config.markupValue.toLocaleString("id-ID")} (flat IDR)`;

  let providerSection = "";
  if (providers && providers.length > 0) {
    const top3 = providers.slice(0, 3).map((p, idx) => `  ${idx + 1}. ID: <code>${p.providerId}</code> ➔ <b>$${p.price.toFixed(4)} USD</b> (Stok: ${p.count.toLocaleString("id-ID")})`).join("\n");
    providerSection =
      `\n🏆 <b>3 Provider Termurah (getPricesV3):</b>\n` +
      top3 + `\n` +
      `🆔 <b>Param providerIds:</b> <code>${providerIds || "—"}</code>\n`;
  }

  return (
    `🔍 <b>Rincian Harga Asli Provider SMSBower (V3)</b>\n` +
    `${"─".repeat(34)}\n\n` +
    `📱 <b>Layanan:</b>  <b>${escapeHtml(service.name)}</b> (<code>${service.code}</code>)\n` +
    `🌍 <b>Negara:</b>   <b>${escapeHtml(country.name)}</b> (ID: <code>${country.id}</code>)\n` +
    `📦 <b>Total Stok:</b> ${stockText}\n\n` +
    `💵 <b>Modal Termurah (USD):</b>  <code>$${costUsd.toFixed(4)} USD</code>\n` +
    `💱 <b>Kurs Realtime:</b>         <code>1 USD = Rp ${Math.round(usdRate).toLocaleString("id-ID")}</code>\n` +
    `🇮🇩 <b>Modal Konversi IDR:</b>    <b>Rp ${pricing.baseCostIdr.toLocaleString("id-ID")}</b>\n\n` +
    `📊 <b>Pengaturan Markup:</b>     <code>${markupDisplay}</code>\n` +
    `🏷️ <b>Harga Jual ke User:</b>    <b>Rp ${pricing.sellingPriceIdr.toLocaleString("id-ID")}</b>\n` +
    `💰 <b>Estimasi Profit:</b>        <b>+Rp ${profit.toLocaleString("id-ID")}</b> (${profitPercent.toFixed(1)}%)\n` +
    `🛡️ <b>MaxPrice Provider:</b>     <code>$${pricing.maxPriceUsd.toFixed(4)} USD</code>\n` +
    providerSection + "\n" +
    `<i>💡 Catatan: Sistem otomatis menggunakan providerIds dari 3 provider termurah saat menyewa nomor.</i>`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parses the first word argument from a command message. */
function parseArg(ctx: Context): string | null {
  const text  = ctx.message?.text ?? "";
  const parts = text.trim().split(/\s+/);
  const arg   = parts[1]?.trim();
  return arg && arg.length > 0 ? arg : null;
}

/** Reloads cache and returns a compact summary string. */
async function reload(): Promise<string> {
  await SMSBowerService.loadData();
  const svc = SMSBowerService.cachedServices.map((s) => `${s.name} (${s.code})`).join(", ") || "—";
  const ctr = SMSBowerService.cachedCountries.map((c) => `${c.name} (${c.id})`).join(", ") || "—";
  return (
    `✅ <b>Cache refreshed.</b>\n\n` +
    `<b>Layanan (${SMSBowerService.cachedServices.length}):</b>\n<code>${svc}</code>\n\n` +
    `<b>Negara (${SMSBowerService.cachedCountries.length}):</b>\n<code>${ctr}</code>`
  );
}

function formatIDR(amount: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function maskEmail(email?: string): string {
  if (!email || !email.includes("@")) return email || "(Tidak terdeteksi)";
  const parts = email.split("@");
  const local = parts[0] || "";
  const domain = parts.slice(1).join("@");
  if (!local || !domain) return email;

  let maskedLocal = local;
  if (local.length <= 2) {
    maskedLocal = "*".repeat(local.length);
  } else if (local.length <= 3) {
    maskedLocal = "**" + local.slice(-1);
  } else {
    const keepCount = 2;
    const starCount = Math.min(local.length - keepCount, 3);
    maskedLocal = "*".repeat(starCount) + local.slice(-keepCount);
  }

  const dotIndex = domain.indexOf(".");
  if (dotIndex > 0) {
    const mainDomain = domain.slice(0, dotIndex);
    const ext = domain.slice(dotIndex);
    let maskedMain = mainDomain;
    if (mainDomain.length <= 2) {
      maskedMain = "*".repeat(mainDomain.length);
    } else {
      const starCount = Math.min(2, mainDomain.length - 1);
      maskedMain = "*".repeat(starCount) + mainDomain.slice(starCount);
    }
    return `${maskedLocal}@${maskedMain}${ext}`;
  }

  return `${maskedLocal}@${domain}`;
}

function buildStatsKeyboard(
  currentTab: "overview" | "users" | "finance" | "digital" | "sms"
): InlineKeyboard {
  return new InlineKeyboard()
    .text(currentTab === "overview" ? "• 📊 Overview •" : "📊 Overview", "adm_stats_overview")
    .text(currentTab === "users" ? "• 👥 User •" : "👥 User", "adm_stats_users")
    .row()
    .text(currentTab === "finance" ? "• 💳 Top-Up •" : "💳 Top-Up", "adm_stats_finance")
    .text(currentTab === "digital" ? "• 📦 Digital •" : "📦 Digital", "adm_stats_digital")
    .row()
    .text(currentTab === "sms" ? "• 📱 OTP SMS •" : "📱 OTP SMS", "adm_stats_sms")
    .text("🔄 Refresh Data", `adm_stats_rf_${currentTab}`)
    .row()
    .text("🔙 Kembali ke Menu Admin", "adm_home");
}

async function buildStatsOverviewText(): Promise<string> {
  const stats = await BotStatsService.getOverviewStats();
  const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    `📊 <b>Statistik & Analisis Bot — Ringkasan Utama</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `👥 <b>Pengguna & Saldo:</b>\n` +
    `• Total Terdaftar: <b>${stats.totalUsers.toLocaleString("id-ID")}</b> user\n` +
    `• User Baru Hari Ini: <b>+${stats.newUsersToday.toLocaleString("id-ID")}</b> user\n` +
    `• Total Saldo Beredar: <b>${formatIDR(stats.totalUserBalance)}</b>\n\n` +
    `💳 <b>Deposit QRIS (Uang Masuk):</b>\n` +
    `• Hari Ini: <b>${formatIDR(stats.qrisTodaySettledAmount)}</b> (<code>${stats.qrisTodaySettledCount} trx</code>)\n` +
    `• Sepanjang Waktu: <b>${formatIDR(stats.qrisTotalSettledAmount)}</b> (<code>${stats.qrisTotalSettledCount} trx</code>)\n\n` +
    `📦 <b>Produk Digital:</b>\n` +
    `• Omset Hari Ini: <b>${formatIDR(stats.digitalTodayRevenue)}</b> (<code>${stats.digitalTodayOrders} order</code>)\n` +
    `• Total Omset: <b>${formatIDR(stats.digitalTotalRevenue)}</b> (<code>${stats.digitalTotalOrders} order</code>)\n` +
    `• Katalog: <b>${stats.totalDigitalProducts}</b> produk (<b>${stats.totalStockAvailable}</b> stok ready)\n\n` +
    `📱 <b>Layanan OTP SMS:</b>\n` +
    `• Belanja Hari Ini: <b>${formatIDR(stats.smsTodayRevenue)}</b> (<code>${stats.smsTodayCompletedCount} OTP sukses</code>)\n` +
    `• Total Belanja OTP: <b>${formatIDR(stats.smsTotalRevenue)}</b> (<code>${stats.smsCompletedOrders} / ${stats.smsTotalOrders} sukses</code>)\n\n` +
    `<i>🕒 Diperbarui: ${time} WIB</i>`
  );
}

async function buildStatsUsersText(): Promise<string> {
  const stats = await BotStatsService.getUserStats();
  const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  let topBalancesText = "<i>(Belum ada data saldo user)</i>";
  if (stats.topBalances.length > 0) {
    topBalancesText = stats.topBalances
      .map((u, i) => {
        const name = escapeHtml(u.firstName || "User");
        const tag = u.username ? ` (@${escapeHtml(u.username)})` : "";
        return `${i + 1}. <b>${name}</b>${tag} [<code>${u.telegramId}</code>]: <b>${formatIDR(u.balance)}</b>`;
      })
      .join("\n");
  }

  let topActiveText = "<i>(Belum ada data order user)</i>";
  if (stats.topActiveUsers.length > 0) {
    topActiveText = stats.topActiveUsers
      .map((u, i) => {
        const name = escapeHtml(u.firstName || "User");
        const tag = u.username ? ` (@${escapeHtml(u.username)})` : "";
        return `${i + 1}. <b>${name}</b>${tag} [<code>${u.telegramId}</code>]: <b>${u.totalOrders} order</b> (${formatIDR(u.balance)})`;
      })
      .join("\n");
  }

  return (
    `👥 <b>Statistik Pertumbuhan & Saldo Pengguna</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `📈 <b>Pertumbuhan Pengguna:</b>\n` +
    `• Total Terdaftar: <b>${stats.totalUsers.toLocaleString("id-ID")}</b> user\n` +
    `• Baru Hari Ini: <b>+${stats.newToday.toLocaleString("id-ID")}</b> user\n` +
    `• Baru Minggu Ini (7 hari): <b>+${stats.newThisWeek.toLocaleString("id-ID")}</b> user\n` +
    `• Baru Bulan Ini: <b>+${stats.newThisMonth.toLocaleString("id-ID")}</b> user\n\n` +
    `💰 <b>Informasi Saldo:</b>\n` +
    `• Total Saldo Tersimpan: <b>${formatIDR(stats.totalBalance)}</b>\n` +
    `• User dengan Saldo (&gt;0): <b>${stats.usersWithBalanceCount.toLocaleString("id-ID")}</b> user\n` +
    `• Rata-rata Saldo Aktif: <b>${formatIDR(stats.avgBalance)}</b> / user\n\n` +
    `🏆 <b>Top 5 Saldo Tertinggi:</b>\n` +
    `${topBalancesText}\n\n` +
    `🔥 <b>Top 5 User Paling Aktif (Order Terbanyak):</b>\n` +
    `${topActiveText}\n\n` +
    `<i>🕒 Diperbarui: ${time} WIB</i>`
  );
}

async function buildStatsFinanceText(): Promise<string> {
  const stats = await BotStatsService.getFinanceStats();
  const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    `💳 <b>Statistik Keuangan & Deposit QRIS</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `💵 <b>Volume Deposit Berhasil (Settled):</b>\n` +
    `• Hari Ini: <b>${formatIDR(stats.todaySettledAmount)}</b> (<code>${stats.todaySettledCount} transaksi</code>)\n` +
    `• 7 Hari Terakhir: <b>${formatIDR(stats.weekSettledAmount)}</b> (<code>${stats.weekSettledCount} transaksi</code>)\n` +
    `• Bulan Ini: <b>${formatIDR(stats.monthSettledAmount)}</b> (<code>${stats.monthSettledCount} transaksi</code>)\n` +
    `• Sepanjang Waktu: <b>${formatIDR(stats.totalSettledAmount)}</b> (<code>${stats.totalSettledCount} transaksi</code>)\n\n` +
    `📊 <b>Performa Sesi QRIS:</b>\n` +
    `• Sukses Terbayar: <b>${stats.totalSettledCount}</b> sesi\n` +
    `• Menunggu Pembayaran: <b>${stats.pendingCount}</b> sesi\n` +
    `• Expired / Dibatalkan: <b>${stats.expiredOrCancelledCount}</b> sesi\n` +
    `• Success Rate (Conversion): <b>${stats.conversionRate}%</b>\n\n` +
    `<i>💡 Catatan: Data dihitung otomatis dari riwayat invoice QRIS GoPay / GoBiz.</i>\n\n` +
    `<i>🕒 Diperbarui: ${time} WIB</i>`
  );
}

async function buildStatsDigitalText(): Promise<string> {
  const stats = await BotStatsService.getDigitalStats();
  const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  let topSellingText = "<i>(Belum ada riwayat penjualan digital)</i>";
  if (stats.topSellingProducts.length > 0) {
    topSellingText = stats.topSellingProducts
      .map((p, i) => {
        return `${i + 1}. <b>${escapeHtml(p.productName)}</b>: <b>${p.totalSold} item</b> (${formatIDR(p.totalRevenue)})`;
      })
      .join("\n");
  }

  return (
    `📦 <b>Statistik Penjualan Produk Digital</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `💰 <b>Pendapatan & Transaksi:</b>\n` +
    `• Omset Hari Ini: <b>${formatIDR(stats.todayRevenue)}</b> (<code>${stats.todayOrders} order</code>)\n` +
    `• Omset Bulan Ini: <b>${formatIDR(stats.monthRevenue)}</b> (<code>${stats.monthOrders} order</code>)\n` +
    `• Total Omset Sepanjang Waktu: <b>${formatIDR(stats.totalRevenue)}</b> (<code>${stats.totalOrders} order</code>)\n` +
    `• Total Item Terkirim: <b>${stats.totalItemsSold.toLocaleString("id-ID")}</b> item\n\n` +
    `📂 <b>Inventaris & Katalog:</b>\n` +
    `• Total Produk: <b>${stats.totalProducts}</b> (<b>${stats.activeProducts}</b> aktif di katalog)\n` +
    `• Jumlah Kategori: <b>${stats.totalCategories}</b> kategori\n` +
    `• Stok Tersedia: <b>${stats.totalStockAvailable}</b> item ready\n` +
    `• Stok Terjual: <b>${stats.totalStockSold}</b> item\n\n` +
    `🏆 <b>Top 5 Produk Terlaris:</b>\n` +
    `${topSellingText}\n\n` +
    `<i>🕒 Diperbarui: ${time} WIB</i>`
  );
}

async function buildStatsSmsText(): Promise<string> {
  const stats = await BotStatsService.getSmsStats();
  const time = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  let topServicesText = "<i>(Belum ada data layanan SMS)</i>";
  if (stats.topServices.length > 0) {
    topServicesText = stats.topServices
      .map((s, i) => {
        const found = SMSBowerService.allServices.find((item) => item.code === s.service);
        const name = found ? found.name : s.service;
        return `${i + 1}. <b>${escapeHtml(name)}</b> (<code>${escapeHtml(s.service)}</code>): <b>${s.count} order</b> (${formatIDR(s.totalCost)})`;
      })
      .join("\n");
  }

  let topCountriesText = "<i>(Belum ada data negara SMS)</i>";
  if (stats.topCountries.length > 0) {
    topCountriesText = stats.topCountries
      .map((c, i) => {
        const found = SMSBowerService.allCountries.find((item) => item.id === String(c.country));
        const name = found ? found.name : `ID ${c.country}`;
        return `${i + 1}. <b>${escapeHtml(name)}</b> (<code>ID: ${c.country}</code>): <b>${c.count} order</b>`;
      })
      .join("\n");
  }

  return (
    `📱 <b>Statistik Layanan OTP SMS (Virtual Number)</b>\n` +
    `${"─".repeat(32)}\n\n` +
    `📊 <b>Performa Pesanan OTP:</b>\n` +
    `• Total Sewa Nomor: <b>${stats.totalOrders.toLocaleString("id-ID")}</b> order\n` +
    `• OTP Berhasil (SMS Masuk): <b>${stats.completedOrders.toLocaleString("id-ID")}</b> order\n` +
    `• Dibatalkan / Timeout: <b>${stats.canceledOrders.toLocaleString("id-ID")}</b> order\n` +
    `• Sedang Berjalan: <b>${stats.pendingOrders.toLocaleString("id-ID")}</b> order\n` +
    `• <b>Success Rate:</b> <b>${stats.successRate}%</b>\n\n` +
    `💰 <b>Perputaran Biaya OTP:</b>\n` +
    `• Hari Ini: <b>${formatIDR(stats.todayCost)}</b> (<code>${stats.todayCompletedCount} sukses</code>)\n` +
    `• Bulan Ini: <b>${formatIDR(stats.monthCost)}</b> (<code>${stats.monthCompletedCount} sukses</code>)\n` +
    `• Total Sepanjang Waktu: <b>${formatIDR(stats.totalCost)}</b>\n\n` +
    `🏆 <b>Top 5 Layanan SMS Paling Diminati:</b>\n` +
    `${topServicesText}\n\n` +
    `🌍 <b>Top 3 Negara Paling Sering Disewa:</b>\n` +
    `${topCountriesText}\n\n` +
    `<i>🕒 Diperbarui: ${time} WIB</i>`
  );
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const adminPlugin: Plugin = {
  name:    "admin",
  version: "2.0.0",

  commands: [
    { command: "admin",             description: "[Admin] Buka panel manajemen admin utama" },
    { command: "stats",             description: "[Admin] Lihat ringkasan & statistik performa bot" },
    { command: "statistik",         description: "[Admin] Lihat ringkasan & statistik performa bot" },
    { command: "otpadmin",          description: "[Admin] Buka panel pengaturan layanan OTP SMS" },
    { command: "toggleotp",         description: "[Admin] Toggle on/off layanan OTP SMS" },
    { command: "togglesms",         description: "[Admin] Toggle on/off layanan OTP SMS" },
    { command: "smsadmin",          description: "[Admin] Buka panel manajemen OTP SMS" },
    { command: "forcesub",          description: "[Admin] Buka panel Wajib Join Channel" },
    { command: "setchannel",        description: "[Admin] Set channel: /setchannel <@channel> [link]" },
    { command: "toggleforcesub",    description: "[Admin] Toggle on/off wajib join channel" },
    { command: "testi",             description: "[Admin] Buka panel pengaturan Channel Testimoni" },
    { command: "settesti",          description: "[Admin] Set channel testimoni: /settesti <@channel> [link]" },
    { command: "toggletesti",       description: "[Admin] Toggle on/off kirim testimoni" },
    { command: "testtesti",         description: "[Admin] Kirim testimoni uji coba ke channel" },
    { command: "log",               description: "[Admin] Buka panel Channel Log Aktivitas" },
    { command: "setlog",            description: "[Admin] Set channel log: /setlog <@channel> [link]" },
    { command: "togglelog",         description: "[Admin] Toggle on/off kirim log ke channel" },
    { command: "testlog",           description: "[Admin] Kirim log uji coba ke channel" },
    { command: "otpchannel",        description: "[Admin] Buka panel pengaturan Channel OTP & IMAP" },
    { command: "setotpchannel",     description: "[Admin] Set channel OTP: /setotpchannel <@channel> [link]" },
    { command: "toggleotpchannel",  description: "[Admin] Toggle on/off forwarder OTP ke channel" },
    { command: "testotpchannel",    description: "[Admin] Kirim pesan OTP uji coba ke channel" },
    { command: "imapstatus",        description: "[Admin] Cek status listener email IMAP" },
    { command: "setimap",           description: "[Admin] Set kredensial IMAP: /setimap <host> <user> <pass> [port] [sender]" },
    { command: "find",              description: "[Admin] Cari layanan: /find <keyword>" },
    { command: "cekharga",          description: "[Admin] Cek harga asli SMSBower (USD & IDR): /cekharga [layanan] [negara]" },
    { command: "hargasms",          description: "[Admin] Cek harga asli SMSBower (USD & IDR)" },
    { command: "markup",            description: "[Admin] Lihat markup harga aktif" },
    { command: "setmarkup",         description: "[Admin] Set markup: /setmarkup <type> <val>" },
    { command: "smsreload",         description: "[Admin] Reload cache SMS dari DB + API" },
    { command: "addservice",        description: "[Admin] Tambah service ke whitelist" },
    { command: "rmservice",         description: "[Admin] Hapus service dari whitelist" },
    { command: "addcountry",        description: "[Admin] Tambah negara ke whitelist" },
    { command: "rmcountry",         description: "[Admin] Hapus negara dari whitelist" },
    { command: "maintenance",       description: "[Admin] Buka panel mode maintenance" },
    { command: "addsaldo",          description: "[Admin] Tambah saldo user: /addsaldo <id/@username> <nominal> [alasan]" },
    { command: "minsaldo",          description: "[Admin] Kurangi saldo user: /minsaldo <id/@username> <nominal> [alasan]" },
    { command: "cekuser",           description: "[Admin] Cek detail user: /cekuser <id/@username>" },
    { command: "addpromo",          description: "[Admin] Buat kode promo: /addpromo <CODE> <FIXED|PERCENT> <value> <quota> <minSpend> <days>" },
    { command: "listpromo",         description: "[Admin] Lihat daftar kode promo aktif" },
    { command: "broadcast",         description: "[Admin] Buka menu broadcast pesan ke user" },
    { command: "backup",            description: "[Admin] Buat & kirim backup database sekarang" },
    { command: "cf",                description: "[Admin] Buka panel Cloudflare Email Routing" },
    { command: "cloudflare",        description: "[Admin] Buka panel Cloudflare Email Routing" },
    { command: "cfcreate",          description: "[Admin] Buat email forward: /cfcreate [prefix] [domain] [dest]" },
    { command: "cflist",            description: "[Admin] Daftar rule email Cloudflare: /cflist [domain]" },
    { command: "cfdel",             description: "[Admin] Hapus rule Cloudflare: /cfdel <zoneId> <ruleId>" },
    { command: "cfzones",           description: "[Admin] Daftar domain / zone Cloudflare" },
    { command: "rollback",          description: "[Admin] Rollback / pulihkan database dari file backup" },
    { command: "restore",           description: "[Admin] Restore / pulihkan database dari file backup" },
  ],

  register(bot: Bot<Context>): void {

    // ── /smsadmin & /admin — Main admin panel ────────────────────────────────
    const openAdmin = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildHomeText(), {
        parse_mode:   "HTML",
        reply_markup: await buildHomeKeyboard(),
      });
    };

    // ── /otpadmin — OTP SMS admin panel ──────────────────────────────────────
    const openOtpAdmin = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildOtpAdminText(), {
        parse_mode:   "HTML",
        reply_markup: await buildOtpAdminKeyboard(),
      });
    };

    bot.command("admin", openAdmin);
    bot.command("smsadmin", openOtpAdmin);
    bot.command("otpadmin", openOtpAdmin);

    // ── /stats & /statistik — Bot Analytics Dashboard ────────────────────────
    const openStats = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildStatsOverviewText(), {
        parse_mode: "HTML",
        reply_markup: buildStatsKeyboard("overview"),
      });
    };

    bot.command("stats", openStats);
    bot.command("statistik", openStats);

    // ── /forcesub — Wajib Join Channel Panel ──────────────────────────────────
    const openForceSub = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildForceSubAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildForceSubAdminKeyboard(),
      });
    };

    bot.command("forcesub", openForceSub);

    // ── /testi, /testimonial — Testimonial Channel Panel ─────────────────────
    const openTestimonial = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildTestimonialAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildTestimonialAdminKeyboard(),
      });
    };

    bot.command("testi", openTestimonial);
    bot.command("testimonial", openTestimonial);

    // ── adm_testi callback ───────────────────────────────────────────────────
    bot.callbackQuery("adm_testi", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildTestimonialAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildTestimonialAdminKeyboard(),
      });
    });

    // ── adm_testi_toggle — Toggle testimonial on/off ─────────────────────────
    bot.callbackQuery("adm_testi_toggle", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await TestimonialService.getConfig();
      const nextState = !config.testimonialEnabled;
      await TestimonialService.updateConfig({ testimonialEnabled: nextState });

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Fitur Testimoni Otomatis DIAKTIFKAN!" : "🔴 Fitur Testimoni Otomatis DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildTestimonialAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildTestimonialAdminKeyboard(),
      });
    });

    // ── adm_testi_setchan — Set testimonial channel ──────────────────────────
    bot.callbackQuery("adm_testi_setchan", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_TESTI_CHAN" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_testi");
      await ctx.reply(
        `✏️ <b>Ubah Target Channel Testimoni</b>\n\n` +
        `Kirimkan username publik channel (misal: <code>@namachannel</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_testi_setlink — Set testimonial channel link ─────────────────────
    bot.callbackQuery("adm_testi_setlink", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_TESTI_LINK" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_testi");
      await ctx.reply(
        `✏️ <b>Ubah Tautan / Link Channel Testimoni</b>\n\n` +
        `Kirimkan link tautan channel testimoni (misal: <code>https://t.me/namachannel</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_testi_test — Send a test testimonial to channel ──────────────────
    bot.callbackQuery("adm_testi_test", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⏳ Mengirimkan pesan uji coba…" });

      const res = await TestimonialService.sendTestTestimonial(ctx.api);
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba testimoni telah dikirim ke channel <code>${res.channel}</code>.\n\n` +
          `Silakan periksa channel target untuk memastikan format tampilan sudah sesuai.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Testimoni", "adm_testi"),
          }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan Uji Coba</b>\n\n` +
          `<b>Error:</b> <code>${res.error}</code>\n\n` +
          `<b>Saran Perbaikan:</b>\n` +
          `1. Pastikan username/ID channel sudah benar: <code>${res.channel || "Belum diatur"}</code>.\n` +
          `2. Pastikan bot telah ditambahkan sebagai <b>ADMINISTRATOR</b> di channel tersebut dengan izin <b>Post Messages</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Testimoni", "adm_testi"),
          }
        );
      }
    });

    // ── Command: /settesti <@channel> [link] ──────────────────────────────────
    bot.command("settesti", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/settesti(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const channel = parts[0]?.trim();
      const link = parts[1]?.trim() || (channel?.startsWith("@") ? `https://t.me/${channel.slice(1)}` : "");

      if (!channel) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/settesti &lt;@username_atau_ID&gt; [link_invite]</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/settesti @testimoni_store https://t.me/testimoni_store</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      await TestimonialService.updateConfig({
        testimonialChannel: channel,
        ...(link && { testimonialLink: link }),
        testimonialEnabled: true,
      });

      await ctx.reply(
        `✅ <b>Channel Testimoni berhasil disetel & fitur diaktifkan!</b>\n\n` +
        `🆔 Channel: <code>${channel}</code>\n` +
        `🔗 Link: <code>${link || "(Belum diatur)"}</code>\n\n` +
        `<i>Pastikan bot sudah dijadikan Administrator di channel tersebut dengan izin Post Messages!</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🧪 Tes Kirim Pesan", "adm_testi_test"),
        }
      );
    });

    // ── Command: /toggletesti ────────────────────────────────────────────────
    bot.command("toggletesti", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const config = await TestimonialService.getConfig();
      const nextState = !config.testimonialEnabled;
      await TestimonialService.updateConfig({ testimonialEnabled: nextState });

      await ctx.reply(
        nextState
          ? `🟢 <b>Fitur Testimoni Otomatis telah DIAKTIFKAN.</b>`
          : `🔴 <b>Fitur Testimoni Otomatis telah DINONAKTIFKAN.</b>`,
        { parse_mode: "HTML" }
      );
    });

    // ── Command: /testtesti ──────────────────────────────────────────────────
    bot.command("testtesti", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const res = await TestimonialService.sendTestTestimonial(ctx.api);
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba testimoni telah dikirim ke channel <code>${res.channel}</code>.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan Uji Coba:</b>\n<code>${res.error}</code>\n\n` +
          `<i>Pastikan bot adalah Admin di channel tersebut dengan hak kirim pesan!</i>`,
          { parse_mode: "HTML" }
        );
      }
    });

    // ── /log, /auditlog — Activity Log Channel Panel ─────────────────────────
    const openLogAdmin = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildLogAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildLogAdminKeyboard(),
      });
    };

    bot.command("log", openLogAdmin);
    bot.command("auditlog", openLogAdmin);

    // ── adm_log callback ─────────────────────────────────────────────────────
    bot.callbackQuery("adm_log", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildLogAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildLogAdminKeyboard(),
      });
    });

    // ── adm_log_toggle — Toggle activity log on/off ──────────────────────────
    bot.callbackQuery("adm_log_toggle", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await ActivityLogService.getConfig();
      const nextState = !config.logChannelEnabled;
      await ActivityLogService.updateConfig({ logChannelEnabled: nextState });

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Fitur Log Aktivitas DIAKTIFKAN!" : "🔴 Fitur Log Aktivitas DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildLogAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildLogAdminKeyboard(),
      });
    });

    // ── adm_log_setchan — Set log channel ────────────────────────────────────
    bot.callbackQuery("adm_log_setchan", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_LOG_CHAN" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_log");
      await ctx.reply(
        `✏️ <b>Ubah Target Channel Log Aktivitas</b>\n\n` +
        `Kirimkan username channel (misal: <code>@channel_log</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_log_setlink — Set log channel link ───────────────────────────────
    bot.callbackQuery("adm_log_setlink", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_LOG_LINK" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_log");
      await ctx.reply(
        `✏️ <b>Ubah Tautan / Link Channel Log Aktivitas</b>\n\n` +
        `Kirimkan link tautan channel log (misal: <code>https://t.me/channel_log</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_log_test — Send a test log to channel ────────────────────────────
    bot.callbackQuery("adm_log_test", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⏳ Mengirimkan log uji coba…" });

      const res = await ActivityLogService.sendTestLog(ctx.api);
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba log telah dikirim ke channel <code>${res.channel}</code>.\n\n` +
          `Silakan periksa channel target untuk memastikan bot dapat memposting log secara normal.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Log", "adm_log"),
          }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Log Uji Coba</b>\n\n` +
          `<b>Error:</b> <code>${res.error}</code>\n\n` +
          `<b>Saran Perbaikan:</b>\n` +
          `1. Pastikan username/ID channel sudah benar: <code>${res.channel || "Belum diatur"}</code>.\n` +
          `2. Pastikan bot telah ditambahkan sebagai <b>ADMINISTRATOR</b> di channel tersebut dengan izin <b>Post Messages</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Log", "adm_log"),
          }
        );
      }
    });

    // ── Command: /setlog <@channel> [link] ────────────────────────────────────
    bot.command("setlog", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/setlog(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const channel = parts[0]?.trim();
      const link = parts[1]?.trim() || (channel?.startsWith("@") ? `https://t.me/${channel.slice(1)}` : "");

      if (!channel) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/setlog &lt;@username_atau_ID&gt; [link_invite]</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/setlog @bot_audit_log https://t.me/bot_audit_log</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      await ActivityLogService.updateConfig({
        logChannel: channel,
        ...(link && { logChannelLink: link }),
        logChannelEnabled: true,
      });

      await ctx.reply(
        `✅ <b>Channel Log Aktivitas berhasil disetel & fitur diaktifkan!</b>\n\n` +
        `🆔 Channel: <code>${channel}</code>\n` +
        `🔗 Link: <code>${link || "(Belum diatur)"}</code>\n\n` +
        `<i>Pastikan bot sudah dijadikan Administrator di channel tersebut dengan izin Post Messages!</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🧪 Tes Kirim Log", "adm_log_test"),
        }
      );
    });

    // ── Command: /togglelog ──────────────────────────────────────────────────
    bot.command("togglelog", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const config = await ActivityLogService.getConfig();
      const nextState = !config.logChannelEnabled;
      await ActivityLogService.updateConfig({ logChannelEnabled: nextState });

      await ctx.reply(
        nextState
          ? `🟢 <b>Fitur Log Aktivitas telah DIAKTIFKAN.</b>`
          : `🔴 <b>Fitur Log Aktivitas telah DINONAKTIFKAN.</b>`,
        { parse_mode: "HTML" }
      );
    });

    // ── Command: /testlog ────────────────────────────────────────────────────
    bot.command("testlog", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const res = await ActivityLogService.sendTestLog(ctx.api);
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba log telah dikirim ke channel <code>${res.channel}</code>.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Log Uji Coba:</b>\n<code>${res.error}</code>\n\n` +
          `<i>Pastikan bot adalah Admin di channel tersebut dengan hak kirim pesan!</i>`,
          { parse_mode: "HTML" }
        );
      }
    });

    // ── /otpchannel, /imapadmin — OTP Channel & IMAP Panel ───────────────────
    const openOtpChannelAdmin = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildOtpChannelAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildOtpChannelAdminKeyboard(),
      });
    };

    bot.command("otpchannel", openOtpChannelAdmin);
    bot.command("imapadmin", openOtpChannelAdmin);

    // ── adm_otpchan callback ─────────────────────────────────────────────────
    bot.callbackQuery("adm_otpchan", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildOtpChannelAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildOtpChannelAdminKeyboard(),
      });
    });

    // ── adm_otpchan_toggle_pp — Toggle PayPal OTP forwarder ─────────────────
    bot.callbackQuery(["adm_otpchan_toggle_pp", "adm_otpchan_toggle"], async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await BotConfig.getOrCreate();
      const nextState = !config.otpChannelEnabled;
      config.otpChannelEnabled = nextState;
      await config.save();

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Forwarder OTP PayPal DIAKTIFKAN!" : "🔴 Forwarder OTP PayPal DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildOtpChannelAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildOtpChannelAdminKeyboard(),
      });
    });

    // ── adm_otpchan_toggle_nf — Toggle Netflix OTP forwarder ────────────────
    bot.callbackQuery("adm_otpchan_toggle_nf", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await BotConfig.getOrCreate();
      const nextState = !config.otpNetflixChannelEnabled;
      config.otpNetflixChannelEnabled = nextState;
      await config.save();

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Forwarder OTP Netflix DIAKTIFKAN!" : "🔴 Forwarder OTP Netflix DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildOtpChannelAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildOtpChannelAdminKeyboard(),
      });
    });

    // ── adm_otpchan_toggle_dc — Toggle Discord OTP forwarder ────────────────
    bot.callbackQuery("adm_otpchan_toggle_dc", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await BotConfig.getOrCreate();
      const nextState = !config.otpDiscordChannelEnabled;
      config.otpDiscordChannelEnabled = nextState;
      await config.save();

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Forwarder OTP Discord DIAKTIFKAN!" : "🔴 Forwarder OTP Discord DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildOtpChannelAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildOtpChannelAdminKeyboard(),
      });
    });

    // ── adm_otpchan_setchan_pp — Set PayPal OTP channel ──────────────────────
    bot.callbackQuery(["adm_otpchan_setchan_pp", "adm_otpchan_setchan"], async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_CHAN_PP" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `✏️ <b>Ubah Target Channel OTP PayPal</b>\n\n` +
        `Kirimkan username channel (misal: <code>@paypal_otp</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_setlink_pp — Set PayPal OTP channel link ─────────────────
    bot.callbackQuery(["adm_otpchan_setlink_pp", "adm_otpchan_setlink"], async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_LINK_PP" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `✏️ <b>Ubah Link / Tautan Channel OTP PayPal</b>\n\n` +
        `Kirimkan link tautan channel (misal: <code>https://t.me/paypal_otp</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_setchan_nf — Set Netflix OTP channel ────────────────────
    bot.callbackQuery("adm_otpchan_setchan_nf", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_CHAN_NF" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `🎬 <b>Ubah Target Channel OTP Netflix</b>\n\n` +
        `Kirimkan username channel (misal: <code>@netflix_otp</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_setlink_nf — Set Netflix OTP channel link ────────────────
    bot.callbackQuery("adm_otpchan_setlink_nf", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_LINK_NF" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `🎬 <b>Ubah Link / Tautan Channel OTP Netflix</b>\n\n` +
        `Kirimkan link tautan channel (misal: <code>https://t.me/netflix_otp</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_setchan_dc — Set Discord OTP channel ────────────────────
    bot.callbackQuery("adm_otpchan_setchan_dc", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_CHAN_DC" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `🎮 <b>Ubah Target Channel OTP Discord</b>\n\n` +
        `Kirimkan username channel (misal: <code>@discord_otp</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_setlink_dc — Set Discord OTP channel link ────────────────
    bot.callbackQuery("adm_otpchan_setlink_dc", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_OTP_LINK_DC" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_otpchan");
      await ctx.reply(
        `🎮 <b>Ubah Link / Tautan Channel OTP Discord</b>\n\n` +
        `Kirimkan link tautan channel (misal: <code>https://t.me/discord_otp</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_otpchan_test_pp — Send test PayPal OTP to channel ────────────────
    bot.callbackQuery("adm_otpchan_test_pp", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⏳ Mengirimkan pesan OTP PayPal uji coba…" });

      const res = await ImapOtpService.sendTestOtp(ctx.api, "paypal");
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba OTP PayPal telah dikirim ke channel <code>${res.channel}</code>.\n\n` +
          `Silakan periksa channel target untuk memastikan format tampilan dan izin bot sudah sesuai.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan OTP PayPal Uji Coba</b>\n\n` +
          `<b>Error:</b> <code>${res.error}</code>\n\n` +
          `<b>Saran Perbaikan:</b>\n` +
          `1. Pastikan username/ID channel sudah benar: <code>${res.channel || "Belum diatur"}</code>.\n` +
          `2. Pastikan bot telah ditambahkan sebagai <b>ADMINISTRATOR</b> di channel PayPal dengan izin <b>Post Messages</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      }
    });

    // ── adm_otpchan_test_nf — Send test Netflix OTP to channel ───────────────
    bot.callbackQuery(["adm_otpchan_test_nf", "adm_otpchan_test"], async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⏳ Mengirimkan pesan OTP Netflix uji coba…" });

      const res = await ImapOtpService.sendTestOtp(ctx.api, "netflix");
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba OTP Netflix telah dikirim ke channel <code>${res.channel}</code>.\n\n` +
          `Silakan periksa channel target untuk memastikan format tampilan dan izin bot sudah sesuai.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan OTP Netflix Uji Coba</b>\n\n` +
          `<b>Error:</b> <code>${res.error}</code>\n\n` +
          `<b>Saran Perbaikan:</b>\n` +
          `1. Pastikan username/ID channel sudah benar: <code>${res.channel || "Belum diatur"}</code>.\n` +
          `2. Pastikan bot telah ditambahkan sebagai <b>ADMINISTRATOR</b> di channel Netflix dengan izin <b>Post Messages</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      }
    });

    // ── adm_otpchan_test_dc — Send test Discord OTP to channel ───────────────
    bot.callbackQuery("adm_otpchan_test_dc", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⏳ Mengirimkan pesan OTP Discord uji coba…" });

      const res = await ImapOtpService.sendTestOtp(ctx.api, "discord");
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba OTP Discord telah dikirim ke channel <code>${res.channel}</code>.\n\n` +
          `Silakan periksa channel target untuk memastikan format tampilan dan izin bot sudah sesuai.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan OTP Discord Uji Coba</b>\n\n` +
          `<b>Error:</b> <code>${res.error}</code>\n\n` +
          `<b>Saran Perbaikan:</b>\n` +
          `1. Pastikan username/ID channel sudah benar: <code>${res.channel || "Belum diatur"}</code>.\n` +
          `2. Pastikan bot telah ditambahkan sebagai <b>ADMINISTRATOR</b> di channel Discord dengan izin <b>Post Messages</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
      }
    });

    // ── adm_imap_config — Open IMAP credential manager ───────────────────────
    bot.callbackQuery("adm_imap_config", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildImapConfigAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildImapConfigAdminKeyboard(),
      });
    });

    // ── adm_imap_toggle — Toggle IMAP active/inactive ────────────────────────
    bot.callbackQuery("adm_imap_toggle", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await BotConfig.getOrCreate();
      const nextState = !config.imapEnabled;
      config.imapEnabled = nextState;
      await config.save();

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Listener IMAP DIAKTIFKAN!" : "🔴 Listener IMAP DINONAKTIFKAN!",
      });

      if (nextState) {
        await ImapOtpService.restart(ctx.api);
      } else {
        await ImapOtpService.stop();
      }

      await ctx.editMessageText(await buildImapConfigAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildImapConfigAdminKeyboard(),
      });
    });

    // ── adm_imap_restart — Restart IMAP connection ───────────────────────────
    bot.callbackQuery("adm_imap_restart", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "🔄 Merestart koneksi IMAP…" });
      await ImapOtpService.restart(ctx.api);
      await ctx.reply("✅ <b>Perintah restart IMAP dikirim.</b> Sedang menghubungkan kembali…", {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔙 Buka Pengaturan Channel OTP", "adm_otpchan"),
      });
    });

    // ── adm_imap_fetch — Fetch latest 5 emails (All, Netflix, PayPal) ────────
    const handleFetchEmails = async (ctx: Context, filterSender?: string) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const filterLabel = filterSender === "netflix" ? "Netflix" : filterSender === "paypal" ? "PayPal" : "Semua";
      await ctx.answerCallbackQuery({ text: `⏳ Mengambil 5 email terbaru (${filterLabel}) dari server IMAP…` });

      try {
        const emails = await ImapOtpService.fetchLatestEmails(5, false, filterSender);
        if (emails.length === 0) {
          const kb = new InlineKeyboard()
            .text("🔄 Coba Semua Email", "adm_imap_fetch")
            .row()
            .text("🔙 Channel OTP", "adm_otpchan");

          await ctx.reply(
            `📭 <b>Tidak Ada Email Ditemukan</b>\n\n` +
            `Tidak ditemukan email ${filterSender ? `dari "${filterSender}"` : "di mailbox"} yang dikonfigurasi.`,
            {
              parse_mode: "HTML",
              reply_markup: kb,
            }
          );
          return;
        }

        let report =
          `📬 <b>Hasil 5 Email Terbaru di Mailbox (${filterLabel})</b>\n` +
          `${"━".repeat(28)}\n\n`;

        for (const [i, mail] of emails.entries()) {
          const dateStr = mail.date ? formatDateWIB(mail.date) : "-";
          const providerIcon =
            mail.provider === "NETFLIX" ? "🎬 [Netflix]" : mail.provider === "PAYPAL" ? "🅿️ [PayPal]" : "📧 [Email]";
          const isNetflix = mail.provider === "NETFLIX";
          const maskedEmailStr = mail.recipientEmail ? maskEmail(mail.recipientEmail) : undefined;
          const emailLine = isNetflix && maskedEmailStr
            ? `   📧 Akun: <code>${escapeHtml(maskedEmailStr)}</code>\n`
            : "";
          const nameLine = !isNetflix && mail.recipientName
            ? `   👤 Nama: <b>${escapeHtml(mail.recipientName)}</b>\n`
            : "";
          const otpStr = mail.otpCode ? `<code>${escapeHtml(mail.otpCode)}</code>` : "<i>(Tidak terdeteksi)</i>";
          const safeSender = escapeHtml(mail.senderEmail || mail.senderName);
          const safeSubject = escapeHtml(mail.subject || "(Tanpa Subjek)");
          const preview = mail.previewText
            ? `\n   💬 <i>${escapeHtml(mail.previewText.slice(0, 120))}${mail.previewText.length > 120 ? "..." : ""}</i>`
            : "";
          const linkLine = mail.magicLink
            ? `\n   🔗 <a href="${escapeHtml(mail.magicLink)}">Buka Link Akses / Verifikasi</a>`
            : "";

          report +=
            `<b>${i + 1}. ${providerIcon} UID: <code>${mail.uid}</code></b>\n` +
            `   📅 ${dateStr}\n` +
            emailLine +
            nameLine +
            `   🔑 Kode OTP: ${otpStr}\n` +
            `   📌 Subjek: <b>${safeSubject}</b>\n` +
            `   📧 Dari: <code>${safeSender}</code>` +
            preview +
            linkLine +
            `\n\n`;
        }

        const kb = new InlineKeyboard()
          .text("🔄 Refresh Semua", "adm_imap_fetch")
          .row()
          .text("🎬 Cek Netflix", "adm_imap_fetch_netflix")
          .text("🅿️ Cek PayPal", "adm_imap_fetch_paypal")
          .row()
          .text("🔙 Kembali ke Channel OTP", "adm_otpchan");

        await ctx.reply(report, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: kb,
        });
      } catch (fetchErr: any) {
        await ctx.reply(
          `❌ <b>Gagal Mengambil Email:</b>\n<code>${escapeHtml(fetchErr?.message || String(fetchErr))}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Channel OTP", "adm_otpchan"),
          }
        );
      }
    };

    bot.callbackQuery("adm_imap_fetch", async (ctx) => {
      await handleFetchEmails(ctx);
    });

    bot.callbackQuery("adm_imap_fetch_netflix", async (ctx) => {
      await handleFetchEmails(ctx, "netflix");
    });

    bot.callbackQuery("adm_imap_fetch_paypal", async (ctx) => {
      await handleFetchEmails(ctx, "paypal");
    });

    // ── IMAP Field Setters (State Prompts) ───────────────────────────────────
    bot.callbackQuery("adm_imap_sethost", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_HOST" });
      await ctx.reply(
        `✏️ <b>Ubah Host Server IMAP</b>\n\n` +
        `Kirimkan host server IMAP (misal: <code>imap.gmail.com</code> atau <code>mail.domainanda.com</code>).\n\n` +
        `<i>Ketik atau paste ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    bot.callbackQuery("adm_imap_setport", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_PORT" });
      await ctx.reply(
        `✏️ <b>Ubah Port Server IMAP</b>\n\n` +
        `Kirimkan nomor port IMAP (misal: <code>993</code> untuk SSL/TLS atau <code>143</code>).\n\n` +
        `<i>Ketik ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    bot.callbackQuery("adm_imap_setuser", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_USER" });
      await ctx.reply(
        `✏️ <b>Ubah Email / Akun IMAP</b>\n\n` +
        `Kirimkan alamat email akun IMAP (misal: <code>akunanda@gmail.com</code>).\n\n` +
        `<i>Ketik ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    bot.callbackQuery("adm_imap_setpass", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_PASS" });
      await ctx.reply(
        `✏️ <b>Ubah Password / App Password IMAP</b>\n\n` +
        `Kirimkan password akun atau App Password 16 digit Gmail Anda.\n\n` +
        `<i>Ketik ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    bot.callbackQuery("adm_imap_setsender", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_SENDER" });
      await ctx.reply(
        `✏️ <b>Ubah Target Pengirim Email</b>\n\n` +
        `Kirimkan alamat email pengirim yang ingin dipantau (misal: <code>service@intl.paypal.com</code>).\n\n` +
        `<i>Ketik ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    bot.callbackQuery("adm_imap_setmbox", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from?.id), { action: "SET_IMAP_MAILBOX" });
      await ctx.reply(
        `✏️ <b>Ubah Folder Mailbox</b>\n\n` +
        `Kirimkan nama folder mailbox yang ingin dipantau (default: <code>INBOX</code>).\n\n` +
        `<i>Ketik ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("❌ Batal", "adm_imap_config") }
      );
    });

    // ── Command: /setotpchannel <@channel> [link] ────────────────────────────
    bot.command("setotpchannel", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/setotpchannel(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const channel = parts[0]?.trim();
      const link = parts[1]?.trim() || (channel?.startsWith("@") ? `https://t.me/${channel.slice(1)}` : "");

      if (!channel) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/setotpchannel &lt;@username_atau_ID&gt; [link_invite]</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/setotpchannel @channel_otp https://t.me/channel_otp</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const config = await BotConfig.getOrCreate();
      config.otpChannel = channel;
      if (link) config.otpChannelLink = link;
      config.otpChannelEnabled = true;
      await config.save();

      await ctx.reply(
        `✅ <b>Channel OTP Forwarder berhasil disetel & diaktifkan!</b>\n\n` +
        `🆔 Channel: <code>${channel}</code>\n` +
        `🔗 Link: <code>${link || "(Belum diatur)"}</code>\n\n` +
        `<i>Pastikan bot sudah dijadikan Administrator di channel tersebut dengan izin Post Messages!</i>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🧪 Tes Kirim OTP", "adm_otpchan_test"),
        }
      );
    });

    // ── Command: /toggleotpchannel ───────────────────────────────────────────
    bot.command("toggleotpchannel", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const config = await BotConfig.getOrCreate();
      const nextState = !config.otpChannelEnabled;
      config.otpChannelEnabled = nextState;
      await config.save();

      await ctx.reply(
        nextState
          ? `🟢 <b>Fitur Forwarder OTP ke Channel telah DIAKTIFKAN.</b>`
          : `🔴 <b>Fitur Forwarder OTP ke Channel telah DINONAKTIFKAN.</b>`,
        { parse_mode: "HTML" }
      );
    });

    // ── Command: /testotpchannel ─────────────────────────────────────────────
    bot.command("testotpchannel", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const res = await ImapOtpService.sendTestOtp(ctx.api);
      if (res.success) {
        await ctx.reply(
          `✅ <b>Berhasil!</b> Pesan uji coba OTP telah dikirim ke channel <code>${res.channel}</code>.`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(
          `❌ <b>Gagal Mengirimkan Pesan OTP Uji Coba:</b>\n<code>${res.error}</code>\n\n` +
          `<i>Pastikan bot adalah Admin di channel tersebut dengan hak kirim pesan!</i>`,
          { parse_mode: "HTML" }
        );
      }
    });

    // ── Command: /imapstatus ─────────────────────────────────────────────────
    bot.command("imapstatus", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const status = await ImapOtpService.getStatus();
      const conn = status.listening
        ? "🟢 Standby Listening (IDLE)"
        : status.connected
        ? "🟡 Terhubung"
        : "🔴 Terputus";

      const lastDate = status.lastReceivedAt ? formatDateWIB(status.lastReceivedAt) : "-";

      await ctx.reply(
        `📡 <b>Status Real-Time IMAP OTP Listener</b>\n` +
        `${"─".repeat(34)}\n\n` +
        `• <b>Koneksi:</b> ${conn}\n` +
        `• <b>Host:</b> <code>${status.host}</code>\n` +
        `• <b>Akun:</b> <code>${status.user}</code>\n` +
        `• <b>Target Sender:</b> <code>${status.targetSender}</code>\n` +
        `• <b>Mailbox:</b> <code>${status.mailbox}</code>\n` +
        `• <b>Total OTP Diteruskan:</b> <b>${status.totalOtpForwarded}</b>\n` +
        `• <b>Penerima Terakhir:</b> <b>${escapeHtml(status.lastRecipientName || "-")}</b>\n` +
        `• <b>OTP Terakhir:</b> <code>${escapeHtml(status.lastReceivedOtp || "-")}</code>\n` +
        `• <b>Waktu Terakhir:</b> ${lastDate}\n` +
        (status.lastError ? `\n⚠️ <b>Error:</b> <code>${escapeHtml(status.lastError)}</code>` : ""),
        { parse_mode: "HTML" }
      );
    });

    // ── Command: /setimap <host> <user> <pass> [port] [sender] ───────────────
    bot.command("setimap", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/setimap(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const host = parts[0]?.trim();
      const user = parts[1]?.trim();
      const pass = parts[2]?.trim();
      const portStr = parts[3]?.trim();
      const sender = parts[4]?.trim();

      if (!host || !user || !pass) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/setimap &lt;host&gt; &lt;email_user&gt; &lt;password&gt; [port] [target_sender]</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/setimap imap.gmail.com myacc@gmail.com abcdexyz1234 993 service@intl.paypal.com</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const port = Number(portStr) || 993;

      const config = await BotConfig.getOrCreate();
      config.imapHost = host;
      config.imapUser = user;
      config.imapPass = pass;
      config.imapPort = port;
      if (sender) config.imapTargetSender = sender.toLowerCase();
      config.imapEnabled = true;
      await config.save();

      await ctx.reply(
        `✅ <b>Kredensial IMAP berhasil diperbarui & disimpan!</b>\n\n` +
        `🌐 Host: <code>${host}</code>:${port}\n` +
        `👤 User: <code>${user}</code>\n` +
        `🎯 Target: <code>${config.imapTargetSender}</code>\n\n` +
        `🔄 Merestart koneksi IMAP…`,
        { parse_mode: "HTML" }
      );

      await ImapOtpService.restart(ctx.api);
    });

    // ── Cloudflare Email Routing Commands & Callbacks ───────────────────────

    const openCloudflareAdmin = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildCloudflareAdminText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareAdminKeyboard(),
      });
    };

    bot.command(["cf", "cloudflare"], openCloudflareAdmin);

    // /cfcreate [prefix] [domain] [destination] (aliases: /cfgen, /cfforward, /createcf)
    bot.command(["cfcreate", "cfgen", "cfforward", "createcf"], async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/(?:cfcreate|cfgen|cfforward|createcf)(?:@\S+)?\s*/i, "").trim().split(/\s+/).filter(Boolean);
      const prefix = parts[0]?.trim();
      const domain = parts[1]?.trim();
      const destinationEmail = parts[2]?.trim();

      const waitMsg = await ctx.reply("⏳ <i>Menghubungi Cloudflare API untuk membuat email routing…</i>", {
        parse_mode: "HTML",
      });

      const res = await CloudflareService.createEmailRule({
        prefix,
        domain,
        destinationEmail,
      });

      if (res.success) {
        const kb = new InlineKeyboard()
          .text("📋 Daftar Rule", "adm_cf_rules")
          .text("⚡ Buat Lagi", "adm_cf_quick_random")
          .row()
          .text("☁️ Menu Cloudflare", "adm_cf_menu");

        await ctx.api.editMessageText(
          ctx.chat!.id,
          waitMsg.message_id,
          `✅ <b>Email Routing Cloudflare Berhasil Dibuat!</b>\n` +
          `────────────────────────────────\n\n` +
          `📧 <b>Email Baru:</b> <code>${res.email}</code> <i>(klik untuk salin)</i>\n` +
          `🎯 <b>Diteruskan Ke:</b> <code>${res.destinationEmail}</code>\n` +
          `🌐 <b>Domain:</b> <code>${res.domain}</code>\n` +
          `🆔 <b>Rule ID:</b> <code>${res.ruleId}</code>\n\n` +
          `<i>Email siap digunakan untuk menerima OTP / pesan masuk!</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          waitMsg.message_id,
          `❌ <b>Gagal Membuat Rule Email Cloudflare:</b>\n` +
          `<code>${res.error}</code>\n\n` +
          `<i>Periksa kembali kredensial API Key & daftar domain di menu /cf</i>`,
          { parse_mode: "HTML" }
        );
      }
    });

    // /cflist [domain]
    bot.command("cflist", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildCloudflareRulesText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareRulesKeyboard(),
      });
    });

    // /cfdel <zoneId> <ruleId>
    bot.command("cfdel", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/cfdel(?:@\S+)?\s*/i, "").trim().split(/\s+/).filter(Boolean);
      const zoneId = parts[0]?.trim();
      const ruleId = parts[1]?.trim();

      if (!zoneId || !ruleId) {
        await ctx.reply(
          `⚠️ <b>Format Perintah:</b>\n<code>/cfdel &lt;zoneId&gt; &lt;ruleId&gt;</code>\n\n` +
          `<i>Gunakan perintah /cflist untuk melihat daftar rule ID dan zone ID.</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const res = await CloudflareService.deleteEmailRule(zoneId, ruleId);
      if (res.success) {
        await ctx.reply(`✅ <b>Rule <code>${ruleId}</code> berhasil dihapus dari Cloudflare!</b>`, {
          parse_mode: "HTML",
        });
      } else {
        await ctx.reply(`❌ <b>Gagal menghapus rule:</b> <code>${res.error}</code>`, {
          parse_mode: "HTML",
        });
      }
    });

    // /cfzones
    bot.command("cfzones", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.reply(await buildCloudflareZonesText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareZonesKeyboard(),
      });
    });

    // ── adm_cf_menu callback ─────────────────────────────────────────────────
    bot.callbackQuery("adm_cf_menu", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildCloudflareAdminText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareAdminKeyboard(),
      });
    });

    // ── adm_cf_quick_random — 1-Click Generate Random Email ─────────────────
    bot.callbackQuery("adm_cf_quick_random", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "⚡ Membuat email Cloudflare baru..." });

      const res = await CloudflareService.createEmailRule();
      if (res.success) {
        const kb = new InlineKeyboard()
          .text("📋 Daftar Rule", "adm_cf_rules")
          .text("⚡ Buat Lagi (Random)", "adm_cf_quick_random")
          .row()
          .text("☁️ Menu Cloudflare", "adm_cf_menu");

        await ctx.editMessageText(
          `✅ <b>Email Routing Cloudflare Berhasil Dibuat!</b>\n` +
          `────────────────────────────────\n\n` +
          `📧 <b>Email Baru:</b> <code>${res.email}</code> <i>(klik untuk salin)</i>\n` +
          `🎯 <b>Diteruskan Ke:</b> <code>${res.destinationEmail}</code>\n` +
          `🌐 <b>Domain:</b> <code>${res.domain}</code>\n` +
          `🆔 <b>Rule ID:</b> <code>${res.ruleId}</code>\n\n` +
          `<i>Email siap digunakan untuk menerima OTP / pesan masuk!</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      } else {
        await ctx.editMessageText(
          `❌ <b>Gagal Membuat Rule Email Cloudflare:</b>\n` +
          `<code>${res.error}</code>\n\n` +
          `<i>Periksa kembali kredensial API Key & daftar domain di menu /cf</i>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali ke Cloudflare", "adm_cf_menu"),
          }
        );
      }
    });

    // ── adm_cf_create_prompt — Custom Prefix / Domain ────────────────────────
    bot.callbackQuery("adm_cf_create_prompt", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_CF_CUSTOM" });
      const kb = new InlineKeyboard().text("❌ Batal", "adm_cf_menu");
      await ctx.reply(
        `✏️ <b>Buat Email Routing Custom</b>\n\n` +
        `Kirimkan <b>prefix email</b> yang diinginkan, atau format: <code>prefix domain</code>.\n\n` +
        `<b>Contoh:</b>\n` +
        `• <code>support</code> (akan memilih domain acak)\n` +
        `• <code>paypal danka.web.id</code>\n` +
        `• <code>netflix dstur.my.id</code>\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_cf_rules callback ────────────────────────────────────────────────
    bot.callbackQuery("adm_cf_rules", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildCloudflareRulesText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareRulesKeyboard(),
      });
    });

    // ── adm_cf_zones callback ────────────────────────────────────────────────
    bot.callbackQuery("adm_cf_zones", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildCloudflareZonesText(), {
        parse_mode: "HTML",
        reply_markup: buildCloudflareZonesKeyboard(),
      });
    });

    // ── adm_cf_sync_zones — Sync zones from Cloudflare API ──────────────────
    bot.callbackQuery("adm_cf_sync_zones", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "🔄 Mengambil data zone dari Cloudflare..." });

      const res = await CloudflareService.fetchAccountZones();
      if (res.success && res.zones && res.zones.length > 0) {
        await CloudflareService.updateConfig({ cfZones: res.zones });
        await ctx.editMessageText(
          `✅ <b>Berhasil Menyinkronkan ${res.zones.length} Domain Dari Cloudflare!</b>\n\n` +
          res.zones.map((z) => `• <code>${z.domain}</code> (ID: <code>${z.id}</code>)`).join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali ke Kelola Domain", "adm_cf_zones"),
          }
        );
      } else {
        await ctx.editMessageText(
          `❌ <b>Gagal Menyinkronkan Domain:</b>\n<code>${res.error || "Tidak ada zone yang ditemukan"}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali ke Kelola Domain", "adm_cf_zones"),
          }
        );
      }
    });

    // ── adm_cf_add_zone_prompt ───────────────────────────────────────────────
    bot.callbackQuery("adm_cf_add_zone_prompt", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "ADD_CF_ZONE" });
      const kb = new InlineKeyboard().text("❌ Batal", "adm_cf_zones");
      await ctx.reply(
        `➕ <b>Tambah Domain & Zone ID Cloudflare</b>\n\n` +
        `Kirimkan <b>Zone ID</b> dan <b>Nama Domain</b> dipisahkan spasi.\n\n` +
        `<b>Contoh:</b>\n` +
        `<code>79f4b48dab6a3c999f36cedba5ecfc12 danka.web.id</code>\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_cf_set_dest — Change Destination Forward Email ──────────────────
    bot.callbackQuery("adm_cf_set_dest", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_CF_DEST" });
      const kb = new InlineKeyboard().text("❌ Batal", "adm_cf_menu");
      await ctx.reply(
        `🎯 <b>Ubah Target Forward Email (Gmail)</b>\n\n` +
        `Kirimkan alamat email tujuan forwarding (misal: <code>myemail@gmail.com</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_cf_set_cred — Change Cloudflare Credentials ──────────────────────
    bot.callbackQuery("adm_cf_set_cred", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const kb = new InlineKeyboard()
        .text("📧 Ubah Email CF", "adm_cf_set_email")
        .text("🔑 Ubah API Key / Token", "adm_cf_set_key")
        .row()
        .text("🔙 Kembali ke Cloudflare", "adm_cf_menu");

      await ctx.editMessageText(
        `🔑 <b>Pengaturan Kredensial Cloudflare API</b>\n\n` +
        `Pilih bagian kredensial yang ingin diubah:`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    bot.callbackQuery("adm_cf_set_email", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_CF_EMAIL" });
      const kb = new InlineKeyboard().text("❌ Batal", "adm_cf_menu");
      await ctx.reply(
        `📧 <b>Ubah Email Akun Cloudflare</b>\n\n` +
        `Kirimkan email akun Cloudflare Anda (misal: <code>admin@example.com</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    bot.callbackQuery("adm_cf_set_key", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_CF_KEY" });
      const kb = new InlineKeyboard().text("❌ Batal", "adm_cf_menu");
      await ctx.reply(
        `🔑 <b>Ubah Global API Key / API Token Cloudflare</b>\n\n` +
        `Kirimkan Global API Key (contoh: <code>cfk_...</code>) atau API Token Anda.\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_forcesub callback ────────────────────────────────────────────────
    bot.callbackQuery("adm_forcesub", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildForceSubAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildForceSubAdminKeyboard(),
      });
    });

    // ── adm_fsub_toggle — Toggle force sub on/off ────────────────────────────
    bot.callbackQuery("adm_fsub_toggle", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await ForceSubService.getConfig();
      const nextState = !config.forceSubEnabled;
      await ForceSubService.updateConfig({ forceSubEnabled: nextState });

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Fitur Wajib Join Channel DIAKTIFKAN!" : "🔴 Fitur Wajib Join Channel DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildForceSubAdminText(), {
        parse_mode: "HTML",
        reply_markup: await buildForceSubAdminKeyboard(),
      });
    });

    // ── adm_fsub_setchan — Set channel identifier ────────────────────────────
    bot.callbackQuery("adm_fsub_setchan", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_CHAN" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_forcesub");
      await ctx.reply(
        `✏️ <b>Ubah Target Channel Telegram</b>\n\n` +
        `Kirimkan username publik channel (misal: <code>@namachannel</code>) atau Channel Chat ID (misal: <code>-1001234567890</code>).\n\n` +
        `<i>Ketik atau paste pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_fsub_setlink — Set channel invite link ───────────────────────────
    bot.callbackQuery("adm_fsub_setlink", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_LINK" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_forcesub");
      await ctx.reply(
        `✏️ <b>Ubah Tautan / Link Channel</b>\n\n` +
        `Kirimkan link tautan channel (misal: <code>https://t.me/namachannel</code> atau link invite privat <code>https://t.me/+xxxxxx</code>).\n\n` +
        `<i>Ketik atau paste tautan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── adm_fsub_setname — Set channel display name ──────────────────────────
    bot.callbackQuery("adm_fsub_setname", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      fsubInputState.set(String(ctx.from?.id), { action: "SET_NAME" });

      const kb = new InlineKeyboard().text("❌ Batal", "adm_forcesub");
      await ctx.reply(
        `✏️ <b>Ubah Nama Tampilan Channel</b>\n\n` +
        `Kirimkan nama tampilan channel (misal: <code>Official Store Channel</code>).\n\n` +
        `<i>Ketik pesan ke chat ini sekarang:</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── Command: /setchannel <@channel> [link] ──────────────────────────────
    bot.command("setchannel", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/setchannel(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const channel = parts[0]?.trim();
      const link = parts[1]?.trim() || (channel?.startsWith("@") ? `https://t.me/${channel.slice(1)}` : "");

      if (!channel) {
        await ctx.reply(
          `⚠️ <b>Format:</b>\n` +
          `<code>/setchannel &lt;@username_atau_ID&gt; [link_invite]</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/setchannel @mychannel https://t.me/mychannel</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      await ForceSubService.updateConfig({
        forceSubChannel: channel,
        ...(link && { forceSubLink: link }),
        forceSubEnabled: true,
      });

      await ctx.reply(
        `✅ <b>Channel berhasil disetel & fitur diaktifkan!</b>\n\n` +
        `🆔 Channel: <code>${channel}</code>\n` +
        `🔗 Link: <code>${link || "(Belum diatur)"}</code>\n\n` +
        `<i>Pastikan bot sudah dijadikan Administrator di channel tersebut!</i>`,
        { parse_mode: "HTML" }
      );
    });

    // ── Command: /toggleforcesub ─────────────────────────────────────────────
    bot.command("toggleforcesub", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const config = await ForceSubService.getConfig();
      const nextState = !config.forceSubEnabled;
      await ForceSubService.updateConfig({ forceSubEnabled: nextState });

      await ctx.reply(
        nextState
          ? `🟢 <b>Fitur Wajib Join Channel telah DIAKTIFKAN.</b>`
          : `🔴 <b>Fitur Wajib Join Channel telah DINONAKTIFKAN.</b>`,
        { parse_mode: "HTML" }
      );
    });

    // ── Message listener for Admin interactive inputs ────────────────────────
    bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (!from || !isAdmin(ctx)) return next();

      const adminId = String(from.id);
      const state = fsubInputState.get(adminId);
      if (!state) return next();

      const text = ctx.message.text.trim();
      if (text === "/batal" || text === "/cancel") {
        fsubInputState.delete(adminId);
        pendingRollbackSessions.delete(adminId);
        await ctx.reply("❌ Dibatalkan.");
        return;
      }

      if (text.startsWith("/")) {
        fsubInputState.delete(adminId);
        pendingRollbackSessions.delete(adminId);
        return next();
      }

      if (state.action === "WAIT_ROLLBACK_FILE") {
        await ctx.reply(
          "⚠️ Silakan kirimkan (upload) file arsip <code>.zip</code> backup database, atau ketik /batal untuk membatalkan.",
          { parse_mode: "HTML" }
        );
        return;
      }

      fsubInputState.delete(adminId);

      if (state.action === "SET_CHAN") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        await ForceSubService.updateConfig({
          forceSubChannel: text,
          ...(link && { forceSubLink: link }),
        });
        await ctx.reply(
          `✅ <b>Target channel berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📢 Buka Pengaturan Channel", "adm_forcesub"),
          }
        );
        return;
      }

      if (state.action === "SET_LINK") {
        await ForceSubService.updateConfig({ forceSubLink: text });
        await ctx.reply(
          `✅ <b>Link channel berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📢 Buka Pengaturan Channel", "adm_forcesub"),
          }
        );
        return;
      }

      if (state.action === "SET_NAME") {
        await ForceSubService.updateConfig({ forceSubName: text });
        await ctx.reply(
          `✅ <b>Nama channel berhasil diubah ke:</b> <b>${text}</b>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📢 Buka Pengaturan Channel", "adm_forcesub"),
          }
        );
        return;
      }

      if (state.action === "SET_TESTI_CHAN") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        await TestimonialService.updateConfig({
          testimonialChannel: text,
          ...(link && { testimonialLink: link }),
          testimonialEnabled: true,
        });
        await ctx.reply(
          `✅ <b>Target Channel Testimoni berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🧪 Tes Kirim Pesan", "adm_testi_test")
              .row()
              .text("🌟 Buka Pengaturan Testimoni", "adm_testi"),
          }
        );
        return;
      }

      if (state.action === "SET_TESTI_LINK") {
        await TestimonialService.updateConfig({ testimonialLink: text });
        await ctx.reply(
          `✅ <b>Link channel testimoni berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🌟 Buka Pengaturan Testimoni", "adm_testi"),
          }
        );
        return;
      }

      if (state.action === "SET_LOG_CHAN") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        await ActivityLogService.updateConfig({
          logChannel: text,
          ...(link && { logChannelLink: link }),
          logChannelEnabled: true,
        });
        await ctx.reply(
          `✅ <b>Target Channel Log Aktivitas berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🧪 Tes Kirim Log", "adm_log_test")
              .row()
              .text("📜 Buka Pengaturan Log", "adm_log"),
          }
        );
        return;
      }

      if (state.action === "SET_LOG_LINK") {
        await ActivityLogService.updateConfig({ logChannelLink: text });
        await ctx.reply(
          `✅ <b>Link channel log berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📜 Buka Pengaturan Log", "adm_log"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_CHAN_PP" || state.action === "SET_OTP_CHAN") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        const config = await BotConfig.getOrCreate();
        config.otpChannel = text;
        if (link) config.otpChannelLink = link;
        config.otpChannelEnabled = true;
        await config.save();

        await ctx.reply(
          `✅ <b>Target Channel OTP PayPal berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🧪 Tes Kirim OTP PayPal", "adm_otpchan_test_pp")
              .row()
              .text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_LINK_PP" || state.action === "SET_OTP_LINK") {
        const config = await BotConfig.getOrCreate();
        config.otpChannelLink = text;
        await config.save();

        await ctx.reply(
          `✅ <b>Link channel OTP PayPal berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_CHAN_NF") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        const config = await BotConfig.getOrCreate();
        config.otpNetflixChannel = text;
        if (link) config.otpNetflixChannelLink = link;
        config.otpNetflixChannelEnabled = true;
        await config.save();

        await ctx.reply(
          `🎬 <b>Target Channel OTP Netflix berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🧪 Tes Kirim OTP Netflix", "adm_otpchan_test_nf")
              .row()
              .text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_LINK_NF") {
        const config = await BotConfig.getOrCreate();
        config.otpNetflixChannelLink = text;
        await config.save();

        await ctx.reply(
          `🎬 <b>Link channel OTP Netflix berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_CHAN_DC") {
        const link = text.startsWith("@") ? `https://t.me/${text.slice(1)}` : undefined;
        const config = await BotConfig.getOrCreate();
        config.otpDiscordChannel = text;
        if (link) config.otpDiscordChannelLink = link;
        config.otpDiscordChannelEnabled = true;
        await config.save();

        await ctx.reply(
          `🎮 <b>Target Channel OTP Discord berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🧪 Tes Kirim OTP Discord", "adm_otpchan_test_dc")
              .row()
              .text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_OTP_LINK_DC") {
        const config = await BotConfig.getOrCreate();
        config.otpDiscordChannelLink = text;
        await config.save();

        await ctx.reply(
          `🎮 <b>Link channel OTP Discord berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("📬 Buka Pengaturan Channel OTP", "adm_otpchan"),
          }
        );
        return;
      }

      if (state.action === "SET_IMAP_HOST") {
        const config = await BotConfig.getOrCreate();
        config.imapHost = text.trim();
        await config.save();
        await ctx.reply(
          `✅ <b>Host IMAP berhasil diubah ke:</b> <code>${text.trim()}</code>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_IMAP_PORT") {
        const port = Number(text.trim()) || 993;
        const config = await BotConfig.getOrCreate();
        config.imapPort = port;
        await config.save();
        await ctx.reply(
          `✅ <b>Port IMAP berhasil diubah ke:</b> <code>${port}</code>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_IMAP_USER") {
        const config = await BotConfig.getOrCreate();
        config.imapUser = text.trim();
        await config.save();
        await ctx.reply(
          `✅ <b>Email Akun IMAP berhasil diubah ke:</b> <code>${text.trim()}</code>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_IMAP_PASS") {
        const config = await BotConfig.getOrCreate();
        config.imapPass = text.trim();
        await config.save();
        await ctx.reply(
          `✅ <b>Password Akun IMAP berhasil disimpan!</b>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_IMAP_SENDER") {
        const config = await BotConfig.getOrCreate();
        config.imapTargetSender = text.trim().toLowerCase();
        await config.save();
        await ctx.reply(
          `✅ <b>Target Pengirim Email berhasil diubah ke:</b> <code>${text.trim().toLowerCase()}</code>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_IMAP_MAILBOX") {
        const config = await BotConfig.getOrCreate();
        config.imapMailbox = text.trim();
        await config.save();
        await ctx.reply(
          `✅ <b>Folder Mailbox berhasil diubah ke:</b> <code>${text.trim()}</code>\n\n🔄 Merestart koneksi IMAP…`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("⚙️ Pengaturan IMAP", "adm_imap_config"),
          }
        );
        await ImapOtpService.restart(ctx.api);
        return;
      }

      if (state.action === "SET_CF_DEST") {
        await CloudflareService.updateConfig({ cfDestinationEmail: text });
        await ctx.reply(
          `✅ <b>Target forward email berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("☁️ Buka Pengaturan Cloudflare", "adm_cf_menu"),
          }
        );
        return;
      }

      if (state.action === "SET_CF_EMAIL") {
        await CloudflareService.updateConfig({ cfEmail: text });
        await ctx.reply(
          `✅ <b>Email akun Cloudflare berhasil diubah ke:</b> <code>${text}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("☁️ Buka Pengaturan Cloudflare", "adm_cf_menu"),
          }
        );
        return;
      }

      if (state.action === "SET_CF_KEY") {
        await CloudflareService.updateConfig({ cfApiKey: text });
        await ctx.reply(
          `✅ <b>API Key Cloudflare berhasil diperbarui!</b>`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("☁️ Buka Pengaturan Cloudflare", "adm_cf_menu"),
          }
        );
        return;
      }

      if (state.action === "SET_CF_CUSTOM") {
        const parts = text.split(/\s+/).filter(Boolean);
        const prefix = parts[0]?.trim();
        const domain = parts[1]?.trim();

        const waitMsg = await ctx.reply("⏳ <i>Menghubungi Cloudflare API untuk membuat email routing…</i>", {
          parse_mode: "HTML",
        });

        const res = await CloudflareService.createEmailRule({ prefix, domain });
        if (res.success) {
          const kb = new InlineKeyboard()
            .text("📋 Daftar Rule", "adm_cf_rules")
            .text("⚡ Buat Lagi (Random)", "adm_cf_quick_random")
            .row()
            .text("☁️ Menu Cloudflare", "adm_cf_menu");

          await ctx.api.editMessageText(
            ctx.chat!.id,
            waitMsg.message_id,
            `✅ <b>Email Routing Cloudflare Berhasil Dibuat!</b>\n` +
            `────────────────────────────────\n\n` +
            `📧 <b>Email Baru:</b> <code>${res.email}</code> <i>(klik untuk salin)</i>\n` +
            `🎯 <b>Diteruskan Ke:</b> <code>${res.destinationEmail}</code>\n` +
            `🌐 <b>Domain:</b> <code>${res.domain}</code>\n` +
            `🆔 <b>Rule ID:</b> <code>${res.ruleId}</code>\n\n` +
            `<i>Email siap digunakan untuk menerima OTP / pesan masuk!</i>`,
            { parse_mode: "HTML", reply_markup: kb }
          );
        } else {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            waitMsg.message_id,
            `❌ <b>Gagal Membuat Rule Email Cloudflare:</b>\n` +
            `<code>${res.error}</code>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🔙 Menu Cloudflare", "adm_cf_menu"),
            }
          );
        }
        return;
      }

      if (state.action === "ADD_CF_ZONE") {
        const parts = text.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          await ctx.reply(
            `⚠️ <b>Format tidak sesuai!</b>\n` +
            `Kirimkan: <code>&lt;ZoneID&gt; &lt;Domain&gt;</code>\n` +
            `Contoh: <code>79f4b48dab6a3c999f36cedba5ecfc12 danka.web.id</code>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const id = parts[0]!.trim();
        const domain = parts[1]!.trim();
        const added = await CloudflareService.addZone({ id, domain });
        if (added) {
          await ctx.reply(
            `✅ <b>Domain <code>${domain}</code> (Zone ID: <code>${id}</code>) berhasil ditambahkan!</b>`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🌐 Kelola Domain", "adm_cf_zones"),
            }
          );
        } else {
          await ctx.reply(
            `⚠️ Domain atau Zone ID tersebut sudah ada dalam daftar.`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("🌐 Kelola Domain", "adm_cf_zones"),
            }
          );
        }
        return;
      }

      if (state.action === "SET_MAINTENANCE_MSG") {
        const config = await BotConfig.getOrCreate();
        config.maintenanceMessage = text;
        await config.save();
        clearMaintenanceCache();
        await ctx.reply("✅ Pesan maintenance berhasil diperbarui.", { parse_mode: "HTML" });
        return;
      }

      if (state.action === "BC_TEXT" && state.broadcastFilter) {
        const filter = state.broadcastFilter;
        const label = getBroadcastFilterLabel(filter);
        const count = await estimateBroadcastTarget(filter);

        const progressMsg = await ctx.reply(
          `📢 <b>Mengirim broadcast…</b>\n\nTarget: <b>${label}</b> (${count} user)\n\n⏳ Memulai pengiriman…`,
          { parse_mode: "HTML" }
        );

        let lastProgress = "";
        const result = await broadcastMessage(ctx.api, text, filter, async (progress) => {
          const progressText =
            `📢 <b>Broadcast Berjalan</b>\n\n` +
            `✅ Terkirim: <b>${progress.sent}</b>\n` +
            `❌ Gagal: <b>${progress.failed}</b>\n` +
            `🚫 Diblokir: <b>${progress.blocked}</b>\n` +
            `📊 Total: <b>${progress.total}</b>`;

          if (progressText !== lastProgress) {
            lastProgress = progressText;
            try {
              await ctx.api.editMessageText(ctx.chat!.id, progressMsg.message_id, progressText, { parse_mode: "HTML" });
            } catch { /* ignore if not modified */ }
          }
        });

        const finalText =
          `📢 <b>Broadcast Selesai!</b>\n${"─".repeat(30)}\n\n` +
          `✅ Terkirim: <b>${result.sent}</b>\n` +
          `❌ Gagal: <b>${result.failed}</b>\n` +
          `🚫 Diblokir: <b>${result.blocked}</b>\n` +
          `📊 Total Target: <b>${result.total}</b>`;

        try {
          await ctx.api.editMessageText(ctx.chat!.id, progressMsg.message_id, finalText, { parse_mode: "HTML" });
        } catch {
          await ctx.reply(finalText, { parse_mode: "HTML" });
        }
        return;
      }

      return next();
    });

    // ── adm_home — back to main menu ────────────────────────────────────────
    bot.callbackQuery("adm_home", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      await ctx.editMessageText(await buildHomeText(), {
        parse_mode:   "HTML",
        reply_markup: await buildHomeKeyboard(),
      });
    });

    // ── adm_stats & adm_stats_overview — Overview Tab ────────────────────────
    const handleStatsOverview = async (ctx: Context) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      try {
        await ctx.editMessageText(await buildStatsOverviewText(), {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard("overview"),
        });
      } catch {
        /* safe ignore unchanged */
      }
    };
    bot.callbackQuery("adm_stats", handleStatsOverview);
    bot.callbackQuery("adm_stats_overview", handleStatsOverview);

    // ── adm_stats_users — Users Tab ──────────────────────────────────────────
    bot.callbackQuery("adm_stats_users", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      try {
        await ctx.editMessageText(await buildStatsUsersText(), {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard("users"),
        });
      } catch {
        /* safe ignore unchanged */
      }
    });

    // ── adm_stats_finance — Finance / Top-Up Tab ─────────────────────────────
    bot.callbackQuery("adm_stats_finance", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      try {
        await ctx.editMessageText(await buildStatsFinanceText(), {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard("finance"),
        });
      } catch {
        /* safe ignore unchanged */
      }
    });

    // ── adm_stats_digital — Digital Products Tab ─────────────────────────────
    bot.callbackQuery("adm_stats_digital", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      try {
        await ctx.editMessageText(await buildStatsDigitalText(), {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard("digital"),
        });
      } catch {
        /* safe ignore unchanged */
      }
    });

    // ── adm_stats_sms — SMS OTP Tab ──────────────────────────────────────────
    bot.callbackQuery("adm_stats_sms", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      try {
        await ctx.editMessageText(await buildStatsSmsText(), {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard("sms"),
        });
      } catch {
        /* safe ignore unchanged */
      }
    });

    // ── adm_stats_rf_<tab> — Refresh Tab with Alert ──────────────────────────
    bot.callbackQuery(/^adm_stats_rf_(overview|users|finance|digital|sms)$/, async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const tab = ctx.match[1] as "overview" | "users" | "finance" | "digital" | "sms";
      await ctx.answerCallbackQuery({ text: "🔄 Data statistik berhasil diperbarui!" });

      let text = "";
      if (tab === "overview") text = await buildStatsOverviewText();
      else if (tab === "users") text = await buildStatsUsersText();
      else if (tab === "finance") text = await buildStatsFinanceText();
      else if (tab === "digital") text = await buildStatsDigitalText();
      else if (tab === "sms") text = await buildStatsSmsText();

      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: buildStatsKeyboard(tab),
        });
      } catch {
        /* safe ignore unchanged */
      }
    });

    // ── adm_otp_menu — OTP SMS management sub-panel ──────────────────────────
    bot.callbackQuery("adm_otp_menu", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.delete(String(ctx.from?.id));
      await ctx.editMessageText(await buildOtpAdminText(), {
        parse_mode:   "HTML",
        reply_markup: await buildOtpAdminKeyboard(),
      });
    });

    // ── adm_otp_toggle — Toggle OTP SMS service on/off ───────────────────────
    bot.callbackQuery("adm_otp_toggle", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      const config = await SmsConfig.getOrCreate();
      const nextState = config.enabled === false ? true : false;
      config.enabled = nextState;
      await config.save();

      await ctx.answerCallbackQuery({
        text: nextState ? "🟢 Layanan OTP SMS DIAKTIFKAN!" : "🔴 Layanan OTP SMS DINONAKTIFKAN!",
      });

      await ctx.editMessageText(await buildOtpAdminText(), {
        parse_mode:   "HTML",
        reply_markup: await buildOtpAdminKeyboard(),
      });
    });

    // ── adm_sms_reload — Reload SMS cache via inline button ──────────────────
    bot.callbackQuery("adm_sms_reload", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "🔄 Memuat ulang cache SMS…" });
      await reload();
      await ctx.editMessageText(await buildOtpAdminText(), {
        parse_mode:   "HTML",
        reply_markup: await buildOtpAdminKeyboard(),
      });
    });

    // ── Command: /toggleotp & /togglesms ─────────────────────────────────────
    const handleToggleOtp = async (ctx: Context) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const config = await SmsConfig.getOrCreate();
      const nextState = config.enabled === false ? true : false;
      config.enabled = nextState;
      await config.save();

      await ctx.reply(
        nextState
          ? `🟢 <b>Layanan OTP SMS telah DIAKTIFKAN.</b>\nUser sekarang dapat memesan nomor virtual di bot.`
          : `🔴 <b>Layanan OTP SMS telah DINONAKTIFKAN.</b>\nUser tidak dapat melakukan pemesanan nomor baru (mode maintenance).`,
        { parse_mode: "HTML" }
      );
    };

    bot.command("toggleotp", handleToggleOtp);
    bot.command("togglesms", handleToggleOtp);

    // ── adm_c_pg_<n> — Country list page ────────────────────────────────────
    bot.callbackQuery(/^adm_c_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      if (SMSBowerService.allCountries.length === 0) {
        await ctx.answerCallbackQuery({ text: "⚠️ Data belum dimuat. Coba /smsreload.", show_alert: true });
        return;
      }

      const page          = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildCountryPage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        // Message content unchanged — safe to ignore
      }
    });

    // ── adm_s_pg_<n> — Service list page ────────────────────────────────────
    bot.callbackQuery(/^adm_s_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      if (SMSBowerService.allServices.length === 0) {
        await ctx.answerCallbackQuery({ text: "⚠️ Data belum dimuat. Coba /smsreload.", show_alert: true });
        return;
      }

      const page               = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildServicePage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        // Message content unchanged — safe to ignore
      }
    });

    // ── tgl_c_<id>_<page> — Toggle a country on/off ─────────────────────────
    bot.callbackQuery(/^tgl_c_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const countryId = ctx.match[1]!;
      const page      = parseInt(ctx.match[2]!, 10);

      const config = await SmsConfig.getOrCreate();
      const idx    = config.allowedCountries.indexOf(countryId);

      if (idx === -1) {
        // Not in whitelist → activate
        config.allowedCountries.push(countryId);
      } else {
        // In whitelist → deactivate
        config.allowedCountries.splice(idx, 1);
      }
      await config.save();

      // Refresh in-memory cache so the public user UI is updated immediately.
      await SMSBowerService.loadData();

      // Re-render the same page so the ✅/❌ flips instantly.
      const { text, keyboard } = await buildCountryPage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        // No change in message — safe to ignore
      }
    });

    // ── tgl_s_<code>_<page> — Toggle a service on/off ───────────────────────
    bot.callbackQuery(/^tgl_s_([a-z0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;

      const code = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);

      const config = await SmsConfig.getOrCreate();
      const idx    = config.allowedServices.indexOf(code);

      if (idx === -1) {
        config.allowedServices.push(code);
      } else {
        config.allowedServices.splice(idx, 1);
      }
      await config.save();

      await SMSBowerService.loadData();

      const { text, keyboard } = await buildServicePage(page);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        // No change in message — safe to ignore
      }
    });

    // ── /smsreload — Force a full cache refresh ──────────────────────────────
    bot.command("smsreload", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      await ctx.reply("🔄 Memuat ulang cache SMSBower dari database + API…");
      const summary = await reload();
      await ctx.reply(summary, { parse_mode: "HTML" });
    });

    // ── adm_pricing — Pricing panel (callback) ────────────────────────────
    bot.callbackQuery("adm_pricing", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const config = await SmsConfig.getOrCreate();
      await ctx.editMessageText(await buildPricingText(config.markupType, config.markupValue), {
        parse_mode:   "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔍 Cek Harga Asli SMSBower (USD & IDR)", "adm_check_price")
          .row()
          .text("🔙 Kembali", "adm_home"),
      });
    });

    // ── adm_check_price — Main price explorer menu ─────────────────────────
    bot.callbackQuery("adm_check_price", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const text = await buildCheckPriceMenuText();
      const kb = buildCheckPriceMenuKeyboard();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    });

    // ── adm_cp_refresh — Refresh rate and clear price cache ─────────────────
    bot.callbackQuery("adm_cp_refresh", async (ctx) => {
      if (!isAdmin(ctx)) return;
      SMSBowerService.priceCache.clear();
      await CurrencyService.getUsdRate();
      await ctx.answerCallbackQuery({ text: "🔄 Kurs dan cache harga berhasil diperbarui!", show_alert: false });
      const text = await buildCheckPriceMenuText();
      const kb = buildCheckPriceMenuKeyboard();
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    });

    // ── adm_cp_ctry_pg_<page> — Country list for price checking ────────────
    bot.callbackQuery(/^adm_cp_ctry_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const page = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildCheckPriceCountryKeyboard(page);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── adm_cp_c_<countryId>_<page> — Services in Country price view ────────
    bot.callbackQuery(/^adm_cp_c_(\d+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const countryId = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);
      const { text, keyboard } = await buildCountryServicesPriceView(countryId, page);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── adm_cp_svc_pg_<page> — Service list for price checking ─────────────
    bot.callbackQuery(/^adm_cp_svc_pg_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const page = parseInt(ctx.match[1]!, 10);
      const { text, keyboard } = await buildCheckPriceServiceKeyboard(page);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── adm_cp_s_<serviceCode>_<page> — Service across countries view ───────
    bot.callbackQuery(/^adm_cp_s_([a-z0-9]+)_(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const serviceCode = ctx.match[1]!;
      const page = parseInt(ctx.match[2]!, 10);
      const { text, keyboard } = await buildServiceCountriesPriceView(serviceCode, page);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    // ── /cekharga & /hargasms — Check SMSBower original price (USD & IDR) ───
    bot.command(["cekharga", "hargasms", "smsprice"], async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw = ctx.message?.text ?? "";
      const cleaned = raw.replace(/^\/(?:cekharga|hargasms|smsprice)(?:@\S+)?\s*/i, "").trim();

      if (!cleaned) {
        const text = await buildCheckPriceMenuText();
        const kb = buildCheckPriceMenuKeyboard();
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
        return;
      }

      const parts = cleaned.split(/\s+/);

      // Case A: 2 arguments -> service & country (in either order)
      if (parts.length >= 2) {
        const arg1 = parts[0]!;
        const arg2 = parts.slice(1).join(" ");

        let service = SMSBowerService.findService(arg1);
        let country = SMSBowerService.findCountry(arg2);

        // Swap if user provided country first, e.g. /cekharga 6 wa or /cekharga indonesia whatsapp
        if (!service || !country) {
          const swappedCountry = SMSBowerService.findCountry(arg1);
          const swappedService = SMSBowerService.findService(arg2);
          if (swappedService && swappedCountry) {
            service = swappedService;
            country = swappedCountry;
          }
        }

        if (!service || !country) {
          await ctx.reply(
            `⚠️ <b>Layanan atau Negara tidak dikenali.</b>\n\n` +
            `• Layanan terdeteksi: <b>${service ? service.name : `❌ Tidak ditemukan ("${escapeHtml(arg1)}")`}</b>\n` +
            `• Negara terdeteksi: <b>${country ? country.name : `❌ Tidak ditemukan ("${escapeHtml(arg2)}")`}</b>\n\n` +
            `<i>Contoh: <code>/cekharga wa 6</code> atau <code>/cekharga whatsapp indonesia</code></i>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const waitMsg = await ctx.reply(`🔄 Mengambil harga realtime <b>${escapeHtml(service.name)}</b> (${escapeHtml(country.name)}) dari SMSBower…`, { parse_mode: "HTML" });

        const [priceEntry, config, usdRate] = await Promise.all([
          SMSBowerService.getServicePrice(service.code, country.id),
          SmsConfig.getOrCreate(),
          CurrencyService.getUsdRate(),
        ]);

        if (!priceEntry || priceEntry.cost <= 0) {
          await ctx.api.editMessageText(
            ctx.chat.id,
            waitMsg.message_id,
            `⚠️ <b>Harga tidak ditemukan / stok kosong.</b>\n\n` +
            `Layanan <b>${escapeHtml(service.name)}</b> di negara <b>${escapeHtml(country.name)}</b> saat ini tidak memiliki harga/stok dari SMSBower.\n\n` +
            `<i>Silakan coba layanan atau negara lain.</i>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        const detailText = buildSinglePriceDetailText(
          service,
          country,
          priceEntry.cost,
          priceEntry.count,
          usdRate,
          config,
          priceEntry.providerIds,
          priceEntry.providers
        );

        const kb = new InlineKeyboard()
          .text(`📱 Cek ${service.name} di Negara Lain`, `adm_cp_s_${service.code}_0`)
          .row()
          .text(`🌍 Cek Layanan Lain di ${country.name}`, `adm_cp_c_${country.id}_0`)
          .row()
          .text("🔍 Menu Cek Harga", "adm_check_price");

        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, detailText, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
        return;
      }

      // Case B: 1 argument -> could be a country or a service
      const query = parts[0]!;

      // 1. Try matching as Country
      const matchedCountry = SMSBowerService.findCountry(query);
      if (matchedCountry) {
        const waitMsg = await ctx.reply(`🔄 Memuat daftar harga SMSBower untuk negara <b>${escapeHtml(matchedCountry.name)}</b>…`, { parse_mode: "HTML" });
        const view = await buildCountryServicesPriceView(matchedCountry.id, 0);
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, view.text, {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        });
        return;
      }

      // 2. Try matching as Service
      const matchedService = SMSBowerService.findService(query);
      if (matchedService) {
        const waitMsg = await ctx.reply(`🔄 Memuat harga <b>${escapeHtml(matchedService.name)}</b> di berbagai negara dari SMSBower…`, { parse_mode: "HTML" });
        const view = await buildServiceCountriesPriceView(matchedService.code, 0);
        await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, view.text, {
          parse_mode: "HTML",
          reply_markup: view.keyboard,
        });
        return;
      }

      // 3. Not found
      await ctx.reply(
        `❌ Tidak ditemukan layanan atau negara dengan kata kunci "<b>${escapeHtml(query)}</b>".\n\n` +
        `<b>Format penggunaan:</b>\n` +
        `• <code>/cekharga &lt;layanan&gt; &lt;negara&gt;</code> (Contoh: <code>/cekharga wa 6</code>)\n` +
        `• <code>/cekharga &lt;layanan&gt;</code> (Contoh: <code>/cekharga telegram</code>)\n` +
        `• <code>/cekharga &lt;negara&gt;</code> (Contoh: <code>/cekharga indonesia</code>)`,
        { parse_mode: "HTML" }
      );
    });

    // ── /markup — Show current pricing settings ────────────────────────────
    bot.command("markup", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      const config = await SmsConfig.getOrCreate();
      await ctx.reply(await buildPricingText(config.markupType, config.markupValue), { parse_mode: "HTML" });
    });

    // ── /setmarkup <type> <value> — Update pricing markup ───────────────────
    // Examples:
    //   /setmarkup fixed 1000        → base cost + 1000 credits
    //   /setmarkup percentage 15     → base cost + 15%
    bot.command("setmarkup", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      const raw   = ctx.message?.text ?? "";
      const parts = raw.replace(/^\/setmarkup(?:@\S+)?\s*/i, "").trim().split(/\s+/);
      const type  = parts[0]?.toLowerCase();
      const val   = parseFloat(parts[1] ?? "");

      if (type !== "fixed" && type !== "percentage") {
        await ctx.reply(
          "⚠️ Format: <code>/setmarkup &lt;fixed|percentage&gt; &lt;nilai&gt;</code>\n\n" +
          "Contoh:\n" +
          "  <code>/setmarkup fixed 1000</code>       → base + 1000 credits\n" +
          "  <code>/setmarkup percentage 10</code>    → base + 10%",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (isNaN(val) || val < 0) {
        await ctx.reply(
          "⚠️ Nilai markup harus berupa angka positif.\n" +
          "Contoh: <code>/setmarkup fixed 500</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (type === "percentage" && val > 1000) {
        await ctx.reply(
          "⚠️ Markup persentase tidak boleh melebihi 1000%.\n" +
          "Pastikan kamu tidak salah ketik.",
          { parse_mode: "HTML" }
        );
        return;
      }

      const config        = await SmsConfig.getOrCreate();
      const prevType      = config.markupType;
      const prevVal       = config.markupValue;
      config.markupType   = type;
      config.markupValue  = val;
      await config.save();

      const prevLine = prevType === "percentage" ? `+${prevVal}%` : `+Rp ${prevVal.toLocaleString("id-ID")}`;
      const newLine  = type      === "percentage" ? `+${val}%`    : `+Rp ${val.toLocaleString("id-ID")}`;

      await ctx.reply(
        `✅ <b>Markup berhasil diperbarui!</b>\n\n` +
        `Sebelum: <s>${prevLine}</s>\n` +
        `Sekarang: <b>${newLine}</b>\n\n` +
        await buildPricingText(type, val),
        { parse_mode: "HTML" }
      );
    });

    // ── /find <keyword> — Search services ────────────────────────────────────
    // Searches SMSBowerService.allServices by name (case-insensitive, partial).
    // Shows ✅/❌ status per result and lets the admin toggle inline.
    bot.command("find", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }

      // Extract keyword — everything after the command word.
      const raw     = ctx.message?.text ?? "";
      const keyword = raw.replace(/^\/find(?:@\S+)?\s*/i, "").trim().toLowerCase();

      if (!keyword) {
        await ctx.reply(
          "⚠️ Format: <code>/find &lt;nama_layanan&gt;</code>\n" +
          "Contoh: <code>/find netflix</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (SMSBowerService.allServices.length === 0) {
        await ctx.reply("⚠️ Data layanan belum dimuat. Coba /smsreload terlebih dahulu.");
        return;
      }

      // Search — name must contain the keyword anywhere (case-insensitive).
      const MAX_RESULTS = 40;
      const results = SMSBowerService.allServices
        .filter((s) => s.name.toLowerCase().includes(keyword))
        .slice(0, MAX_RESULTS);

      if (results.length === 0) {
        await ctx.reply(`❌ Tidak ditemukan layanan yang mengandung kata "<b>${keyword}</b>".`, { parse_mode: "HTML" });
        return;
      }

      // Fetch current whitelist from DB for ✅/❌ status.
      const config  = await SmsConfig.getOrCreate();
      const allowed = new Set(config.allowedServices);

      // Build keyboard — 2 buttons per row, callback: tgl_src_<code>.
      const kb = new InlineKeyboard();
      results.forEach((svc, idx) => {
        const icon = allowed.has(svc.code) ? "✅" : "❌";
        kb.text(`${icon} ${svc.name}`, `tgl_src_${svc.code}`);
        // New row after every 2nd button, or for the last button.
        if (idx % 2 === 1 || idx === results.length - 1) kb.row();
      });

      const truncated = results.length === MAX_RESULTS
        ? `\n<i>(Menampilkan ${MAX_RESULTS} hasil pertama. Perjelas kata kunci jika perlu.)</i>`
        : "";

      await ctx.reply(
        `🔍 <b>Hasil pencarian: "${keyword}"</b>\n` +
        `${"─".repeat(28)}\n` +
        `Ditemukan <b>${results.length}</b> layanan. Klik untuk toggle.${truncated}`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    // ── tgl_src_<code> — Toggle service from search result ───────────────────
    // Smart update: mutates the existing inline keyboard in-place rather than
    // re-rendering from DB, so the ✅/❌ flips instantly without a visible
    // full-page reload. Only the changed button's text is rewritten.
    bot.callbackQuery(/^tgl_src_(.+)$/, async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.answerCallbackQuery({ text: "⛔ Admin only.", show_alert: true });
        return;
      }

      const code = ctx.match[1]!;

      // 1. Toggle in DB.
      const config = await SmsConfig.getOrCreate();
      const idx    = config.allowedServices.indexOf(code);
      const nowActive = idx === -1; // true if we're activating, false if deactivating

      if (idx === -1) {
        config.allowedServices.push(code);
      } else {
        config.allowedServices.splice(idx, 1);
      }
      await config.save();

      // 2. Refresh in-memory cache (updates public user UI).
      await SMSBowerService.loadData();

      // 3. Smart in-place keyboard mutation.
      //    Clone the existing keyboard and flip only the affected button's icon.
      //    `InlineKeyboardButton` is a discriminated union; narrow with `in` before
      //    accessing `callback_data` to satisfy TypeScript's type checker.
      const existingRows = ctx.msg?.reply_markup?.inline_keyboard ?? [];
      const thisCallback = ctx.callbackQuery.data;

      const updatedRows = existingRows.map((row) =>
        row.map((btn) => {
          if (!("callback_data" in btn) || btn.callback_data !== thisCallback) return btn;
          // Replace leading ✅ or ❌ with the new state.
          const newIcon = nowActive ? "✅" : "❌";
          const label   = btn.text.replace(/^[✅❌]\s*/, "");
          return { ...btn, text: `${newIcon} ${label}` };
        })
      );

      try {
        // editMessageReplyMarkup's `other` param accepts `{ reply_markup: InlineKeyboardMarkup }`.
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: updatedRows } });
      } catch {
        // Keyboard unchanged — safe to ignore.
      }

      await ctx.answerCallbackQuery({ text: nowActive ? "✅ Layanan diaktifkan!" : "❌ Layanan dinonaktifkan!" });
    });

    // ── Legacy text commands (kept for power-user convenience) ───────────────

    bot.command("addservice", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Perintah ini hanya untuk admin."); return; }
      const code = parseArg(ctx);
      if (!code) { await ctx.reply("⚠️ Usage: <code>/addservice &lt;code&gt;</code>", { parse_mode: "HTML" }); return; }
      const config = await SmsConfig.getOrCreate();
      if (config.allowedServices.includes(code)) { await ctx.reply(`ℹ️ <code>${code}</code> sudah aktif.`, { parse_mode: "HTML" }); return; }
      config.allowedServices.push(code);
      await config.save();
      await ctx.reply(`✅ Layanan <code>${code}</code> ditambahkan.\n\n${await reload()}`, { parse_mode: "HTML" });
    });

    bot.command("rmservice", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Perintah ini hanya untuk admin."); return; }
      const code = parseArg(ctx);
      if (!code) { await ctx.reply("⚠️ Usage: <code>/rmservice &lt;code&gt;</code>", { parse_mode: "HTML" }); return; }
      const config = await SmsConfig.getOrCreate();
      const idx    = config.allowedServices.indexOf(code);
      if (idx === -1) { await ctx.reply(`ℹ️ <code>${code}</code> tidak ada di whitelist.`, { parse_mode: "HTML" }); return; }
      config.allowedServices.splice(idx, 1);
      await config.save();
      await ctx.reply(`✅ Layanan <code>${code}</code> dihapus.\n\n${await reload()}`, { parse_mode: "HTML" });
    });

    bot.command("addcountry", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Perintah ini hanya untuk admin."); return; }
      const id = parseArg(ctx);
      if (!id) { await ctx.reply("⚠️ Usage: <code>/addcountry &lt;id&gt;</code>", { parse_mode: "HTML" }); return; }
      const config = await SmsConfig.getOrCreate();
      if (config.allowedCountries.includes(id)) { await ctx.reply(`ℹ️ Negara <code>${id}</code> sudah aktif.`, { parse_mode: "HTML" }); return; }
      config.allowedCountries.push(id);
      await config.save();
      await ctx.reply(`✅ Negara <code>${id}</code> ditambahkan.\n\n${await reload()}`, { parse_mode: "HTML" });
    });

    bot.command("rmcountry", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Perintah ini hanya untuk admin."); return; }
      const id = parseArg(ctx);
      if (!id) { await ctx.reply("⚠️ Usage: <code>/rmcountry &lt;id&gt;</code>", { parse_mode: "HTML" }); return; }
      const config = await SmsConfig.getOrCreate();
      const idx    = config.allowedCountries.indexOf(id);
      if (idx === -1) { await ctx.reply(`ℹ️ Negara <code>${id}</code> tidak ada di whitelist.`, { parse_mode: "HTML" }); return; }
      config.allowedCountries.splice(idx, 1);
      await config.save();
      await ctx.reply(`✅ Negara <code>${id}</code> dihapus.\n\n${await reload()}`, { parse_mode: "HTML" });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  MAINTENANCE MODE
    // ═══════════════════════════════════════════════════════════════════════════

    bot.command("maintenance", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Perintah ini hanya untuk admin."); return; }
      const config = await BotConfig.getOrCreate();
      const status = config.isMaintenance
        ? `🔴 <b>MAINTENANCE AKTIF</b>\nSemua user non-admin diblokir sementara.`
        : `🟢 <b>Bot Berjalan Normal</b>`;
      const kb = new InlineKeyboard()
        .text(config.isMaintenance ? "✅ Matikan Maintenance" : "🔧 Aktifkan Maintenance", "adm_toggle_maintenance")
        .row()
        .text("✏️ Ubah Pesan Maintenance", "adm_set_maintenance_msg")
        .row()
        .text("🔙 Kembali ke Admin Panel", "adm_home");
      await ctx.reply(
        `🔧 <b>Panel Mode Maintenance</b>\n${"─".repeat(30)}\n\n${status}\n\n<b>Pesan Maintenance Saat Ini:</b>\n<i>${config.maintenanceMessage}</i>`,
        { parse_mode: "HTML", reply_markup: kb }
      );
    });

    bot.callbackQuery("adm_maintenance", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const config = await BotConfig.getOrCreate();
      const status = config.isMaintenance
        ? `🔴 <b>MAINTENANCE AKTIF</b>\nSemua user non-admin diblokir sementara.`
        : `🟢 <b>Bot Berjalan Normal</b>`;
      const kb = new InlineKeyboard()
        .text(config.isMaintenance ? "✅ Matikan Maintenance" : "🔧 Aktifkan Maintenance", "adm_toggle_maintenance")
        .row()
        .text("✏️ Ubah Pesan Maintenance", "adm_set_maintenance_msg")
        .row()
        .text("🔙 Kembali ke Admin Panel", "adm_home");
      try {
        await ctx.editMessageText(
          `🔧 <b>Panel Mode Maintenance</b>\n${"─".repeat(30)}\n\n${status}\n\n<b>Pesan Maintenance:</b>\n<i>${config.maintenanceMessage}</i>`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      } catch {
        await ctx.reply(
          `🔧 <b>Panel Mode Maintenance</b>\n${"─".repeat(30)}\n\n${status}`,
          { parse_mode: "HTML", reply_markup: kb }
        );
      }
    });

    bot.callbackQuery("adm_toggle_maintenance", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const config = await BotConfig.getOrCreate();
      config.isMaintenance = !config.isMaintenance;
      await config.save();
      clearMaintenanceCache();

      const newStatus = config.isMaintenance
        ? `🔴 <b>MAINTENANCE AKTIF</b> — Bot diblokir untuk user non-admin.`
        : `🟢 <b>Bot Kembali Normal</b> — Semua user bisa mengakses bot.`;

      await ctx.reply(`🔧 <b>Status Maintenance Diperbarui</b>\n\n${newStatus}`, { parse_mode: "HTML" });
    });

    bot.callbackQuery("adm_set_maintenance_msg", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      fsubInputState.set(String(ctx.from.id), { action: "SET_MAINTENANCE_MSG" });
      await ctx.reply(
        `✏️ <b>Ubah Pesan Maintenance</b>\n\nKetik pesan maintenance baru (mendukung HTML Telegram):\n\n<i>Contoh: 🔧 <b>Bot Sedang Maintenance</b>\\n\\nSilakan coba lagi nanti.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  BALANCE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════

    async function resolveUserTarget(target: string): Promise<import("../../models/User.js").IUser | null> {
      const clean = target.trim();
      if (!clean) return null;

      if (clean.startsWith("@")) {
        const uname = clean.slice(1);
        return await User.findOne({
          username: { $regex: new RegExp(`^${uname}$`, "i") },
        }).lean();
      }

      if (/^\d+$/.test(clean)) {
        const byId = await User.findOne({ telegramId: clean }).lean();
        if (byId) return byId;
      }

      return await User.findOne({
        username: { $regex: new RegExp(`^${clean}$`, "i") },
      }).lean();
    }

    bot.callbackQuery("adm_balance_menu", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      try {
        await ctx.editMessageText(
          `💳 <b>Manajemen Saldo User</b>\n${"─".repeat(30)}\n\n` +
          `Gunakan perintah berikut untuk mengelola saldo:\n\n` +
          `• <code>/addsaldo &lt;id/@username&gt; &lt;nominal&gt; [alasan]</code>\n  Tambah saldo user\n\n` +
          `• <code>/minsaldo &lt;id/@username&gt; &lt;nominal&gt; [alasan]</code>\n  Kurangi saldo user\n\n` +
          `• <code>/cekuser &lt;id/@username&gt;</code>\n  Cek detail user & riwayat saldo`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔙 Kembali", "adm_home") }
        );
      } catch {
        await ctx.reply(
          `💳 <b>Manajemen Saldo User</b>\n\nGunakan:\n/addsaldo, /minsaldo, /cekuser`,
          { parse_mode: "HTML" }
        );
      }
    });

    bot.command("addsaldo", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const parts = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const userTarget = parts[0];
      const amount = parseInt(parts[1] ?? "", 10);
      const reason = parts.slice(2).join(" ") || "Topup manual oleh admin";

      if (!userTarget || isNaN(amount) || amount <= 0) {
        await ctx.reply(
          `⚠️ Usage: <code>/addsaldo &lt;id/@username&gt; &lt;nominal&gt; [alasan]</code>\n\n` +
          `Contoh: <code>/addsaldo 123456789 50000 Bonus referral</code>\n` +
          `Contoh: <code>/addsaldo @username 50000 Bonus referral</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const targetUser = await resolveUserTarget(userTarget);
      if (!targetUser) {
        await ctx.reply(`❌ User <code>${userTarget}</code> tidak ditemukan di database.`, { parse_mode: "HTML" });
        return;
      }

      const result = await adjustBalance(targetUser.telegramId, amount, "CREDIT", reason, String(ctx.from?.id));
      if (!result.success) {
        await ctx.reply(`❌ Gagal: ${result.message}`, { parse_mode: "HTML" });
        return;
      }

      const handle = targetUser.username ? `@${targetUser.username}` : `<code>${targetUser.telegramId}</code>`;
      await ctx.reply(
        `✅ <b>Saldo Berhasil Ditambahkan</b>\n${"─".repeat(30)}\n\n` +
        `👤 User: <b>${targetUser.firstName}</b> (${handle})\n` +
        `🆔 Telegram ID: <code>${targetUser.telegramId}</code>\n` +
        `💰 Ditambahkan: <b>Rp ${amount.toLocaleString("id-ID")}</b>\n` +
        `💳 Saldo Baru: <b>Rp ${result.newBalance!.toLocaleString("id-ID")}</b>\n` +
        `📝 Alasan: <i>${reason}</i>`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("minsaldo", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const parts = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const userTarget = parts[0];
      const amount = parseInt(parts[1] ?? "", 10);
      const reason = parts.slice(2).join(" ") || "Pengurangan manual oleh admin";

      if (!userTarget || isNaN(amount) || amount <= 0) {
        await ctx.reply(
          `⚠️ Usage: <code>/minsaldo &lt;id/@username&gt; &lt;nominal&gt; [alasan]</code>\n\n` +
          `Contoh: <code>/minsaldo 123456789 10000 Koreksi refund</code>\n` +
          `Contoh: <code>/minsaldo @username 10000 Koreksi refund</code>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const targetUser = await resolveUserTarget(userTarget);
      if (!targetUser) {
        await ctx.reply(`❌ User <code>${userTarget}</code> tidak ditemukan di database.`, { parse_mode: "HTML" });
        return;
      }

      const result = await adjustBalance(targetUser.telegramId, amount, "DEBIT", reason, String(ctx.from?.id), true);
      if (!result.success) {
        await ctx.reply(`❌ Gagal: ${result.message}`, { parse_mode: "HTML" });
        return;
      }

      const handle = targetUser.username ? `@${targetUser.username}` : `<code>${targetUser.telegramId}</code>`;
      await ctx.reply(
        `✅ <b>Saldo Berhasil Dikurangi</b>\n${"─".repeat(30)}\n\n` +
        `👤 User: <b>${targetUser.firstName}</b> (${handle})\n` +
        `🆔 Telegram ID: <code>${targetUser.telegramId}</code>\n` +
        `💰 Dikurangi: <b>Rp ${amount.toLocaleString("id-ID")}</b>\n` +
        `💳 Saldo Baru: <b>Rp ${result.newBalance!.toLocaleString("id-ID")}</b>\n` +
        `📝 Alasan: <i>${reason}</i>`,
        { parse_mode: "HTML" }
      );
    });

    bot.command("cekuser", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const userTarget = parseArg(ctx);
      if (!userTarget) {
        await ctx.reply(`⚠️ Usage: <code>/cekuser &lt;id/@username&gt;</code>`, { parse_mode: "HTML" });
        return;
      }

      const user = await resolveUserTarget(userTarget);
      if (!user) {
        await ctx.reply(`❌ User <code>${userTarget}</code> tidak ditemukan di database.`, { parse_mode: "HTML" });
        return;
      }

      const logs = await getUserBalanceLogs(user.telegramId, 5);
      const formatIDR = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
      const formatDT = (d: Date) => new Date(d).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

      let logText = "";
      if (logs.length > 0) {
        logText = `\n\n📊 <b>5 Riwayat Saldo Terakhir:</b>\n`;
        for (const log of logs) {
          const sign = ["CREDIT", "TOPUP", "COMMISSION"].includes(log.type) ? "+" : "-";
          logText += `• ${sign}${formatIDR(log.amount)} <i>(${log.type})</i> — ${formatDT(log.createdAt)}\n  <i>${log.reason}</i>\n`;
        }
      } else {
        logText = `\n\n<i>Belum ada riwayat mutasi saldo.</i>`;
      }

      await ctx.reply(
        `👤 <b>Detail User</b>\n${"─".repeat(30)}\n\n` +
        `🆔 Telegram ID: <code>${user.telegramId}</code>\n` +
        `📛 Nama: <b>${user.firstName}</b>\n` +
        `🔗 Username: ${user.username ? `@${user.username}` : "—"}\n` +
        `💳 Saldo: <b>${formatIDR(user.balance)}</b>\n` +
        `👥 Saldo Afiliasi: <b>${formatIDR(user.affiliateBalance ?? 0)}</b>\n` +
        `🛒 Total Pesanan: <b>${user.totalOrders}</b>\n` +
        `📅 Terdaftar: ${formatDT(user.createdAt)}` +
        logText,
        { parse_mode: "HTML" }
      );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  PROMO / VOUCHER ADMIN
    // ═══════════════════════════════════════════════════════════════════════════

    bot.callbackQuery("adm_promo_menu", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const promos = await listAllPromos(0, 5);
      const formatIDR = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
      const now = new Date();

      let promoList = promos.length === 0
        ? `<i>Belum ada kode promo yang dibuat.</i>`
        : promos.map(p => {
          const expired = now > p.expiresAt;
          const status = !p.isActive || expired ? "❌" : "✅";
          const discountStr = p.discountType === "FIXED"
            ? formatIDR(p.discountValue)
            : `${p.discountValue}%`;
          return `${status} <code>${p.code}</code> — ${discountStr} | ${p.usedCount}/${p.quota} used | exp: ${p.expiresAt.toLocaleDateString("id-ID")}`;
        }).join("\n");

      try {
        await ctx.editMessageText(
          `🎟️ <b>Kelola Promo & Voucher</b>\n${"─".repeat(30)}\n\n` +
          `<b>Promo Terbaru:</b>\n${promoList}\n\n` +
          `<b>Buat promo baru:</b>\n<code>/addpromo &lt;CODE&gt; &lt;FIXED|PERCENT&gt; &lt;value&gt; &lt;quota&gt; &lt;minSpend&gt; &lt;days&gt;</code>\n\n` +
          `Contoh: <code>/addpromo HEMAT50 FIXED 5000 10 0 30</code>\n` +
          `Contoh: <code>/addpromo DISKON10 PERCENT 10 50 20000 7</code>`,
          { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔄 Refresh", "adm_promo_menu").row().text("🔙 Kembali", "adm_home") }
        );
      } catch {
        await ctx.reply("Gunakan /listpromo untuk melihat daftar promo dan /addpromo untuk membuat baru.");
      }
    });

    bot.command("addpromo", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const parts = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      // /addpromo <CODE> <FIXED|PERCENT> <value> <quota> <minSpend> <days>
      if (parts.length < 6) {
        await ctx.reply(
          `⚠️ <b>Usage:</b> <code>/addpromo &lt;CODE&gt; &lt;FIXED|PERCENT&gt; &lt;value&gt; &lt;quota&gt; &lt;minSpend&gt; &lt;days&gt;</code>\n\n` +
          `<b>Contoh:</b>\n` +
          `<code>/addpromo HEMAT50 FIXED 5000 10 0 30</code>\n<i>(kode HEMAT50, diskon flat Rp5.000, 10 kuota, min belanja 0, berlaku 30 hari)</i>\n\n` +
          `<code>/addpromo DISKON10 PERCENT 10 50 20000 7</code>\n<i>(kode DISKON10, diskon 10%, 50 kuota, min belanja Rp20.000, berlaku 7 hari)</i>`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const [code, typeRaw, valueStr, quotaStr, minSpendStr, daysStr] = parts;
      const discountTypeRaw = typeRaw!.toUpperCase();
      const discountType = (discountTypeRaw === "PERCENT" || discountTypeRaw === "PERCENTAGE")
        ? "PERCENTAGE" as const
        : "FIXED" as const;
      const discountValue = parseFloat(valueStr!);
      const quota = parseInt(quotaStr!, 10);
      const minSpend = parseInt(minSpendStr!, 10);
      const days = parseInt(daysStr!, 10);

      if (isNaN(discountValue) || isNaN(quota) || isNaN(minSpend) || isNaN(days) || quota <= 0 || days <= 0) {
        await ctx.reply("❌ Parameter tidak valid. Pastikan semua angka benar.", { parse_mode: "HTML" });
        return;
      }

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);

      try {
        const promo = await createPromo({
          code: code!,
          discountType,
          discountValue,
          minSpend: minSpend || 0,
          quota,
          expiresAt,
        });

        const formatIDR = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
        const discountStr = discountType === "FIXED" ? formatIDR(discountValue) : `${discountValue}%`;
        await ctx.reply(
          `✅ <b>Kode Promo Berhasil Dibuat!</b>\n${"─".repeat(30)}\n\n` +
          `🎟️ Kode: <code>${promo.code}</code>\n` +
          `💰 Diskon: <b>${discountStr}</b>\n` +
          `🎯 Kuota: <b>${quota} penggunaan</b>\n` +
          `💵 Min. Belanja: <b>${formatIDR(minSpend)}</b>\n` +
          `📅 Berlaku s/d: <b>${expiresAt.toLocaleDateString("id-ID")}</b>`,
          { parse_mode: "HTML" }
        );
      } catch (err: any) {
        if (err?.code === 11000) {
          await ctx.reply(`❌ Kode promo <code>${code!.toUpperCase()}</code> sudah ada.`, { parse_mode: "HTML" });
        } else {
          await ctx.reply(`❌ Gagal membuat promo: ${err?.message ?? "Unknown error"}`, { parse_mode: "HTML" });
        }
      }
    });

    bot.command("listpromo", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const promos = await listAllPromos(0, 15);
      const formatIDR = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
      const now = new Date();

      if (promos.length === 0) {
        await ctx.reply("ℹ️ Belum ada kode promo yang dibuat.");
        return;
      }

      let msg = `🎟️ <b>Daftar Kode Promo (${promos.length})</b>\n${"─".repeat(30)}\n\n`;
      for (const p of promos) {
        const expired = now > p.expiresAt;
        const status = !p.isActive ? "❌ Nonaktif" : expired ? "⏰ Kadaluarsa" : "✅ Aktif";
        const discountStr = p.discountType === "FIXED" ? formatIDR(p.discountValue) : `${p.discountValue}%`;
        msg += `<code>${p.code}</code> [${status}]\n`;
        msg += `  Diskon: ${discountStr} | Kuota: ${p.usedCount}/${p.quota} | Min: ${formatIDR(p.minSpend)}\n`;
        msg += `  Exp: ${p.expiresAt.toLocaleDateString("id-ID")}\n\n`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  BROADCAST
    // ═══════════════════════════════════════════════════════════════════════════

    const buildBroadcastMenu = async (): Promise<{ text: string; keyboard: InlineKeyboard }> => {
      const filters: BroadcastFilter[] = ["ALL", "WITH_BALANCE", "ACTIVE_BUYERS", "NEW_BUYERS"];
      let text = `📢 <b>Broadcast Pesan ke User</b>\n${"─".repeat(30)}\n\n`;
      text += `Pilih segmen target broadcast:\n\n`;
      for (const f of filters) {
        const count = await estimateBroadcastTarget(f);
        text += `• <b>${getBroadcastFilterLabel(f)}</b>: ${count} user\n`;
      }
      text += `\n<i>Pesan dikirim dengan delay 35ms/user untuk menghindari ban rate.</i>`;

      const kb = new InlineKeyboard()
        .text(`📣 Semua User`, "adm_bc_filter_ALL").row()
        .text(`💳 User Bersaldo`, "adm_bc_filter_WITH_BALANCE").row()
        .text(`🛒 Pernah Beli`, "adm_bc_filter_ACTIVE_BUYERS").row()
        .text(`🆕 Belum Pernah Beli`, "adm_bc_filter_NEW_BUYERS").row()
        .text("🔙 Kembali", "adm_home");

      return { text, keyboard: kb };
    };

    bot.command("broadcast", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const { text, keyboard } = await buildBroadcastMenu();
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    bot.callbackQuery("adm_broadcast", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const { text, keyboard } = await buildBroadcastMenu();
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } catch {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
    });

    bot.callbackQuery(/^adm_bc_filter_(ALL|WITH_BALANCE|ACTIVE_BUYERS|NEW_BUYERS)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const filter = ctx.match[1]! as BroadcastFilter;
      const label = getBroadcastFilterLabel(filter);
      const count = await estimateBroadcastTarget(filter);

      fsubInputState.set(String(ctx.from.id), { action: "BC_TEXT", broadcastFilter: filter });

      await ctx.reply(
        `📢 <b>Broadcast: ${label}</b>\n${"─".repeat(30)}\n\n` +
        `Target: <b>${count} user</b>\n\n` +
        `Ketik isi pesan broadcast di bawah ini (mendukung HTML Telegram):\n\n` +
        `<i>Ketik /batal untuk membatalkan.</i>`,
        { parse_mode: "HTML" }
      );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  BACKUP & ROLLBACK
    // ═══════════════════════════════════════════════════════════════════════════

    const processBackupFile = async (ctx: Context, fileId: string, fileName: string) => {
      const from = ctx.from;
      if (!from || !isAdmin(ctx)) return;

      const adminId = String(from.id);
      const statusMsg = await ctx.reply(
        `⏳ <b>Mengunduh & menganalisis file backup</b> <code>${escapeHtml(fileName)}</code>…\n` +
        `<i>Mohon tunggu beberapa detik.</i>`,
        { parse_mode: "HTML" }
      );

      try {
        const file = await ctx.api.getFile(fileId);
        if (!file.file_path) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            "❌ Gagal mengunduh file backup dari Telegram (file_path tidak ditemukan)."
          );
          return;
        }

        const token = ctx.api.token;
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            `❌ Gagal mengunduh file backup dari server Telegram (HTTP ${response.status}).`
          );
          return;
        }

        const arrayBuf = await response.arrayBuffer();
        const zipBuffer = Buffer.from(arrayBuf);

        const inspectResult = inspectBackupZip(zipBuffer);
        if (!inspectResult.success) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            `❌ <b>Analisis File Backup Gagal:</b>\n${escapeHtml(inspectResult.error || "Format arsip tidak valid.")}`,
            { parse_mode: "HTML" }
          );
          return;
        }

        pendingRollbackSessions.set(adminId, {
          collections: inspectResult.collections,
          totalDocs: inspectResult.totalDocs,
          fileName,
          timestamp: Date.now(),
        });

        const collectionLines = inspectResult.collections
          .map((c) => `• <b>${escapeHtml(c.name)}:</b> ${c.count} dokumen`)
          .join("\n");

        const text =
          `♻️ <b>PREVIEW ROLLBACK DATABASE</b>\n` +
          `${"─".repeat(34)}\n\n` +
          `📁 <b>File Backup:</b> <code>${escapeHtml(fileName)}</code>\n` +
          `📦 <b>Total Dokumen:</b> <b>${inspectResult.totalDocs} data</b>\n\n` +
          `📊 <b>Koleksi Terdeteksi (${inspectResult.collections.length}):</b>\n` +
          `${collectionLines}\n\n` +
          `⚠️ <b>PERINGATAN & KONFIRMASI:</b>\n` +
          `• Data di database saat ini pada koleksi di atas akan <b>DITIMPA</b> dengan isi file backup ini.\n` +
          `• Sistem akan otomatis membuat & mengirim <b>1 file safety-backup</b> ke DM Anda sesaat sebelum eksekusi dimulai.\n\n` +
          `<i>Apakah Anda yakin ingin mengeksekusi rollback sekarang?</i>`;

        const keyboard = new InlineKeyboard()
          .text("🚀 Ya, Jalankan Rollback", "adm_rb_confirm")
          .row()
          .text("❌ Batalkan", "adm_rb_cancel");

        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          text,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
          }
        );
      } catch (err: any) {
        console.error("[admin] processBackupFile error:", err);
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            `❌ Terjadi kesalahan saat memproses file: ${escapeHtml(err?.message || String(err))}`,
            { parse_mode: "HTML" }
          );
        } catch { /* ignore */ }
      }
    };

    bot.command("backup", async (ctx) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const msg = await ctx.reply("⏳ <b>Membuat backup database…</b>\nProses ini memerlukan beberapa detik.", { parse_mode: "HTML" });
      const result = await createAndSendBackup(ctx.api);
      if (!result.success) {
        await ctx.reply(`❌ Backup gagal: ${result.message}`);
        return;
      }
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, msg.message_id);
      } catch { /* ignore */ }
    });

    bot.callbackQuery("adm_backup", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "⏳ Membuat backup…" });
      if (!isAdmin(ctx)) return;
      const result = await createAndSendBackup(ctx.api);
      await ctx.reply(
        result.success
          ? `✅ Backup berhasil dibuat dan dikirim ke DM admin.`
          : `❌ Backup gagal: ${result.message}`,
        { parse_mode: "HTML" }
      );
    });

    const handleRollbackPrompt = async (ctx: Context) => {
      if (!isAdmin(ctx)) { await ctx.reply("⛔ Hanya admin."); return; }
      const adminId = String(ctx.from!.id);

      // Check if current message has a document attached (e.g. caption /rollback)
      const doc = ctx.message?.document;
      if (doc && (doc.file_name?.toLowerCase().endsWith(".zip") || doc.mime_type?.includes("zip"))) {
        await processBackupFile(ctx, doc.file_id, doc.file_name || "backup.zip");
        return;
      }

      // Check if replying to a document message
      const replyDoc = ctx.message?.reply_to_message?.document;
      if (replyDoc && (replyDoc.file_name?.toLowerCase().endsWith(".zip") || replyDoc.mime_type?.includes("zip"))) {
        await processBackupFile(ctx, replyDoc.file_id, replyDoc.file_name || "backup.zip");
        return;
      }

      fsubInputState.set(adminId, { action: "WAIT_ROLLBACK_FILE" });

      const text =
        `♻️ <b>Rollback / Restore Database</b>\n` +
        `${"─".repeat(34)}\n\n` +
        `Fitur ini digunakan untuk memulihkan seluruh koleksi database bot dari file arsip backup (<code>.zip</code>).\n\n` +
        `⚠️ <b>PERINGATAN:</b>\n` +
        `• Data pada koleksi terkait akan ditimpa dengan data arsip backup.\n` +
        `• Sistem akan otomatis membuat <b>1 safety-backup</b> sebelum eksekusi dimulai.\n\n` +
        `📥 <b>Silakan kirim (upload) file backup <code>.zip</code> sekarang:</b>\n\n` +
        `<i>💡 Tips: Anda juga bisa membalas (reply) file zip backup dengan /rollback atau /restore. Ketik /batal untuk membatalkan.</i>`;

      const keyboard = new InlineKeyboard().text("❌ Batalkan", "adm_home");

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    };

    bot.command(["rollback", "restore"], handleRollbackPrompt);

    bot.callbackQuery("adm_rollback", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!isAdmin(ctx)) return;
      const adminId = String(ctx.from.id);
      fsubInputState.set(adminId, { action: "WAIT_ROLLBACK_FILE" });

      const text =
        `♻️ <b>Rollback / Restore Database</b>\n` +
        `${"─".repeat(34)}\n\n` +
        `Fitur ini digunakan untuk memulihkan seluruh koleksi database bot dari file arsip backup (<code>.zip</code>).\n\n` +
        `⚠️ <b>PERINGATAN:</b>\n` +
        `• Data pada koleksi terkait akan ditimpa dengan data arsip backup.\n` +
        `• Sistem akan otomatis membuat <b>1 safety-backup</b> sebelum eksekusi dimulai.\n\n` +
        `📥 <b>Silakan kirim (upload) file backup <code>.zip</code> sekarang:</b>\n\n` +
        `<i>💡 Tips: Anda juga bisa membalas (reply) file zip backup dengan /rollback atau /restore. Ketik /batal untuk membatalkan.</i>`;

      const keyboard = new InlineKeyboard().text("❌ Batalkan", "adm_home");

      await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    });

    bot.on("message:document", async (ctx, next) => {
      const from = ctx.from;
      if (!from || !isAdmin(ctx)) return next();

      const adminId = String(from.id);
      const state = fsubInputState.get(adminId);
      const doc = ctx.message.document;
      const fileName = doc.file_name || "";
      const isZip =
        fileName.toLowerCase().endsWith(".zip") ||
        (doc.mime_type && doc.mime_type.toLowerCase().includes("zip"));

      const hasRollbackCaption =
        ctx.message.caption &&
        /^\/(rollback|restore)/i.test(ctx.message.caption.trim());

      if (state?.action === "WAIT_ROLLBACK_FILE" || (isZip && hasRollbackCaption)) {
        fsubInputState.delete(adminId);
        if (!isZip) {
          await ctx.reply(
            "❌ File yang dikirim bukan file arsip <code>.zip</code>.\nSilakan kirim file backup dengan ekstensi <code>.zip</code>.",
            { parse_mode: "HTML" }
          );
          return;
        }
        await processBackupFile(ctx, doc.file_id, fileName || "backup.zip");
        return;
      }

      return next();
    });

    bot.callbackQuery("adm_rb_cancel", async (ctx) => {
      await ctx.answerCallbackQuery({ text: "Rollback dibatalkan." });
      if (!isAdmin(ctx)) return;
      const adminId = String(ctx.from.id);
      pendingRollbackSessions.delete(adminId);
      fsubInputState.delete(adminId);

      try {
        await ctx.editMessageText(
          "❌ <b>Proses Rollback Database Dibatalkan.</b>\nTidak ada perubahan yang dilakukan pada database.",
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("🔙 Kembali ke Menu Admin", "adm_home"),
          }
        );
      } catch { /* ignore */ }
    });

    bot.callbackQuery("adm_rb_confirm", async (ctx) => {
      if (!isAdmin(ctx)) return;
      const adminId = String(ctx.from.id);
      const session = pendingRollbackSessions.get(adminId);

      if (!session) {
        await ctx.answerCallbackQuery({
          text: "⚠️ Sesi rollback telah kedaluwarsa. Silakan upload ulang file backup.",
          show_alert: true,
        });
        return;
      }

      // 15-minute expiration
      if (Date.now() - session.timestamp > 15 * 60 * 1000) {
        pendingRollbackSessions.delete(adminId);
        await ctx.answerCallbackQuery({
          text: "⚠️ Sesi rollback kedaluwarsa (>15 menit). Silakan upload ulang file backup.",
          show_alert: true,
        });
        return;
      }

      await ctx.answerCallbackQuery({ text: "⏳ Menjalankan safety backup & rollback..." });

      try {
        await ctx.editMessageText(
          `⏳ <b>Sedang melakukan rollback database…</b>\n` +
          `${"─".repeat(34)}\n\n` +
          `1️⃣ Membuat <i>safety-backup</i> ke DM Admin…\n` +
          `2️⃣ Memulihkan ${session.collections.length} koleksi MongoDB…\n\n` +
          `<i>Mohon tidak mematikan bot selama proses berlangsung.</i>`,
          { parse_mode: "HTML" }
        );
      } catch { /* ignore */ }

      const startTime = Date.now();
      const rollbackResult = await executeRollback(session.collections, ctx.api, {
        telegramId: ctx.from.id,
        firstName: ctx.from.first_name,
        username: ctx.from.username,
      });

      pendingRollbackSessions.delete(adminId);
      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

      const resultLines = rollbackResult.results
        .map((r) => {
          const icon = r.error ? "⚠️" : "✅";
          const errInfo = r.error ? ` <i>(${escapeHtml(r.error)})</i>` : "";
          return `${icon} <b>${escapeHtml(r.name)}:</b> ${r.restored} dokumen${errInfo}`;
        })
        .join("\n");

      const successText =
        `✅ <b>ROLLBACK DATABASE SELESAI!</b>\n` +
        `${"─".repeat(34)}\n\n` +
        `🎉 <b>Status:</b> Database berhasil dipulihkan dari file backup!\n` +
        `📁 <b>File Sumber:</b> <code>${escapeHtml(session.fileName)}</code>\n` +
        `📦 <b>Total Dokumen:</b> <b>${rollbackResult.totalRestored} data</b>\n` +
        `⏱️ <b>Waktu Proses:</b> ${durationSec} detik\n\n` +
        `📊 <b>Rincian Hasil Pemulihan:</b>\n` +
        `${resultLines}\n\n` +
        `🛡️ <i>Catatan: 1 file safety-backup telah dikirimkan ke DM Anda sebelum eksekusi dimulai.</i>`;

      try {
        await ctx.editMessageText(successText, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔙 Kembali ke Menu Admin", "adm_home"),
        });
      } catch {
        await ctx.reply(successText, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔙 Kembali ke Menu Admin", "adm_home"),
        });
      }
    });
  },
};

export default adminPlugin;
