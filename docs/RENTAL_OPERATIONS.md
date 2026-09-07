# Operasi Telegram Bot Rental

Satu proses Node menjalankan bot platform dan banyak bot rental. Setiap rental mempunyai `tenantId`, owner Telegram ID, token terenkripsi, konfigurasi toko, dan konfigurasi payment sendiri. Perintah di bawah dijalankan operator platform; jangan mengarahkannya ke database produksi tanpa izin operasional dan backup yang diperlukan.

## Menyiapkan paket dan rental

Pastikan `RENTAL_ENABLED=true` dan `CREDENTIAL_ENCRYPTION_KEY` sudah diisi, lalu restart aplikasi. Admin perlu membuat minimal satu paket aktif melalui `/admin` → **Kelola Bot Rental** atau `/rental` di chat pribadi bot platform.

### Sewa otomatis dari bot platform

Pengguna biasa dapat menyewa tanpa bantuan admin melalui **Catalog → 🤖 Sewa Bot Otomatis** atau command `/sewa` di chat pribadi bot platform.

1. Pengguna memilih salah satu paket yang masih aktif.
2. Bot meminta token baru dari BotFather yang khusus dipakai untuk rental tersebut. Token bot platform atau token bot yang sudah terdaftar tidak dapat digunakan.
3. Pengguna mengirim token di chat pribadi. Pesan token harus berhasil dihapus oleh bot sebelum token dibaca, diverifikasi ke Telegram, dan disimpan terenkripsi. Jika penghapusan gagal, proses dibatalkan dan token tidak diproses.
4. Bot membuat rental berstatus `pending`, lalu memotong harga paket dari saldo user pada main bot.
5. Jika saldo cukup, masa aktif diterapkan satu kali, status menjadi `active`, lalu instance bot rental dimulai otomatis.
6. Jika saldo kurang, bot menawarkan invoice QRIS platform bila payment platform sudah dikonfigurasi. Jika belum, user cukup top up saldo main bot dan membuka `/sewa` kembali.

Satu Telegram owner hanya dapat membuat satu rental yang belum `terminated` melalui alur otomatis. Jika memerlukan lebih dari satu bot, admin platform dapat membuatnya melalui panel `/rental`; `/sewa` akan memprioritaskan rental `pending` satu per satu, sedangkan bot yang sudah aktif dapat diperpanjang melalui `/renew` pada bot masing-masing. Token harus berasal dari bot BotFather baru yang tidak dipakai oleh proses lain; jangan kirim token melalui grup, tiket, atau log.

### Provisioning oleh admin platform

1. Pilih **Tambah Paket**, lalu kirim `kode | durasi_hari | harga | nama | fitur`.
2. Pilih **Tambah Rental**, lalu kirim `OWNER_ID | KODE_PAKET | BOT_TOKEN | ADMIN_ID1,ADMIN_ID2 | pending`.
3. Admin tambahan boleh diisi `-`. Gunakan status `pending` agar owner membuat invoice awal lewat `/sewa` pada bot platform, atau `active` untuk memberi masa aktif awal sesuai paket.
4. Pesan token harus berhasil dihapus oleh bot sebelum diproses. Token diverifikasi ke Telegram dan disimpan terenkripsi. Rental `active` langsung dijalankan; rental `pending` tetap offline sampai pembayaran terkonfirmasi.

Menu yang sama menampilkan maksimal 30 paket dan rental terbaru. Provisioning hanya tersedia pada bot platform dan hanya melalui chat pribadi admin numerik dari `ADMIN_ID`.

CLI berikut tetap tersedia sebagai jalur pemulihan operator jika main bot tidak dapat digunakan.

Build terlebih dahulu dengan `npm.cmd run build`. CLI memuat environment server dari `.env`; token renter hanya dibaca dari `RENTAL_BOT_TOKEN`, bukan argumen command line. `BOT_TOKEN` platform diperlukan agar bot platform tidak dapat didaftarkan sebagai rental. Jangan memasukkan token ke source, log, tiket, atau riwayat command yang dibagikan.

CLI bersifat dry-run sampai ditambah `--apply`. `--apply` membuat/memperbarui data dan memastikan index unik pada model yang bersangkutan. Jalankan migrasi tenant sesuai panduan deployment sebelum memakai database existing.

