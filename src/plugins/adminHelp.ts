export const ADMIN_HELP_SECTION_IDS = [
  "ringkasan",
  "produk",
  "otp",
  "channel",
  "cloudflare",
  "sistem",
] as const;

export type AdminHelpSectionId = (typeof ADMIN_HELP_SECTION_IDS)[number];

interface AdminHelpSection {
  title: string;
  lines: readonly string[];
}

export const ADMIN_HELP_SECTION_LABELS: Readonly<Record<AdminHelpSectionId, string>> = {
  ringkasan: "🏠 Umum & User",
  produk: "📦 Produk",
  otp: "📱 OTP SMS",
  channel: "📢 Channel & IMAP",
  cloudflare: "☁️ Cloudflare",
  sistem: "🛡 Sistem & Rental",
};

const ADMIN_HELP_SECTIONS: Readonly<Record<AdminHelpSectionId, AdminHelpSection>> = {
  ringkasan: {
    title: "Umum, Statistik, User & Promosi",
    lines: [
      "<code>/admin</code> — buka panel admin utama",
      "<code>/stats</code> / <code>/statistik</code> — statistik bot",
      "<code>/pendapatan [YYYY-MM-DD]</code> — pendapatan per periode/tanggal",
      "<code>/addsaldo &lt;id/@user&gt; &lt;nominal&gt; [alasan]</code>",
      "<code>/minsaldo &lt;id/@user&gt; &lt;nominal&gt; [alasan]</code>",
      "<code>/cekuser &lt;id/@user&gt;</code> — detail dan riwayat saldo user",
      "<code>/addpromo &lt;kode&gt; &lt;fixed|percent&gt; &lt;nilai&gt; &lt;kuota&gt; &lt;min&gt; &lt;hari&gt;</code>",
      "<code>/listpromo</code> — daftar promo aktif",
      "<code>/broadcast</code> — kirim pesan berdasarkan filter user",
    ],
  },
  produk: {
    title: "Produk Digital, Stok & Garansi",
    lines: [
      "<code>/digiadmin</code> — panel produk dan stok",
      "<code>/garansi</code> / <code>/claims</code> — klaim garansi pending",
      "<code>/addproduct &lt;kategori&gt; | &lt;nama&gt; | &lt;harga&gt; | ...</code>",
      "<code>/listproducts</code> — daftar seluruh produk",
      "<code>/delproduct &lt;id_produk&gt;</code>",
      "<code>/addstock &lt;id_produk&gt;</code>",
      "<code>/viewstock &lt;id_produk&gt;</code>",
      "<code>/clearstock &lt;id_produk&gt;</code>",
      "<code>/editprice &lt;id_produk&gt; &lt;harga&gt;</code>",
      "<code>/editdesc &lt;id_produk&gt; &lt;deskripsi&gt;</code>",
      "<code>/editpesan &lt;id_produk&gt; &lt;pesan&gt;</code>",
      "<code>/setwarranty &lt;id_produk&gt; &lt;durasi&gt;</code>",
      "<code>/setmaxclaims &lt;id_produk&gt; &lt;jumlah&gt;</code>",
      "<code>/setbulk &lt;id_produk&gt; &lt;min_qty&gt; &lt;harga/persen&gt;</code>",
      "<code>/delbulk &lt;id_produk&gt; [min_qty/all]</code>",
      "<code>/bulklist &lt;id_produk&gt;</code>",
    ],
  },
  otp: {
    title: "Layanan OTP SMS & Harga",
    lines: [
      "<code>/otpadmin</code> / <code>/smsadmin</code> — panel OTP SMS",
      "<code>/toggleotp</code> / <code>/togglesms</code> — aktif/nonaktifkan OTP",
      "<code>/find &lt;keyword&gt;</code> — cari layanan",
      "<code>/cekharga [layanan] [negara]</code> / <code>/hargasms</code>",
      "<code>/markup</code> — lihat markup aktif",
      "<code>/setmarkup &lt;fixed|percentage&gt; &lt;nilai&gt;</code>",
      "<code>/smsreload</code> — muat ulang cache layanan",
      "<code>/addservice &lt;kode&gt;</code> / <code>/rmservice &lt;kode&gt;</code>",
      "<code>/addcountry &lt;id&gt;</code> / <code>/rmcountry &lt;id&gt;</code>",
    ],
  },
  channel: {
    title: "Channel, Force Sub & IMAP",
    lines: [
      "<code>/forcesub</code> — panel wajib join channel",
      "<code>/setchannel &lt;@channel&gt; [link]</code>",
      "<code>/toggleforcesub</code>",
      "<code>/testi</code> — panel channel testimoni",
      "<code>/settesti &lt;@channel&gt; [link]</code>",
      "<code>/toggletesti</code> / <code>/testtesti</code>",
      "<code>/log</code> — panel log aktivitas",
      "<code>/setlog &lt;@channel&gt; [link]</code>",
      "<code>/togglelog</code> / <code>/testlog</code>",
      "<code>/otpchannel</code> — panel channel OTP dan IMAP",
      "<code>/setotpchannel &lt;@channel&gt; [link]</code>",
      "<code>/toggleotpchannel</code> / <code>/testotpchannel</code>",
      "<code>/imapstatus</code> — status listener IMAP",
      "<code>/imapinfo</code> — konfigurasi IMAP tersimpan",
      "<code>/setimap &lt;host&gt; &lt;user&gt; &lt;pass&gt; [port] [sender]</code>",
    ],
  },
  cloudflare: {
    title: "Cloudflare Email Routing",
    lines: [
      "<code>/cf</code> / <code>/cloudflare</code> — panel Cloudflare",
      "<code>/cfcreate [prefix] [domain] [tujuan]</code>",
      "<code>/cflist [domain]</code> — daftar rule aktif",
      "<code>/cfdel &lt;zoneId&gt; &lt;ruleId&gt;</code>",
      "<code>/cfzones</code> — daftar domain/zone",
    ],
  },
  sistem: {
    title: "Sistem, Keamanan, Backup & Rental",
    lines: [
      "<code>/maintenance</code> — panel mode maintenance",
      "<code>/backup</code> — buat backup database",
      "<code>/rollback</code> / <code>/restore</code> — pulihkan backup",
      "<code>/antifraud</code> — panel keamanan",
      "<code>/fraudlogs</code> — 10 log fraud terbaru",
      "<code>/banned</code> — daftar user diblokir",
      "<code>/ban &lt;telegramId&gt; [alasan]</code>",
      "<code>/unban &lt;telegramId&gt;</code>",
      "<code>/rental</code> — kelola paket dan bot rental",
      "<code>/cancelrental</code> — batalkan/hentikan bot rental",
      "<code>/vpsadmin</code> — token DigitalOcean, pemeriksaan akun, paket & harga VPS",
      "<code>/vps</code> — katalog VPS, jasa install dan riwayat pesanan",
    ],
  },
};

