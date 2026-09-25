import type { Api } from "grammy";
import { EmailDomain } from "../../models/EmailDomain.js";
import { EmailDomainAlias } from "../../models/EmailDomainAlias.js";
import { EmailMailbox } from "../../models/EmailMailbox.js";
import { EmailProvider } from "../../models/EmailProvider.js";
import { EmailRental } from "../../models/EmailRental.js";
import { EmailRentalSettings } from "../../models/EmailRentalSettings.js";
import { decryptSecret } from "../../services/crypto.js";
import { ActivityLogService } from "../../services/activityLog.js";
import { hasFeature } from "../../tenant/features.js";
import { getTenantId } from "../../tenant/context.js";
import { clearTenantInterval, setTenantInterval } from "../../runtime/tenantTimers.js";
import type { InboundEmail } from "../contracts.js";
import { imapMailboxProvider, ImapMailboxProviderError } from "../providers/imapProvider.js";
import { InboundEmailService } from "../services/inboundEmail.service.js";
import { recoverActiveMailboxFailure, sweepEmailRentalLifecycle } from "../services/emailRental.service.js";

interface MailboxSource {
  mailboxId: string;
  aliases: Map<string, string>;
  directRental: boolean;
}
interface FailureState { attempts: number; retryAt: number; }

export class MailboxConnectionManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, FailureState>();
  private readonly lastPollAt = new Map<string, number>();

  async start(api: Api): Promise<void> {
    const tenantId = getTenantId();
    if (process.env.EMAIL_RENTAL_ENABLED !== "true" || !hasFeature("email_otp") || this.timers.has(tenantId)) return;
    // Small scheduler cadence lets admin changes to pollIntervalSeconds take
    // effect without restarting a tenant bot.
    const timer = setTenantInterval(() => this.tick(api), 5_000);
    this.timers.set(tenantId, timer);
    void this.tick(api);
  }

  async stop(): Promise<void> {
    const tenantId = getTenantId();
    clearTenantInterval(this.timers.get(tenantId));
    this.timers.delete(tenantId);
    await this.inFlight.get(tenantId);
    const prefix = tenantId + ":";
    for (const key of this.failures.keys()) if (key.startsWith(prefix)) this.failures.delete(key);
    this.lastPollAt.delete(tenantId);
  }

  private tick(api: Api): Promise<void> {
    const tenantId = getTenantId();
    const existing = this.inFlight.get(tenantId);
    if (existing) return existing;
    const task = this.runTick(api).catch(() => {
      console.warn("[Tenant:" + tenantId + "] Email Rental polling failed; it will retry.");
    }).finally(() => {
      if (this.inFlight.get(tenantId) === task) this.inFlight.delete(tenantId);
    });
    this.inFlight.set(tenantId, task);
    return task;
  }

  private async runTick(api: Api): Promise<void> {
    const settings = await EmailRentalSettings.findOne().lean();
    const tenantId = getTenantId();
    const cadence = Math.min(300, Math.max(5, settings?.pollIntervalSeconds ?? 15)) * 1000;
    const last = this.lastPollAt.get(tenantId) ?? 0;
    if (Date.now() - last < cadence) return;
    this.lastPollAt.set(tenantId, Date.now());
    await sweepEmailRentalLifecycle(api);
    const maximum = Math.min(25, Math.max(1, settings?.maxConcurrentConnections ?? 5));
    const active = await EmailRental.find({
      $or: [
        { status: "ACTIVE" },
        { status: "EXPIRED", expiresAt: { $gte: new Date(Date.now() - (settings?.messageGraceMinutes ?? 5) * 60_000) } },
      ],
    }).sort({ startedAt: 1 }).select("resourceType resourceId").lean();
    if (!active.length) return;
    const sources = new Map<string, MailboxSource>();
    for (const rental of active) {
      if (rental.resourceType === "MAILBOX") {
        const mailboxId = rental.resourceId;
        const source = sources.get(mailboxId) ?? { mailboxId, aliases: new Map<string, string>(), directRental: false };
        source.directRental = true;
        sources.set(mailboxId, source);
      } else {
        const alias = await EmailDomainAlias.findById(rental.resourceId).lean();
        const domain = alias ? await EmailDomain.findById(alias.domainId).lean() : null;
        if (!domain || domain.routingMode !== "FORWARD") continue;
        const mailboxId = domain.destinationMailboxId;
        const source = sources.get(mailboxId) ?? { mailboxId, aliases: new Map<string, string>(), directRental: false };
        source.aliases.set(String(alias!._id), alias!.address);
        sources.set(mailboxId, source);
      }
    }
    const jobs = [...sources.values()];
    const inbound = new InboundEmailService(api);
    let next = 0;
    const runners = Array.from({ length: Math.min(maximum, jobs.length) }, async () => {
      while (next < jobs.length) {
        const source = jobs[next++];
        if (source) await this.pollMailbox(source, inbound, api);
      }
    });
    await Promise.all(runners);
  }

  private async pollMailbox(source: MailboxSource, inbound: InboundEmailService, api: Api): Promise<void> {
    const mailboxId = source.mailboxId;
    const key = getTenantId() + ":" + mailboxId;
    const failure = this.failures.get(key);
    if (failure && failure.retryAt > Date.now()) return;
    const mailbox = await EmailMailbox.findById(mailboxId).select("+credentialEncrypted").lean();
    if (!mailbox || !mailbox.enabled || mailbox.status === "DISABLED" || mailbox.status === "BROKEN") return;
    const provider = await EmailProvider.findOne({ _id: mailbox.providerId, enabled: true }).lean();
    if (!provider) return;
    const password = decryptSecret(mailbox.credentialEncrypted, "email-mailbox:" + String(mailbox._id) + ":credential");
    const credentials = {
      host: provider.imapHost, port: provider.imapPort, secure: provider.imapSecure,
      username: mailbox.username, password, mailbox: "INBOX",
    };
    try {
      const messages = await imapMailboxProvider.fetchMessages(credentials, mailbox.lastUid ?? 0);
      let maxUid = mailbox.lastUid ?? 0;
      for (const message of messages) {
        if (typeof message.uid === "number") maxUid = Math.max(maxUid, message.uid);
        if (source.directRental) {
          await inbound.handleIncomingMessage({ sourceType: "MAILBOX", sourceId: mailboxId, mailboxId, message });
        }
        if (source.aliases.size) {
          const lowerRecipient = message.recipient.toLowerCase();
          for (const [aliasId, address] of source.aliases) {
            if (lowerRecipient.includes(address.toLowerCase())) {
              await inbound.handleIncomingMessage({ sourceType: "DOMAIN_ALIAS", sourceId: aliasId, domainAliasId: aliasId, message });
            }
          }
        }
      }
      await EmailMailbox.updateOne({ _id: mailboxId }, {
        $set: { lastCheckedAt: new Date(), lastSuccessfulLoginAt: new Date(), lastUid: maxUid },
        ...(messages.length ? { $inc: { totalMessages: messages.length } } : {}),
        $unset: { lastError: 1 },
      });
      this.failures.delete(key);
    } catch (error) {
      const authFailure = error instanceof ImapMailboxProviderError && error.kind === "AUTH";
      const current = this.failures.get(key) ?? { attempts: 0, retryAt: 0 };
      const attempts = Math.min(8, current.attempts + 1);
      this.failures.set(key, { attempts, retryAt: Date.now() + Math.min(300_000, 5_000 * (2 ** (attempts - 1))) });
      if (authFailure) {
        await EmailMailbox.updateOne({ _id: mailboxId }, { $set: { status: "BROKEN", enabled: false, lastCheckedAt: new Date(), lastError: "IMAP authentication failed" } });
        await ActivityLogService.logEmailRentalEvent(ActivityLogService.getDefaultApi(), { event: "mailbox_broken" });
        if (source.directRental) {
          const replacements = await recoverActiveMailboxFailure(mailboxId, api).catch(() => []);
          for (const rental of replacements) {
            await this.apiSendReplacementNotice(inbound, rental.userId, rental.emailAddress).catch(() => {});
          }
        }
      } else {
        await EmailMailbox.updateOne({ _id: mailboxId }, { $set: { lastCheckedAt: new Date(), lastError: "IMAP temporarily unavailable" } });
      }
      console.warn("[EmailRental] Mailbox poll failed; connection details are withheld.");
    }
  }

  private async apiSendReplacementNotice(inbound: InboundEmailService, userId: string, address: string): Promise<void> {
    await inbound.sendNotice(userId, "📧 Mailbox sebelumnya tidak dapat diakses. Rental dilanjutkan menggunakan alamat pengganti: " + address);
  }
}

export const emailRentalWorker = new MailboxConnectionManager();
