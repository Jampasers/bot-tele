import { Types } from "mongoose";
import { Cart, ICart, ICartItem, CartDocument } from "../models/Cart.js";
import { DigitalProduct, IDigitalProduct, DigitalProductDocument, DeliveryType } from "../models/DigitalProduct.js";
import { DigitalStock } from "../models/DigitalStock.js";
import { DigitalProductService, BulkPricingResult } from "./digitalProduct.js";

// ============================================================================
//  Types & Interfaces
// ============================================================================

export interface CartItemSummary {
  productId: string;
  variantId?: string | undefined;
  productName: string;
  category: string;
  deliveryType: DeliveryType;
  quantity: number;
  unitPrice: number;
  normalUnitPrice: number;
  lineTotalPrice: number;
  lineNormalPrice: number;
  discountAmount: number;
  discountPercent: number;
  bulkTierApplied?: boolean | undefined;
  availableStock: number;
  isAvailable: boolean;
  unavailableReason?: string | undefined;
  fileId?: string | undefined;
  fileUrl?: string | undefined;
}

export interface CartSummary {
  userId: string;
  items: CartItemSummary[];
  totalQuantity: number;
  totalUniqueItems: number;
  totalRawPrice: number;
  totalDiscount: number;
  totalPrice: number;
  isCartValid: boolean;
  validationErrors: string[];
}

export type CartOperationResult =
  | {
      success: true;
      cart: CartSummary;
      message: string;
    }
  | {
      success: false;
      reason:
        | "PRODUCT_NOT_FOUND"
        | "PRODUCT_INACTIVE"
        | "OUT_OF_STOCK"
        | "EXCEEDS_STOCK"
        | "INVALID_QUANTITY"
        | "CART_EMPTY"
        | "INTERNAL_ERROR";
      message: string;
    };

// ============================================================================
//  Cart Service
// ============================================================================

export class CartService {
  /**
   * Adds a product to the user's shopping cart or increases quantity.
   */
  static async addToCart(
    userId: string,
    productId: string,
    quantity: number = 1,
    variantId?: string
  ): Promise<CartOperationResult> {
    const safeQty = Math.max(1, Math.floor(Number(quantity)));
    if (isNaN(safeQty) || safeQty <= 0) {
      return {
        success: false,
        reason: "INVALID_QUANTITY",
        message: "Jumlah produk tidak valid.",
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
        message: "Produk tidak ditemukan di katalog.",
      };
    }

    if (!product.isActive) {
      return {
        success: false,
        reason: "PRODUCT_INACTIVE",
        message: `Produk "${product.name}" sedang dinonaktifkan oleh admin.`,
      };
    }

    const deliveryType: DeliveryType = product.deliveryType || "CREDENTIAL";

    // Real-time stock check for CREDENTIAL products
    let availableStock = 999999;
    if (deliveryType === "CREDENTIAL") {
      availableStock = await DigitalStock.countDocuments({
        productId: product._id,
        isSold: false,
      });

      if (availableStock <= 0) {
        return {
          success: false,
          reason: "OUT_OF_STOCK",
          message: `Maaf, stok untuk "${product.name}" sedang habis.`,
        };
      }
    }

    let cart = await Cart.findOne({ userId });
    if (!cart) {
      cart = new Cart({ userId, items: [] });
    }

    const itemIdx = cart.items.findIndex(
      (item) =>
        String(item.productId) === String(product._id) &&
        (variantId ? item.variantId === variantId : !item.variantId)
    );

    const currentQtyInCart = itemIdx >= 0 ? cart.items[itemIdx]!.quantity : 0;
    const newTargetQty = currentQtyInCart + safeQty;

    if (deliveryType === "CREDENTIAL" && newTargetQty > availableStock) {
      return {
        success: false,
        reason: "EXCEEDS_STOCK",
        message: `Stok tidak mencukupi. Anda sudah memiliki ${currentQtyInCart} item di keranjang dan stok tersisa hanya ${availableStock} item.`,
      };
    }

    if (itemIdx >= 0) {
      cart.items[itemIdx]!.quantity = newTargetQty;
      cart.items[itemIdx]!.priceAtAdded = product.price;
    } else {
      cart.items.push({
        productId: product._id,
        variantId,
        quantity: safeQty,
        priceAtAdded: product.price,
        addedAt: new Date(),
      });
    }

    cart.updatedAt = new Date();
    await cart.save();

    const summary = await CartService.getCartSummary(userId);
    return {
      success: true,
      cart: summary,
      message: `Berhasil menambahkan ${safeQty}x "${product.name}" ke keranjang.`,
    };
  }

