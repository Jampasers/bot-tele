# Implementasi VPS DigitalOcean

Spesifikasi: permintaan pengguna 12 September 2026; main bot saja, pembayaran saldo/QRIS, token toko terenkripsi, token buyer hanya memori, instalasi mengikuti `isinya-testing/vps.js`.

Urutan pekerjaan dan batas verifikasi:
1. Model order/snapshot/harga/credential dan kontrak client DO/installer; uji pagination, klasifikasi error, secret dan OS.
2. Ledger pembayaran dan efek saldo atomik, reservasi kapasitas per team serta penanda create sebelum POST; uji duplikasi dan pemulihan.
3. Worker tahap persisten, input token sementara, instalasi dan reboot; uji lease, timeout dan kepemilikan.
4. Plugin buyer/admin, catalog, startup, index/migrasi dan backup; uji handler mock.
5. Build, seluruh tes, audit dependensi/diff dan dokumentasi operasional.

Tidak ada token nyata, droplet berbayar, deployment atau migrasi database produksi dalam pengujian. Installer remote dan login Windows hanya dapat dinyatakan terverifikasi setelah bukti runtime di lingkungan yang diotorisasi.

## Percobaan SSH dan penggantian VPS DO

Status DO `active` tidak membuktikan user-data/password SSH sudah diterapkan. Worker mulai memeriksa SSH setelah droplet aktif, tidak terkunci, dan memiliki IP publik. Masa boot default **300 detik** dimulai saat itu; `VPS_SSH_BOOT_GRACE_SECONDS` dapat diatur 60–1800 detik. SSH yang siap lebih cepat langsung dilanjutkan. Pemeriksaan selama masa boot belum mengurangi jatah retry. Waktu mulai boot, jadwal pemeriksaan berikutnya, dan kode kegagalan disimpan pada order agar restart atau pengiriman ulang token tidak mengulang timer.

VPS DO dari akun toko dan Jasa Install dari akun DO buyer memakai maksimal tiga kegagalan SSH yang dihitung **setelah masa boot** per droplet. Satu pemeriksaan SSH dibatasi 20 detik, dengan jeda 30 detik setelah pemeriksaan selesai. Setelah tiga kegagalan yang dihitung, worker menyimpan tahap `replacing`, memeriksa identitas droplet, lalu menghapus hanya droplet milik order tersebut. VPS pengganti memakai spek, region, image, dan pembayaran order yang sama, dengan nama baru untuk rekonsiliasi create. Setiap VPS pengganti mendapat masa boot sendiri.

Diagnosis membedakan koneksi TCP ditolak/timeout/reset, handshake timeout, login ditolak, akses root/sudo tidak cukup, dan cloud-init yang belum selesai. Login yang sudah berhasil tetapi masih menunggu cloud-init tidak mengurangi retry atau menjalankan installer; setelah 30 menit order masuk `review` dan tetap mengamati VPS yang sama. Error routing `ENETUNREACH`/`EHOSTUNREACH`/`EADDRNOTAVAIL` dari server bot juga masuk `review` tanpa menghapus VPS, membuat pengganti, atau refund otomatis; pemeriksaan dilanjutkan pada VPS yang sama setelah jalur pulih. Pesan status menggunakan kode/detail tetap dan tidak memuat output/error mentah, password, atau token. Order lama yang sudah masuk `replacing` terlalu cepat kembali menunggu SSH selama belum ada intent DELETE; intent DELETE yang sudah tersimpan tetap direkonsiliasi.

Batas keseluruhan adalah tiga droplet (VPS awal dan dua pengganti), atau maksimal sembilan kegagalan SSH yang dihitung setelah masa boot. Jika droplet ketiga juga gagal, worker memastikan ketiga droplet sudah terhapus, menandai order `failed` dengan alasan `ssh_retry_exhausted` serta diagnosis terakhir, dan mengembalikan pembayaran ke saldo buyer. Pembayaran QRIS dikembalikan beserta kode uniknya. Refund menggunakan bukti wallet yang sama agar aman saat restart atau dipanggil ulang.

