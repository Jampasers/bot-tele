import { CloudflareService } from "./src/services/cloudflare.js";

async function run() {
  console.log("🚀 Menjalankan pembuatan rule email Cloudflare...");
  const result = await CloudflareService.createEmailRule();
  if (result.success) {
    console.log("✅ Berhasil membuat rule Email Forwarding Spesifik!");
    console.log(`📧 Target Email: ${result.email}`);
    console.log(`🎯 Forward Ke:   ${result.destinationEmail}`);
    console.log(`🌐 Domain:       ${result.domain}`);
    console.log(`🆔 Rule ID:      ${result.ruleId}`);
  } else {
    console.error("❌ Gagal membuat rule:", result.error);
  }
}

run();