# Implementasi multi-tenant rental

## Arsitektur yang dipasang

Codebase dan layanan bisnis existing dipakai bersama. Satu proses Node menjalankan `BotInstance` platform dan `Map<rentalId, BotInstance>` di `BotManager`, tanpa salinan source atau proses Node per renter. Process IMAP existing dan WhatsApp hanya dijalankan untuk platform. Gunakan **satu instance PM2 dalam fork mode**, bukan cluster.

`createBot(token, tenantContext)` memasang konteks AsyncLocalStorage pada setiap update. Context memuat tenant/rental ID, owner/admin IDs, paket, fitur, status, expiry dan grace. Identitas tidak dapat dimutasi selama update berjalan. Query Mongoose lazy juga dieksekusi di dalam konteks tersebut. Tidak adanya context menyebabkan operasi tenant ditolak.

Plugin Mongoose pada semua 15 model existing dan `TenantPaymentConfig` menambahkan `tenantId` ke reads, counts, distinct, aggregates, update/delete, insert, save, upsert dan replace. Index unik yang sebelumnya global menjadi gabungan dengan tenant; TTL tetap berdiri sendiri. Aggregate join/write stages, raw collection access melalui jalur aplikasi, pipeline updates, `bulkWrite` dan estimated counts tidak digunakan sebagai jalur CRUD tenant. Middleware secara eksplisit menolak operasi yang tidak dapat dijamin isolasinya. **Pemanggilan raw Mongo collection oleh kode baru dapat melewati middleware dan dilarang di luar migration/test infrastructure.**

`TenantMap` memisahkan state percakapan digital/digiadmin, rate limit, ban cache dan membership. Cache force-sub, log, testimoni, maintenance, QRIS, token login merchant, dan konfigurasi payment juga terpisah. Admin helper memakai owner/admin tenant berdasarkan ID numerik. Default rental tidak mengambil channel, IMAP atau Cloudflare credential dari environment platform.

Metadata plugin `internalOnly` mengunci admin internal, SMSBower dan info internal dari rental. Plugin rentaladmin memakai layanan produk/stok/garansi existing. Metadata `feature` diperiksa pada setiap update agar fitur paket berubah saat cache rental diperbarui. Handler renewal dipasang sebelum anti-fraud, maintenance, dan force-sub, sehingga owner tetap dapat memperpanjang rental yang sedang terkunci.

Bot platform juga memuat alur self-service melalui `/sewa` dan **Catalog → 🤖 Sewa Bot Otomatis**. Pengguna memilih paket aktif dan mengirim token BotFather baru melalui chat pribadi. Handler wajib menghapus pesan sebelum memverifikasi atau menyimpan token. Rental dan invoice QRIS platform kemudian dibuat dalam status `pending`, sementara instance rental ditahan offline. Settlement dari scheduler atau tombol pemeriksaan mengaktifkan masa sewa secara idempotent dan baru kemudian memulai instance. Alur publik membatasi satu rental yang belum `terminated` per owner Telegram; provisioning admin tetap dapat membuat lebih dari satu rental.

