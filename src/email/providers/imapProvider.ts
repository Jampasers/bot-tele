import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailMailboxProvider, InboundEmail, MailboxCredentials } from "../contracts.js";

export class ImapMailboxProviderError extends Error {
  constructor(readonly kind: "AUTH" | "TRANSIENT") { super(kind === "AUTH" ? "IMAP authentication failed." : "IMAP connection failed."); }
}

function buildClient(credentials: MailboxCredentials): any {
  return new ImapFlow({
    host: credentials.host, port: credentials.port, secure: credentials.secure,
    auth: { user: credentials.username, pass: credentials.password }, logger: false,
    connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 25_000,
  });
}
function addresses(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const item = entry as { address?: string; name?: string };
    return item.address ? (item.name ? item.name + " <" + item.address + ">" : item.address) : "";
  }).filter(Boolean).join(", ");
}
function recipientFrom(parsed: Awaited<ReturnType<typeof simpleParser>>): string {
  for (const name of ["x-original-to", "delivered-to", "envelope-to", "x-envelope-to"]) {
    const value = parsed.headers.get(name);
    if (typeof value === "string" && value.includes("@")) return value.trim().slice(0, 320);
  }
  const recipients = parsed.to;
  if (!recipients) return "";
  return Array.isArray(recipients)
    ? recipients.map((entry) => addresses(entry.value)).filter(Boolean).join(", ")
    : addresses(recipients.value);
}
export class ImapMailboxProvider implements EmailMailboxProvider {
  async testConnection(credentials: MailboxCredentials): Promise<void> {
    const client = buildClient(credentials);
    try { await client.connect(); await client.mailboxOpen(credentials.mailbox || "INBOX"); }
    catch (error) { throw new ImapMailboxProviderError(isAuthFailure(error) ? "AUTH" : "TRANSIENT"); }
    finally { await client.logout().catch(() => {}); }
  }
  async fetchMessages(credentials: MailboxCredentials, afterUid: number): Promise<InboundEmail[]> {
    const client = buildClient(credentials);
    const output: InboundEmail[] = [];
    try {
      await client.connect();
      await client.mailboxOpen(credentials.mailbox || "INBOX");
      const box = client.mailbox as { uidNext?: number } | false;
      const uidNext = box && typeof box.uidNext === "number" ? box.uidNext : afterUid + 1;
      const startUid = Math.max(afterUid + 1, afterUid === 0 ? uidNext - 20 : 1);
      const endUid = Math.min(Math.max(startUid, uidNext - 1), startUid + 19);
      if (endUid < startUid) return output;
      const range = String(startUid) + ":" + String(endUid);
      for await (const item of client.fetch(range, { uid: true, source: { maxLength: 128 * 1024 }, internalDate: true }, { uid: true })) {
        if (!item.source) continue;
        const parsed = await simpleParser(item.source);
        const sender = addresses(parsed.from?.value);
        const uid = Number(item.uid);
        output.push({
          ...(Number.isFinite(uid) ? { uid } : {}), messageId: parsed.messageId?.trim() || "uid:" + String(uid),
          sender: sender.slice(0, 320), recipient: recipientFrom(parsed), subject: (parsed.subject || "").slice(0, 500),
          receivedAt: item.internalDate instanceof Date ? item.internalDate : parsed.date ?? new Date(),
          text: (parsed.text || "").slice(0, 20_000),
          ...(typeof parsed.html === "string" ? { html: parsed.html.slice(0, 20_000) } : {}),
        });
      }
      return output;
    } catch (error) { throw new ImapMailboxProviderError(isAuthFailure(error) ? "AUTH" : "TRANSIENT"); }
    finally { await client.logout().catch(() => {}); }
  }
}
function isAuthFailure(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as { message?: unknown; code?: unknown; responseText?: unknown } : {};
  const summary = [value.message, value.code, value.responseText].filter((part): part is string => typeof part === "string").join(" ").toLowerCase();
  return /auth|login|password|credential|authenticationfailed/.test(summary);
}
export const imapMailboxProvider = new ImapMailboxProvider();
