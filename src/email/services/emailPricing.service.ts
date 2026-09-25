import { EmailRentalPrice, type IEmailRentalPrice } from "../../models/EmailRentalPrice.js";
import type { EmailResourceType } from "../../models/EmailUsage.js";

/** Reserved pricing key for a provider-wide fallback across all OTP services. */
export const GLOBAL_EMAIL_SERVICE_ID = "__GLOBAL__";

interface EmailPriceKey {
  serviceId: string;
  resourceType: EmailResourceType;
  providerId?: string;
}

export function selectEmailRentalPrice<T extends Pick<IEmailRentalPrice, "serviceId">>(
  prices: readonly T[],
  serviceId: string,
): T | null {
  return prices.find((price) => price.serviceId === serviceId)
    ?? prices.find((price) => price.serviceId === GLOBAL_EMAIL_SERVICE_ID)
    ?? null;
}

/** Service-specific prices override the provider-wide global price. */
export async function getEmailRentalPrice(input: EmailPriceKey): Promise<IEmailRentalPrice | null> {
  const prices = await EmailRentalPrice.find({
    serviceId: { $in: [input.serviceId, GLOBAL_EMAIL_SERVICE_ID] },
    resourceType: input.resourceType,
    enabled: true,
    ...(input.providerId ? { providerId: input.providerId } : { providerId: { $in: [null] } }),
  }).lean();
  return selectEmailRentalPrice(prices, input.serviceId) as IEmailRentalPrice | null;
}

async function upsertPrice(input: EmailPriceKey & { price: number }): Promise<void> {
  if (!Number.isSafeInteger(input.price) || input.price < 1) throw new Error("Harga harus angka rupiah positif.");
  await EmailRentalPrice.findOneAndUpdate({
    serviceId: input.serviceId,
    resourceType: input.resourceType,
    ...(input.providerId ? { providerId: input.providerId } : { providerId: { $in: [null] } }),
  }, {
    $set: {
      price: input.price,
      enabled: true,
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
  }, { upsert: true, returnDocument: "after", runValidators: true });
}

export async function setEmailRentalPrice(input: EmailPriceKey & { price: number }): Promise<void> {
  if (input.serviceId === GLOBAL_EMAIL_SERVICE_ID) throw new Error("Gunakan pengaturan harga global provider.");
  await upsertPrice(input);
}

export async function setGlobalEmailRentalPrice(input: Omit<EmailPriceKey, "serviceId"> & { price: number }): Promise<void> {
  await upsertPrice({ ...input, serviceId: GLOBAL_EMAIL_SERVICE_ID });
}