Referensi mekanisme: [Mongoose middleware](https://mongoosejs.com/docs/middleware.html), [Node AsyncLocalStorage](https://nodejs.org/api/async_context.html), dan [grammY runner](https://grammy.dev/plugins/runner). Implementasi dan tests mengikuti versi dependency yang terpasang di repository.

## Database dan migrasi

Model existing yang diberi tenant: `User`, `Order`, `DigitalProduct`, `DigitalStock`, `DigitalOrder`, `Cart`, `TopupSession`, `BotConfig`, `SmsConfig`, `PromoCode`, `AffiliateLog`, `BalanceLog`, `RestockAlert`, `WarrantyClaim`, `FraudLog`.

Model baru:

| Model | Tujuan |
| --- | --- |
| `BotRental` | Identitas bot/owner, token terenkripsi, paket, lifecycle, expiry, reminder dan receipt renewal yang sudah diterapkan. |
| `RentalPlan` | Paket configurable: kode, nama, durasi, harga, fitur, enabled. |
| `RentalPayment` | Billing platform untuk sewa; provider reference, merchant, nominal dan durasi disimpan saat invoice dibuat. |
| `TenantPaymentConfig` | Konfigurasi QRIS/GoPay per tenant; payload dan credential terenkripsi. |
| `PaymentAmountReservation` | Reservasi nominal akhir per merchant selama 30 menit, termasuk toko platform dan renewal. |
| `PaymentSettlementClaim` | Klaim transaksi merchant yang persisten tanpa TTL untuk mencegah replay lintas invoice/tenant/jenis pembayaran. |

Control-plane rental, plan dan ledger pembayaran sengaja memakai model global privat; akses UI berjalan melalui layanan yang memeriksa actor serta identitas rental tersimpan. `TopupSession` juga memperoleh snapshot `paymentMerchantId` dan `paymentConfigVersion`.

Script migrasi tidak menghapus atau menggabungkan dokumen. Data tanpa tenant dipindahkan ke tenant `platform`. Preflight menolak tenant invalid atau data duplikat yang melanggar index target. Index tenant dipasang sebelum index unik global lama dilepas. Index control-plane baru juga dipasang. Migrasi dapat dijalankan ulang; startup melakukan pemeriksaan read-only dan menolak berjalan jika migrasi belum lengkap.

Urutan operator:

1. Hentikan seluruh proses bot. Ambil backup MongoDB lengkap dengan alat operator, bukan hanya ZIP koleksi lama dari bot.
2. Pertahankan `MONGODB_URI` dan `DATABASE_NAME` existing. Periksa target database secara privat.
3. Jalankan `npm.cmd run build`, kemudian `npm.cmd run migrate:tenants` untuk dry-run.
4. Tinjau jumlah dokumen dan rencana index. Setelah operator menyetujui perubahan database, jalankan `npm.cmd run migrate:tenants -- --apply`.
5. Jalankan ulang dry-run, isi environment rental, kemudian mulai aplikasi.

Untuk instalasi database kosong, perintah migrasi yang sama membuat koleksi dan index. Jangan menjalankan source versi lama pada database yang sudah dipakai beberapa tenant: query lama tidak mempunyai isolasi tenant. Rollback sebelum menerima transaksi baru dapat memakai snapshot penuh pra-migrasi dan versi source lama. Setelah ada aktivitas tenant baru, gunakan perbaikan maju atau prosedur restore/reconciliation operator; tidak disediakan rollback otomatis yang membuang data tenant.

ZIP backup/rollback existing tetap berfungsi untuk data tenant platform dan menolak dokumen tenant asing sebelum penghapusan. ZIP ini **bukan backup seluruh SaaS**. Backup seluruh SaaS harus mencakup semua koleksi baru, data semua tenant, dan salinan aman kunci enkripsi.

## Environment dan menjalankan

| Variable | Pemakaian |
| --- | --- |
| `RENTAL_ENABLED` | `true` menyalakan rental, scheduler, serta `/sewa` dan entri self-service di Catalog bot platform; default `false` hanya platform. Migrasi tetap diperlukan untuk versi source ini. |
| `CREDENTIAL_ENCRYPTION_KEY` | 32 byte acak sebagai 64 karakter hex atau base64; wajib untuk token dan credential rental. |
| `RENTAL_BOT_TOKEN` | Input privat sementara untuk CLI provisioning darurat; setup normal dilakukan melalui menu `/rental` pada main bot. |
| `RENTAL_WEBHOOK_PORT` | Default `0`: tidak membuka HTTP listener. Nilai lain membuka listener loopback untuk relay opsional. |
| `RENTAL_WEBHOOK_SECRET` | Secret relay HMAC minimal 32 karakter jika HTTP diaktifkan. |

`BOT_TOKEN`, `ADMIN_ID`, MongoDB dan environment fitur platform existing tetap dipakai. `GOPAY_MERCHANT_ID`, QRIS platform serta `GOJEK_EMAIL`/`GOBIZ_EMAIL` dan password terkait dipakai **hanya oleh payment platform**. Renter tanpa konfigurasi merchant tidak mendapat fallback ke payment platform. Invoice platform ditolak jika konfigurasi login merchant belum tersedia.

Enkripsi menggunakan AES-256-GCM dengan IV acak per nilai, tag autentikasi, dan AAD yang terikat pada tenant serta jenis credential. Jangan mengganti kunci secara langsung; backup kunci terpisah diperlukan untuk recovery. Token bot, QRIS payload renter, email/password merchant, client secret dan access token renter disimpan terenkripsi. Field IMAP/Cloudflare **platform existing** masih mengikuti penyimpanan lama; perubahan ini tidak memigrasikan credential internal tersebut.

```powershell
npm.cmd run build
npm.cmd start
# Pengembangan:
npm.cmd run dev
# Bantuan provisioning:
npm.cmd run rental:admin -- help
```

Admin membuat paket dan dapat memprovision rental melalui `/rental`. Pengguna menyewa otomatis dari bot platform melalui `/sewa` atau **Catalog → 🤖 Sewa Bot Otomatis**; CLI tetap tersedia sebagai jalur pemulihan. Detail input ada di [panduan operasi](RENTAL_OPERATIONS.md). Tidak ada harga yang di-hardcode pada handler `/renew` atau `/sewa`. Semua rental `pending` tetap offline sampai settlement atau aktivasi operator. Rental `active`, `expired_grace`, dan `suspended` dijalankan; rental `terminated` dihentikan. Grace berakhir tepat 24 jam setelah expiry; scheduler menyinkronkan database dan reminder setiap sekitar 60 detik, sementara middleware memeriksa waktu expiry dari cache pada setiap update.

Shutdown menghentikan penerimaan pekerjaan baru, menunggu startup yang masih berjalan, menghentikan scheduler/relay/backup, semua runner, polling finansial, WhatsApp, IMAP, browser receipt, lalu koneksi MongoDB. Polling tenant dilacak dan didrain, termasuk follow-up yang dibuat saat poll sebelumnya menyelesaikan pekerjaan. Kegagalan satu bot ditangani per instance; scheduler mencoba menyalakannya kembali pada tick berikutnya. Log rental menambahkan identitas tenant dan tidak menyerialisasi object error HTTP/payload dari plugin lama.

## Pembayaran dan webhook

GoPay existing menggunakan **polling settlement**, bukan webhook native yang diasumsikan tersedia. Renewal menggunakan polling scheduler dan tombol Cek Pembayaran. Merchant ID, QRIS, status settlement, nominal dan waktu dibuktikan oleh transaksi provider; tenant/rental/durasi ditentukan dari invoice server. Update expiry dan receipt ID pembayaran pada `BotRental` bersifat atomik; crash sebelum ledger ditandai paid dapat dipulihkan tanpa menambah durasi kedua kali.

Satu rental memakai satu invoice pending aktif agar klik berulang tidak mengambil seluruh slot nominal. Jika memilih paket berbeda saat invoice lama masih berlaku, bot menjelaskan bahwa invoice sebelumnya harus diselesaikan atau ditunggu hingga kedaluwarsa. Invoice berlaku 15 menit; ada tambahan lima menit untuk menunggu indexing provider, dengan waktu transfer tetap harus berada dalam window invoice asli. Transfer di luar window atau ke merchant yang berubah memerlukan rekonsiliasi operator.

Endpoint opsional: `POST /webhooks/rental-payment`, JSON `{ "providerReference": "referensi-invoice-server" }`. Ini adapter untuk **relay tepercaya**, bukan implementasi kontrak webhook resmi GoPay. Header `x-rental-timestamp` berisi epoch milliseconds (epoch seconds juga diterima), dan `x-rental-signature` berisi hex HMAC-SHA256 dari `timestamp + "." + rawBody` memakai secret relay. Timestamp maksimum berbeda lima menit; payload dibatasi 4 KB. Handler tetap mengambil invoice tersimpan dan mengecek settlement merchant platform. Field tenant/rental/amount/status dari body tidak dipercaya. Pengiriman berulang memakai jalur idempotensi yang sama.

Listener hanya bind `127.0.0.1`. Jika memakai relay eksternal, operator menyediakan reverse proxy HTTPS dan secret relay. Tanpa relay, biarkan port `0`; renewal otomatis tetap berjalan.

## Validasi dan batas yang masih berlaku

Hasil validasi lokal pada 7 September 2026 setelah setup rental dipindahkan ke main bot: build TypeScript berhasil, seluruh **67 tests lulus dengan 0 gagal dan 0 skip**, serta `git diff --check` berhasil. Integration tests dijalankan dengan MongoDB 7.0.14 sementara pada loopback; tidak memakai database aplikasi. Tidak ada dependency produksi baru atau perubahan lockfile.

`npm.cmd run build` memeriksa seluruh source TypeScript. `npm.cmd test` menjalankan tests dari hasil build. Integration tests hanya menerima URI MongoDB loopback melalui `TEST_MONGODB_URI` dan `PAYMENT_TEST_MONGODB_URI`, membuat database acak khusus test, kemudian menghapus database itu saja. Tanpa variable test tersebut, integration tests ditandai skip. Jangan isi variable test dengan database aplikasi.

```powershell
# Gunakan MongoDB disposable khusus test, bukan instance data aplikasi.
$env:TEST_MONGODB_URI = 'mongodb://127.0.0.1:PORT_TEST/'
$env:PAYMENT_TEST_MONGODB_URI = $env:TEST_MONGODB_URI
npm.cmd run build
npm.cmd test
```

Pengujian mencakup dua runner dengan token mock dalam satu proses, isolasi tenant/query/cache, tenant ownership, callback invoice pelanggan, migrasi dry-run dan apply berulang, credential/auth merchant terpisah, reservasi nominal concurrent, duplicate payment/webhook, crash-retry renewal, expiry/grace/suspended, reminder, gating dan shutdown timer. Telegram dan GoPay dimock; akses produksi, pengiriman pesan live, pembayaran nyata, deploy, push dan migrasi produksi tidak dijalankan.

Batas operasional:

- Jalankan satu proses aplikasi. Horizontal scaling memerlukan lease bot, koordinasi restart dan penjadwalan antar proses sebelum PM2 cluster diaktifkan.
- Store order/stock/balance existing dipertahankan. Alur kredit saldo dan fulfillment toko masih terdiri dari beberapa write terpisah; crash di antaranya memerlukan rekonsiliasi operator. Klaim payment persisten mencegah replay, tetapi bukan transaksi atomik untuk seluruh fulfillment toko. Pemulihan invoice toko setelah restart masih mengikuti mekanisme existing/manual check.
- Reminder memakai klaim sebelum pengiriman agar tidak duplicate; kegagalan Telegram yang tidak pasti dapat menyebabkan satu reminder tidak terkirim.
- `storeId` disiapkan dalam konfigurasi; endpoint GoPay existing memilih settlement berdasarkan merchant ID. Dukungan filtering store khusus memerlukan kontrak provider tambahan.
- Secret platform IMAP/Cloudflare existing belum dimigrasikan ke enkripsi, dan backup lama mungkin menyimpannya dalam format lama. Kunci/token/payment renter baru memakai enkripsi.
- Audit `npm audit --omit=dev` menemukan 4 temuan dependency existing (3 high pada rantai `mailparser` → `html-to-text` → `deepmerge-ts`, 1 moderate pada `qs`). Tidak ada upgrade dependency atau perubahan lockfile dalam refactor ini. Perlu tindak lanjut dependency sebelum rilis produksi.
- Tidak tersedia script lint/E2E browser; bot tidak memiliki UI browser baru. Smoke test Telegram/merchant nyata tetap diperlukan sesuai panduan operasi.

## Inventaris perubahan

Daftar file yang dibuat dan diubah pada implementasi ini tercantum di [RENTAL_FILES.md](RENTAL_FILES.md).
