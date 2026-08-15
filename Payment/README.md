# payment-gopay-qris

Package npm mandiri untuk QRIS dinamis dan verifikasi transaksi QRIS GoPay Merchant / GoBiz.

Modul ini mengimplementasikan metode QRIS & GoPay settlement terbaru dari **Main Bot**, menggunakan login **Email & Password Gojek / GoBiz** secara otomatis tanpa perlu mengelola access token secara manual.

## Fitur Utama

- **Login Otomatis Email & Password**: `GopayMerchant` dan `GobizAuthService` login langsung ke GoBiz API (`https://api.gobiz.co.id/goid/token`) untuk memperoleh dan memperbarui `access_token` secara otomatis.
- **QrisGenerator**: Pembuatan QRIS dinamis berdasar nominal (IDR) dengan kalkulasi CRC16-CCITT False otomatis.
- **readQrCodeImage**: Utilitas pembacaan QR Code dari file PNG atau JPEG.
- **GopayMerchant**: Client GoPay Merchant API untuk mengambil transaksi settlement QRIS dengan auto token refresh.
- **QrisWatcher**: Service watcher dengan polling otomatis dan exponential backoff safeguard.

## Instalasi

```bash
npm install payment-gopay-qris
```

## 1. Generate QRIS Dinamis

```ts
import { QrisGenerator } from "payment-gopay-qris";

const qris = new QrisGenerator({
  qrisImage: "./qris-static.png",
});

// Mengembalikan PNG Data URI (base64 image)
const imageDataUri = await qris.generate(25_000);
```

## 2. Login Email & Password Gojek & Ambil Transaksi Settlement

```ts
import { GopayMerchant } from "payment-gopay-qris";

// Login otomatis menggunakan Email & Password Gojek
const merchant = new GopayMerchant({
  merchantId: process.env.GOPAY_MERCHANT_ID!,
  email: process.env.GOJEK_EMAIL!,
  password: process.env.GOJEK_PASSWORD!,
});

// Ambil transaksi QRIS settlement
const transactions = await merchant.getQrisSettlements({
  startTime: new Date(Date.now() - 30 * 60 * 1_000),
  endTime: new Date(),
});

for (const tx of transactions) {
  console.log(tx.transactionId, tx.amount, new Date(tx.paidAt).toLocaleString());
}
```

## 3. QrisWatcher (Polling Otomatis)

```ts
import { GopayMerchant, QrisWatcher } from "payment-gopay-qris";

const merchant = new GopayMerchant({
  merchantId: process.env.GOPAY_MERCHANT_ID!,
  email: process.env.GOJEK_EMAIL!,
  password: process.env.GOJEK_PASSWORD!,
});

const watcher = new QrisWatcher({
  gopayService: merchant,
  intervalMs: 5_000,
  getWatchWindow: async () => ({
    startTime: new Date(Date.now() - 15 * 60 * 1_000),
    endTime: new Date(),
  }),
  matchTransactions: async (transactions) => {
    // Cocokkan transaksi dengan order pending di database
    return [];
  },
  notifyMatch: async (match) => {
    console.log(`Topup berhasil: Rp${match.amount}`);
  },
});

watcher.start();
```

## Build & Test Local

```bash
cd Payment
npm install
npm run build
```
