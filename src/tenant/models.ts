import { AffiliateLog } from "../models/AffiliateLog.js";
import { BalanceLog } from "../models/BalanceLog.js";
import { BotConfig } from "../models/BotConfig.js";
import { Cart } from "../models/Cart.js";
import { DigitalOrder } from "../models/DigitalOrder.js";
import { DigitalProduct } from "../models/DigitalProduct.js";
import { DigitalStock } from "../models/DigitalStock.js";
import { FraudLog } from "../models/FraudLog.js";
import { Order } from "../models/Order.js";
import { PromoCode } from "../models/PromoCode.js";
import { RestockAlert } from "../models/RestockAlert.js";
import { SmsConfig } from "../models/SmsConfig.js";
import { TopupSession } from "../models/TopupSession.js";
import { User } from "../models/User.js";
import { WarrantyClaim } from "../models/WarrantyClaim.js";
import { TenantPaymentConfig } from "../models/TenantPaymentConfig.js";
import { BotRental } from "../models/BotRental.js";
import { RentalPlan } from "../models/RentalPlan.js";
import { RentalPayment } from "../models/RentalPayment.js";
import { PaymentAmountReservation, PaymentSettlementClaim } from "../models/PaymentLedger.js";

/** Tenant data models only. Rental/plan/platform payment metadata is deliberately separate. */
export const TENANT_MODELS = [AffiliateLog, BalanceLog, BotConfig, Cart, DigitalOrder, DigitalProduct, DigitalStock, FraudLog, Order, PromoCode, RestockAlert, SmsConfig, TopupSession, User, WarrantyClaim, TenantPaymentConfig] as const;

/** Private control-plane collections retain platform-wide uniqueness. */
export const PLATFORM_MODELS = [BotRental, RentalPlan, RentalPayment, PaymentAmountReservation, PaymentSettlementClaim] as const;
