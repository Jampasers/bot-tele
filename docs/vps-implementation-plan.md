# Implementasi VPS DigitalOcean

Spesifikasi: permintaan pengguna 12 September 2026; main bot saja, pembayaran saldo/QRIS, token toko terenkripsi, token buyer hanya memori, instalasi mengikuti `isinya-testing/vps.js`.

Urutan pekerjaan dan batas verifikasi:
1. Model order/snapshot/harga/credential dan kontrak client DO/installer; uji pagination, klasifikasi error, secret dan OS.
2. Ledger pembayaran dan efek saldo atomik, reservasi kapasitas per team serta penanda create sebelum POST; uji duplikasi dan pemulihan.
3. Worker tahap persisten, input token sementara, instalasi dan reboot; uji lease, timeout dan kepemilikan.
4. Plugin buyer/admin, catalog, startup, index/migrasi dan backup; uji handler mock.
5. Build, seluruh tes, audit dependensi/diff dan dokumentasi operasional.

Tidak ada token nyata, droplet berbayar, deployment atau migrasi database produksi dalam pengujian. Installer remote dan login Windows hanya dapat dinyatakan terverifikasi setelah bukti runtime di lingkungan yang diotorisasi.

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
