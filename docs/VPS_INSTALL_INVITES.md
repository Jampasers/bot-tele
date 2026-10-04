# Undangan Jasa Install Gratis

Buka `/vpsadmin` → **Undangan Jasa Install Gratis** → **Buat undangan gratis**.
Pilih **Semua Installer (VPS Buyer + DO)** agar penerima bisa memilih Install
VPS Buyer via SSH atau Install dari DO. Pilih **Tanpa batas waktu** agar undangan
tidak kedaluwarsa. Batas 1, 7, atau 30 hari dan satu sumber VPS juga tersedia.
Kirim Telegram ID penerima, atau `-` untuk link yang bisa
diklaim satu orang. Bagikan link yang dibuat bot. Daftar undangan menampilkan
status dan menyediakan tombol **Cabut undangan** sebelum digunakan.

User membuka link, menekan **Buka undangan gratis**, memilih sumber VPS,
spek/region/OS dan opsi Chrome seperti order biasa. Harga jasa tampil gratis.
Setelah checkout, user menekan **Mulai install gratis** untuk menjalankan
instalasi. Biaya VPS/DigitalOcean tetap ditanggung user. Undangan berlaku untuk
Jasa Install saja, mengikuti harga yang sudah tersedia dan aturan disable
katalog; tidak dapat dipakai untuk membeli VPS dari akun toko.

Satu link terikat ke satu user saat diklaim dan satu ID order sejak dibuat.
Membuka ulang link mengarah ke order yang sama. Bot restart tidak menghapus
undangan; token DO tetap sementara sehingga user mungkin perlu mengirim ulang.
Link kedaluwarsa atau dicabut tidak dapat memulai instalasi baru. Undangan
yang sudah digunakan tidak bisa dicabut, dan order yang telah aktif tetap jalan.
Untuk melihat order lama gunakan Riwayat Pesanan jika link sudah kedaluwarsa.
Undangan tanpa batas waktu tetap bisa dicabut sebelum digunakan dan tetap untuk
satu order. Undangan lama dengan tanggal kedaluwarsa mempertahankan tanggalnya.

Aktivasi memakai status payment `paid` dan worker/log/testimoni/struk yang sama
dengan order biasa, dengan metode **Undangan Gratis** dan nominal transaksi
Rp0. Harga normal disimpan dalam snapshot dan dicantumkan pada audit admin.
Statistik menghitung order gratis sebagai order, dengan omzet Rp0.
Saldo tidak dipotong, invoice QRIS tidak dibuat, pembatalan/refund tidak
menambah saldo, dan undangan tidak kembali menjadi link untuk order lain.

Koleksi `vpsinstallinvites` disertakan pada backup platform sebagai export-only,
seperti order VPS, supaya rollback tidak membuka kembali undangan yang telah
digunakan. Tidak ada konfigurasi environment atau paket tambahan.
