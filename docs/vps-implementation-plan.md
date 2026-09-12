# Implementasi VPS DigitalOcean

Spesifikasi: permintaan pengguna 12 September 2026; main bot saja, pembayaran saldo/QRIS, token toko terenkripsi, token buyer hanya memori, instalasi mengikuti `isinya-testing/vps.js`.

Urutan pekerjaan dan batas verifikasi:
1. Model order/snapshot/harga/credential dan kontrak client DO/installer; uji pagination, klasifikasi error, secret dan OS.
2. Ledger pembayaran dan efek saldo atomik, reservasi kapasitas per team serta penanda create sebelum POST; uji duplikasi dan pemulihan.
3. Worker tahap persisten, input token sementara, instalasi dan reboot; uji lease, timeout dan kepemilikan.
4. Plugin buyer/admin, catalog, startup, index/migrasi dan backup; uji handler mock.
5. Build, seluruh tes, audit dependensi/diff dan dokumentasi operasional.

Tidak ada token nyata, droplet berbayar, deployment atau migrasi database produksi dalam pengujian. Installer remote dan login Windows hanya dapat dinyatakan terverifikasi setelah bukti runtime di lingkungan yang diotorisasi.
