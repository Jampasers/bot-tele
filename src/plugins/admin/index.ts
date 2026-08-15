import { Bot, Context, InlineKeyboard } from "grammy";
import { Plugin } from "../../types/Plugin.js";
import { SmsConfig } from "../../models/SmsConfig.js";
import { SMSBowerService } from "../../services/smsbower.js";
import { ForceSubService } from "../../services/forceSub.js";
import { TestimonialService } from "../../services/testimonial.js";
import { BotStatsService } from "../../services/stats.js";

// ============================================================================
//  ADMIN PLUGIN — Interactive Whitelist & Platform Manager
//
//  All interactions are gated behind ADMIN_ID from process.env.
// ============================================================================

const ITEMS_PER_PAGE = 20;

interface FsubAdminState {
  action: "SET_CHAN" | "SET_LINK" | "SET_NAME" | "SET_TESTI_CHAN" | "SET_TESTI_LINK";
}

const fsubInputState = new Map<string, FsubAdminState>();

// ── Admin guard ───────────────────────────────────────────────────────────────

function isAdmin(ctx: Context): boolean {
  const adminId = process.env["ADMIN_ID"];
  if (!adminId) {
    console.warn("[admin] ADMIN_ID env variable is not set — all admin commands are locked.");
    return false;
  }
  return String(ctx.from?.id) === adminId;
}

// ── UI Builders ───────────────────────────────────────────────────────────────

/** Returns the main admin panel text. */
async function buildHomeText(): Promise<string> {
  const config     = await SmsConfig.getOrCreate();
  const botConfig  = await ForceSubService.getConfig();
  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}% (persentase)`
    : `+${config.markupValue} (flat)`;

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

  return (
    `🛠 <b>Admin Panel Utama</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `<b>Layanan OTP SMS:</b>     ${otpStatus}\n` +
    `<b>Active services:</b>     ${SMSBowerService.cachedServices.length} / ${SMSBowerService.allServices.length}\n` +
    `<b>Active countries:</b>    ${SMSBowerService.cachedCountries.length} / ${SMSBowerService.allCountries.length}\n` +
    `<b>Markup aktif:</b>        <code>${markupLine}</code>\n` +
    `<b>Wajib Join Channel:</b>  ${fsubStatus}\n` +
    `<b>Channel Testimoni:</b>   ${testiStatus}\n\n` +
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
    .text(otpLabel, "adm_otp_menu")
    .row()
    .text(`🌍 Kelola Negara (${SMSBowerService.cachedCountries.length}/${SMSBowerService.allCountries.length})`, "adm_c_pg_0")
    .row()
    .text(`📱 Kelola Layanan (${SMSBowerService.cachedServices.length}/${SMSBowerService.allServices.length})`, "adm_s_pg_0")
    .row()
    .text("💰 Pricing & Markup", "adm_pricing")
    .row()
    .text("📦 Kelola Produk Digital & Stok", "dga_home");
}

