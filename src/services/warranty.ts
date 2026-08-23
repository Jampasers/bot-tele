import { Api, InlineKeyboard } from "grammy";
import { Types } from "mongoose";
import { DigitalProduct, WarrantyUnit } from "../models/DigitalProduct.js";
import { DigitalOrder, DigitalOrderDocument, IDigitalOrder } from "../models/DigitalOrder.js";
import { DigitalStock } from "../models/DigitalStock.js";
import { WarrantyClaim, IWarrantyClaim, WarrantyClaimDocument, ClaimStatus } from "../models/WarrantyClaim.js";
import { User } from "../models/User.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { ActivityLogService } from "./activityLog.js";
import { getAdminIds } from "../core/admin.js";

// ============================================================================
//  Warranty & Claim Service
// ============================================================================

export class WarrantyService {
  /**
   * Calculates expiry date based on creation time, duration, and unit.
   */
  static calculateExpiryDate(
    createdAt: Date,
    duration?: number,
    unit?: WarrantyUnit | string
  ): Date | undefined {
    if (!duration || duration <= 0 || !unit || unit === "NONE") {
      return undefined;
    }

    const d = new Date(createdAt);
    switch (unit) {
      case "HOURS":
        return new Date(d.getTime() + duration * 60 * 60 * 1000);
      case "DAYS":
        return new Date(d.getTime() + duration * 24 * 60 * 60 * 1000);
      case "WEEKS":
        return new Date(d.getTime() + duration * 7 * 24 * 60 * 60 * 1000);
      case "MONTHS": {
        const res = new Date(d);
        res.setMonth(res.getMonth() + duration);
        return res;
      }
      default:
        return undefined;
    }
  }

  /**
   * Formats warranty duration and unit into friendly Indonesian text.
   */
  static formatWarrantyText(
    duration?: number,
    unit?: WarrantyUnit | string,
    maxClaims?: number
  ): string {
    if (!duration || duration <= 0 || !unit || unit === "NONE") {
      return "Tanpa Garansi";
    }

    let unitLabel = "";
    switch (unit) {
      case "HOURS":
        unitLabel = `${duration} Jam`;
        break;
      case "DAYS":
        unitLabel = `${duration} Hari`;
        break;
      case "WEEKS":
        unitLabel = `${duration} Minggu`;
        break;
      case "MONTHS":
        unitLabel = `${duration} Bulan`;
        break;
      default:
        unitLabel = `${duration} ${unit}`;
    }

    if (maxClaims !== undefined && maxClaims > 0) {
      return `${unitLabel} (Maks. ${maxClaims}x klaim)`;
    }

    return unitLabel;
  }

  /**
   * Formats warranty in compact form (e.g. "30 Hari", "24 Jam").
   */
  static formatWarrantyShort(duration?: number, unit?: WarrantyUnit | string): string {
    if (!duration || duration <= 0 || !unit || unit === "NONE") {
      return "Tanpa Garansi";
    }
    switch (unit) {
      case "HOURS":
        return `${duration} Jam`;
      case "DAYS":
        return `${duration} Hari`;
      case "WEEKS":
        return `${duration} Minggu`;
      case "MONTHS":
        return `${duration} Bulan`;
      default:
        return `${duration} ${unit}`;
    }
  }

