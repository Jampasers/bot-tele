import { WASocket } from "@whiskeysockets/baileys";
import { IUser } from "../../models/User.js";
import { DigitalProductService } from "../../services/digitalProduct.js";
import { ReceiptService } from "../../services/receipt.js";
import { generateQris, getUniquePaymentAmount, checkSessionSettlement } from "../../services/payment/index.js";
import { TopupSession, ITopupSession } from "../../models/TopupSession.js";
import { formatIDR, bold, italic, mono, strike, cleanJid } from "../formatter.js";
import { WaSessionManager } from "../session.js";
import { WaUserService } from "../userService.js";
import { HydratedDocument } from "mongoose";

export class WaDigitalController {
  /**
   * Menampilkan daftar kategori produk digital yang memiliki stok aktif.
   */
  static async showCategories(sock: WASocket, jid: string): Promise<void> {
    const activeCategories = await DigitalProductService.getActiveCategories();

    if (activeCategories.length === 0) {
      await sock.sendMessage(jid, {
        text:
          `📦 ${bold("Katalog Produk Digital")}\n\n` +
          `Maaf, saat ini belum ada produk digital yang tersedia.\n\n` +
          `💡 ${italic("Ketik 0 atau .menu untuk kembali ke Menu Utama.")}`,
      });
      WaSessionManager.setStep(jid, "MAIN_MENU");
      return;
    }

    let msg =
      `📦 ${bold("KATALOG PRODUK DIGITAL")}\n` +
      `${"─".repeat(28)}\n` +
      `Pilih kategori produk di bawah ini:\n\n`;

    const catList: string[] = [];
    activeCategories.forEach((cat, idx) => {
      catList.push(cat);
      msg += `${idx + 1}️⃣ ${bold(cat)}\n`;
    });

    msg += `\n0️⃣ ${italic("Kembali ke Menu Utama")}\n\n`;
    msg += `💡 ${italic("Balas dengan nomor kategori (contoh: 1)")}`;

    WaSessionManager.setStep(jid, "DIGITAL_CATEGORIES", { categories: catList });
    await sock.sendMessage(jid, { text: msg });
  }

  /**
   * Menampilkan produk dalam kategori yang dipilih.
   */
  static async handleCategoryChoice(
    sock: WASocket,
    jid: string,
    choiceText: string
  ): Promise<void> {
    const num = parseInt(choiceText.trim(), 10);
    const session = WaSessionManager.getSession(jid);
    const categories: string[] = session.data?.categories || [];

    if (choiceText.trim() === "0") {
      WaSessionManager.setStep(jid, "MAIN_MENU");
      await sock.sendMessage(jid, { text: "🔙 Kembali ke Menu Utama. Ketik .menu untuk opsi." });
      return;
    }

    if (isNaN(num) || num < 1 || num > categories.length) {
      await sock.sendMessage(jid, {
        text: `⚠️ Pilihan tidak valid. Silakan balas dengan nomor antara 1 - ${categories.length} atau 0 untuk kembali.`,
      });
      return;
    }

    const selectedCategory = categories[num - 1];
    if (!selectedCategory) {
      await sock.sendMessage(jid, { text: "⚠️ Kategori tidak ditemukan." });
      return;
    }

    const products = await DigitalProductService.getAllProducts({
      onlyActive: true,
      category: selectedCategory,
    });
    const activeProducts = products.filter((p) => p.isActive && p.stockCount > 0);

    if (activeProducts.length === 0) {
      await sock.sendMessage(jid, {
        text:
          `📂 Kategori: ${bold(selectedCategory)}\n\n` +
          `Maaf, semua produk dalam kategori ini sedang habis terjual.\n\n` +
          `Ketik 1 untuk memilih kategori lain, atau 0 untuk menu utama.`,
      });
      return;
    }

    let msg =
      `📂 Kategori: ${bold(selectedCategory)}\n` +
      `${"─".repeat(28)}\n` +
      `Pilih produk yang ingin kamu beli:\n\n`;

    const productMap: { id: string; name: string; price: number; stock: number }[] = [];
    activeProducts.forEach((p, idx) => {
      productMap.push({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stockCount,
      });
      msg +=
        `${idx + 1}️⃣ ${bold(p.name)}\n` +
        `   💵 Harga: ${formatIDR(p.price)}\n` +
        `   📦 Sisa Stok: ${p.stockCount} akun\n\n`;
    });

    msg += `0️⃣ ${italic("Kembali ke Daftar Kategori")}\n\n`;
    msg += `💡 ${italic("Balas dengan nomor produk yang ingin dibeli (contoh: 1)")}`;

    WaSessionManager.setStep(jid, "DIGITAL_PRODUCTS", {
      category: selectedCategory,
      products: productMap,
    });
    await sock.sendMessage(jid, { text: msg });
  }

