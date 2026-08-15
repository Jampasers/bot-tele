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
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      width: 480px;
      padding: 24px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    /* Container Struk Modern */
    .card {
      width: 390px;
      background: #ffffff;
      border-radius: 16px;
      padding: 28px 24px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
      position: relative;
    }

    /* Header Brand */
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .brand-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #0f172a;
    }
    .badge-success {
      background: #ecfdf5;
      color: #059669;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 20px;
      border: 1px solid #a7f3d0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Total Amount Section */
    .amount-box {
      background: #f8fafc;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
      text-align: center;
      border: 1px dashed #cbd5e1;
    }
    .amount-label {
      font-size: 11px;
      color: #64748b;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .amount-value {
      font-size: 24px;
      font-weight: 700;
      color: #059669;
      margin-top: 4px;
    }
    .amount-sub {
      font-size: 12px;
      color: #94a3b8;
      margin-top: 2px;
    }

    /* List Items */
    .details {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      font-size: 13px;
    }
    .detail-label {
      color: #64748b;
      font-weight: 500;
      min-width: 80px;
    }
    .detail-val {
      color: #1e293b;
      font-weight: 700;
      font-family: 'Space Mono', monospace;
      text-align: right;
      max-width: 240px;
      word-break: break-word;
    }

    /* Footer Section */
    .footer-divider {
      border-top: 1px dashed #e2e8f0;
      margin-top: 6px;
      padding-top: 16px;
      text-align: center;
    }
    .footer-text {
      text-align: center;
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div class="card">
    <!-- Header -->
    <div class="brand">
      <span class="brand-title">${safeBrandTitle}</span>
      <span class="badge-success">${safeStatus}</span>
    </div>

    <!-- Amount Highlight -->
    <div class="amount-box">
      <div class="amount-label">Total Pembayaran</div>
      <div class="amount-value">Rp ${safeTotalIdr}</div>
      ${usdSub}
    </div>

    <!-- Details List -->
    <div class="details">
      <div class="detail-row">
        <span class="detail-label">Order ID</span>
        <span class="detail-val">${safeOrderId}</span>
      </div>
      ${buyerRow}
      <div class="detail-row">
        <span class="detail-label">Metode</span>
        <span class="detail-val">${safeMethod}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Produk</span>
        <span class="detail-val">${safeProduct}</span>
      </div>
      ${categoryRow}
      <div class="detail-row">
        <span class="detail-label">Tanggal</span>
        <span class="detail-val">${safeDate}</span>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer-divider">
      <div class="footer-text">
        Terima kasih telah menggunakan layanan kami!
      </div>
    </div>
  </div>
</body>
</html>
    `;

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport({ width: 480, height: 620, deviceScaleFactor: 2 });
      await page.setContent(htmlContent, { waitUntil: "networkidle0" as any });

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
