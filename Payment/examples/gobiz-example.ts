import {
  GobizAuthService,
  GopayMerchant,
  QrisGenerator,
  QrisWatcher,
  readQrCodeImage,
} from "../index.js";

const qrisImagePath = process.env.QRIS_IMAGE_PATH;
const merchantId = process.env.GOPAY_MERCHANT_ID;
const gobizEmail = process.env.GOBIZ_EMAIL;
const gobizPassword = process.env.GOBIZ_PASSWORD;

if (!qrisImagePath || !merchantId || !gobizEmail || !gobizPassword) {
  console.log("Usage: Set QRIS_IMAGE_PATH, GOPAY_MERCHANT_ID, GOBIZ_EMAIL, GOBIZ_PASSWORD in .env");
  process.exit(1);
}

// 1. Read static QRIS payload from image file
const staticPayload = await readQrCodeImage(qrisImagePath);
console.log(`Static QRIS Payload extracted: ${staticPayload.slice(0, 30)}...`);

// 2. Instantiate QRIS generator with static payload
const generator = new QrisGenerator({ qrisStaticPayload: staticPayload });
const dataUri = await generator.generate(15_000);
console.log(`Dynamic QRIS generated for Rp15.000: ${dataUri.slice(0, 35)}...`);

// 3. Autentikasi otomatis GoBiz untuk akses token
const auth = new GobizAuthService({
  email: gobizEmail,
  password: gobizPassword,
});

// 4. Client GoPay Merchant dengan auto token provider
const merchant = new GopayMerchant({
  accessTokenProvider: auth,
  merchantId,
});

// 5. Run single settlement check
const transactions = await merchant.getQrisSettlements({
  endTime: new Date(),
  startTime: new Date(Date.now() - 60 * 60 * 1_000),
});
console.log(`Transactions fetched from GoPay Merchant: ${transactions.length}`);

// 6. Start QrisWatcher loop
const watcher = new QrisWatcher({
  getWatchWindow: async () => ({
    endTime: new Date(),
    startTime: new Date(Date.now() - 15 * 60 * 1_000),
  }),
  gopayService: merchant,
  intervalMs: 10_000,
  matchTransactions: async (txs) => {
    console.log(`[Watcher] Analyzing ${txs.length} transactions...`);
    return [];
  },
  notifyMatch: async (match) => {
    console.log(`[Watcher] Matched topup payment: Rp${match.amount}`);
  },
});

console.log("Starting QrisWatcher loop...");
watcher.start();
setTimeout(() => {
  watcher.stop();
  console.log("QrisWatcher stopped.");
}, 5_000);
