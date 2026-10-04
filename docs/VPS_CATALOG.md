# Katalog Jasa Install & VPS DO

Menu memakai satu spek per entri katalog, bukan paket bernama bebas. Defaultnya 7 spek Basic, 16 region, 14 OS Linux, serta Windows Server 2012 R2/2016/2019/2022/2025, Windows 10, Windows 10 Atlas, Windows 10 Ghost Spectre, Windows 11 Atlas, dan Windows 11 Ghost Spectre. OS Windows membuat VPS bootstrap Ubuntu sebelum instalasi; alur VPS milik buyer hanya menawarkan Windows.

Di `/vpsadmin`, pilih **Harga per spek / region / OS**, pilih layanan dan spek, region, kemudian OS. Harga Rupiah berlaku hanya pada kombinasi tersebut. Semua pilihan tetap tampil ketika harga belum diatur, tetapi checkout ditolak sampai harganya terisi. Label dolar bulanan dari daftar spek hanya referensi biaya DigitalOcean, bukan harga jual atau jasa install.

Menu **Katalog OS/region/spek** menerima tambahan satu field per pesan. Entri baru langsung ditampilkan dalam menu; tidak perlu membuat paket bernama atau menyalin semua kombinasi. Harga dan status tersimpan di `vpsplans`; pilihan katalog tersimpan di `vpscatalogs`. Order lama tetap memakai snapshot checkout.

Admin juga bisa membagikan [undangan Jasa Install gratis](VPS_INSTALL_INVITES.md)
melalui `/vpsadmin` → **Undangan Jasa Install Gratis**.

## Install ke VPS milik buyer

Install VPS Buyer langsung menawarkan Windows, lalu meminta IP, username dan
password SSH, serta opsi Chrome. Buyer tidak perlu memilih spek atau region.
Admin memakai satu layanan **Install Windows di VPS Buyer** dengan harga global
layanan atau harga khusus per Windows. Harga khusus Windows diprioritaskan.

Windows Server 2025 dan Windows 10 memakai fallback image publik installer yang
sama dengan versi Windows stock lain. Atlas/Ghost Spectre sengaja tidak memakai
image acak pihak ketiga: isi URL image DD BIOS/UEFI melalui environment
`VPS_WIN10_ATLAS_*`, `VPS_WIN10_GHOST_*`, `VPS_WIN11_ATLAS_*`, dan
`VPS_WIN11_GHOST_*`. Katalog lama disinkron secara additive saat dibaca, jadi
OS built-in baru ditambahkan tanpa reset katalog atau menghapus harga lama.

Sebelum persiapan installer, bot memeriksa kapasitas disk fisik yang menampung
OS melalui SSH. Minimum **50 GB (50.000.000.000 byte)**; bukan sisa ruang partisi
Linux, karena instalasi mengganti OS. Disk data tambahan tidak dihitung. Disk
yang sudah diperiksa diteruskan sebagai target installer. Jika kapasitas di
bawah minimum, order gagal sebelum perubahan disk dan seluruh pembayaran
dikembalikan ke saldo bot, termasuk nominal unik QRIS. Refund tetap sekali
meski worker restart. Undangan gratis ditutup tanpa kredit saldo.

Jika disk tidak dapat dibaca atau root berada pada beberapa disk, bot menahan
instalasi dan mencoba pemeriksaan ulang pada VPS yang sama. Tidak ada refund
berdasarkan ukuran yang belum terverifikasi. Pesanan lama tetap memakai
snapshot harga saat checkout dan juga diperiksa sebelum persiapan installer.

## Disable spek, OS, dan region

Buka `/vpsadmin` → **Disable Spek / OS / Region** (juga tersedia di menu katalog).
Pilih jenis dan target, tentukan cakupan, lalu kirim pesan disable maksimal 500
karakter. Kirim `-` untuk pesan bawaan. Aturan baru disimpan setelah pesan
dikirim; `/batal` membatalkan input.

| Jenis | Cakupan |
| --- | --- |
| Spek | Satu spek untuk semua OS dan region |
| OS global | Satu OS untuk semua spek dan region |
| OS per spek | Satu OS untuk satu spek, semua region |
| Region global | Satu region untuk semua OS dan spek |
| Region per OS | Satu region dan satu OS, semua spek |
| Region per spek | Satu region dan satu spek, semua OS |
| Region per OS + spek | Satu region untuk pasangan OS dan spek tertentu |

Aturan berlaku pada VPS DO dan jasa install DO buyer.
Install melalui SSH memakai disable layanan dan OS global;
aturan spek DO dan region tidak berlaku pada VPS eksternal. Cakupan global
mencakup entri katalog baru juga.

Pilihan nonaktif tetap tampil dengan tanda 🚫 dan menampilkan pesan aturan
saat dipilih. Karena region dipilih sebelum OS, aturan region yang dibatasi
pada OS tertentu diperiksa ketika OS dipilih. User bisa mengganti pilihan
tanpa membuat pembayaran. Aturan dibaca ulang saat memilih dan checkout,
termasuk dari tombol sesi lama. Backend juga memeriksa sebelum checkout,
pemotongan saldo baru, dan pembuatan invoice QRIS baru.

Buka aturan dari daftar untuk **Aktifkan kembali pilihan**, **Disable lagi**,
atau **Ubah pesan disable**. Aturan untuk target/cakupan yang sama memperbarui
aturan yang sudah ada. Bila beberapa aturan cocok, pesan paling spesifik
dipakai. Mematikan satu aturan tidak membatalkan aturan lain yang masih aktif
atau status spek nonaktif dari menu harga.