async function buildOtpAdminText(): Promise<string> {
  const config = await SmsConfig.getOrCreate();
  const status = config.enabled !== false
    ? "🟢 <b>Aktif</b> (User dapat memilih negara dan menyewa nomor OTP virtual)"
    : "🔴 <b>Nonaktif</b> (Layanan dinonaktifkan / mode maintenance)";

  const markupLine = config.markupType === "percentage"
    ? `+${config.markupValue}% (persentase)`
    : `+${config.markupValue} (flat)`;

  return (
    `💬 <b>Pengaturan Layanan OTP SMS (Virtual Number)</b>\n` +
    `${"─".repeat(36)}\n\n` +
    `⚙️ <b>Status Layanan:</b>   ${status}\n` +
    `🌍 <b>Negara Aktif:</b>     ${SMSBowerService.cachedCountries.length} / ${SMSBowerService.allCountries.length}\n` +
    `📱 <b>Layanan Aktif:</b>    ${SMSBowerService.cachedServices.length} / ${SMSBowerService.allServices.length}\n` +
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
function buildPricingText(
  markupType:  "fixed" | "percentage",
  markupValue: number
): string {
  const rule =
    markupType === "percentage"
      ? `Harga jual = Harga dasar + <b>${markupValue}%</b>`
      : `Harga jual = Harga dasar + <b>${markupValue} credits</b>`;

  const examples =
    markupType === "percentage"
      ? [1000, 2000, 5000].map(
          (base) =>
            `  Base ${base} → Jual <b>${Math.round(base + base * (markupValue / 100))}</b>`
        )
      : [1000, 2000, 5000].map(
          (base) =>
            `  Base ${base} → Jual <b>${base + markupValue}</b>`
        );

  return (
    `💰 <b>Pengaturan Harga Aktif</b>\n` +
    `${"─".repeat(30)}\n\n` +
    `<b>Tipe markup:</b>  <code>${markupType}</code>\n` +
    `<b>Nilai markup:</b> <code>${markupValue}${markupType === "percentage" ? "%" : ""}</code>\n\n` +
    `<b>Rumus:</b> ${rule}\n\n` +
    `<b>Contoh harga:</b>\n` +
    examples.join("\n") + "\n\n" +
    `<i>Ubah dengan /setmarkup &lt;fixed|percentage&gt; &lt;nilai&gt;</i>`
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
    { command: "admin",          description: "[Admin] Buka panel manajemen admin utama" },
    { command: "stats",          description: "[Admin] Lihat ringkasan & statistik performa bot" },
    { command: "statistik",      description: "[Admin] Lihat ringkasan & statistik performa bot" },
    { command: "otpadmin",       description: "[Admin] Buka panel pengaturan layanan OTP SMS" },
    { command: "toggleotp",      description: "[Admin] Toggle on/off layanan OTP SMS" },
    { command: "togglesms",      description: "[Admin] Toggle on/off layanan OTP SMS" },
    { command: "smsadmin",       description: "[Admin] Buka panel manajemen OTP SMS" },
    { command: "forcesub",       description: "[Admin] Buka panel Wajib Join Channel" },
    { command: "setchannel",     description: "[Admin] Set channel: /setchannel <@channel> [link]" },
    { command: "toggleforcesub", description: "[Admin] Toggle on/off wajib join channel" },
    { command: "testi",          description: "[Admin] Buka panel pengaturan Channel Testimoni" },
    { command: "settesti",       description: "[Admin] Set channel testimoni: /settesti <@channel> [link]" },
    { command: "toggletesti",    description: "[Admin] Toggle on/off kirim testimoni" },
    { command: "testtesti",      description: "[Admin] Kirim testimoni uji coba ke channel" },
    { command: "find",           description: "[Admin] Cari layanan: /find <keyword>"   },
    { command: "markup",         description: "[Admin] Lihat markup harga aktif"        },
    { command: "setmarkup",      description: "[Admin] Set markup: /setmarkup <type> <val>" },
    { command: "smsreload",      description: "[Admin] Reload cache SMS dari DB + API"  },
    { command: "addservice",     description: "[Admin] Tambah service ke whitelist"     },
    { command: "rmservice",      description: "[Admin] Hapus service dari whitelist"    },
    { command: "addcountry",     description: "[Admin] Tambah negara ke whitelist"      },
    { command: "rmcountry",      description: "[Admin] Hapus negara dari whitelist"     },
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

    // ── Message listener for ForceSub interactive input ─────────────────────
    bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (!from || !isAdmin(ctx)) return next();

      const adminId = String(from.id);
      const state = fsubInputState.get(adminId);
      if (!state) return next();

      const text = ctx.message.text.trim();
      if (text.startsWith("/")) {
        fsubInputState.delete(adminId);
        return next();
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
      await ctx.editMessageText(buildPricingText(config.markupType, config.markupValue), {
        parse_mode:   "HTML",
        reply_markup: new InlineKeyboard().text("🔙 Kembali", "adm_home"),
      });
    });

    // ── /markup — Show current pricing settings ────────────────────────────
    bot.command("markup", async (ctx) => {
      if (!isAdmin(ctx)) {
        await ctx.reply("⛔ Perintah ini hanya untuk admin.");
        return;
      }
      const config = await SmsConfig.getOrCreate();
      await ctx.reply(buildPricingText(config.markupType, config.markupValue), { parse_mode: "HTML" });
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

      const prevLine = prevType === "percentage" ? `+${prevVal}%` : `+${prevVal} credits`;
      const newLine  = type      === "percentage" ? `+${val}%`    : `+${val} credits`;

      await ctx.reply(
        `✅ <b>Markup berhasil diperbarui!</b>\n\n` +
        `Sebelum: <s>${prevLine}</s>\n` +
        `Sekarang: <b>${newLine}</b>\n\n` +
        buildPricingText(type, val),
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
  },
};

export default adminPlugin;