Token akun toko dan DO buyer perlu izin `droplet:read`, `droplet:create`, dan `droplet:delete`. Respons DELETE yang terputus, izin yang tidak cukup, atau penghapusan yang belum terkonfirmasi mempertahankan tahap penghapusan; worker belum membuat VPS tambahan atau memberikan refund. Jika token buyer hilang setelah restart, tombol kirim ulang token melanjutkan percobaan dan target penghapusan yang tersimpan. [API penghapusan droplet DigitalOcean](https://docs.digitalocean.com/products/droplets/reference/api/droplets/) memakai DELETE berdasarkan ID droplet; worker mengonfirmasi bahwa ID tersebut sudah tidak ditemukan sebelum melanjutkan.

VPS yang sudah dimiliki buyer melalui Direct SSH tetap mengikuti alur pemantauan sebelumnya. Penggantian otomatis hanya berlaku sebelum instalasi Windows dimulai. Jumlah percobaan, alasan kegagalan, dan hasil refund diperbarui melalui pesan status order yang sama.

Referensi: [user-data saat boot pertama di DigitalOcean](https://docs.digitalocean.com/products/droplets/how-to/provide-user-data/) dan [tahap Final cloud-init](https://docs.cloud-init.io/en/latest/explanation/boot.html). Sebelumnya tiga pemeriksaan langsung setelah `active` dapat menghapus droplet dalam sekitar 90 detik, sebelum script konfigurasi login selesai.

## Pemulihan Windows setelah perubahan wallpaper

Perintah `SetDankaWallpaper` pada versi awal wallpaper menyisipkan kode C# ke dalam blok `if` CMD dengan kutip bertingkat. Reproduksi lokal menghasilkan `]public was unexpected at this time.` dan menghentikan pemanggil `SetupComplete.cmd` sebelum batch konfigurasi jaringan bawaan installer dijalankan. Windows dapat mencapai layar login tetapi belum memiliki konfigurasi jaringan untuk RDP.

Installer sekarang menjalankan wallpaper dalam batch terpisah setelah batch jaringan. Kode wallpaper saat login disimpan dalam `danka-wallpaper.ps1`, sehingga nilai RunOnce hanya berisi perintah pendek `powershell.exe ... -File`. Hook installer yang tidak ditemukan menggagalkan persiapan sebelum reboot.

Perbaikan source berlaku untuk persiapan instalasi berikutnya. Untuk VPS yang sudah terkena masalah, login sebagai Administrator melalui recovery console, buka **Command Prompt sebagai Administrator**, lalu periksa batch jaringan yang tersisa:

```cmd
dir C:\windows-set-netconf-*.bat
```

Jika file tersedia, jalankan hanya batch jaringan tersebut dari CMD interaktif:

```cmd
for %f in (C:\windows-set-netconf-*.bat) do @if exist "%f" cmd.exe /d /c "%f"
```

Batch tersebut membawa konfigurasi IP/gateway/DNS yang ditangkap installer. Jangan jalankan ulang `windows-fix-rdp.bat` atau `SetupComplete.cmd` dari versi yang bermasalah. Jika file tidak ada atau eksekusinya gagal, periksa output console serta konfigurasi NIC; jangan menebak gateway atau membuat VPS pengganti. Worker tetap memantau order yang sama dan baru menandainya siap setelah tiga respons RDP berturut-turut. Login RDP tetap perlu diuji tersendiri.

Referensi installer yang dipakai: [modify_windows dan create_win_set_netconf_script](https://github.com/bin456789/reinstall/blob/6a0a2c9b3c678728fe63bc8bbb0ab82c86717830/trans.sh). Batas nilai RunOnce: [dokumentasi Microsoft](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).