Pesanan yang sudah dibayar, invoice QRIS yang sudah terbit, dan pembayaran
saldo yang sudah dimulai tetap diselesaikan agar rekonsiliasi pembayaran
tidak terganggu. Disable mengatur pembelian baru; tidak menghapus VPS atau
membatalkan pesanan yang sedang diproses.

Konfigurasi tersimpan pada `vpscatalogs.availabilityRules` dan ikut dalam
ekspor backup katalog. Katalog lama tanpa field ini dianggap tidak memiliki
aturan; tidak perlu migrasi atau reset katalog. Build dan restart bot setelah
memperbarui source. Perubahan aturan berikutnya berlaku langsung tanpa restart.
Reset katalog yang sengaja dijalankan operator juga mengosongkan aturan disable.

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

## Windows sudah login screen tetapi RDP belum aktif dengan opsi Chrome

Jika Windows sudah menampilkan layar login setelah installer `DONE`, boot OS
sudah berhasil. Versi generator sebelum perbaikan newline Chrome menulis teks
literal `\n` ke blok CMD opsi Chrome, sehingga blok tersebut tidak menjadi
baris terpisah dan bootstrap bisa berhenti sebelum mengaktifkan RDP.

Untuk instalasi baru, update source bot, build, lalu restart proses bot.
Untuk Windows yang sudah terpasang, masuk melalui console/VNC, kirim
Ctrl+Alt+Delete dari kontrol console, lalu login sebagai Administrator dengan
password pesanan. Buka PowerShell sebagai Administrator dan jalankan:

```powershell
$ErrorActionPreference = 'Stop'
$p = 'C:\windows-fix-rdp.bat'
if (!(Test-Path "$p.bak")) { Copy-Item $p "$p.bak" }
$s = [IO.File]::ReadAllText($p)
[IO.File]::WriteAllText($p, $s.Replace('\n', [Environment]::NewLine))
cmd /d /c $p
```

Ini memperbaiki salinan batch yang telah terpasang, kemudian menjalankan ulang
bootstrap yang sama untuk network, password, Chrome, dan RDP. Keberhasilan
impor registry di Alpine tidak memastikan bootstrap Windows telah berhasil.
Jika masih gagal, periksa `C:\windows-setup.log`, `ipconfig /all`, dan
`sc query TermService` dari console. Tidak perlu menulis ulang image untuk
memperbaiki newline di batch ini.

### Jika desktop di Recovery Console terlalu lambat

Perbaikan yang sama dapat dilakukan pada file Windows dari Linux tanpa login
ke desktop. Di panel DigitalOcean, matikan Droplet, pilih **Boot from Recovery
ISO** di pengaturan recovery, lalu hidupkan lagi dan buka **Recovery Console**.
Recovery ISO menampilkan password root sementara dan menyediakan SSH. Dari
laptop, gunakan `ssh root@IP_VPS` dengan password sementara tersebut. Host key
recovery memang berbeda; gunakan file known-hosts terpisah untuk sesi ini agar
catatan koneksi normal tidak diganti:

```powershell
ssh -o UserKnownHostsFile="$env:TEMP\bot-tele-recovery-known-hosts" root@IP_VPS
```

Dari shell recovery, periksa partisi sebelum memilihnya:

```sh
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS
```

Pilih partisi NTFS yang berisi folder `Windows`, bukan partisi boot/recovery.
Ganti `/dev/PARTISI_WINDOWS` di bawah dengan hasil pemeriksaan tersebut. Jangan
mengasumsikan nomor partisi sama pada image BIOS dan EFI. Jika partisi sudah
ter-mount, gunakan mount point yang ada dan jangan mount ulang.

```sh
apt-get update
apt-get install -y ntfs-3g python3 curl
mkdir -p /mnt/windows
mount -t ntfs-3g /dev/PARTISI_WINDOWS /mnt/windows
curl -fL https://raw.githubusercontent.com/Jampasers/bot-tele/main/scripts/repair-windows-bootstrap.py -o /tmp/repair-windows-bootstrap.py
python3 /tmp/repair-windows-bootstrap.py /mnt/windows
tail -n 60 /mnt/windows/windows-setup.log
```

Helper hanya menerima partisi dengan hive `Windows/System32/config/SYSTEM` dan
bootstrap bot-tele yang dikenali. Ia mengganti satu blok Chrome rusak,
mempertahankan bytes di luar blok, dan menyimpan file asli di
`windows-fix-rdp.bat.bot-tele-bootstrap.bak`. Impor registry, password, dan file
network tidak disentuh. Jika tidak menemukan bug yang dikenali, helper tidak
mengubah file; gunakan log untuk diagnosis berikutnya.

Jika NTFS menolak mount karena hibernasi/volume kotor, simpan error untuk
diagnosis. Jangan gunakan `remove_hiberfile` atau memaksa mount writable.
Setelah helper berhasil memperbaiki blok, lakukan:

```sh
sync
umount /mnt/windows
poweroff
```

Di panel DO, pilih **Boot from Hard Drive**, lalu hidupkan Droplet kembali.
Bootstrap yang telah diperbaiki akan dicoba lagi pada boot Windows berikutnya.
Periksa port 3389 dan status di bot; perbaikan file sendiri tidak memastikan
network, Chrome MSI, atau service RDP berhasil pada VPS tersebut.
