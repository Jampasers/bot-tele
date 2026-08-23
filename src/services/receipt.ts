import puppeteer, { Browser } from "puppeteer";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export interface ReceiptData {
  orderId: string;
  method?: string | undefined;
  product: string;
  category?: string | undefined;
  date: string;
  totalIdr: string | number;
  totalUsd?: string | undefined;
  status?: string | undefined;
  buyerName?: string | undefined;
  brandTitle?: string | undefined;
}

// ============================================================================
//  Browser Singleton Manager
// ============================================================================

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  browserInstance = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
    ],
  });
  return browserInstance;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPriceNumber(amount: string | number): string {
  const num = typeof amount === "number" ? amount : parseFloat(String(amount).replace(/[^0-9.-]+/g, ""));
  if (isNaN(num)) return String(amount);
  return new Intl.NumberFormat("id-ID").format(num);
}

// ============================================================================
//  Receipt Service
// ============================================================================

export class ReceiptService {
  /**
   * Generates a modern receipt image buffer using Puppeteer.
   */
  static async generateReceiptBuffer(data: ReceiptData): Promise<Buffer> {
    const safeBrandTitle = escapeHtml(data.brandTitle || "⚡ Official Store");
    const safeStatus = escapeHtml(data.status || "PAID");
    const safeTotalIdr = formatPriceNumber(data.totalIdr);
    const safeOrderId = escapeHtml(data.orderId);
    const safeMethod = escapeHtml(data.method || "Saldo / QRIS");
    const safeProduct = escapeHtml(data.product);
    const safeDate = escapeHtml(data.date);

    const buyerRow = data.buyerName
      ? `
        <div class="detail-row">
          <span class="detail-label">Pembeli</span>
          <span class="detail-val">${escapeHtml(data.buyerName)}</span>
        </div>`
      : "";

    const categoryRow = data.category
      ? `
        <div class="detail-row">
          <span class="detail-label">Kategori</span>
          <span class="detail-val">${escapeHtml(data.category)}</span>
        </div>`
      : "";

    const usdSub = data.totalUsd
      ? `<div class="amount-sub">($${escapeHtml(data.totalUsd)} USD)</div>`
      : "";

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      width: 480px;
      padding: 28px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f3f6fb;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #0f172a;
    }

