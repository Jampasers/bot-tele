import { Schema, model, Document, Model } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

/**
 * Mirrors the Mongoose document fields.
 * Use this type anywhere you work with User documents in TypeScript.
 */
export interface IUser {
  /** Telegram numeric user ID (stored as a string to avoid JS integer overflow). */
  telegramId: string;

  /** Telegram display name (first_name from the Update). */
  firstName: string;

  /** Telegram @username — optional, not all accounts have one. */
  username?: string;

  /**
   * Account balance in the smallest currency unit (e.g. cents / IDR).
   * Stored as a plain number; apply display formatting in the UI layer.
   */
  balance: number;

  /** Lifetime count of completed orders placed by this user. */
  totalOrders: number;

  /**
   * Telegram ID of the user who referred this user.
   * Null/undefined if user registered without a referral link.
   */
  referredBy?: string;

  /**
   * Pending affiliate commission balance earned through referrals.
   * Can be withdrawn to main `balance` by the user.
   */
  affiliateBalance: number;

  /**
   * Lifetime total affiliate commissions earned (historical, never decremented on withdrawal).
   */
  totalEarnedAffiliate: number;

  /** Timestamp set automatically by Mongoose on first insert. */
  createdAt: Date;

  /** Timestamp updated automatically by Mongoose on every save. */
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Mongoose Schema — defines validation, defaults, and indexes.
// ---------------------------------------------------------------------------

const userSchema = new Schema<IUser>(
  {
    telegramId: {
      type: String,
      required: [true, "telegramId is required"],
      unique: true,       // creates a unique index in MongoDB
      index: true,        // also makes look-ups by telegramId fast
      trim: true,
    },
    firstName: {
      type: String,
      required: [true, "firstName is required"],
      trim: true,
      maxlength: [64, "firstName must be 64 characters or fewer"],
    },
    username: {
      type: String,
      trim: true,
      maxlength: [32, "username must be 32 characters or fewer"],
      default: undefined, // keep the field absent rather than null when not provided
    },
    balance: {
      type: Number,
      default: 0,
      min: [0, "balance cannot be negative"],
    },
    totalOrders: {
      type: Number,
      default: 0,
      min: [0, "totalOrders cannot be negative"],
    },
    referredBy: {
      type: String,
      default: undefined,
      trim: true,
    },
    affiliateBalance: {
      type: Number,
      default: 0,
      min: [0, "affiliateBalance cannot be negative"],
    },
    totalEarnedAffiliate: {
      type: Number,
      default: 0,
      min: [0, "totalEarnedAffiliate cannot be negative"],
    },
  },
  {
    // Automatically manage `createdAt` and `updatedAt` fields.
    timestamps: true,

    // Omit the __v (version key) field from query results — cleaner output.
    versionKey: false,
  }
);

// ---------------------------------------------------------------------------
// 3. Model — the compiled Mongoose model exported for use in plugins/services.
// ---------------------------------------------------------------------------

/**
 * Mongoose model for the `users` collection.
 *
 * Usage in a plugin:
 * ```ts
 * import { User } from "../../models/User.js";
 *
 * const existing = await User.findOne({ telegramId: String(ctx.from.id) });
 * ```
 */
export const User: Model<IUser> = model<IUser>("User", userSchema);
