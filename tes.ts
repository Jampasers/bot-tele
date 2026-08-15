import { ReceiptService } from "./src/services/receipt.js";
import fs from "fs";

async function main() {
  console.log("Generating modern receipt with ReceiptService...");
  const buffer = await ReceiptService.generateReceiptBuffer({
    orderId: "ORDER-1786611090-2137",
    method: "QRIS",
    product: "DO 3 DROP (x1)",
    category: "VPS & Cloud",
    date: "2026-08-15 14:45",
    totalIdr: 40000,
    status: "PAID",
    buyerName: "Budi (@budis) (5938****)",
    brandTitle: "⚡ PentaHostinger",
  });

  fs.writeFileSync("struk_modern.png", buffer);
  console.log(`✅ Struk berhasil dibuat dari ReceiptService: struk_modern.png (size: ${buffer.length} bytes)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});