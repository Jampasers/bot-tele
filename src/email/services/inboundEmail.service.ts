import type { Api } from "grammy";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailMessage } from "../../models/EmailMessage.js";
import { EmailRental } from "../../models/EmailRental.js";
import { EmailRentalSettings } from "../../models/EmailRentalSettings.js";
import { ActivityLogService } from "../../services/activityLog.js";
import type { EmailInboundSource, InboundEmail } from "../contracts.js";
import { matchesOtpService, parseOtpEmail } from "./otpParser.js";

const duplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === 11000;
const safeLine = (value: string): string => value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
function extractRecipientAddresses(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);
}

export function isMessageForRental(
  rental: { status: string; startedAt?: Date; expiresAt?: Date; startUid: number; resourceType: "MAILBOX" | "DOMAIN_ALIAS" },
  message: Pick<InboundEmail, "receivedAt" | "uid">,
  graceMs: number,
): boolean {
  if (rental.status !== "ACTIVE" && rental.status !== "EXPIRED") return false;
  if (!rental.startedAt || !rental.expiresAt || message.receivedAt < rental.startedAt) return false;
  if (message.receivedAt.getTime() > rental.expiresAt.getTime() + graceMs) return false;
  if (rental.resourceType === "MAILBOX" && typeof message.uid === "number" && message.uid <= rental.startUid) return false;
  return true;
}

export class InboundEmailService implements EmailInboundSource {
  constructor(private readonly api: Api) {}

  async sendNotice(userId: string, text: string): Promise<void> {
    await this.api.sendMessage(userId, text.slice(0, 1000), { link_preview_options: { is_disabled: true } });
  }

  async handleIncomingMessage(input: {
    sourceType: "MAILBOX" | "DOMAIN_ALIAS"; sourceId: string; mailboxId?: string; domainAliasId?: string; message: InboundEmail;
  }): Promise<void> {
    const resourceType = input.sourceType;
    const resourceId = resourceType === "MAILBOX" ? input.mailboxId : input.domainAliasId;
    if (!resourceId) return;
    const settings = await EmailRentalSettings.findOne().lean();
    const graceMs = (settings?.messageGraceMinutes ?? 5) * 60_000;
    const rentals = await EmailRental.find({
      resourceType, resourceId,
      $or: [{ status: "ACTIVE" }, { status: "EXPIRED", expiresAt: { $gte: new Date(Date.now() - graceMs) } }],
    }).lean();
    if (!rentals.length) return;
    const alias = resourceType === "DOMAIN_ALIAS" ? await EmailDomainAlias.findById(resourceId).lean() : null;
    const recipient = input.message.recipient.toLowerCase();
    const recipientAddresses = extractRecipientAddresses(recipient);
    const receivedAt = input.message.receivedAt instanceof Date && Number.isFinite(input.message.receivedAt.getTime())
      ? input.message.receivedAt : new Date();
    const messageId = safeLine(input.message.messageId || "missing-message-id").slice(0, 255);

    for (const rental of rentals) {
      if (!isMessageForRental(rental, { ...input.message, receivedAt }, graceMs)) continue;
      if (resourceType === "DOMAIN_ALIAS" && (!alias || !recipientAddresses.includes(alias.address.toLowerCase()))) continue;
      if (resourceType === "MAILBOX" && recipientAddresses.length && !recipientAddresses.includes(rental.emailAddress.toLowerCase())) continue;
      const service = {
        senderPatterns: rental.serviceSnapshot.senderPatterns,
        subjectPatterns: rental.serviceSnapshot.subjectPatterns,
        otpPatterns: rental.serviceSnapshot.otpPatterns,
        allowMagicLink: rental.serviceSnapshot.allowMagicLink,
        allowVerificationLink: rental.serviceSnapshot.allowVerificationLink,
      };
      if (!matchesOtpService(input.message, service)) continue;
      const parsed = parseOtpEmail(input.message, service);
      const hasCredential = Boolean(parsed.otpCode || parsed.verificationLink || parsed.magicLink);
      let message;
      try {
        [message] = await EmailMessage.create([{
          sourceType: resourceType, sourceId: input.sourceId, messageId,
          ...(typeof input.message.uid === "number" ? { uid: input.message.uid } : {}),
          ...(resourceType === "MAILBOX" ? { mailboxId: resourceId } : { domainAliasId: resourceId }),
          rentalId: String(rental._id), sender: safeLine(parsed.sender), recipient: safeLine(recipient || rental.emailAddress),
          subject: safeLine(parsed.subject), receivedAt, ...(parsed.otpCode ? { otpCode: parsed.otpCode } : {}),
          ...(parsed.verificationLink ? { verificationLink: parsed.verificationLink } : {}),
          ...(parsed.magicLink ? { magicLink: parsed.magicLink } : {}),
          preview: parsed.preview, dispatchStatus: hasCredential ? "SENDING" : "IGNORED",
        }]);
      } catch (error) {
        if (duplicate(error)) continue;
        throw error;
      }
      if (!message || !hasCredential) continue;
      const receivedTime = receivedAt.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });
      const body = [
        "📨 Email baru untuk rental OTP",
        "Layanan: " + rental.serviceSnapshot.icon + " " + safeLine(rental.serviceSnapshot.name),
        "From: " + safeLine(parsed.sender),
        "Subject: " + safeLine(parsed.subject),
        parsed.otpCode ? "🔐 OTP: " + parsed.otpCode : "",
        parsed.verificationLink ? "🔗 Verification link: " + parsed.verificationLink : "",
        parsed.magicLink ? "🔗 Magic link: " + parsed.magicLink : "",
        "Received: " + receivedTime + " WIB",
        "",
        parsed.preview,
      ].filter(Boolean).join("\n");
      try {
        await this.api.sendMessage(rental.userId, body, { link_preview_options: { is_disabled: true } });
        await EmailMessage.updateOne({ _id: message._id, dispatchStatus: "SENDING" }, { $set: { dispatchStatus: "SENT" } });
        await EmailRental.updateOne({ _id: rental._id, status: "ACTIVE" }, { $set: { lastMessageAt: receivedAt } });
        await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), {
          event: "otp_received", rentalId: String(rental._id), userId: rental.userId, serviceName: rental.serviceSnapshot.name,
        });
      } catch {
        await EmailMessage.updateOne({ _id: message._id, dispatchStatus: "SENDING" }, { $set: { dispatchStatus: "FAILED" } }).catch(() => {});
        console.warn("[EmailRental] OTP delivery failed; message details are withheld from logs.");
      }
    }
  }
}
