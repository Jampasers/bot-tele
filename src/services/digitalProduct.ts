import { Types } from "mongoose";
import {
  DigitalProduct,
  IDigitalProduct,
  DigitalProductDocument,
  WarrantyUnit,
  IBulkDiscountTier,
  DeliveryType,
} from "../models/DigitalProduct.js";
import { DigitalStock, IDigitalStock, DigitalStockDocument } from "../models/DigitalStock.js";
import { DigitalOrder, IDigitalOrder, DigitalOrderDocument, IDigitalOrderItem } from "../models/DigitalOrder.js";
import { User } from "../models/User.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { RestockAlert } from "../models/RestockAlert.js";
import { WarrantyService } from "./warranty.js";
import { CartService, CartSummary } from "./cartService.js";
import type { Api } from "grammy";

// ============================================================================
//  DTOs & Return Types
// ============================================================================

export interface BulkPricingResult {
  unitPrice: number;
  totalPrice: number;
  normalPrice: number;
  normalTotalPrice: number;
  discountAmount: number;
  discountPercent: number;
  appliedTier?: IBulkDiscountTier | undefined;
  nextTier?:
    | {
        tier: IBulkDiscountTier;
        neededQty: number;
        pricePerUnit: number;
        discountPercent: number;
      }
    | undefined;
}

export interface ProductWithStock {
  id: string;
  name: string;
  category: string;
  description: string;
  deliveryMessage?: string | undefined;
  price: number;
  bulkDiscounts?: IBulkDiscountTier[] | undefined;
  deliveryType: DeliveryType;
  fileId?: string | undefined;
  fileUrl?: string | undefined;
  webhookUrl?: string | undefined;
  isActive: boolean;
  warrantyDuration?: number | undefined;
  warrantyUnit?: WarrantyUnit | undefined;
  maxClaims?: number | undefined;
  stockCount: number;
  soldCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveredLineItem {
  productId: string;
  productName: string;
  category: string;
  deliveryType: DeliveryType;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discountAmount?: number | undefined;
  itemContent?: string | undefined;
  fileId?: string | undefined;
  fileUrl?: string | undefined;
  dynamicResponse?: string | undefined;
  deliveryMessage?: string | undefined;
  warrantyExpiresAt?: Date | undefined;
  warrantyDuration?: number | undefined;
  warrantyUnit?: WarrantyUnit | undefined;
  maxClaims?: number | undefined;
}

export type PurchaseResult =
  | {
      success: true;
      order: DigitalOrderDocument;
      itemContent: string;
      productName: string;
      quantity: number;
      price: number;
      deliveryType: DeliveryType;
      fileId?: string | undefined;
      fileUrl?: string | undefined;
      dynamicResponse?: string | undefined;
      deliveryMessage?: string | undefined;
    }
  | {
      success: false;
      reason:
        | "PRODUCT_NOT_FOUND"
        | "PRODUCT_INACTIVE"
        | "OUT_OF_STOCK"
        | "INSUFFICIENT_BALANCE"
        | "INVALID_QUANTITY"
        | "INTERNAL_ERROR";
      message: string;
    };

export type CartCheckoutResult =
  | {
      success: true;
      order: DigitalOrderDocument;
      items: DeliveredLineItem[];
      totalQuantity: number;
      totalPrice: number;
      totalDiscount: number;
      remainingBalance: number;
    }
  | {
      success: false;
      reason:
        | "CART_EMPTY"
        | "CART_INVALID"
        | "OUT_OF_STOCK"
        | "INSUFFICIENT_BALANCE"
        | "INTERNAL_ERROR";
      message: string;
      validationErrors?: string[];
    };

// ============================================================================
//  Digital Product Service
// ============================================================================

export class DigitalProductService {
  /**
   * Computes effective wholesale / bulk pricing for a given quantity.
   */
  static calculatePricing(
    product: { price: number; bulkDiscounts?: IBulkDiscountTier[] | undefined },
    quantity: number
  ): BulkPricingResult {
    const safeQty = Math.max(1, Math.floor(quantity));
    const normalPrice = Math.max(0, product.price);
    const normalTotalPrice = normalPrice * safeQty;

    const tiers = Array.isArray(product.bulkDiscounts)
      ? [...product.bulkDiscounts]
          .filter((t) => t && typeof t.minQty === "number" && t.minQty >= 2 && typeof t.pricePerUnit === "number" && t.pricePerUnit >= 0)
          .sort((a, b) => a.minQty - b.minQty)
      : [];

    // Find all matching tiers where safeQty >= tier.minQty
    const matchingTiers = tiers.filter((t) => safeQty >= t.minQty);
    const appliedTier = matchingTiers.length > 0 ? matchingTiers[matchingTiers.length - 1] : undefined;

    let unitPrice = normalPrice;
    if (appliedTier && appliedTier.pricePerUnit < normalPrice) {
      unitPrice = appliedTier.pricePerUnit;
    }

    const totalPrice = unitPrice * safeQty;
    const discountAmount = Math.max(0, normalTotalPrice - totalPrice);
    const discountPercent =
      normalPrice > 0 ? Math.round(((normalPrice - unitPrice) / normalPrice) * 100) : 0;

    // Find next tier for upselling
    const nextTiers = tiers.filter((t) => t.minQty > safeQty && t.pricePerUnit < unitPrice);
    const nextTierDoc = nextTiers.length > 0 ? nextTiers[0] : undefined;
    let nextTier: BulkPricingResult["nextTier"] = undefined;
    if (nextTierDoc) {
      const nextDiscPct =
        normalPrice > 0
          ? Math.round(((normalPrice - nextTierDoc.pricePerUnit) / normalPrice) * 100)
          : 0;
      nextTier = {
        tier: nextTierDoc,
        neededQty: nextTierDoc.minQty - safeQty,
        pricePerUnit: nextTierDoc.pricePerUnit,
        discountPercent: nextDiscPct,
      };
    }

    return {
      unitPrice,
      totalPrice,
      normalPrice,
      normalTotalPrice,
      discountAmount,
      discountPercent,
      appliedTier: appliedTier && appliedTier.pricePerUnit < normalPrice ? appliedTier : undefined,
      nextTier,
    };
  }

