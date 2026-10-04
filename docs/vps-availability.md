# Disable spek, OS, dan region VPS

Buka `/vpsadmin` → **Ketersediaan VPS**. Pilih jenis aturan, cakupannya, lalu kirim pesan untuk buyer (1–500 karakter). Menyimpan cakupan yang sama memperbarui pesannya.

| Jenis | Pilihan cakupan |
| --- | --- |
| Spek | Satu spek untuk semua OS dan region |
| OS | Satu OS untuk semua spek, atau hanya satu spek |
| Region | Satu region untuk semua OS dan spek |
| Region | Satu region + satu OS, semua spek |
| Region | Satu region + satu spek, semua OS |
| Region | Satu region + satu OS + satu spek |

Pilihan tetap tampil. Saat buyer memilih opsi yang cocok, bot mengirim pesan disable dan tidak melanjutkan langkah tersebut. Karena alurnya spek → region → OS, aturan region dengan cakupan OS diperiksa saat OS dipilih. Cakupan yang belum dipilih tidak dianggap cocok.

Aturan berlaku lintas layanan VPS DO, DO buyer, dan install VPS buyer. Install VPS buyer memakai region `external`, sehingga tidak terkena aturan region DigitalOcean; aturan spek dan OS tetap berlaku.

Aturan tersimpan pada `VpsCatalog.disabledRules` di dokumen platform, tanpa migrasi wajib. Katalog lama yang belum punya field ini tetap aktif. Reset katalog juga menghapus aturan ini. Hanya admin bot utama di chat pribadi yang dapat mengaturnya.

Aturan dibaca ulang saat memilih, checkout, dan memulai pembayaran. Tombol/sesi lama tidak melewati aturan baru. Pembayaran yang sudah dimulai (`paying`) atau selesai tetap direkonsiliasi dan diproses; aturan tidak mematikan VPS aktif.

Jika beberapa aturan cocok, semuanya memblokir; pesan dari cakupan paling spesifik dipilih. Tombol **Aktifkan** menghapus satu aturan. Aturan lain yang cocok tetap berlaku. Pengaturan enable/disable paket lama pada menu harga tetap terpisah dan bisa menyembunyikan paket.

Pengecekan aturan dilakukan sebelum perubahan status pembayaran, bukan transaksi database bersama perubahan pengaturan admin: pembayaran yang sedang dimulai bersamaan dengan penyimpanan aturan dapat terlanjur berjalan.