  /**
   * Menampilkan detail produk terpilih & meminta input kuantitas.
   */
  static async handleProductChoice(
    sock: WASocket,
    jid: string,
    choiceText: string
  ): Promise<void> {
    const num = parseInt(choiceText.trim(), 10);
    const session = WaSessionManager.getSession(jid);
    const products: any[] = session.data?.products || [];

    if (choiceText.trim() === "0") {
      await this.showCategories(sock, jid);
      return;
    }

    if (isNaN(num) || num < 1 || num > products.length) {
      await sock.sendMessage(jid, {
        text: `⚠️ Pilihan tidak valid. Silakan balas dengan nomor produk 1 - ${products.length} atau 0 untuk kembali.`,
      });
      return;
    }

    const selectedProduct = products[num - 1];
    if (!selectedProduct) {
      await sock.sendMessage(jid, { text: "⚠️ Produk tidak ditemukan." });
      return;
    }

    const fullProduct = await DigitalProductService.getProductWithStock(selectedProduct.id);

    if (!fullProduct || fullProduct.stockCount < 1) {
      await sock.sendMessage(jid, {
        text: `⚠️ Maaf, stok produk ${bold(selectedProduct.name)} baru saja habis. Silakan pilih produk lain.`,
      });
      await this.showCategories(sock, jid);
      return;
    }

    let msg =
      `🛍️ ${bold(fullProduct.name)}\n` +
      `${"─".repeat(28)}\n` +
      `📂 Kategori: ${fullProduct.category}\n` +
      `💵 Harga Satuan: ${bold(formatIDR(fullProduct.price))}\n` +
      `📦 Stok Tersedia: ${bold(fullProduct.stockCount)} item\n`;

    if (fullProduct.description) {
      msg += `\n📝 Deskripsi:\n${italic(fullProduct.description)}\n`;
    }

    // Bulk discount tiers info
    if (fullProduct.bulkDiscounts && fullProduct.bulkDiscounts.length > 0) {
      msg += `\n🏷️ ${bold("Diskon Grosir Tersedia:")}\n`;
      fullProduct.bulkDiscounts.forEach((tier) => {
        msg += ` • Beli ≥ ${tier.minQty} item: ${bold(formatIDR(tier.pricePerUnit))}/item\n`;
      });
    }

    msg +=
      `\n${"─".repeat(28)}\n` +
      `Silakan ketik ${bold("jumlah kuantitas")} yang ingin dibeli (1 - ${fullProduct.stockCount}).\n` +
      `Ketik 0 untuk batal.`;

    WaSessionManager.setStep(jid, "DIGITAL_INPUT_QTY", {
      productId: fullProduct.id,
      productName: fullProduct.name,
      productPrice: fullProduct.price,
      maxStock: fullProduct.stockCount,
      fullProduct,
    });

    await sock.sendMessage(jid, { text: msg });
  }