  /**
   * Updates quantity of a specific item in the cart.
   */
  static async updateQuantity(
    userId: string,
    productId: string,
    quantity: number,
    variantId?: string
  ): Promise<CartOperationResult> {
    const targetQty = Math.floor(Number(quantity));

    if (targetQty <= 0) {
      return await CartService.removeFromCart(userId, productId, variantId);
    }

    if (!Types.ObjectId.isValid(productId)) {
      return {
        success: false,
        reason: "PRODUCT_NOT_FOUND",
        message: "Produk tidak valid.",
      };
    }

    const product = await DigitalProduct.findById(productId);
    if (!product || !product.isActive) {
      return {
        success: false,
        reason: "PRODUCT_INACTIVE",
        message: "Produk tidak tersedia atau tidak aktif.",
      };
    }

    const deliveryType: DeliveryType = product.deliveryType || "CREDENTIAL";
    if (deliveryType === "CREDENTIAL") {
      const availableStock = await DigitalStock.countDocuments({
        productId: product._id,
        isSold: false,
      });

      if (targetQty > availableStock) {
        return {
          success: false,
          reason: "EXCEEDS_STOCK",
          message: `Stok tidak mencukupi untuk ${targetQty} item. Stok tersisa hanya ${availableStock} item.`,
        };
      }
    }

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return {
        success: false,
        reason: "CART_EMPTY",
        message: "Keranjang belanja Anda kosong.",
      };
    }

    const item = cart.items.find(
      (i) =>
        String(i.productId) === String(product._id) &&
        (variantId ? i.variantId === variantId : !i.variantId)
    );

    if (!item) {
      return {
        success: false,
        reason: "PRODUCT_NOT_FOUND",
        message: "Item tidak ada di keranjang Anda.",
      };
    }

    item.quantity = targetQty;
    item.priceAtAdded = product.price;
    cart.updatedAt = new Date();
    await cart.save();

