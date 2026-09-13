# Katalog Jasa Install & VPS DO

Menu memakai satu spek per entri katalog, bukan paket bernama bebas. Defaultnya 7 spek Basic, 16 region, 14 OS Linux, dan Windows Server 2012 R2/2016/2019/2022 yang sudah ada pada installer. OS Windows membuat VPS bootstrap Ubuntu sebelum instalasi; alur VPS milik buyer hanya menawarkan Windows.

Di `/vpsadmin`, pilih **Harga per spek / region / OS**, pilih layanan dan spek, region, kemudian OS. Harga Rupiah berlaku hanya pada kombinasi tersebut. Semua pilihan tetap tampil ketika harga belum diatur, tetapi checkout ditolak sampai harganya terisi. Label dolar bulanan dari daftar spek hanya referensi biaya DigitalOcean, bukan harga jual atau jasa install.

Menu **Katalog OS/region/spek** menerima tambahan satu field per pesan. Entri baru langsung ditampilkan dalam menu; tidak perlu membuat paket bernama atau menyalin semua kombinasi. Harga dan status tersimpan di `vpsplans`; pilihan katalog tersimpan di `vpscatalogs`. Order lama tetap memakai snapshot checkout.

## Penggantian paket lama

`npm.cmd run vps:reset-catalog` hanya memeriksa database dari `.env` dan menampilkan fingerprint konfigurasi. Untuk reset yang sudah disetujui operator:

```powershell
npm.cmd run vps:reset-catalog -- --apply --expect FINGERPRINT_DARI_DRY_RUN
```

Reset menyimpan salinan konfigurasi lama dalam `vpscatalogresetbackups`, mengganti katalog dengan default, memasukkan 14 entri spek (7 per layanan) tanpa harga, lalu menghapus ID paket lama yang telah diperiksa. Tidak ada penghapusan order, wallet, token, atau resource DigitalOcean. Transaksi Mongo digunakan jika tersedia. Reset tidak dijalankan otomatis saat startup dan mengosongkan harga bila sengaja dijalankan lagi.

Untuk pemulihan, pilih backupId yang tercetak setelah reset dan tinjau `plans` serta `catalog` dalam koleksi backup secara privat. Hentikan perubahan harga selama restore, lalu pulihkan hanya konfigurasi tersebut; jangan memulihkan order/payment sebagai bagian dari reset katalog.

Sesudah source diperbarui, build dan jalankan ulang proses bot dari versi tersebut. Penggantian data database berlaku langsung pada pembacaan baru, tetapi proses yang masih menjalankan versi lama belum memiliki UI harga/OS baru.