  /**
   * Menerima input kuantitas & menampilkan opsi metode pembayaran.
   */
  static async handleQuantityInput(
    sock: WASocket,
    jid: string,
    qtyText: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    if (qtyText.trim() === "0") {
      await this.showCategories(sock, jid);
      return;
    }

    const qty = parseInt(qtyText.trim(), 10);
    const session = WaSessionManager.getSession(jid);
    const maxStock = session.data?.maxStock || 1;
    const fullProduct = session.data?.fullProduct;

    if (isNaN(qty) || qty < 1) {
      await sock.sendMessage(jid, {
        text: "⚠️ Jumlah tidak valid. Masukkan angka minimal 1.",
      });
      return;
    }

    if (qty > maxStock) {
      await sock.sendMessage(jid, {
        text: `⚠️ Jumlah melebihi stok yang tersedia (${maxStock} item). Silakan masukkan jumlah yang lebih kecil.`,
      });
      return;
    }

    const pricing = DigitalProductService.calculatePricing(fullProduct, qty);
    const totalPrice = pricing.totalPrice;

    let discountInfo = "";
    if (pricing.discountAmount > 0) {
      discountInfo =
        `🏷️ Normal: ${strike(formatIDR(pricing.normalTotalPrice))}\n` +
        `✨ Diskon Grosir: -${formatIDR(pricing.discountAmount)} (${pricing.discountPercent}% OFF)\n`;
    }

    const hasEnoughBalance = user.balance >= totalPrice;

    let msg =
      `🧾 ${bold("KONFIRMASI PEMBELIAN")}\n` +
      `${"─".repeat(28)}\n` +
      `📦 Produk: ${bold(fullProduct.name)}\n` +
      `🔢 Jumlah: ${bold(qty)} item\n` +
      discountInfo +
      `💰 Total Bayar: ${bold(formatIDR(totalPrice))}\n\n` +
      `💳 Saldo Akun Kamu: ${bold(formatIDR(user.balance))}\n` +
      `${"─".repeat(28)}\n` +
      `Pilih metode pembayaran:\n\n`;

    if (hasEnoughBalance) {
      msg += `1️⃣  ${bold("Bayar dengan Saldo")} (Sisa saldo: ${formatIDR(user.balance - totalPrice)})\n`;
    } else {
      msg += `1️⃣  ${strike("Bayar dengan Saldo")} _(Saldo tidak cukup, kurang ${formatIDR(totalPrice - user.balance)})_\n`;
    }
    msg += `2️⃣  ${bold("Bayar Langsung via QRIS")} (GoPay Otomatis)\n`;
    msg += `0️⃣  ${italic("Batalkan Pembelian")}\n\n`;
    msg += `💡 ${italic("Balas dengan angka 1 atau 2")}`;

    WaSessionManager.setStep(jid, "DIGITAL_CONFIRM_PAY", {
      quantity: qty,
      totalPrice,
      hasEnoughBalance,
    });

    await sock.sendMessage(jid, { text: msg });
  }

