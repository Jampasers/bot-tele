# Undangan Jasa Install Gratis

Buka `/vpsadmin` → **Undangan Jasa Install Gratis** → **Buat undangan gratis**.
Pilih **Semua Installer (VPS Buyer + DO)** agar penerima bisa memilih Install
VPS Buyer via SSH atau Install dari DO. Pilih **Tanpa batas waktu** agar undangan
tidak kedaluwarsa. Batas 1, 7, atau 30 hari dan satu sumber VPS juga tersedia.
Kirim Telegram ID penerima, atau `-` untuk link yang bisa
diklaim satu orang. Bagikan link yang dibuat bot. Daftar undangan menampilkan
status dan menyediakan tombol **Cabut akses gratis** kapan saja, termasuk setelah
digunakan.

User membuka link, menekan **Buka undangan gratis**, memilih sumber VPS,
spek/region/OS untuk DO, atau langsung Windows dan akses SSH untuk VPS Buyer,
serta opsi Chrome seperti order biasa. Harga jasa tampil gratis.
Setelah checkout, user menekan **Mulai install gratis** untuk menjalankan
instalasi. Biaya VPS/DigitalOcean tetap ditanggung user. Undangan berlaku untuk
Jasa Install saja, mengikuti harga yang sudah tersedia dan aturan disable
katalog; tidak dapat dipakai untuk membeli VPS dari akun toko.

Satu link terikat ke satu user saat diklaim. User bisa membuat order install
gratis berulang selama undangan aktif; setiap checkout baru memiliki ID order
sendiri. Membuka ulang link menawarkan pilihan sumber VPS untuk install baru.
Riwayat Pesanan tetap menyediakan akses ke setiap order sebelumnya. Bot restart
tidak menghapus undangan. Setelah diklaim, membuka menu Jasa Install biasa
otomatis memakai undangan aktif yang sesuai sumber VPS, termasuk yang sudah
pernah dipakai. User tidak perlu membuka link lagi setelah kembali ke menu atau
bot restart. Menu juga menyediakan **Lanjut undangan gratis**; setiap sesi
checkout memakai ID order baru, dengan retry pada sesi yang sama tetap idempoten.
Token DO tetap sementara sehingga user mungkin perlu mengirim ulang.
Link kedaluwarsa atau dicabut tidak dapat memulai instalasi baru. Undangan
bisa dicabut lewat **Cabut akses gratis** kapan saja. Order yang telah diaktifkan
tetap jalan; order yang belum diaktifkan tidak dapat dimulai gratis setelah akses
dicabut.
Untuk melihat order lama gunakan Riwayat Pesanan jika link sudah kedaluwarsa.
Undangan tanpa batas waktu tetap bisa dicabut setelah digunakan. Undangan lama
dengan tanggal kedaluwarsa mempertahankan tanggalnya.

Aktivasi memakai status payment `paid` dan worker/log/testimoni/struk yang sama
dengan order biasa, dengan metode **Undangan Gratis** dan nominal transaksi
Rp0. Harga normal disimpan dalam snapshot dan dicantumkan pada audit admin.
Statistik menghitung order gratis sebagai order, dengan omzet Rp0.
Saldo tidak dipotong, invoice QRIS tidak dibuat, pembatalan/refund tidak
menambah saldo. Pembatalan order tidak mencabut undangan; akses tetap dapat
dipakai lagi sampai admin mencabutnya atau masa berlakunya habis.

Koleksi `vpsinstallinvites` disertakan pada backup platform sebagai export-only,
seperti order VPS, supaya rollback tidak membatalkan klaim atau pencabutan
undangan. Tidak ada konfigurasi environment atau paket tambahan.

Aktivasi gratis memiliki bukti penerimaan per order pada `installInviteAcceptedAt`,
sehingga recovery setelah restart, expiry, atau pencabutan tidak mengaktifkan order baru.
Undangan lama tetap berlaku berulang jika belum dicabut/kedaluwarsa. Receipt
aktivasi lama dipertahankan untuk pemulihan order sebelumnya tanpa migrasi manual.
