import { GopayMerchant, QrisGenerator } from "../index.js";

const qrisImage = process.env.QRIS_IMAGE_PATH;
const merchantId = process.env.GOPAY_MERCHANT_ID;
const email = process.env.GOJEK_EMAIL;
const password = process.env.GOJEK_PASSWORD;

if (!qrisImage || !merchantId || !email || !password) {
  throw new Error(
    "Set QRIS_IMAGE_PATH, GOPAY_MERCHANT_ID, GOJEK_EMAIL, and GOJEK_PASSWORD in .env first.",
  );
}

// 1. Generate QRIS dinamis
const qris = new QrisGenerator({ qrisImage });
const imageDataUri = await qris.generate(25_000);
console.log(`QRIS generated: ${imageDataUri.slice(0, 30)}...`);

// 2. Inisialisasi GopayMerchant dengan Email & Password Gojek
const merchant = new GopayMerchant({
  email,
  merchantId,
  password,
});

// 3. Ambil transaksi QRIS settlement
const transactions = await merchant.getQrisSettlements({
  endTime: new Date(),
  startTime: new Date(Date.now() - 30 * 60 * 1_000),
});

console.log(`Settlements found: ${transactions.length}`);
