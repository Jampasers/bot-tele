import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { EmailUsage } from "../../src/models/EmailUsage.js";
import { emailResourceKey } from "../../src/email/services/emailUsage.service.js";
import { isMessageForRental } from "../../src/email/services/inboundEmail.service.js";
import { claimFirstAvailable } from "../../src/email/services/emailReservation.service.js";
import { parseOtpEmail, matchesOtpService } from "../../src/email/services/otpParser.js";
import { decryptSecret, encryptSecret } from "../../src/services/crypto.js";
import { scopeTenantFilter } from "../../src/tenant/tenantPlugin.js";
import { runWithTenant } from "../../src/tenant/context.js";
import { GLOBAL_EMAIL_SERVICE_ID, selectEmailRentalPrice } from "../../src/email/services/emailPricing.service.js";

const service = {
  senderPatterns: ["discord\\.com"], subjectPatterns: ["verification|security code"], otpPatterns: [],
  allowMagicLink: true, allowVerificationLink: true,
};
function message(text: string, overrides: Record<string, unknown> = {}) {
  return {
    messageId: "<test@example.invalid>", sender: "Discord <noreply@discord.com>", recipient: "renter@example.invalid",
    subject: "Your verification code", receivedAt: new Date("2026-01-01T00:00:00Z"), text, ...overrides,
  };
}

test("generic OTP parser extracts context-bound 4-8 digit codes and hyphenated values", () => {
  assert.equal(parseOtpEmail(message("Your code is 123456"), service).otpCode, "123456");
  assert.equal(parseOtpEmail(message("Verification code: 823-199"), service).otpCode, "823199");
  assert.equal(parseOtpEmail(message("OTP: 7264"), service).otpCode, "7264");
  assert.equal(parseOtpEmail(message("Order 123456 costs $19.99"), service).otpCode, undefined);
  assert.equal(parseOtpEmail(message("Your code is year 2025 and order #991234"), service).otpCode, undefined);
});

test("generic OTP parser extracts allowed verification and magic links only from safe URLs", () => {
  const result = parseOtpEmail(message("Use the verification link, then sign in.", {
    html: '<a href="https://example.invalid/verify?t=abc">Verify account</a> <a href="https://example.invalid/login?token=xyz">Magic link</a>',
  }), service);
  assert.equal(result.verificationLink, "https://example.invalid/verify?t=abc");
  assert.equal(result.magicLink, "https://example.invalid/login?token=xyz");
  const unsafe = parseOtpEmail(message("verification link", { text: "javascript:alert(1)" }), service);
  assert.equal(unsafe.verificationLink, undefined);
});

test("sender and subject matching fails closed when service matchers do not match", () => {
  assert.equal(matchesOtpService({ sender: "Discord <noreply@discord.com>", subject: "Your verification code" }, service), true);
  assert.equal(matchesOtpService({ sender: "Newsletter <news@example.invalid>", subject: "Your verification code" }, service), false);
  assert.equal(matchesOtpService({ sender: "noreply@discord.com", subject: "Weekly offers" }, service), false);
  assert.equal(matchesOtpService({ sender: "anything", subject: "anything" }, { ...service, senderPatterns: [], subjectPatterns: [] }), false);
});

test("late messages stay with the original rental only inside its receive-time and UID window", () => {
  const startedAt = new Date("2026-01-01T00:00:00Z");
  const expiresAt = new Date("2026-01-01T00:20:00Z");
  const expiredRental = { status: "EXPIRED", startedAt, expiresAt, startUid: 30, resourceType: "MAILBOX" as const };
  const received = (time: string, uid: number) => ({ receivedAt: new Date(time), uid });
  assert.equal(isMessageForRental(expiredRental, received("2026-01-01T00:00:00Z", 31), 5 * 60_000), true);
  assert.equal(isMessageForRental(expiredRental, received("2025-12-31T23:59:59Z", 31), 5 * 60_000), false);
  assert.equal(isMessageForRental(expiredRental, received("2026-01-01T00:25:00.001Z", 31), 5 * 60_000), false);
  assert.equal(isMessageForRental(expiredRental, received("2026-01-01T00:22:00Z", 30), 5 * 60_000), false);
  const nextRenter = { ...expiredRental, status: "ACTIVE", startedAt: expiresAt, expiresAt: new Date("2026-01-01T00:40:00Z") };
  assert.equal(isMessageForRental(nextRenter, received("2026-01-01T00:19:00Z", 31), 5 * 60_000), false);
});