  /**
   * Adds or updates a bulk discount tier for a product.
   */
  static async addBulkDiscountTier(
    productId: string,
    minQty: number,
    pricePerUnit: number
  ): Promise<DigitalProductDocument | null> {
    if (!Types.ObjectId.isValid(productId)) return null;

    const safeMinQty = Math.max(2, Math.floor(minQty));
    const safePrice = Math.max(0, Math.floor(pricePerUnit));

    const product = await DigitalProduct.findById(productId);
    if (!product) return null;

    const currentTiers: IBulkDiscountTier[] = (product.bulkDiscounts || []).filter(
      (t) => t.minQty !== safeMinQty
    );

    currentTiers.push({ minQty: safeMinQty, pricePerUnit: safePrice });
    currentTiers.sort((a, b) => a.minQty - b.minQty);

    product.bulkDiscounts = currentTiers;
    return await product.save();
  }

  /**
   * Removes a specific bulk discount tier by minQty.
   */
  static async removeBulkDiscountTier(
    productId: string,
    minQty: number
  ): Promise<DigitalProductDocument | null> {
    if (!Types.ObjectId.isValid(productId)) return null;

    const product = await DigitalProduct.findById(productId);
    if (!product) return null;

    product.bulkDiscounts = (product.bulkDiscounts || []).filter((t) => t.minQty !== minQty);
    return await product.save();
  }

  /**
   * Clears all bulk discount tiers for a product.
   */
  static async clearBulkDiscounts(productId: string): Promise<DigitalProductDocument | null> {
    if (!Types.ObjectId.isValid(productId)) return null;
    return await DigitalProduct.findByIdAndUpdate(
      productId,
      { $set: { bulkDiscounts: [] } },
      { returnDocument: "after" }
    );
  }

  /**
   * Creates a new digital product.
   */
  static async createProduct(data: {
    name: string;
    category?: string;
    description?: string;
    deliveryMessage?: string;
    price: number;
    bulkDiscounts?: IBulkDiscountTier[];
    deliveryType?: DeliveryType;
    fileId?: string;
    fileUrl?: string;
    webhookUrl?: string;
    apiHeader?: Record<string, string>;
    isActive?: boolean;
    warrantyDuration?: number;
    warrantyUnit?: WarrantyUnit;
    maxClaims?: number;
  }): Promise<DigitalProductDocument> {
    return await DigitalProduct.create({
      name: data.name.trim(),
      category: (data.category || "Umum").trim(),
      description: data.description?.trim() || "",
      deliveryMessage: data.deliveryMessage?.trim() || "",
      price: Math.max(0, Math.round(data.price)),
      bulkDiscounts: (data.bulkDiscounts || []).sort((a, b) => a.minQty - b.minQty),
      deliveryType: data.deliveryType || "CREDENTIAL",
      fileId: data.fileId?.trim() || undefined,
      fileUrl: data.fileUrl?.trim() || undefined,
      webhookUrl: data.webhookUrl?.trim() || undefined,
      apiHeader: data.apiHeader || undefined,
      isActive: data.isActive ?? true,
      warrantyDuration: Math.max(0, data.warrantyDuration ?? 0),
      warrantyUnit: data.warrantyUnit ?? "NONE",
      maxClaims: Math.max(0, data.maxClaims ?? 1),
    });
  }

  /**
   * Updates an existing product.
   */
  static async updateProduct(
    id: string,
    data: Partial<IDigitalProduct>
  ): Promise<DigitalProductDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return await DigitalProduct.findByIdAndUpdate(
      id,
      { $set: data },
      { returnDocument: "after", runValidators: true }
    );
  }

