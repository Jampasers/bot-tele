import { getTenantContext, type TenantContext } from "./context.js";

export const INTERNAL_FEATURES = new Set(["smsbower", "imap", "whatsapp", "admin", "info"]);

export function hasFeature(feature: string, context: TenantContext = getTenantContext()): boolean {
  if (feature === "email_otp" && process.env.EMAIL_RENTAL_ENABLED !== "true") return false;
  if (!context.rentalId) return true;
  if (INTERNAL_FEATURES.has(feature)) return false;
  return context.enabledFeatures?.includes(feature) ?? false;
}
