import { EmailMailbox } from "../../models/EmailMailbox.js";
import { EmailOtpService } from "../../models/EmailOtpService.js";
import { EmailProvider } from "../../models/EmailProvider.js";
import { EmailRentalCounter } from "../../models/EmailRentalCounter.js";
import { EmailUsage } from "../../models/EmailUsage.js";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailDomain } from "../../models/EmailDomain.js";
import { Types } from "mongoose";
import { randomBytes } from "node:crypto";
import { assertEmailUsageIndex } from "./emailUsage.service.js";

export interface ClaimedMailbox { _id: unknown; email: string; providerId: string; username: string; lastUid: number; }
export async function claimFirstAvailable<T>(candidates: readonly T[], claim: (candidate: T) => Promise<boolean>): Promise<T | undefined> {
  for (const candidate of candidates) if (await claim(candidate)) return candidate;
  return undefined;
}
function duplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export async function reserveUserRentalSlot(userId: string, maximum: number): Promise<void> {
  await assertCounterIndex();
  const current = await EmailRentalCounter.findOneAndUpdate(
    { userId, activeCount: { $lt: maximum } }, { $inc: { activeCount: 1 } }, { returnDocument: "after" },
  );
  if (current) return;
  try {
    await EmailRentalCounter.create({ userId, activeCount: 1 });
  } catch (error) {
    if (!duplicate(error)) throw error;
    const retried = await EmailRentalCounter.findOneAndUpdate(
      { userId, activeCount: { $lt: maximum } }, { $inc: { activeCount: 1 } }, { returnDocument: "after" },
    );
    if (!retried) throw new Error("Batas rental email aktif sudah tercapai.");
  }
}

async function assertCounterIndex(): Promise<void> {
  try {
    const indexes = await EmailRentalCounter.collection.indexes();
    if (indexes.some((index) => index.unique === true && index.key.tenantId === 1 && index.key.userId === 1)) return;
  } catch { /* report the same explicit migration action below */ }
  throw new Error("Email Rental belum siap. Jalankan npm run migrate:email-rental -- --apply terlebih dahulu.");
}

export async function releaseUserRentalSlot(userId: string): Promise<void> {
  await EmailRentalCounter.updateOne({ userId, activeCount: { $gt: 0 } }, { $inc: { activeCount: -1 } });
}

async function collectorMailboxIds(): Promise<Types.ObjectId[]> {
  const ids = await EmailDomain.distinct("destinationMailboxId", { enabled: true });
  return ids.filter((id): id is string => typeof id === "string" && Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
}

export async function getEligibleMailboxCount(serviceId: string, providerId: string): Promise<number> {
  await EmailProvider.findOne({ _id: providerId, enabled: true }).orFail().lean();
  const used = (await EmailUsage.distinct("emailResourceId", { serviceId }))
    .filter((address): address is string => typeof address === "string");
  const collectors = await collectorMailboxIds();
  const count = await EmailMailbox.countDocuments({
    providerId, enabled: true, status: "AVAILABLE",
    email: { $nin: used }, _id: { $nin: collectors },
  });
  return count;
}

export async function getEligibleDomainCount(): Promise<number> {
  const domains = await EmailDomain.find({ enabled: true, sellable: true, routingMode: "FORWARD" }).select("_id destinationMailboxId").lean();
  let available = 0;
  for (const domain of domains) {
    const collector = await EmailMailbox.findOne({ _id: domain.destinationMailboxId, enabled: true, status: { $in: ["AVAILABLE", "COOLDOWN"] } }).select("providerId").lean();
    if (!collector) continue;
    if (await EmailProvider.exists({ _id: collector.providerId, enabled: true })) available++;
  }
  return available;
}

export async function reserveMailboxCandidate(input: {
  serviceId: string; providerId: string; userId: string; reservationExpiresAt: Date;
}): Promise<ClaimedMailbox> {
  await assertEmailUsageIndex();
  await assertCounterIndex();
  await EmailProvider.findOne({ _id: input.providerId, enabled: true }).orFail().lean();
  await EmailOtpService.findOne({ _id: input.serviceId, enabled: true }).orFail().lean();
  const usedEmails = (await EmailUsage.distinct("emailResourceId", { serviceId: input.serviceId }))
    .filter((address): address is string => typeof address === "string");
  const collectors = await collectorMailboxIds();
  const scanned: Types.ObjectId[] = [];
  for (let page = 0; page < 10; page++) {
    const candidates = await EmailMailbox.find({
      providerId: input.providerId, enabled: true, status: "AVAILABLE", email: { $nin: usedEmails },
      _id: { $nin: [...collectors, ...scanned] },
    }).sort({ totalRentals: 1, createdAt: 1 }).limit(100).select("_id email providerId username lastUid").lean();
    if (!candidates.length) break;
    for (const candidate of candidates) scanned.push(candidate._id);
    const claimed = await claimFirstAvailable(candidates, async (candidate) => {
      const result = await EmailMailbox.findOneAndUpdate({
        _id: candidate._id, enabled: true, status: "AVAILABLE",
      }, { $set: { status: "RESERVED", reservedBy: input.userId, reservedUntil: input.reservationExpiresAt }, $unset: { lastError: 1 } }, { returnDocument: "after" }).lean();
      return Boolean(result);
    });
    if (claimed) return claimed as unknown as ClaimedMailbox;
  }
  throw new Error("Stok email untuk layanan ini baru saja habis. Coba pilih provider lain.");
}

export async function reserveDomainAlias(input: {
  serviceId: string; domainId: string; userId: string; reservationExpiresAt: Date;
}): Promise<{ _id: unknown; address: string; localPart: string; domainId: string; cloudflareZoneId: string; destinationMailboxId: string }> {
  await assertEmailUsageIndex();
  await assertCounterIndex();
  await EmailOtpService.findOne({ _id: input.serviceId, enabled: true }).orFail().lean();
  const domain = await EmailDomain.findOne({ _id: input.domainId, enabled: true, sellable: true }).lean();
  if (!domain) throw new Error("Domain email tidak tersedia.");
  for (let attempt = 0; attempt < 8; attempt++) {
    const localPart = randomBytes(7).toString("hex");
    const address = localPart + "@" + domain.domain;
    try {
      const alias = await EmailDomainAlias.create({
        domainId: String(domain._id), address, localPart, cloudflareZoneId: domain.zoneId, status: "RESERVED",
      });
      return {
        _id: alias._id, address: alias.address, localPart: alias.localPart, domainId: String(alias.domainId),
        cloudflareZoneId: alias.cloudflareZoneId, destinationMailboxId: domain.destinationMailboxId,
      };
    } catch (error) {
      if (!duplicate(error)) throw error;
    }
  }
  throw new Error("Tidak bisa membuat alamat email unik. Coba lagi.");
}

export async function releaseReservedResource(type: "MAILBOX" | "DOMAIN_ALIAS", id: string, userId: string): Promise<void> {
  if (type === "MAILBOX") {
    await EmailMailbox.updateOne(
      { _id: id, status: "RESERVED", reservedBy: userId },
      { $set: { status: "AVAILABLE" }, $unset: { reservedBy: 1, reservedUntil: 1 } },
    );
  } else {
    await EmailDomainAlias.updateOne(
      { _id: id, status: "RESERVED" },
      { $set: { status: "RETIRED", retiredAt: new Date(), ruleDeleted: true }, $unset: { rentalId: 1 } },
    );
  }
}