    const summary = await CartService.getCartSummary(userId);
    return {
      success: true,
      cart: summary,
      message: `Jumlah "${product.name}" diubah menjadi ${targetQty} item.`,
    };
  }

  /**
   * Removes an item from the cart.
   */
  static async removeFromCart(
    userId: string,
    productId: string,
    variantId?: string
  ): Promise<CartOperationResult> {
    const cart = await Cart.findOne({ userId });
    if (!cart) {
      const emptySummary = await CartService.getCartSummary(userId);
      return {
        success: true,
        cart: emptySummary,
        message: "Keranjang belanja kosong.",
      };
    }

    const initialLen = cart.items.length;
    cart.items = cart.items.filter(
      (item) =>
        !(
          String(item.productId) === productId &&
          (variantId ? item.variantId === variantId : !item.variantId)
        )
    );

    if (cart.items.length !== initialLen) {
      cart.updatedAt = new Date();
      await cart.save();
    }

    const summary = await CartService.getCartSummary(userId);
    return {
      success: true,
      cart: summary,
      message: "Item berhasil dihapus dari keranjang.",
    };
  }

  /**
   * Completely empties the user's cart.
   */
  static async clearCart(userId: string): Promise<boolean> {
    const res = await Cart.findOneAndUpdate(
      { userId },
      { $set: { items: [], updatedAt: new Date() } },
      { returnDocument: "after" }
    );
    return res !== null;
  }

  /**
   * Returns total count of items in the user's cart (fast lookup for badges).
   */
  static async getItemCount(userId: string): Promise<number> {
    const cart = await Cart.findOne({ userId }).lean();
    if (!cart || !cart.items || cart.items.length === 0) return 0;
    return cart.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  }

  /**
   * Compiles a comprehensive real-time summary of the shopping cart with live pricing and stock validation.
   */
  static async getCartSummary(userId: string): Promise<CartSummary> {
    const cart = await Cart.findOne({ userId }).lean();
    if (!cart || !cart.items || cart.items.length === 0) {
      return {
        userId,
        items: [],
        totalQuantity: 0,
        totalUniqueItems: 0,
        totalRawPrice: 0,
        totalDiscount: 0,
        totalPrice: 0,
        isCartValid: false,
        validationErrors: ["Keranjang belanja Anda masih kosong."],
      };
    }

    const productIds = cart.items.map((i) => i.productId);
    const products = await DigitalProduct.find({ _id: { $in: productIds } }).lean();
    const productMap = new Map<string, IDigitalProduct & { _id: Types.ObjectId }>();
    for (const p of products) {
      productMap.set(String(p._id), p);
    }

    // Pre-fetch unsold stock counts in bulk
    const unsoldCounts = await DigitalStock.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { productId: { $in: productIds }, isSold: false } },
      { $group: { _id: "$productId", count: { $sum: 1 } } },
    ]);
    const stockMap = new Map<string, number>();
    for (const s of unsoldCounts) {
      stockMap.set(String(s._id), s.count);
    }

    const itemsSummary: CartItemSummary[] = [];
    const validationErrors: string[] = [];
    let totalQuantity = 0;
    let totalRawPrice = 0;
    let totalDiscount = 0;
    let totalPrice = 0;

    for (const item of cart.items) {
      const pidStr = String(item.productId);
      const product = productMap.get(pidStr);

      if (!product) {
        validationErrors.push(`Produk ID ${pidStr} sudah tidak tersedia.`);
        continue;
      }

      const deliveryType: DeliveryType = product.deliveryType || "CREDENTIAL";
      const availableStock = deliveryType === "CREDENTIAL" ? (stockMap.get(pidStr) ?? 0) : 999999;
      const safeQty = Math.max(1, item.quantity);

      // Compute pricing with wholesale bulk discount tiers
      const pricing: BulkPricingResult = DigitalProductService.calculatePricing(product, safeQty);

      let isAvailable = true;
      let unavailableReason: string | undefined = undefined;

      if (!product.isActive) {
        isAvailable = false;
        unavailableReason = "Produk sedang dinonaktifkan.";
        validationErrors.push(`"${product.name}" sedang dinonaktifkan.`);
      } else if (deliveryType === "CREDENTIAL") {
        if (availableStock <= 0) {
          isAvailable = false;
          unavailableReason = "Stok habis.";
          validationErrors.push(`Stok "${product.name}" habis.`);
        } else if (safeQty > availableStock) {
          isAvailable = false;
          unavailableReason = `Stok tersisa hanya ${availableStock} item.`;
          validationErrors.push(
            `Jumlah "${product.name}" (${safeQty}x) melebihi stok tersedia (${availableStock}x).`
          );
        }
      }

      totalQuantity += safeQty;
      totalRawPrice += pricing.normalTotalPrice;
      totalDiscount += pricing.discountAmount;
      totalPrice += pricing.totalPrice;

      itemsSummary.push({
        productId: pidStr,
        variantId: item.variantId,
        productName: product.name,
        category: product.category,
        deliveryType,
        quantity: safeQty,
        unitPrice: pricing.unitPrice,
        normalUnitPrice: pricing.normalPrice,
        lineTotalPrice: pricing.totalPrice,
        lineNormalPrice: pricing.normalTotalPrice,
        discountAmount: pricing.discountAmount,
        discountPercent: pricing.discountPercent,
        bulkTierApplied: Boolean(pricing.appliedTier),
        availableStock,
        isAvailable,
        unavailableReason,
        fileId: product.fileId,
        fileUrl: product.fileUrl,
      });
    }

    const isCartValid = itemsSummary.length > 0 && validationErrors.length === 0;

    return {
      userId,
      items: itemsSummary,
      totalQuantity,
      totalUniqueItems: itemsSummary.length,
      totalRawPrice,
      totalDiscount,
      totalPrice,
      isCartValid,
      validationErrors,
    };
  }
}
