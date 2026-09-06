/**
 * WhatsApp Bot Navigation & Session Types
 */

export type WaSessionStep =
  | "IDLE"
  | "MAIN_MENU"
  | "DIGITAL_CATEGORIES"
  | "DIGITAL_PRODUCTS"
  | "DIGITAL_INPUT_QTY"
  | "DIGITAL_CONFIRM_PAY"
  | "TOPUP_INPUT_AMOUNT"
  | "OTP_SELECT_COUNTRY"
  | "OTP_SELECT_SERVICE"
  | "ADMIN_ADD_STOCK"
  | "ADMIN_ADD_BALANCE";

export interface WaUserSession {
  jid: string;
  step: WaSessionStep;
  lastActive: number;
  data?: {
    category?: string;
    productId?: string;
    productName?: string;
    productPrice?: number;
    maxStock?: number;
    quantity?: number;
    topupBaseAmount?: number;
    pendingSessionId?: string;
    countryCode?: string;
    serviceCode?: string;
    adminTargetPhone?: string;
    [key: string]: any;
  };
}

export interface WaIncomingMessage {
  jid: string;
  senderName: string;
  fromMe: boolean;
  isGroup: boolean;
  text: string;
  messageId: string;
  rawMessage: any;
}