export function isAdminHelpSectionId(value: string): value is AdminHelpSectionId {
  return ADMIN_HELP_SECTION_IDS.includes(value as AdminHelpSectionId);
}

export function buildAdminHelpText(sectionId: AdminHelpSectionId = "ringkasan"): string {
  const section = ADMIN_HELP_SECTIONS[sectionId];
  const page = ADMIN_HELP_SECTION_IDS.indexOf(sectionId) + 1;
  return (
    `📚 <b>Panduan Lengkap Admin — ${section.title}</b>\n` +
    `<i>Halaman ${page}/${ADMIN_HELP_SECTION_IDS.length}. Semua perintah hanya dapat digunakan admin.</i>\n\n` +
    section.lines.join("\n") +
    "\n\n<i>Pilih kategori lain melalui tombol di bawah.</i>"
  );
}

export function buildRentalAdminHelpText(): string {
  return (
    "📚 <b>Panduan Admin Bot Rental</b>\n" +
    "<i>Gunakan melalui chat pribadi bot rental.</i>\n\n" +
    "<code>/admin</code> / <code>/settings</code> — panel pengaturan toko\n" +
    "<code>/payment</code> — lihat konfigurasi pembayaran\n" +
    "<code>/setpayment</code> — panduan payment bertahap memakai foto QRIS\n" +
    "<code>/setshop &lt;field&gt; &lt;nilai&gt;</code> — ubah channel/pesan toko\n" +
    "<code>/setaffiliate &lt;fixed|percentage&gt; &lt;nilai&gt;</code> — komisi afiliasi\n" +
    "<code>/stats</code> — statistik toko\n" +
    "<code>/restart</code> — restart bot rental\n\n" +
    "<b>Field /setshop:</b> forceSubChannel, forceSubLink, forceSubName, " +
    "testimonialChannel, testimonialLink, logChannel, logChannelLink, maintenanceMessage.\n\n" +
    "⚠️ <i>Data payment berisi rahasia. Kirim hanya lewat chat pribadi dan jangan teruskan pesannya.</i>"
  );
}