```powershell
node dist/scripts/rentalAdmin.js help

# Contoh harga; operator bebas mengubah harga, nama, dan durasi.
node dist/scripts/rentalAdmin.js plan weekly 7 10000 "7 Hari" --features digital,affiliate
node dist/scripts/rentalAdmin.js plan weekly 7 10000 "7 Hari" --features digital,affiliate --apply
node dist/scripts/rentalAdmin.js plan monthly 30 25000 "30 Hari" --features digital,affiliate --apply
node dist/scripts/rentalAdmin.js plan quarterly 90 70000 "90 Hari" --features digital,affiliate --apply

# Set RENTAL_BOT_TOKEN secara privat pada environment sesi sebelum perintah ini.
node dist/scripts/rentalAdmin.js create 123456789 monthly
node dist/scripts/rentalAdmin.js create 123456789 monthly --apply
node dist/scripts/rentalAdmin.js list
```

Rental yang dibuat melalui CLI berstatus `pending`. Jalur darurat ini mengikuti provisioning operator; alur otomatis pengguna menerbitkan invoice pada bot platform dan menahan bot rental tetap offline sampai pembayaran berhasil. Jangan memulai proses Node tambahan untuk token yang sama.

`create ... --active --apply` secara eksplisit memberi masa aktif awal sesuai paket tanpa invoice. Gunakan hanya jika operator memang memberikan aktivasi awal. `--admins 111111111,222222222` menambahkan admin berdasarkan ID Telegram. Owner dan admin dapat mengelola rental; username tidak digunakan sebagai dasar otorisasi.

Paket dapat diperbarui dengan command `plan` dan `code` yang sama. `--disabled` menonaktifkan penjualan paket. Fitur rental yang didukung CLI: `digital`, `affiliate`, `totp`. SMSBower, IMAP, WhatsApp, serta admin internal platform tidak dapat dimasukkan ke paket rental. Hindari menghapus dokumen paket yang sudah direferensikan invoice; nonaktifkan paket untuk menghentikan penjualan baru.

CLI mencetak rental ID, tenant ID, username bot, status, dan masa aktif; credential dan owner ID tidak dicetak.

## Pengaturan renter dari bot

Owner/admin menggunakan chat pribadi dengan bot rental:

- `/admin` atau `/settings`: menu pengaturan bot, produk/stok, statistik, payment, fitur, masa aktif, dan restart.
- `/digiadmin`: pengelolaan produk, stok, dan garansi existing.
- `/stats`: pengguna, produk, stok, dan pendapatan produk untuk tenant tersebut.
- `/status`: status dan waktu berakhir layanan dalam WIB.
- `/renew`: pilihan paket dan invoice QRIS platform.
- `/restart`: restart instance bot tersebut. Respons dikirim sebelum runner dihentikan.
- `/payment`: ringkasan konfigurasi payment toko dan contoh input.

Renter menyimpan konfigurasi payment melalui `/setpayment` di chat pribadi. Contoh berikut berisi placeholder:

```text
/setpayment {"qris":{"enabled":true,"payload":"PAYLOAD_QRIS_TOKO"},"gopayMerchant":{"enabled":true,"merchantId":"ID_MERCHANT_TOKO","email":"EMAIL_TOKO","password":"PASSWORD_TOKO"}}
```

Input mengganti seluruh konfigurasi payment toko. Bot menghapus pesan credential sebelum menyimpannya; jika pesan tidak dapat dihapus, penyimpanan dibatalkan. Jangan mengirim credential melalui grup. Field opsional merchant: `clientId`, `clientSecret`, `storeId`, dan `accessToken`; konfigurasi tanpa email/password dapat memakai `accessToken`. Sistem menolak perubahan ketika invoice/reservasi toko masih aktif, agar invoice yang sudah dikirim tetap memakai merchant asal.

Untuk JSON besar, operator dapat menyimpan konfigurasi dari file lokal privat melalui CLI:

```powershell
node dist/scripts/rentalAdmin.js payment RENTAL_ID "C:\private\tenant-payment.json"
node dist/scripts/rentalAdmin.js payment RENTAL_ID "C:\private\tenant-payment.json" --apply
```

Dry-run command payment hanya memeriksa JSON dan rental, tanpa menulis atau memverifikasi credential ke provider. `--apply` menjalankan validasi service dan enkripsi. Field `qris.image` dapat berupa PNG/JPEG data URI sebagai alternatif payload. Path/URL gambar arbitrer tidak diterima sebagai konfigurasi QRIS. Jaga file input tetap privat dan gunakan mekanisme penyimpanan credential yang dikelola operator.