    /* Modern receipt shell */
    .card {
      width: 408px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 22px;
      overflow: hidden;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.10);
      position: relative;
    }

    /* Brand header */
    .brand {
      padding: 22px 24px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid #eef2f7;
    }

    .brand-left {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      border-radius: 12px;
      background: #2563eb;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      box-shadow: 0 7px 16px rgba(37, 99, 235, 0.20);
    }

    .brand-copy {
      min-width: 0;
    }

    .brand-title {
      color: #0b1730;
      font-size: 16px;
      line-height: 1.15;
      font-weight: 800;
      letter-spacing: -0.35px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 245px;
    }

    .brand-subtitle {
      margin-top: 4px;
      color: #94a3b8;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.65px;
      text-transform: uppercase;
    }

    .badge-success {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 999px;
      background: #ecfdf5;
      border: 1px solid #bbf7d0;
      color: #059669;
      font-size: 9px;
      line-height: 1;
      font-weight: 800;
      letter-spacing: 0.45px;
      text-transform: uppercase;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.10);
    }

    /* Payment summary */
    .summary {
      margin: 18px 20px 16px;
      padding: 19px 18px 18px;
      border-radius: 16px;
      background: linear-gradient(135deg, #eff6ff 0%, #f8fbff 100%);
      border: 1px solid #dbeafe;
      position: relative;
      overflow: hidden;
    }

    .summary::after {
      content: '';
      position: absolute;
      width: 110px;
      height: 110px;
      right: -45px;
      top: -55px;
      border-radius: 50%;
      background: rgba(37, 99, 235, 0.07);
    }

    .summary-label {
      color: #64748b;
      font-size: 10px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }

    .amount-row {
      margin-top: 7px;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .amount-value {
      color: #1769e0;
      font-size: 28px;
      line-height: 1.1;
      font-weight: 800;
      letter-spacing: -1px;
    }

    .amount-sub {
      color: #94a3b8;
      font-size: 10px;
      font-weight: 600;
      margin-top: 4px;
    }

    .paid-check {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border-radius: 10px;
      background: #ffffff;
      border: 1px solid #bfdbfe;
      color: #2563eb;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 800;
    }

    /* Information section */
    .section {
      padding: 0 24px;
    }

    .section-title {
      color: #0f172a;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      margin-bottom: 10px;
    }

    .details {
      border: 1px solid #e8edf4;
      border-radius: 14px;
      overflow: hidden;
      background: #ffffff;
    }

    .detail-row {
      min-height: 42px;
      padding: 10px 13px;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      font-size: 11px;
    }

    .detail-row + .detail-row {
      border-top: 1px solid #f1f5f9;
    }

    .detail-label {
      color: #94a3b8;
      font-weight: 600;
      line-height: 1.45;
      min-width: 70px;
    }

    .detail-val {
      color: #172033;
      font-weight: 700;
      line-height: 1.45;
      text-align: right;
      max-width: 245px;
      word-break: break-word;
    }

    .detail-val.mono {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
    }

    /* Product highlight */
    .product-box {
      margin-top: 14px;
      padding: 13px;
      border-radius: 14px;
      background: #f8fafc;
      border: 1px solid #e8edf4;
    }

    .product-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 14px;
    }

    .product-label {
      color: #94a3b8;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      margin-bottom: 5px;
    }

    .product-name {
      color: #0f172a;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 800;
      word-break: break-word;
    }

    .product-price {
      color: #0f172a;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
      text-align: right;
    }

    /* Footer */
    .footer {
      margin-top: 18px;
      padding: 16px 24px 20px;
      border-top: 1px dashed #dbe3ee;
      text-align: center;
    }

    .footer-main {
      color: #475569;
      font-size: 10px;
      font-weight: 700;
    }

    .footer-sub {
      margin-top: 4px;
      color: #a0aec0;
      font-size: 9px;
      line-height: 1.45;
    }

    .footer-brand {
      margin-top: 10px;
      color: #cbd5e1;
      font-size: 8px;
      font-weight: 800;
      letter-spacing: 1.2px;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="card">
    <!-- Header -->
    <div class="brand">
      <div class="brand-left">
        <div class="brand-mark">✓</div>
        <div class="brand-copy">
          <div class="brand-title">${safeBrandTitle}</div>
          <div class="brand-subtitle">Digital Receipt</div>
        </div>
      </div>
      <div class="badge-success">
        <span class="status-dot"></span>
        ${safeStatus}
      </div>
    </div>

    <!-- Payment Summary -->
    <div class="summary">
      <div class="summary-label">Total Pembayaran</div>
      <div class="amount-row">
        <div>
          <div class="amount-value">Rp ${safeTotalIdr}</div>
          ${usdSub}
        </div>
        <div class="paid-check">✓</div>
      </div>
    </div>

    <!-- Transaction Details -->
    <div class="section">
      <div class="section-title">Detail Transaksi</div>
      <div class="details">
        <div class="detail-row">
          <span class="detail-label">Order ID</span>
          <span class="detail-val mono">${safeOrderId}</span>
        </div>
        ${buyerRow}
        <div class="detail-row">
          <span class="detail-label">Metode</span>
          <span class="detail-val">${safeMethod}</span>
        </div>
        ${categoryRow}
        <div class="detail-row">
          <span class="detail-label">Tanggal</span>
          <span class="detail-val">${safeDate}</span>
        </div>
      </div>

      <!-- Product -->
      <div class="product-box">
        <div class="product-top">
          <div>
            <div class="product-label">Produk</div>
            <div class="product-name">${safeProduct}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <div class="footer-main">Terima kasih telah menggunakan layanan kami!</div>
      <div class="footer-sub">Simpan receipt ini sebagai bukti transaksi digital.</div>
      <div class="footer-brand">Official Digital Receipt</div>
    </div>
  </div>
</body>
</html>
    `;

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 480, height: 620, deviceScaleFactor: 2 });
      await page.setContent(htmlContent, { waitUntil: "domcontentloaded", timeout: 5000 });

      // Tiny delay for DOM paint
      await new Promise((res) => setTimeout(res, 100));

      const cardElement = await page.$(".card");
      let screenshotBuffer: Uint8Array | Buffer;
      if (cardElement) {
        screenshotBuffer = await cardElement.screenshot({ type: "png" });
      } else {
        screenshotBuffer = await page.screenshot({ type: "png" });
      }

      return Buffer.from(screenshotBuffer);
    } finally {
      await page.close().catch(() => {});
    }
  }
}