test("EmailUsage declares a tenant-scoped permanent unique resource/service index", () => {
  const index = EmailUsage.schema.indexes().find(([keys, options]) =>
    options.unique === true && keys.emailResourceId === 1 && keys.serviceId === 1);
  assert.ok(index);
  assert.equal(Object.keys(index[0])[0], "tenantId");
  assert.deepEqual(index[0], { tenantId: 1, emailResourceId: 1, serviceId: 1 });
  assert.equal(emailResourceKey("MAILBOX", " Gmail01@Example.com "), "gmail01@example.com");
});

test("parsed OTP messages expire after 30 days while permanent usage history remains", async () => {
  const { EmailMessage } = await import("../../src/models/EmailMessage.js");
  const expiry = EmailMessage.schema.indexes().find(([, options]) => options.expireAfterSeconds !== undefined);
  assert.ok(expiry);
  assert.deepEqual(expiry[0], { createdAt: 1 });
  assert.equal(expiry[1].expireAfterSeconds, 30 * 24 * 60 * 60);
});

test("atomic candidate claiming gives one shared resource to only one concurrent request", async () => {
  const available = new Set(["one-mailbox"]);
  const claims = await Promise.all([
    claimFirstAvailable(["one-mailbox"], async (id) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (!available.has(id)) return false;
      available.delete(id);
      return true;
    }),
    claimFirstAvailable(["one-mailbox"], async (id) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (!available.has(id)) return false;
      available.delete(id);
      return true;
    }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test("credential ciphertext is purpose-bound and never equals the source password", () => {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  try {
    const password = "test-only-app-password";
    const encrypted = encryptSecret(password, "email-mailbox:507f1f77bcf86cd799439011:credential");
    assert.notEqual(encrypted, password);
    assert.equal(decryptSecret(encrypted, "email-mailbox:507f1f77bcf86cd799439011:credential"), password);
    assert.throws(() => decryptSecret(encrypted, "email-mailbox:other-id:credential"), /Credential decryption failed/);
  } finally {
    if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  }
});

test("Email Rental model filters remain tenant-scoped", () => runWithTenant({ tenantId: "email_tenant_a" }, () => {
  assert.deepEqual(scopeTenantFilter({ serviceId: "discord" }), {
    $and: [{ serviceId: "discord" }, { tenantId: "email_tenant_a" }],
  });
}));

test("email pricing prefers a service override and otherwise falls back to the provider global price", () => {
  const global = { serviceId: GLOBAL_EMAIL_SERVICE_ID, price: 2000 };
  const discord = { serviceId: "discord-service-id", price: 2500 };
  assert.equal(selectEmailRentalPrice([global, discord], discord.serviceId)?.price, 2500);
  assert.equal(selectEmailRentalPrice([global, discord], "new-service-id")?.price, 2000);
  assert.equal(selectEmailRentalPrice([discord], "new-service-id"), null);
});


test("Email Rental persists QRIS Telegram message metadata for durable expiry cleanup", async () => {
  const { EmailRental } = await import("../../src/models/EmailRental.js");
  assert.ok(EmailRental.schema.path("qrisChatId"));
  assert.ok(EmailRental.schema.path("qrisMessageId"));
  const status = EmailRental.schema.path("status") as unknown as { enumValues?: string[] };
  assert.ok(status.enumValues?.includes("EXPIRED"));
});