  /**
   * Checks the warranty status of a specific order.
   */
  static checkOrderWarrantyStatus(order: IDigitalOrder): {
    hasWarranty: boolean;
    isExpired: boolean;
    expiresAt?: Date | undefined;
    claimsCount: number;
    maxClaims: number;
    canClaim: boolean;
    reason?: string | undefined;
  } {
    const hasWarranty = Boolean(
      order.warrantyDuration &&
      order.warrantyDuration > 0 &&
      order.warrantyUnit &&
      order.warrantyUnit !== "NONE"
    );

    const maxClaims = order.maxClaims ?? 1;
    const claimsCount = order.claimsCount ?? 0;
    const expiresAt = order.warrantyExpiresAt;

    if (!hasWarranty) {
      return {
        hasWarranty: false,
        isExpired: false,
        claimsCount,
        maxClaims,
        canClaim: false,
        reason: "Produk ini tidak memiliki fasilitas garansi.",
      };
    }

    const now = new Date();
    const isExpired = expiresAt ? now > expiresAt : false;

    if (isExpired) {
      return {
        hasWarranty: true,
        isExpired: true,
        expiresAt,
        claimsCount,
        maxClaims,
        canClaim: false,
        reason: `Masa garansi telah berakhir pada ${expiresAt?.toLocaleString("id-ID")}.`,
      };
    }

    if (claimsCount >= maxClaims) {
      return {
        hasWarranty: true,
        isExpired: false,
        expiresAt,
        claimsCount,
        maxClaims,
        canClaim: false,
        reason: `Batas klaim garansi untuk pesanan ini sudah mencapai batas maksimal (${maxClaims}x).`,
      };
    }

    return {
      hasWarranty: true,
      isExpired: false,
      expiresAt,
      claimsCount,
      maxClaims,
      canClaim: true,
    };
  }

  /**
   * Validates if an order is eligible for a new warranty claim.
   */
  static async validateClaimEligibility(
    orderId: string,
    userId: string
  ): Promise<{
    eligible: boolean;
    order?: DigitalOrderDocument | undefined;
    reason?: string | undefined;
  }> {
    const order = await DigitalOrder.findOne({ orderId, userId });
    if (!order) {
      return { eligible: false, reason: "Pesanan tidak ditemukan atau bukan milik akun kamu." };
    }

    const status = this.checkOrderWarrantyStatus(order);
    if (!status.canClaim) {
      return { eligible: false, order, reason: status.reason };
    }

    // Check if there is already an active pending claim for this order
    const pendingClaim = await WarrantyClaim.findOne({ orderId, status: "PENDING" });
    if (pendingClaim) {
      return {
        eligible: false,
        order,
        reason: `Tiket klaim sebelumnya (<code>${pendingClaim.claimId}</code>) masih berstatus PENDING dan sedang diproses oleh admin.`,
      };
    }

    return { eligible: true, order };
  }

