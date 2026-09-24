export interface MailboxCredentials {
  host: string; port: number; secure: boolean; username: string; password: string; mailbox: string;
}
export interface InboundEmail {
  uid?: number; messageId: string; sender: string; recipient: string; subject: string;
  receivedAt: Date; text: string; html?: string;
}
export interface EmailMailboxProvider {
  testConnection(credentials: MailboxCredentials): Promise<void>;
  fetchMessages(credentials: MailboxCredentials, afterUid: number): Promise<InboundEmail[]>;
  startListening?(credentials: MailboxCredentials, onMessage: (message: InboundEmail) => Promise<void>): Promise<() => Promise<void>>;
}
export interface EmailDomainProvider {
  createAlias(input: { zoneId: string; domain: string; localPart: string; destinationEmail: string }): Promise<{ address: string; ruleId: string }>;
  deleteAlias(input: { zoneId: string; ruleId: string }): Promise<void>;
}
export interface EmailInboundSource {
  handleIncomingMessage(input: { sourceType: "MAILBOX" | "DOMAIN_ALIAS"; sourceId: string; mailboxId?: string; domainAliasId?: string; message: InboundEmail }): Promise<void>;
}
export interface ParsedOtpEmail {
  otpCode?: string; verificationLink?: string; magicLink?: string; subject: string; sender: string;
  receivedAt: Date; preview: string;
}
export interface OtpServiceMatchers {
  senderPatterns: string[]; subjectPatterns: string[]; otpPatterns?: string[];
  allowMagicLink: boolean; allowVerificationLink: boolean;
}