  /**
   * Memproses pembayaran (Saldo atau QRIS Dinamis).
   */
  static async handlePaymentChoice(
    sock: WASocket,
    jid: string,
    choiceText: string,
    user: HydratedDocument<IUser>
  ): Promise<void> {
    const session = WaSessionManager.getSession(jid);
    const productId = session.data?.productId;
    const productName = session.data?.productName;
    const quantity = session.data?.quantity || 1;
    const totalPrice = session.data?.totalPrice || 0;
    const hasEnoughBalance = session.data?.hasEnoughBalance;

    if (choiceText.trim() === "0") {
      WaSessionManager.setStep(jid, "MAIN_MENU");
      await sock.sendMessage(jid, { text: "❌ Pembelian dibatalkan. Kembali ke Menu Utama." });
      return;
    }

    // Pilihan 1: Bayar dengan Saldo
    if (choiceText.trim() === "1") {
      // Refresh fresh balance from DB
      const freshUser = await WaUserService.findOrCreateUser(jid);
      if (freshUser.balance < totalPrice) {
        await sock.sendMessage(jid, {
          text: `⚠️ Saldo kamu tidak mencukupi (${formatIDR(freshUser.balance)}). Silakan pilih opsi 2 untuk bayar via QRIS.`,
        });
        return;
      }

      if (!productId) {
        await sock.sendMessage(jid, { text: "⚠️ Produk tidak valid. Silakan pilih kembali." });
        WaSessionManager.setStep(jid, "MAIN_MENU");
        return;
      }

      await sock.sendMessage(jid, { text: "⏳ Sedang memproses pesanan kamu…" });

      const purchase = await DigitalProductService.purchaseProduct(
        productId,
        freshUser.telegramId,
        quantity
      );

      if (!purchase.success) {
        await sock.sendMessage(jid, {
          text: `❌ Gagal memproses pesanan: ${purchase.message || "Terjadi kesalahan sistem."}`,
        });
        WaSessionManager.setStep(jid, "MAIN_MENU");
        return;
      }

      // Format credentials delivery
      const orderProdName = purchase.order.productName || productName || "Produk Digital";
      let deliveryText =
        `✅ ${bold("PEMBELIAN BERHASIL!")}\n` +
        `${"─".repeat(28)}\n` +
        `🆔 Order ID: ${mono(purchase.order.orderId)}\n` +
        `📦 Produk: ${bold(orderProdName)}\n` +
        `🔢 Jumlah: ${purchase.order.quantity} item\n` +
        `💰 Total: ${formatIDR(purchase.order.price)}\n` +
        `${"─".repeat(28)}\n\n` +
        `🎁 ${bold("DATA AKUN / LISENSI KAMU:")}\n\n`;

      if (purchase.itemContent) {
        deliveryText += `${mono(purchase.itemContent)}\n\n`;
      } else if (purchase.order.itemContent) {
        deliveryText += `${mono(purchase.order.itemContent)}\n\n`;
      }

      if (purchase.order.deliveryMessage) {
        deliveryText += `📌 ${bold("Catatan / Panduan:")}\n${italic(purchase.order.deliveryMessage)}\n\n`;
      }

      deliveryText += `Terima kasih telah berbelanja di store kami! 🙏`;

      await sock.sendMessage(jid, { text: deliveryText });

      // Generate modern PNG receipt with Puppeteer
      try {
        const receiptBuf = await ReceiptService.generateReceiptBuffer({
          orderId: purchase.order.orderId,
          product: orderProdName,
          category: session.data?.category || "Produk Digital",
          date: new Date().toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          totalIdr: purchase.order.price,
          method: "Saldo Akun",
          status: "PAID / SUCCESS",
          buyerName: user.firstName || cleanJid(jid),
        });

        await sock.sendMessage(jid, {
          image: receiptBuf,
          caption: `🧾 ${bold("Struk Resmi Transaksi")} — Order ID: ${mono(purchase.order.orderId)}`,
        });
      } catch (receiptErr) {
        console.warn("[WA Digital] Failed to generate receipt image:", receiptErr);
      }

      WaSessionManager.setStep(jid, "MAIN_MENU");
      return;
    }

    // Pilihan 2: Bayar Langsung via QRIS GoPay
    if (choiceText.trim() === "2") {
      await sock.sendMessage(jid, {
        text: "💳 Sedang men-generate QRIS Dinamis + kode unik pembayaran…",
      });

      try {
        const shortage = totalPrice;
        const { baseAmount, uniqueCode, totalAmount } = await getUniquePaymentAmount(shortage);
        const orderId = `topup-wa-${cleanJid(jid)}-${Date.now()}`;
        const qrisResult = await generateQris(totalAmount);

        const newSession = await TopupSession.create({
          telegramId: user.telegramId,
          platform: "whatsapp",
          chatId: jid,
          messageId: "wa_direct_qris",
          orderId,
          baseAmount,
          uniqueCode,
          amountIDR: totalAmount,
          pendingProductType: "DIGITAL",
          ...(productId ? { pendingDigitalProductId: productId } : {}),
          pendingQuantity: quantity,
          status: "PENDING",
        });

        const caption =
          `💳 ${bold("PEMBAYARAN QRIS — GOPAY")}\n` +
          `${"─".repeat(28)}\n\n` +
          `Silakan scan QRIS di atas untuk menyelesaikan pembelian:\n` +
          `📦 ${bold(productName || "Produk Digital")} (${bold(quantity)} item)\n\n` +
          `🏷️ Harga Normal: ${formatIDR(baseAmount)}\n` +
          `🔢 Kode Unik: +${formatIDR(uniqueCode)}\n` +
          `${"─".repeat(28)}\n` +
          `💳 ${bold("TOTAL TRANSFER:")} ${bold(formatIDR(totalAmount))}\n` +
          `${"─".repeat(28)}\n\n` +
          `⚠️ ${bold("PENTING:")}\n` +
          `Transfer dengan nominal ${bold("TEPAT " + formatIDR(totalAmount))} agar otomatis terdeteksi oleh sistem.\n` +
          `⏱ QR berlaku 15 menit. Begitu terbayar, produk digital langsung otomatis dikirimkan ke chat ini!`;

        await sock.sendMessage(jid, {
          image: qrisResult.buffer,
          caption,
        });

        WaSessionManager.setStep(jid, "MAIN_MENU");

        // Start background polling watcher for this WhatsApp QRIS session
        if (newSession && (newSession as any)._id) {
          this.startWaQrisWatcher(sock, String((newSession as any)._id), jid, user.telegramId);
        }
      } catch (qrisErr) {
        console.error("[WA Digital] QRIS generation error:", qrisErr);
        await sock.sendMessage(jid, {
          text: "❌ Gagal membuat QRIS pembayaran. Silakan coba beberapa saat lagi.",
        });
      }
      return;
    }

    await sock.sendMessage(jid, {
      text: "⚠️ Pilihan tidak dikenal. Balas 1 untuk bayar via saldo, 2 untuk QRIS, atau 0 untuk batal.",
    });
  }