Konfigurasi toko lain memakai whitelist `/setshop`:

```text
/setshop forceSubChannel @channel_toko
/setshop forceSubLink https://t.me/channel_toko
/setshop forceSubName Channel Toko
/setshop testimonialChannel @testimoni_toko
/setshop testimonialLink https://t.me/testimoni_toko
/setshop logChannel @log_toko
/setshop logChannelLink https://t.me/log_toko
/setshop maintenanceMessage Toko sedang pemeliharaan. Silakan coba kembali nanti.
/setaffiliate percentage 5
```

Toggle maintenance, wajib join, testimoni, log, dan afiliasi tersedia melalui menu Pengaturan Toko. Channel tujuan harus diisi sebelum fitur channel diaktifkan. Bot harus mempunyai izin Telegram yang sesuai pada channel. Pengaturan IMAP, SMSBower, Cloudflare internal, credential platform, dan rollback database global tidak tersedia dalam admin rental.

## Expired, grace, suspended, dan reminder

Middleware membaca cache runtime dan membandingkan waktu berakhir dengan waktu saat ini pada setiap update. Fitur bisnis langsung ditolak setelah expiry, meskipun tick scheduler berikutnya belum berjalan. Scheduler menyinkronkan status database setiap sekitar 60 detik.

| Status | Perilaku |
| --- | --- |
| `pending` | Bot tetap offline sampai invoice platform lunas atau operator memberi aktivasi awal. Owner membuat invoice awal lewat `/sewa` pada bot platform. |
| `active` | Fitur toko berjalan sesuai paket dan konfigurasi tenant. |
| `expired_grace` | Bot online, bisnis dikunci, grace berakhir tepat `expiresAt + 24 jam`. |
| `suspended` | Bot online, bisnis dikunci, `/renew` tetap dapat digunakan. |
| `terminated` | Runtime dihentikan ketika scheduler melihat status ini. |

Saat status `expired_grace` atau `suspended`, owner/admin tetap dapat memakai `/start`, `/renew`, `/status`, `/help`, dan tombol renewal. Rental `pending` diaktifkan dari bot platform melalui `/sewa` karena instance belum berjalan. Perintah bisnis dan callback lama menampilkan warning serta tombol perpanjangan. Customer mendapat pesan layanan tidak aktif. Renewal/payment settings/status hanya diperbolehkan pada chat pribadi owner/admin.

Reminder dikirim kepada owner di bot rental pada H-3, H-1, expiry, +1, +3, +6, +12, +18, +23, dan +24 jam. Owner harus sudah memulai chat dengan bot agar Telegram mengizinkan pengiriman. State milestone disimpan dalam `BotRental`; restart server tidak mengulang milestone yang sudah diklaim. Setelah downtime, satu pesan terbaru mewakili milestone yang terlewat. Tidak ada spam setiap menit.

Telegram tidak menyediakan idempotency key untuk `sendMessage`. Marker diklaim sebelum pengiriman; jika respons pengiriman tidak pasti, marker dipertahankan untuk menghindari pesan duplikat. Akibatnya satu reminder bisa tidak diterima saat terjadi kegagalan Telegram; lihat warning `Expiry alert delivery failed` dan panel `/status`. Renewal sukses mereset milestone untuk masa aktif baru.

## Renewal dan pemisahan pembayaran

Transaksi customer memakai QRIS/GoPay tenant. Aktivasi awal melalui `/sewa` memakai saldo main bot lebih dulu. Invoice QRIS platform menjadi cadangan ketika saldo kurang, sedangkan invoice `/renew` pada bot rental tetap dibuat lewat payment platform dan dicatat di `RentalPayment`, terpisah dari `TopupSession` toko. Nominal, durasi, rental, dan provider reference berasal dari invoice tersimpan.

Pembayaran diperiksa otomatis oleh scheduler dan dapat diperiksa lewat tombol Cek Pembayaran. Status `processing` berarti penyelesaian invoice sedang dipulihkan/diproses. Setelah berhasil, rental diaktifkan dan cache diperbarui. Untuk sewa awal dari bot platform, instance rental yang sebelumnya offline juga dimulai otomatis.

