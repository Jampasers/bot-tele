import { User, IUser } from "../models/User.js";
import { HydratedDocument } from "mongoose";
import { cleanJid } from "./formatter.js";

export class WaUserService {
  /**
   * Generates a consistent, unique identifier string for a WhatsApp user.
   */
  static getWaUserId(jid: string): string {
    const phone = cleanJid(jid);
    return `wa:${phone}`;
  }

  /**
   * Finds or creates a WhatsApp user record in MongoDB.
   */
  static async findOrCreateUser(
    jid: string,
    senderName?: string
  ): Promise<HydratedDocument<IUser>> {
    const userId = this.getWaUserId(jid);
    const phone = cleanJid(jid);
    const displayName = senderName && senderName.trim() ? senderName.trim() : phone;

    let user = await User.findOne({
      $or: [{ telegramId: userId }, { whatsappJid: jid }],
    });

    if (!user) {
      user = await User.create({
        telegramId: userId,
        firstName: displayName,
        platform: "whatsapp",
        phoneNumber: phone,
        whatsappJid: jid,
        balance: 0,
        totalOrders: 0,
        accountStatus: "ACTIVE",
      });
      return user;
    }

    // Update name if changed
    if (senderName && user.firstName !== displayName && !user.firstName.startsWith("62")) {
      // keep existing customized name if already set
    } else if (senderName && user.firstName !== displayName) {
      user.firstName = displayName;
      await user.save();
    }

    if (!user.whatsappJid) {
      user.whatsappJid = jid;
      user.platform = "whatsapp";
      user.phoneNumber = phone;
      await user.save();
    }

    return user;
  }
}