  /**
   * Background polling watcher untuk transaksi QRIS WhatsApp.
   * Polling setiap 10 detik hingga 15 menit.
   */
  static startWaQrisWatcher(
    sock: WASocket,
    sessionId: string,
    jid: string,
    userId: string
  ): void {
    const POLLING_INTERVAL_MS = 10_000;
    const MAX_DURATION_MS = 15 * 60 * 1000;
    const startTime = Date.now();

    const interval = setInterval(async () => {
      try {
        if (Date.now() - startTime >= MAX_DURATION_MS) {
          clearInterval(interval);
          await TopupSession.findByIdAndUpdate(sessionId, { status: "EXPIRED" });
          await sock.sendMessage(jid, {
            text: `⏱️ Masa berlaku pembayaran QRIS telah kedaluwarsa (15 menit). Silakan lakukan pemesanan ulang jika masih berminat.`,
          });
          return;
        }

        const session = await TopupSession.findById(sessionId);
        if (!session || session.status !== "PENDING") {
          clearInterval(interval);
          return;
        }

        const matchedTx = await checkSessionSettlement(session);
        if (matchedTx) {
          clearInterval(interval);

          const settledSession = await TopupSession.findByIdAndUpdate(
            sessionId,
            {
              status: "SETTLED",
              matchedTransactionId: matchedTx.transactionId,
            },
            { returnDocument: "after" }
          );

          // Handle pending digital product purchase
          if (settledSession?.pendingProductType === "DIGITAL" && settledSession.pendingDigitalProductId) {
            const purchase = await DigitalProductService.purchaseProduct(
              settledSession.pendingDigitalProductId,
              userId,
              settledSession.pendingQuantity || 1
            );

            if (purchase.success && purchase.order) {
              const orderProdName = purchase.order.productName || "Produk Digital";
              let deliveryText =
                `🎉 ${bold("PEMBAYARAN QRIS BERHASIL DIVERIFIKASI!")}\n` +
                `${"─".repeat(28)}\n` +
                `🆔 Order ID: ${mono(purchase.order.orderId)}\n` +
                `📦 Produk: ${bold(orderProdName)}\n` +
                `🔢 Jumlah: ${purchase.order.quantity} item\n` +
                `💰 Total: ${formatIDR(settledSession.amountIDR)}\n` +
                `${"─".repeat(28)}\n\n` +
                `🎁 ${bold("DATA AKUN / LISENSI KAMU:")}\n\n`;

              if (purchase.itemContent) {
                deliveryText += `${mono(purchase.itemContent)}\n\n`;
              } else if (purchase.order.itemContent) {
                deliveryText += `${mono(purchase.order.itemContent)}\n\n`;
              }

              if (purchase.order.deliveryMessage) {
                deliveryText += `📌 ${bold("Catatan / Panduan:")}\n${italic(purchase.order.deliveryMessage)}\n\n`;
              }

              deliveryText += `Terima kasih atas pesanan kamu! 🙏`;

              await sock.sendMessage(jid, { text: deliveryText });

              // Struk PNG Puppeteer
              try {
                const receiptBuf = await ReceiptService.generateReceiptBuffer({
                  orderId: purchase.order.orderId,
                  product: orderProdName,
                  category: "Produk Digital",
                  date: new Date().toLocaleDateString("id-ID", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  totalIdr: settledSession.amountIDR,
                  method: "GoPay QRIS",
                  status: "PAID / SUCCESS",
                  buyerName: cleanJid(jid),
                });

                await sock.sendMessage(jid, {
                  image: receiptBuf,
                  caption: `🧾 ${bold("Struk Resmi Transaksi")} — Order ID: ${mono(purchase.order.orderId)}`,
                });
              } catch (err) {
                console.warn("[WA Poller] Failed receipt generation:", err);
              }
            } else {
              // Jika produk kehabisan stok setelah pembayaran, alihkan jadi saldo
              await WaUserService.findOrCreateUser(jid).then(async (u) => {
                u.balance += settledSession.amountIDR;
                await u.save();
              });

              await sock.sendMessage(jid, {
                text:
                  `⚠️ Pembayaran QRIS ${formatIDR(settledSession.amountIDR)} berhasil diverifikasi!\n\n` +
                  `Namun stok produk baru saja habis. Dana otomatis telah kami tambahkan ke ${bold("Saldo Akun")} kamu.\n` +
                  `Kamu dapat membeli produk lain atau meminta refund ke admin.`,
              });
            }
          }
        }
      } catch (pollErr) {
        console.error("[WA Digital] Polling error:", pollErr);
      }
    }, POLLING_INTERVAL_MS);
  }
}