Masa aktif baru dihitung dari `max(expiresAt lama, waktu pembayaran diproses) + durationDays`. Renewal sebelum expiry menambah sisa masa aktif. Penerapan expiry dan receipt ID pembayaran memakai satu update atomik rental; pemeriksaan ulang invoice atau pemulihan sesudah crash tidak menambah durasi dua kali.

## Pengujian operator

Tes otomatis yang tidak memakai token bot nyata:

```powershell
npm.cmd run build
node --test dist/rental/rental.lifecycle.test.js dist/runtime/RentalScheduler.test.js
```

Tes tersebut meliputi batas expiry/grace tepat 24 jam, penambahan masa aktif, jadwal reminder, owner/admin allowlist, penolakan customer/group, command target bot, kebocoran fitur internal melalui CLI, whitelist pengaturan toko, error satu rental, tick scheduler yang tumpang tindih, dan drain scheduler saat shutdown.

Smoke test live harus memakai database uji terisolasi, dua bot BotFather uji, merchant uji yang dikelola operator, dan nilai transaksi kecil yang disetujui operator:

1. Buat dua rental A/B dengan owner berbeda. Jalankan satu aplikasi Node. Pastikan kedua bot merespons `/start`; bot platform tetap berjalan.
2. Beri A dan B masa aktif uji melalui provisioning `--active`. Buat produk/stok yang berbeda. Buka bot A dan B menggunakan Telegram customer yang sama: user balance, katalog, stok, pesanan, affiliate, pengaturan, dan invoice harus terpisah.
3. Simpan payment A/B yang berbeda. Buat invoice customer pada setiap bot. Pastikan QRIS/merchant tujuan sesuai toko, sedangkan `/renew` pada kedua bot mengarah ke platform.
4. Pada fixture database uji saja, set `expiresAt` A ke dua menit mendatang dan status `active`. Tunggu satu tick agar cache memuat expiry baru, lalu tunggu waktu expiry tercapai. Tindakan bisnis A harus langsung ditolak tanpa menunggu tick berikutnya; owner masih dapat `/renew`. Dalam tick berikutnya database menjadi `expired_grace`, dengan `graceEndsAt = expiresAt + 24 jam`. Perubahan langsung pada database baru terlihat oleh cache saat scheduler menyinkronkannya.
5. Pada fixture A, set expiry ke lebih dari 24 jam sebelumnya. Tunggu satu tick: status menjadi `suspended`, polling tetap hidup, owner masih dapat `/renew`, bisnis tetap ditolak. B harus tetap berjalan normal.
6. Bayar invoice renewal A ke QRIS platform, tunggu settlement atau tekan Cek Pembayaran. A menjadi `active`, grace dikosongkan, dan pembelian tersedia kembali. Periksa invoice yang sama beberapa kali; expiry harus tetap sama. Ulangi renewal sebelum expiry dan pastikan sisa masa aktif ditambahkan.
7. Tempatkan expiry fixture pada batas H-3/H-1/+1 jam, lalu tunggu tick. Pastikan reminder hanya ke owner rental yang sesuai. Restart aplikasi: milestone yang sudah diklaim tidak dikirim ulang.
8. Putuskan/revoke token A pada lingkungan uji. B dan platform harus tetap melayani update. Pulihkan token dengan prosedur operator, lalu restart instance A.
9. Hentikan Node secara normal. Scheduler selesai, seluruh runner berhenti, lalu koneksi database ditutup; tidak ada instance polling tersisa.

Untuk alur sewa otomatis, lakukan smoke test tambahan memakai owner dengan saldo cukup dan bot BotFather uji: buka `/sewa`, pilih paket, kirim token di chat pribadi, pastikan pesan token terhapus, saldo berkurang satu kali, lalu bot aktif otomatis. Ulangi proses pemulihan `/sewa` dan pastikan saldo maupun masa aktif tidak diterapkan dua kali. Untuk cadangan QRIS, gunakan owner dengan saldo kurang, selesaikan invoice uji, lalu pastikan scheduler atau tombol **Cek Pembayaran** mengaktifkan bot tepat satu kali. Ulangi `/sewa` dengan owner yang sama dan pastikan rental kedua ditolak.

Tes lokal tidak membuktikan token, izin channel, QRIS, credential merchant, konektivitas Telegram, atau settlement nyata bekerja. Validasi tersebut membutuhkan smoke test terkontrol di lingkungan operator.