  /**
   * Deletes a product and its unsold stock items.
   */
  static async deleteProduct(id: string): Promise<{ deleted: boolean; stockDeleted: number }> {
    if (!Types.ObjectId.isValid(id)) return { deleted: false, stockDeleted: 0 };
    const res = await DigitalProduct.findByIdAndDelete(id);
    if (!res) return { deleted: false, stockDeleted: 0 };

    const stockRes = await DigitalStock.deleteMany({ productId: id, isSold: false });
    return { deleted: true, stockDeleted: stockRes.deletedCount ?? 0 };
  }

  /**
   * Retrieves list of all distinct active categories.
   */
  static async getActiveCategories(): Promise<string[]> {
    const categories = await DigitalProduct.distinct("category", { isActive: true });
    return categories.filter((c): c is string => typeof c === "string" && c.trim().length > 0).sort();
  }

  /**
   * Retrieves all distinct categories (including inactive products).
   */
  static async getAllCategories(): Promise<string[]> {
    const categories = await DigitalProduct.distinct("category", {});
    return categories.filter((c): c is string => typeof c === "string" && c.trim().length > 0).sort();
  }

  /**
   * Fetches all products with calculated stock counts.
   */
  static async getAllProducts(options: { onlyActive?: boolean; category?: string } = {}): Promise<ProductWithStock[]> {
    const query: any = {};
    if (options.onlyActive) query.isActive = true;
    if (options.category) query.category = options.category;

    const products = await DigitalProduct.find(query).sort({ category: 1, name: 1 }).lean();
    if (products.length === 0) return [];

    const productIds = products.map((p) => p._id);

    // Aggregate available (unsold) stock count
    const unsoldCounts = await DigitalStock.aggregate([
      { $match: { productId: { $in: productIds }, isSold: false } },
      { $group: { _id: "$productId", count: { $sum: 1 } } },
    ]);

    // Aggregate sold count
    const soldCounts = await DigitalStock.aggregate([
      { $match: { productId: { $in: productIds }, isSold: true } },
      { $group: { _id: "$productId", count: { $sum: 1 } } },
    ]);

    const unsoldMap = new Map<string, number>();
    for (const item of unsoldCounts) {
      unsoldMap.set(String(item._id), item.count);
    }

    const soldMap = new Map<string, number>();
    for (const item of soldCounts) {
      soldMap.set(String(item._id), item.count);
    }

    return products.map((p) => {
      const pidStr = String(p._id);
      const deliveryType: DeliveryType = p.deliveryType || "CREDENTIAL";
      const stockCount = deliveryType === "CREDENTIAL" ? (unsoldMap.get(pidStr) ?? 0) : 9999;

      return {
        id: pidStr,
        name: p.name,
        category: p.category,
        description: p.description || "",
        deliveryMessage: p.deliveryMessage || "",
        price: p.price,
        bulkDiscounts: p.bulkDiscounts || [],
        deliveryType,
        fileId: p.fileId,
        fileUrl: p.fileUrl,
        webhookUrl: p.webhookUrl,
        isActive: p.isActive,
        warrantyDuration: p.warrantyDuration ?? 0,
        warrantyUnit: p.warrantyUnit ?? "NONE",
        maxClaims: p.maxClaims ?? 1,
        stockCount,
        soldCount: soldMap.get(pidStr) ?? 0,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }

  /**
   * Fetches a single product with stock count.
   */
  static async getProductWithStock(id: string): Promise<ProductWithStock | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const p = await DigitalProduct.findById(id).lean();
    if (!p) return null;

    const pidStr = String(p._id);
    const deliveryType: DeliveryType = p.deliveryType || "CREDENTIAL";
    const stockCount =
      deliveryType === "CREDENTIAL"
        ? await DigitalStock.countDocuments({ productId: p._id, isSold: false })
        : 9999;
    const soldCount = await DigitalStock.countDocuments({ productId: p._id, isSold: true });

    return {
      id: pidStr,
      name: p.name,
      category: p.category,
      description: p.description || "",
      deliveryMessage: p.deliveryMessage || "",
      price: p.price,
      bulkDiscounts: p.bulkDiscounts || [],
      deliveryType,
      fileId: p.fileId,
      fileUrl: p.fileUrl,
      webhookUrl: p.webhookUrl,
      isActive: p.isActive,
      warrantyDuration: p.warrantyDuration ?? 0,
      warrantyUnit: p.warrantyUnit ?? "NONE",
      maxClaims: p.maxClaims ?? 1,
      stockCount,
      soldCount,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /**
   * Bulk adds stock items from multi-line text.
   * Splits on newlines, trims each item, ignores empty lines.
   */
  static async addStockBulk(
    productId: string,
    rawText: string,
    api?: Api
  ): Promise<{ added: number; lines: string[] }> {
    if (!Types.ObjectId.isValid(productId)) {
      throw new Error("Invalid product ID");
    }

    const product = await DigitalProduct.findById(productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return { added: 0, lines: [] };
    }

    const docs = lines.map((content) => ({
      productId: product._id,
      content,
      isSold: false,
      createdAt: new Date(),
    }));

    await DigitalStock.insertMany(docs);

    // ── Restock Alert Notifications ─────────────────────────────────────────
    if (api) {
      try {
        const alerts = await RestockAlert.find({ productId: product._id }).lean();
        if (alerts.length > 0) {
          const notifyText =
            `🔔 <b>Stok Kembali Tersedia!</b>\n\n` +
            `📦 Produk yang kamu pantau sudah restock:\n` +
            `<b>${product.name}</b>\n\n` +
            `<i>Segera beli sebelum kehabisan! Klik tombol di bawah untuk melihat katalog.</i>`;

          const { InlineKeyboard } = await import("grammy");
          const kb = new InlineKeyboard().text("🛍️ Lihat Produk", "product_digital");

          for (const alert of alerts) {
            api.sendMessage(alert.chatId, notifyText, {
              parse_mode: "HTML",
              reply_markup: kb,
            }).catch((err) =>
              console.error(`[digitalProduct] Restock notify failed for ${alert.userId}:`, err)
            );
          }

          // Delete resolved alerts
          await RestockAlert.deleteMany({ productId: product._id });
          console.log(`[digitalProduct] Restock: notified ${alerts.length} user(s) for ${product.name}`);
        }
      } catch (err) {
        console.error("[digitalProduct] Restock alert error:", err);
      }
    }

    return { added: docs.length, lines };
  }

  /**
   * Retrieves unsold stock items for admin inspection.
   */
  static async getUnsoldStock(productId: string, limit = 50): Promise<DigitalStockDocument[]> {
    if (!Types.ObjectId.isValid(productId)) return [];
    return await DigitalStock.find({ productId, isSold: false })
      .sort({ createdAt: 1 })
      .limit(limit);
  }

  /**
   * Retrieves count of unsold stock for a product.
   */
  static async getUnsoldStockCount(productId: string): Promise<number> {
    if (!Types.ObjectId.isValid(productId)) return 0;
    return await DigitalStock.countDocuments({ productId, isSold: false });
  }

  /**
   * Removes all unsold stock items for a product.
   */
  static async clearUnsoldStock(productId: string): Promise<number> {
    if (!Types.ObjectId.isValid(productId)) return 0;
    const res = await DigitalStock.deleteMany({ productId, isSold: false });
    return res.deletedCount ?? 0;
  }

  /**
   * Deletes a single specific unsold stock item by its ID.
   */
  static async deleteStockItem(stockId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(stockId)) return false;
    const res = await DigitalStock.findOneAndDelete({ _id: stockId, isSold: false });
    return res !== null;
  }

  /**
   * Takes a single specific unsold stock item by its ID, removes it from stock, and returns it.
   */
  static async takeStockItem(stockId: string): Promise<DigitalStockDocument | null> {
    if (!Types.ObjectId.isValid(stockId)) return null;
    return await DigitalStock.findOneAndDelete({ _id: stockId, isSold: false });
  }

  /**
   * Takes up to `quantity` unsold stock items (FIFO - oldest first) for a product,
   * removes them from stock atomically, and returns the taken items.
   */
  static async takeStockBulk(productId: string, quantity: number): Promise<DigitalStockDocument[]> {
    if (!Types.ObjectId.isValid(productId) || quantity <= 0) return [];
    const safeQty = Math.min(Math.floor(quantity), 500);
    const items = await DigitalStock.find({ productId, isSold: false })
      .sort({ createdAt: 1 })
      .limit(safeQty);
    if (items.length === 0) return [];

    const ids = items.map((i) => i._id);
    await DigitalStock.deleteMany({ _id: { $in: ids } });
    return items;
  }

  /**
   * Retrieves paginated unsold stock items for a product.
   */
  static async getUnsoldStockPaginated(
    productId: string,
    page: number = 0,
    limit: number = 5
  ): Promise<{
    items: DigitalStockDocument[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    if (!Types.ObjectId.isValid(productId)) {
      return { items: [], total: 0, page: 0, totalPages: 0 };
    }
    const safePage = Math.max(0, page);
    const total = await DigitalStock.countDocuments({ productId, isSold: false });
    const totalPages = Math.ceil(total / limit);

    const items = await DigitalStock.find({ productId, isSold: false })
      .sort({ createdAt: 1 })
      .skip(safePage * limit)
      .limit(limit);

    return { items, total, page: safePage, totalPages };
  }

  /**
   * Retrieves a single stock item by ID.
   */
  static async getSingleStockItem(stockId: string): Promise<DigitalStockDocument | null> {
    if (!Types.ObjectId.isValid(stockId)) return null;
    return await DigitalStock.findById(stockId);
  }

  /**
   * Executes a safe atomic purchase of a digital product for a user:
   * 1. Validates quantity (must be positive integer >= 1).
   * 2. Validates product exists and is active.
   * 3. Calculates effective wholesale / bulk price based on quantity.
   * 4. Checks user balance against total price.
   * 5. Atomically acquires N unsold stock items for CREDENTIAL (or resolves FILE/API/PREORDER).
   * 6. Deducts user balance and increments totalOrders.
   * 7. Creates DigitalOrder record with multi-format items.
   * 8. Returns order and delivered stock content.
   */
  static async purchaseProduct(
    productId: string,
    telegramId: string,
    quantity: number = 1
  ): Promise<PurchaseResult> {
    // ── 1. Anti-abuse validation for quantity ───────────────────────────────
    const safeQty = Math.floor(Number(quantity));
    if (isNaN(safeQty) || !Number.isInteger(safeQty) || safeQty <= 0) {
      return {
        success: false,
        reason: "INVALID_QUANTITY",
        message: "Jumlah pembelian tidak valid. Minimal pembelian adalah 1 item.",
      };
    }

    if (!Types.ObjectId.isValid(productId)) {
      return {
        success: false,
        reason: "PRODUCT_NOT_FOUND",
        message: "Produk tidak ditemukan.",
      };
    }

    const product = await DigitalProduct.findById(productId);
    if (!product) {
      return {
        success: false,
        reason: "PRODUCT_NOT_FOUND",
        message: "Produk tidak ditemukan.",
      };
    }

    if (!product.isActive) {
      return {
        success: false,
        reason: "PRODUCT_INACTIVE",
        message: "Produk ini sedang dinonaktifkan oleh admin.",
      };
    }

    const deliveryType: DeliveryType = product.deliveryType || "CREDENTIAL";
    const pricing = DigitalProductService.calculatePricing(product, safeQty);
    const totalPrice = pricing.totalPrice;

    // Check user balance
    const user = await User.findOne({ telegramId });
    if (!user) {
      return {
        success: false,
        reason: "INTERNAL_ERROR",
        message: "Akun pengguna tidak ditemukan di database.",
      };
    }

    if (user.balance < totalPrice) {
      return {
        success: false,
        reason: "INSUFFICIENT_BALANCE",
        message: `Saldo tidak mencukupi. Saldo kamu: Rp ${user.balance.toLocaleString("id-ID")}, Total (${safeQty}x): Rp ${totalPrice.toLocaleString("id-ID")}.`,
      };
    }

    const orderId = `DIGI-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const acquiredItems: DigitalStockDocument[] = [];
    let formattedContent = "";
    let dynamicResponse: string | undefined = undefined;

    // ── 2. Handle Delivery Type Fulfillment ─────────────────────────────────
    if (deliveryType === "CREDENTIAL") {
      // Atomically acquire N unsold stock items (FIFO)
      for (let i = 0; i < safeQty; i++) {
        const acquired = await DigitalStock.findOneAndUpdate(
          {
            productId: product._id,
            isSold: false,
            _id: { $nin: acquiredItems.map((a) => a._id) },
          },
          {
            $set: {
              isSold: true,
              soldTo: telegramId,
              soldAt: new Date(),
              orderId,
            },
          },
          {
            sort: { createdAt: 1 },
            returnDocument: "after",
          }
        );

        if (!acquired) break;
        acquiredItems.push(acquired);
      }

      if (acquiredItems.length < safeQty) {
        // Rollback any acquired items if full quantity could not be fulfilled
        if (acquiredItems.length > 0) {
          await DigitalStock.updateMany(
            { _id: { $in: acquiredItems.map((a) => a._id) } },
            {
              $set: {
                isSold: false,
                soldTo: undefined,
                soldAt: undefined,
                orderId: undefined,
              },
            }
          );
        }

        return {
          success: false,
          reason: "OUT_OF_STOCK",
          message:
            acquiredItems.length === 0
              ? "Maaf, stok produk ini baru saja habis."
              : `Maaf, stok tidak mencukupi untuk jumlah ${safeQty} item. Stok tersisa hanya ${acquiredItems.length} item.`,
        };
      }

      formattedContent =
        acquiredItems.length === 1
          ? acquiredItems[0]!.content
          : acquiredItems.map((item, idx) => `[Item #${idx + 1}]\n${item.content}`).join("\n\n");
    } else if (deliveryType === "FILE") {
      formattedContent = product.fileUrl || product.fileId || "📁 File terlampir (akan dikirimkan otomatis).";
    } else if (deliveryType === "DYNAMIC_API") {
      if (product.webhookUrl) {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...(typeof product.apiHeader === "object" ? product.apiHeader : {}),
          };
          const response = await fetch(product.webhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              orderId,
              userId: telegramId,
              productId: String(product._id),
              productName: product.name,
              quantity: safeQty,
            }),
            signal: AbortSignal.timeout(6000),
          });
          const resJson: any = await response.json().catch(() => null);
          dynamicResponse = resJson?.content || resJson?.key || resJson?.token || JSON.stringify(resJson) || "Success";
          formattedContent = dynamicResponse!;
        } catch (err) {
          console.error(`[digitalProduct] DYNAMIC_API webhook error:`, err);
          dynamicResponse = `GEN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
          formattedContent = `⚡ Token/Lisensi: ${dynamicResponse}`;
        }
      } else {
        dynamicResponse = `KEY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        formattedContent = `⚡ Kode Akses / Serial: ${dynamicResponse}`;
      }
    } else if (deliveryType === "MANUAL_PREORDER") {
      formattedContent = "⏳ Pesanan Pre-Order diterima. Admin akan memproses pesanan Anda secara manual secepatnya.";
    }

    // ── 3. Atomically Deduct Balance ────────────────────────────────────────
    const updatedUser = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: totalPrice } },
      {
        $inc: {
          balance: -totalPrice,
          totalOrders: safeQty,
        },
      },
      { returnDocument: "after" }
    );

    if (!updatedUser) {
      // Rollback acquired items if user balance deduction failed
      if (acquiredItems.length > 0) {
        await DigitalStock.updateMany(
          { _id: { $in: acquiredItems.map((a) => a._id) } },
          {
            $set: {
              isSold: false,
              soldTo: undefined,
              soldAt: undefined,
              orderId: undefined,
            },
          }
        );
      }

      return {
        success: false,
        reason: "INSUFFICIENT_BALANCE",
        message: "Gagal memotong saldo. Pastikan saldo kamu mencukupi.",
      };
    }

    // Create balance audit log
    await BalanceLog.create({
      userId: telegramId,
      type: "PURCHASE",
      amount: totalPrice,
      balanceBefore: user.balance,
      balanceAfter: updatedUser.balance,
      reason: `Beli ${product.name} (${safeQty}x)`,
    });

    // Compute warranty expiry
    const now = new Date();
    const warrantyExpiresAt = WarrantyService.calculateExpiryDate(
      now,
      product.warrantyDuration,
      product.warrantyUnit
    );

    const singleOrderItem: IDigitalOrderItem = {
      productId: product._id,
      productName: product.name,
      category: product.category,
      deliveryType,
      quantity: safeQty,
      unitPrice: pricing.unitPrice,
      totalPrice: totalPrice,
      discountAmount: pricing.discountAmount,
      itemContent: formattedContent,
      fileId: product.fileId,
      fileUrl: product.fileUrl,
      dynamicResponse,
      deliveryMessage: product.deliveryMessage || "",
      warrantyDuration: product.warrantyDuration ?? 0,
      warrantyUnit: product.warrantyUnit ?? "NONE",
      warrantyExpiresAt,
      maxClaims: product.maxClaims ?? 1,
      claimsCount: 0,
    };
    if (pricing.appliedTier) {
      singleOrderItem.bulkTierMinQty = pricing.appliedTier.minQty;
    }

    // Create DigitalOrder document
    const orderData: any = {
      orderId,
      userId: telegramId,
      items: [singleOrderItem],
      productId: product._id,
      productName: product.name,
      quantity: safeQty,
      price: totalPrice,
      unitPrice: pricing.unitPrice,
      discountAmount: pricing.discountAmount,
      itemContent: formattedContent,
      deliveryMessage: product.deliveryMessage || "",
      warrantyDuration: product.warrantyDuration ?? 0,
      warrantyUnit: product.warrantyUnit ?? "NONE",
      maxClaims: product.maxClaims ?? 1,
      claimsCount: 0,
      createdAt: now,
    };
    if (pricing.appliedTier) {
      orderData.bulkTierMinQty = pricing.appliedTier.minQty;
    }
    if (warrantyExpiresAt) {
      orderData.warrantyExpiresAt = warrantyExpiresAt;
    }

    const order = await DigitalOrder.create(orderData);

    return {
      success: true,
      order,
      itemContent: formattedContent,
      productName: product.name,
      quantity: safeQty,
      price: totalPrice,
      deliveryType,
      fileId: product.fileId,
      fileUrl: product.fileUrl,
      dynamicResponse,
      deliveryMessage: product.deliveryMessage || "",
    };
  }

  /**
   * Executes an atomic multi-item checkout from the user's shopping cart:
   * 1. Validates all cart items and stock in real-time.
   * 2. Checks user balance against total cart price (accounting for any promo discount).
   * 3. Atomically acquires stock for all CREDENTIAL items (rollback on any failure).
   * 4. Resolves FILE, DYNAMIC_API, and MANUAL_PREORDER delivery payloads.
   * 5. Atomically deducts user balance & creates audit BalanceLog.
   * 6. Creates a single DigitalOrder containing all line items.
   * 7. Empties the user's shopping cart.
   * 8. Returns comprehensive checkout summary with line items.
   */
  static async checkoutCart(
    userId: string,
    options?: { promoCode?: string; promoDiscountAmount?: number }
  ): Promise<CartCheckoutResult> {
    const user = await User.findOne({ telegramId: userId });
    if (!user) {
      return {
        success: false,
        reason: "INTERNAL_ERROR",
        message: "Akun pengguna tidak ditemukan di database.",
      };
    }

    const cartSummary = await CartService.getCartSummary(userId);
    if (cartSummary.items.length === 0) {
      return {
        success: false,
        reason: "CART_EMPTY",
        message: "Keranjang belanja Anda masih kosong.",
      };
    }

    if (!cartSummary.isCartValid) {
      return {
        success: false,
        reason: "CART_INVALID",
        message: "Beberapa produk di keranjang Anda mengalami perubahan ketersediaan atau stok.",
        validationErrors: cartSummary.validationErrors,
      };
    }

    const promoDiscount = Math.max(0, options?.promoDiscountAmount || 0);
    const grandTotal = Math.max(0, cartSummary.totalPrice - promoDiscount);

    if (user.balance < grandTotal) {
      return {
        success: false,
        reason: "INSUFFICIENT_BALANCE",
        message: `Saldo tidak mencukupi. Saldo kamu: Rp ${user.balance.toLocaleString("id-ID")}, Total Bayar: Rp ${grandTotal.toLocaleString("id-ID")}.`,
      };
    }

    const orderId = `DIGI-CART-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const now = new Date();

    const allAcquiredStockDocs: DigitalStockDocument[] = [];
    const orderLineItems: IDigitalOrderItem[] = [];
    const deliveredLineItems: DeliveredLineItem[] = [];

    // ── Acquire stock & prepare fulfillment for all line items ───────────────
    for (const item of cartSummary.items) {
      const product = await DigitalProduct.findById(item.productId);
      if (!product || !product.isActive) {
        // Rollback already acquired stocks
        if (allAcquiredStockDocs.length > 0) {
          await DigitalStock.updateMany(
            { _id: { $in: allAcquiredStockDocs.map((s) => s._id) } },
            { $set: { isSold: false, soldTo: undefined, soldAt: undefined, orderId: undefined } }
          );
        }
        return {
          success: false,
          reason: "OUT_OF_STOCK",
          message: `Produk "${item.productName}" sudah tidak tersedia.`,
        };
      }

      const deliveryType: DeliveryType = product.deliveryType || "CREDENTIAL";
      let formattedContent = "";
      let dynamicResponse: string | undefined = undefined;

      if (deliveryType === "CREDENTIAL") {
        const itemStocks: DigitalStockDocument[] = [];
        for (let i = 0; i < item.quantity; i++) {
          const acquired = await DigitalStock.findOneAndUpdate(
            {
              productId: product._id,
              isSold: false,
              _id: { $nin: allAcquiredStockDocs.map((s) => s._id) },
            },
            {
              $set: {
                isSold: true,
                soldTo: userId,
                soldAt: now,
                orderId,
              },
            },
            {
              sort: { createdAt: 1 },
              returnDocument: "after",
            }
          );

          if (!acquired) break;
          itemStocks.push(acquired);
          allAcquiredStockDocs.push(acquired);
        }

        if (itemStocks.length < item.quantity) {
          // Rollback ALL acquired stocks across the entire cart
          if (allAcquiredStockDocs.length > 0) {
            await DigitalStock.updateMany(
              { _id: { $in: allAcquiredStockDocs.map((s) => s._id) } },
              { $set: { isSold: false, soldTo: undefined, soldAt: undefined, orderId: undefined } }
            );
          }

          return {
            success: false,
            reason: "OUT_OF_STOCK",
            message: `Stok untuk "${product.name}" tidak mencukupi untuk jumlah ${item.quantity} item.`,
          };
        }

        formattedContent =
          itemStocks.length === 1
            ? itemStocks[0]!.content
            : itemStocks.map((s, idx) => `[Item #${idx + 1}]\n${s.content}`).join("\n\n");
      } else if (deliveryType === "FILE") {
        formattedContent = product.fileUrl || product.fileId || "📁 File terlampir (dikirim otomatis).";
      } else if (deliveryType === "DYNAMIC_API") {
        if (product.webhookUrl) {
          try {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              ...(typeof product.apiHeader === "object" ? product.apiHeader : {}),
            };
            const response = await fetch(product.webhookUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                orderId,
                userId,
                productId: String(product._id),
                productName: product.name,
                quantity: item.quantity,
              }),
              signal: AbortSignal.timeout(6000),
            });
            const resJson: any = await response.json().catch(() => null);
            dynamicResponse = resJson?.content || resJson?.key || resJson?.token || JSON.stringify(resJson) || "Success";
            formattedContent = dynamicResponse!;
          } catch (err) {
            console.error(`[digitalProduct] DYNAMIC_API webhook error for ${product.name}:`, err);
            dynamicResponse = `GEN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            formattedContent = `⚡ Token/Lisensi: ${dynamicResponse}`;
          }
        } else {
          dynamicResponse = `KEY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
          formattedContent = `⚡ Kode Akses / Serial: ${dynamicResponse}`;
        }
      } else if (deliveryType === "MANUAL_PREORDER") {
        formattedContent = "⏳ Pesanan Pre-Order diterima. Admin akan memproses pesanan Anda secara manual secepatnya.";
      }

      const warrantyExpiresAt = WarrantyService.calculateExpiryDate(
        now,
        product.warrantyDuration,
        product.warrantyUnit
      );

      const lineItem: IDigitalOrderItem = {
        productId: product._id,
        productName: product.name,
        category: product.category,
        deliveryType,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.lineTotalPrice,
        discountAmount: item.discountAmount,
        itemContent: formattedContent,
        fileId: product.fileId,
        fileUrl: product.fileUrl,
        dynamicResponse,
        deliveryMessage: product.deliveryMessage || "",
        warrantyDuration: product.warrantyDuration ?? 0,
        warrantyUnit: product.warrantyUnit ?? "NONE",
        warrantyExpiresAt,
        maxClaims: product.maxClaims ?? 1,
        claimsCount: 0,
      };

      orderLineItems.push(lineItem);
      deliveredLineItems.push({
        productId: String(product._id),
        productName: product.name,
        category: product.category,
        deliveryType,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.lineTotalPrice,
        discountAmount: item.discountAmount,
        itemContent: formattedContent,
        fileId: product.fileId,
        fileUrl: product.fileUrl,
        dynamicResponse,
        deliveryMessage: product.deliveryMessage || "",
        warrantyExpiresAt,
        warrantyDuration: product.warrantyDuration,
        warrantyUnit: product.warrantyUnit,
        maxClaims: product.maxClaims,
      });
    }

    // ── Atomically Deduct User Balance ──────────────────────────────────────
    const updatedUser = await User.findOneAndUpdate(
      { telegramId: userId, balance: { $gte: grandTotal } },
      {
        $inc: {
          balance: -grandTotal,
          totalOrders: cartSummary.totalQuantity,
        },
      },
      { returnDocument: "after" }
    );

    if (!updatedUser) {
      // Rollback all acquired stock items if deduction failed
      if (allAcquiredStockDocs.length > 0) {
        await DigitalStock.updateMany(
          { _id: { $in: allAcquiredStockDocs.map((s) => s._id) } },
          { $set: { isSold: false, soldTo: undefined, soldAt: undefined, orderId: undefined } }
        );
      }

      return {
        success: false,
        reason: "INSUFFICIENT_BALANCE",
        message: "Gagal memotong saldo. Pastikan saldo kamu mencukupi.",
      };
    }

    // Create BalanceLog audit entry
    await BalanceLog.create({
      userId,
      type: "PURCHASE",
      amount: grandTotal,
      balanceBefore: user.balance,
      balanceAfter: updatedUser.balance,
      reason: `Checkout keranjang (${cartSummary.totalQuantity} item, ${orderLineItems.length} jenis produk)`,
    });

    // ── Create Unified DigitalOrder Record ──────────────────────────────────
    const primaryItem = orderLineItems[0]!;
    const order = await DigitalOrder.create({
      orderId,
      userId,
      items: orderLineItems,
      productId: primaryItem.productId,
      productName:
        orderLineItems.length === 1
          ? primaryItem.productName
          : `${primaryItem.productName} + ${orderLineItems.length - 1} produk lainnya`,
      quantity: cartSummary.totalQuantity,
      price: grandTotal,
      unitPrice: primaryItem.unitPrice,
      discountAmount: cartSummary.totalDiscount + promoDiscount,
      itemContent: orderLineItems.map((i) => `[${i.productName} (${i.quantity}x)]\n${i.itemContent}`).join("\n\n"),
      deliveryMessage: primaryItem.deliveryMessage || "",
      warrantyDuration: primaryItem.warrantyDuration,
      warrantyUnit: primaryItem.warrantyUnit,
      warrantyExpiresAt: primaryItem.warrantyExpiresAt,
      maxClaims: primaryItem.maxClaims,
      claimsCount: 0,
      createdAt: now,
    });

    // ── Empty Cart ──────────────────────────────────────────────────────────
    await CartService.clearCart(userId);

    return {
      success: true,
      order,
      items: deliveredLineItems,
      totalQuantity: cartSummary.totalQuantity,
      totalPrice: grandTotal,
      totalDiscount: cartSummary.totalDiscount + promoDiscount,
      remainingBalance: updatedUser.balance,
    };
  }

  /**
   * Retrieves purchase history of a user.
   */
  static async getUserOrders(telegramId: string, limit = 15): Promise<DigitalOrderDocument[]> {
    return await DigitalOrder.find({ userId: telegramId })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  /**
   * Retrieves a specific digital order by orderId.
   */
  static async getOrderByOrderId(orderId: string): Promise<DigitalOrderDocument | null> {
    return await DigitalOrder.findOne({ orderId });
  }

  /**
   * Overall platform stats for digital sales.
   */
  static async getPlatformStats(): Promise<{
    totalProducts: number;
    activeProducts: number;
    totalCategories: number;
    totalStockAvailable: number;
    totalStockSold: number;
    totalRevenue: number;
  }> {
    const totalProducts = await DigitalProduct.countDocuments();
    const activeProducts = await DigitalProduct.countDocuments({ isActive: true });
    const categories = await DigitalProduct.distinct("category");
    const totalStockAvailable = await DigitalStock.countDocuments({ isSold: false });
    const totalStockSold = await DigitalStock.countDocuments({ isSold: true });

    const revenueRes = await DigitalOrder.aggregate([
      { $group: { _id: null, total: { $sum: "$price" } } },
    ]);
    const totalRevenue = revenueRes[0]?.total ?? 0;

    return {
      totalProducts,
      activeProducts,
      totalCategories: categories.length,
      totalStockAvailable,
      totalStockSold,
      totalRevenue,
    };
  }
}
