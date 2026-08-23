import { Schema, model, Document, Model, Types } from "mongoose";

// ---------------------------------------------------------------------------
// 1. TypeScript Interface
// ---------------------------------------------------------------------------

export interface IRestockAlert extends Document {
  /** ObjectId reference to the DigitalProduct */
  productId: Types.ObjectId;

  /** Telegram user ID who subscribed to the alert */
  userId: string;

  /** Telegram chat ID to send the notification to */
  chatId: string;

  createdAt: Date;
}

// ---------------------------------------------------------------------------
// 2. Mongoose Schema
// ---------------------------------------------------------------------------

const restockAlertSchema = new Schema<IRestockAlert>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "DigitalProduct",
      required: true,
    },
    userId: {
      type: String,
      required: true,
    },
    chatId: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

// Compound unique index — one alert per user per product
restockAlertSchema.index({ productId: 1, userId: 1 }, { unique: true });
restockAlertSchema.index({ productId: 1 });

// ---------------------------------------------------------------------------
// 3. Model
// ---------------------------------------------------------------------------

export const RestockAlert: Model<IRestockAlert> = model<IRestockAlert>(
  "RestockAlert",
  restockAlertSchema
);
