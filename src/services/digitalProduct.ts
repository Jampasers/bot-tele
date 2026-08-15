import { Types } from "mongoose";
import { DigitalProduct, IDigitalProduct, DigitalProductDocument } from "../models/DigitalProduct.js";
import { DigitalStock, IDigitalStock, DigitalStockDocument } from "../models/DigitalStock.js";
import { DigitalOrder, IDigitalOrder, DigitalOrderDocument } from "../models/DigitalOrder.js";
import { User } from "../models/User.js";

// ============================================================================
//  DTOs & Return Types
// ============================================================================

export interface ProductWithStock {
  id: string;
  name: string;
  category: string;
  description: string;
  price: number;
  isActive: boolean;
  stockCount: number;
  soldCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PurchaseResult =
  | {
      success: true;
      order: DigitalOrderDocument;
      itemContent: string;
      productName: string;
      quantity: number;
      price: number;
    }
  | {
      success: false;
      reason: "PRODUCT_NOT_FOUND" | "PRODUCT_INACTIVE" | "OUT_OF_STOCK" | "INSUFFICIENT_BALANCE" | "INVALID_QUANTITY" | "INTERNAL_ERROR";
      message: string;
    };

// ============================================================================
//  Digital Product Service
// ============================================================================

export class DigitalProductService {
  /**
   * Creates a new digital product.
   */
  static async createProduct(data: {
    name: string;
    category?: string;
    description?: string;
    price: number;
    isActive?: boolean;
  }): Promise<DigitalProductDocument> {
    return await DigitalProduct.create({
      name: data.name.trim(),
      category: (data.category || "Umum").trim(),
      description: data.description?.trim() || "",
      price: Math.max(0, Math.round(data.price)),
      isActive: data.isActive ?? true,
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
      { new: true, runValidators: true }
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
      return {
        id: pidStr,
        name: p.name,
        category: p.category,
        description: p.description || "",
        price: p.price,
        isActive: p.isActive,
        stockCount: unsoldMap.get(pidStr) ?? 0,
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
    const stockCount = await DigitalStock.countDocuments({ productId: p._id, isSold: false });
    const soldCount = await DigitalStock.countDocuments({ productId: p._id, isSold: true });

    return {
      id: pidStr,
      name: p.name,
      category: p.category,
      description: p.description || "",
      price: p.price,
      isActive: p.isActive,
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
  static async addStockBulk(productId: string, rawText: string): Promise<{ added: number; lines: string[] }> {
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
   * Executes a safe atomic purchase of a digital product for a user:
   * 1. Validates quantity (must be positive integer >= 1).
   * 2. Validates product exists and is active.
   * 3. Checks user balance against total price (price * quantity).
   * 4. Atomically acquires N unsold stock items (FIFO).
   * 5. Deducts user balance and increments totalOrders.
   * 6. Creates DigitalOrder record.
   * 7. Returns order and delivered stock content.
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

    const totalPrice = product.price * safeQty;

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

    // Atomically acquire N unsold stock items (FIFO)
    const acquiredItems: DigitalStockDocument[] = [];
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
          new: true,
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

    // Atomically deduct user balance (with balance guard)
    const updatedUser = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: totalPrice } },
      {
        $inc: {
          balance: -totalPrice,
          totalOrders: safeQty,
        },
      },
      { new: true }
    );

    if (!updatedUser) {
      // Rollback acquired items if user balance deduction failed (e.g. race condition)
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

      return {
        success: false,
        reason: "INSUFFICIENT_BALANCE",
        message: "Gagal memotong saldo. Pastikan saldo kamu mencukupi.",
      };
    }

    // Format delivered items
    const formattedContent =
      acquiredItems.length === 1
        ? acquiredItems[0]!.content
        : acquiredItems.map((item, idx) => `[Item #${idx + 1}]\n${item.content}`).join("\n\n");

    // Create DigitalOrder document
    const order = await DigitalOrder.create({
      orderId,
      userId: telegramId,
      productId: product._id,
      productName: product.name,
      quantity: safeQty,
      price: totalPrice,
      itemContent: formattedContent,
      createdAt: new Date(),
    });

    return {
      success: true,
      order,
      itemContent: formattedContent,
      productName: product.name,
      quantity: safeQty,
      price: totalPrice,
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