  /**
   * Creates a new warranty claim ticket, updates order count, and notifies admin(s).
   */
  static async createClaim(data: {
    orderId: string;
    userId: string;
    userHandle?: string | undefined;
    reason: string;
    api: Api;
  }): Promise<{
    success: boolean;
    claim?: WarrantyClaimDocument | undefined;
    message: string;
  }> {
    const check = await this.validateClaimEligibility(data.orderId, data.userId);
    if (!check.eligible || !check.order) {
      return {
        success: false,
        message: check.reason || "Pesanan tidak memenuhi syarat klaim garansi.",
      };
    }

    const order = check.order;
    const claimId = `CLM-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const claim = await WarrantyClaim.create({
      claimId,
      orderId: order.orderId,
      userId: data.userId,
      userHandle: data.userHandle || "",
      productId: order.productId,
      productName: order.productName,
      itemContentSnapshot: order.itemContent,
      reason: data.reason.trim(),
      status: "PENDING",
      createdAt: new Date(),
    });

    // Increment claims count on order
    await DigitalOrder.updateOne({ _id: order._id }, { $inc: { claimsCount: 1 } });

    // Send activity audit log
    ActivityLogService.logWarrantyClaimCreated(data.api, {
      claimId,
      orderId: order.orderId,
      productName: order.productName,
      user: {
        telegramId: data.userId,
        username: data.userHandle,
      },
      reason: data.reason.trim(),
    }).catch((err) => console.error("[WarrantyService] ActivityLog error:", err));

    // Broadcast interactive actionable notification to all Admin(s)
    const adminIds = getAdminIds();
    if (adminIds.length > 0) {
      const adminText =
        `🛡️ <b>[TIKET KLAIM GARANSI BARU]</b>\n` +
        `${"─".repeat(30)}\n\n` +
        `🎫 <b>ID Tiket:</b> <code>${claimId}</code>\n` +
        `📦 <b>Order ID:</b> <code>${order.orderId}</code>\n` +
        `🏷️ <b>Produk:</b> <b>${order.productName}</b>\n` +
        `💰 <b>Harga Beli:</b> Rp ${order.price.toLocaleString("id-ID")}\n` +
        `👤 <b>Pembeli:</b> <code>${data.userId}</code> ${data.userHandle ? `(@${data.userHandle})` : ""}\n` +
        `🔢 <b>Klaim ke:</b> ${order.claimsCount || 1} dari maks. ${order.maxClaims ?? 1}x\n\n` +
        `🔑 <b>Data Akun Terkirim:</b>\n<code>${order.itemContent}</code>\n\n` +
        `📝 <b>Keluhan Pembeli:</b>\n<i>${data.reason.trim()}</i>\n\n` +
        `<i>Pilih tindakan di bawah untuk menyelesaikan tiket klaim ini:</i>`;

      const kb = new InlineKeyboard()
        .text("🔄 Ganti Stok (Replace)", `clm_rep_${claimId}`)
        .row()
        .text("💰 Refund Saldo", `clm_ref_${claimId}`)
        .row()
        .text("❌ Tolak Klaim", `clm_rej_${claimId}`);

      for (const adminId of adminIds) {
        data.api.sendMessage(adminId, adminText, {
          parse_mode: "HTML",
          reply_markup: kb,
        }).catch((err) => console.error(`[WarrantyService] Failed notify admin ${adminId}:`, err));
      }
    }

    return {
      success: true,
      claim,
      message: "Tiket klaim garansi berhasil dikirimkan ke admin!",
    };
  }

  /**
   * Resolves claim by replacing stock (FIFO).
   */
  static async resolveReplace(data: {
    claimId: string;
    adminId: string;
    api: Api;
  }): Promise<{
    success: boolean;
    claim?: WarrantyClaimDocument | undefined;
    replacementContent?: string | undefined;
    message: string;
  }> {
    const claim = await WarrantyClaim.findOne({ claimId: data.claimId });
    if (!claim) {
      return { success: false, message: "Tiket klaim tidak ditemukan." };
    }
    if (claim.status !== "PENDING") {
      return {
        success: false,
        message: `Tiket ini sudah diproses sebelumnya dengan status: ${claim.status}.`,
      };
    }

    // Acquire 1 unsold stock item FIFO
    const stock = await DigitalStock.findOneAndUpdate(
      { productId: claim.productId, isSold: false },
      {
        $set: {
          isSold: true,
          soldTo: claim.userId,
          soldAt: new Date(),
          orderId: `${claim.orderId}-REP`,
        },
      },
      { sort: { createdAt: 1 }, new: true }
    );

    if (!stock) {
      return {
        success: false,
        message: "❌ Stok pengganti untuk produk ini sedang HABIS! Silakan tambahkan stok terlebih dahulu atau pilih opsi Refund Saldo.",
      };
    }

    // Update claim
    claim.status = "APPROVED_REPLACE";
    claim.replacementContent = stock.content;
    claim.resolvedBy = data.adminId;
    claim.resolvedAt = new Date();
    await claim.save();

    // Send replacement message to user chat
    const userMsg =
      `🎉 <b>Klaim Garansi Disetujui! (Penggantian Stok)</b>\n` +
      `${"─".repeat(30)}\n\n` +
      `Halo! Klaim garansi kamu untuk pesanan <code>${claim.orderId}</code> telah <b>disetujui</b> oleh admin.\n\n` +
      `📦 <b>Produk:</b> ${claim.productName}\n` +
      `🎫 <b>ID Tiket:</b> <code>${claim.claimId}</code>\n\n` +
      `🔑 <b>DATA PRODUK / AKUN PENGGANTI:</b>\n` +
      `<code>${stock.content}</code>\n\n` +
      `⚠️ <i>Data akun baru di atas diberikan sebagai pengganti garansi. Harap simpan dengan baik.</i>`;

    data.api.sendMessage(claim.userId, userMsg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("📜 Riwayat Pesanan", "dg_myorders")
        .row()
        .text("🛍️ Belanja Lagi", "product_digital"),
    }).catch((err) => console.error(`[WarrantyService] Failed sending replace to user ${claim.userId}:`, err));

    // Audit log
    ActivityLogService.logWarrantyClaimResolved(data.api, {
      claimId: claim.claimId,
      orderId: claim.orderId,
      productName: claim.productName,
      user: { telegramId: claim.userId, username: claim.userHandle },
      admin: { telegramId: data.adminId },
      resolutionType: "REPLACE",
    }).catch((err) => console.error("[WarrantyService] ActivityLog error:", err));

    return {
      success: true,
      claim,
      replacementContent: stock.content,
      message: `✅ Klaim #${claim.claimId} berhasil disetujui! Stok pengganti telah otomatis dikirimkan ke pembeli.`,
    };
  }

  /**
   * Resolves claim by refunding balance to user.
   */
  static async resolveRefund(data: {
    claimId: string;
    adminId: string;
    api: Api;
  }): Promise<{
    success: boolean;
    claim?: WarrantyClaimDocument | undefined;
    refundAmount?: number | undefined;
    message: string;
  }> {
    const claim = await WarrantyClaim.findOne({ claimId: data.claimId });
    if (!claim) {
      return { success: false, message: "Tiket klaim tidak ditemukan." };
    }
    if (claim.status !== "PENDING") {
      return {
        success: false,
        message: `Tiket ini sudah diproses sebelumnya dengan status: ${claim.status}.`,
      };
    }

    const order = await DigitalOrder.findOne({ orderId: claim.orderId });
    const refundAmount = order?.price ?? 0;

    const user = await User.findOne({ telegramId: claim.userId });
    if (!user) {
      return { success: false, message: "Pengguna pembeli tidak ditemukan di database." };
    }

    const balanceBefore = user.balance;
    const balanceAfter = balanceBefore + refundAmount;

    await User.updateOne(
      { telegramId: claim.userId },
      { $inc: { balance: refundAmount } }
    );

    await BalanceLog.create({
      userId: claim.userId,
      adminId: data.adminId,
      type: "REFUND",
      amount: refundAmount,
      balanceBefore,
      balanceAfter,
      reason: `Refund Garansi #${claim.claimId} (${claim.productName})`,
    });

    claim.status = "APPROVED_REFUND";
    claim.refundAmount = refundAmount;
    claim.resolvedBy = data.adminId;
    claim.resolvedAt = new Date();
    await claim.save();

    // Send refund message to user chat
    const userMsg =
      `💰 <b>Klaim Garansi Disetujui! (Refund Saldo)</b>\n` +
      `${"─".repeat(30)}\n\n` +
      `Halo! Klaim garansi kamu untuk pesanan <code>${claim.orderId}</code> telah <b>disetujui</b> oleh admin.\n\n` +
      `📦 <b>Produk:</b> ${claim.productName}\n` +
      `🎫 <b>ID Tiket:</b> <code>${claim.claimId}</code>\n` +
      `💵 <b>Saldo Dikembalikan:</b> <b>Rp ${refundAmount.toLocaleString("id-ID")}</b>\n\n` +
      `<i>Saldo akun kamu telah otomatis bertambah. Kamu dapat menggunakannya untuk berbelanja kembali.</i>`;

    data.api.sendMessage(claim.userId, userMsg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛍️ Katalog Produk", "product_digital")
        .row()
        .text("👤 Cek Saldo", "menu_catalog"),
    }).catch((err) => console.error(`[WarrantyService] Failed sending refund to user ${claim.userId}:`, err));

    // Audit log
    ActivityLogService.logWarrantyClaimResolved(data.api, {
      claimId: claim.claimId,
      orderId: claim.orderId,
      productName: claim.productName,
      user: { telegramId: claim.userId, username: claim.userHandle },
      admin: { telegramId: data.adminId },
      resolutionType: "REFUND",
      refundAmount,
    }).catch((err) => console.error("[WarrantyService] ActivityLog error:", err));

    return {
      success: true,
      claim,
      refundAmount,
      message: `✅ Klaim #${claim.claimId} berhasil disetujui! Saldo Rp ${refundAmount.toLocaleString("id-ID")} telah dikembalikan ke pembeli.`,
    };
  }

  /**
   * Resolves claim by rejecting with an optional note.
   */
  static async resolveReject(data: {
    claimId: string;
    adminId: string;
    rejectReason: string;
    api: Api;
  }): Promise<{
    success: boolean;
    claim?: WarrantyClaimDocument | undefined;
    message: string;
  }> {
    const claim = await WarrantyClaim.findOne({ claimId: data.claimId });
    if (!claim) {
      return { success: false, message: "Tiket klaim tidak ditemukan." };
    }
    if (claim.status !== "PENDING") {
      return {
        success: false,
        message: `Tiket ini sudah diproses sebelumnya dengan status: ${claim.status}.`,
      };
    }

    const note = data.rejectReason.trim() || "Klaim tidak memenuhi syarat garansi.";

    claim.status = "REJECTED";
    claim.adminNote = note;
    claim.resolvedBy = data.adminId;
    claim.resolvedAt = new Date();
    await claim.save();

    // Send rejection message to user chat
    const userMsg =
      `❌ <b>Klaim Garansi Ditolak</b>\n` +
      `${"─".repeat(30)}\n\n` +
      `Halo! Klaim garansi kamu untuk pesanan <code>${claim.orderId}</code> telah ditinjau dan <b>ditolak</b> oleh admin.\n\n` +
      `📦 <b>Produk:</b> ${claim.productName}\n` +
      `🎫 <b>ID Tiket:</b> <code>${claim.claimId}</code>\n` +
      `💬 <b>Alasan Penolakan:</b>\n<i>${note}</i>\n\n` +
      `<i>Jika ada pertanyaan atau kendala lebih lanjut, silakan hubungi admin.</i>`;

    data.api.sendMessage(claim.userId, userMsg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("📜 Riwayat Pesanan", "dg_myorders"),
    }).catch((err) => console.error(`[WarrantyService] Failed sending reject to user ${claim.userId}:`, err));

    // Audit log
    ActivityLogService.logWarrantyClaimResolved(data.api, {
      claimId: claim.claimId,
      orderId: claim.orderId,
      productName: claim.productName,
      user: { telegramId: claim.userId, username: claim.userHandle },
      admin: { telegramId: data.adminId },
      resolutionType: "REJECT",
      note,
    }).catch((err) => console.error("[WarrantyService] ActivityLog error:", err));

    return {
      success: true,
      claim,
      message: `❌ Klaim #${claim.claimId} telah ditolak dengan alasan: "${note}".`,
    };
  }

  /**
   * Retrieves pending claims for admin queue.
   */
  static async getPendingClaims(limit = 20): Promise<WarrantyClaimDocument[]> {
    return await WarrantyClaim.find({ status: "PENDING" })
      .sort({ createdAt: -1 })
      .limit(limit);
  }

  /**
   * Retrieves count of pending claims.
   */
  static async getPendingClaimsCount(): Promise<number> {
    return await WarrantyClaim.countDocuments({ status: "PENDING" });
  }

  /**
   * Retrieves a claim by ID.
   */
  static async getClaimById(claimId: string): Promise<WarrantyClaimDocument | null> {
    return await WarrantyClaim.findOne({ claimId });
  }

  /**
   * Retrieves claims filed by a specific user.
   */
  static async getUserClaims(userId: string, limit = 10): Promise<WarrantyClaimDocument[]> {
    return await WarrantyClaim.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit);
  }
}
