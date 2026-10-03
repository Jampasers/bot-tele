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

## Recovery error registry startup Windows

Jika log berhenti di `Registering LocalGPO startup bootstrap` dengan
`reg_import: cannot create ...\Scripts\Startup\0 since parent ... does not exist`,
installer lama belum membuat key induk SOFTWARE secara berurutan. Generator yang
baru membuat semua induk lebih dahulu dan meng-escape backslash pada nilai path
Windows agar `hivexregedit` tidak mengubah `C:\windows-fix-rdp.bat` menjadi path
tanpa separator. Impor berulang mempertahankan nilai induk dan key lain.

Update dan build bot berlaku untuk instalasi baru. Pada VPS yang sudah berada
di Alpine, `/trans.sh` adalah salinan lama di RAM. Jalankan perbaikan berikut
melalui console VPS setelah proses installer berhenti:

```sh
apk add python3 wget
wget -O /tmp/repair-windows-gpo.py https://raw.githubusercontent.com/Jampasers/bot-tele/main/scripts/repair-windows-gpo.py
python3 /tmp/repair-windows-gpo.py /trans.sh && /trans.sh
```

Script recovery hanya mengganti payload registry GPO di `/trans.sh`, membuat
backup `/trans.sh.bot-tele-gpo.bak`, dan menolak script yang tidak memiliki satu
blok GPO bot-tele yang dikenali. Script ini tidak menjalankan installer atau
reboot. Perintah `/trans.sh` terakhir mengulangi instalasi: image di-download dan
ditulis ulang ke disk VPS yang sama. Jangan menggunakan `/trans.sh update`,
karena opsi upstream tersebut mengganti script dengan versi tanpa patch bot.
