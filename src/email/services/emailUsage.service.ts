import type { ClientSession } from "mongoose";
import { EmailUsage, type IEmailUsage } from "../../models/EmailUsage.js";

export function emailResourceKey(_type: "MAILBOX" | "DOMAIN_ALIAS", address: string): string {
  // The address is the permanent business identity. A mailbox document may be
  // replaced or re-imported, but an email/service pair must remain consumed.
  return address.trim().toLowerCase();
}

export async function wasEmailUsedForService(type: "MAILBOX" | "DOMAIN_ALIAS", address: string, serviceId: string): Promise<boolean> {
  return Boolean(await EmailUsage.exists({ emailResourceId: emailResourceKey(type, address), serviceId }));
}

/** Returns false for an already-claimed email/service pair; the Mongo unique index is the race boundary. */
export async function commitEmailUsage(input: {
  type: "MAILBOX" | "DOMAIN_ALIAS"; address: string; serviceId: string; rentalId: string; userId: string;
}, session?: ClientSession): Promise<boolean> {
  try {
    await EmailUsage.create([{
      emailResourceType: input.type, emailResourceId: emailResourceKey(input.type, input.address),
      serviceId: input.serviceId, rentalId: input.rentalId, usedBy: input.userId, usedAt: new Date(),
    }], session ? { session } : undefined);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      // A duplicate-key error aborts a MongoDB transaction. Let the caller abort
      // and recover outside the transaction instead of treating it as a value.
      if (session) throw error;
      return false;
    }
    throw error;
  }
}

export async function assertEmailUsageIndex(): Promise<void> {
  try {
    const indexes = await EmailUsage.collection.indexes();
    const ready = indexes.some((index) => index.unique === true &&
      index.key.tenantId === 1 && index.key.emailResourceId === 1 && index.key.serviceId === 1);
    if (!ready) throw new Error("Missing tenant/email/service unique index.");
  } catch {
    throw new Error("Email Rental belum siap. Jalankan npm run migrate:email-rental -- --apply terlebih dahulu.");
  }
}

export async function listUsageForUser(userId: string, limit = 20): Promise<IEmailUsage[]> {
  return EmailUsage.find({ usedBy: userId }).sort({ usedAt: -1 }).limit(Math.min(100, Math.max(1, limit))).lean() as unknown as IEmailUsage[];
}
