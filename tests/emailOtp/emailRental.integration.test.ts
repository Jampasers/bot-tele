import assert from "node:assert/strict";
import test from "node:test";
import mongoose, { Types } from "mongoose";
import { randomBytes, randomUUID } from "node:crypto";
import { EmailDomain } from "../../src/models/EmailDomain.js";
import { EmailMailbox } from "../../src/models/EmailMailbox.js";
import { EmailOtpService } from "../../src/models/EmailOtpService.js";
import { EmailProvider } from "../../src/models/EmailProvider.js";
import { EmailRentalCounter } from "../../src/models/EmailRentalCounter.js";
import { EmailRentalPrice } from "../../src/models/EmailRentalPrice.js";
import { EmailUsage } from "../../src/models/EmailUsage.js";
import { encryptSecret } from "../../src/services/crypto.js";
import { runWithTenant } from "../../src/tenant/context.js";
import { getEligibleMailboxCount, reserveMailboxCandidate, releaseReservedResource } from "../../src/email/services/emailReservation.service.js";
import { GLOBAL_EMAIL_SERVICE_ID, getEmailRentalPrice } from "../../src/email/services/emailPricing.service.js";

const uri = process.env.TEST_MONGODB_URI;

test("Email Rental usage is permanent per service and atomic mailbox reservation is race-safe", { skip: !uri }, async () => {
  assert.match(uri!, /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//);
  const dbName = "email_rental_test_" + randomUUID().replaceAll("-", "");
  const savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  await mongoose.connect(uri!, { dbName, autoCreate: false, autoIndex: false });
  const models = [EmailProvider, EmailMailbox, EmailOtpService, EmailUsage, EmailRentalCounter, EmailDomain, EmailRentalPrice];
  try {
    for (const Model of models) {
      await Model.createCollection();
      await Model.createIndexes();
    }
    const tenantId = "email_test_" + randomUUID().replaceAll("-", "");
    await runWithTenant({ tenantId }, async () => {
      const provider = await EmailProvider.create({ code: "TEST", name: "Test IMAP", imapHost: "localhost", imapPort: 993, imapSecure: true });
      const discord = await EmailOtpService.create({ code: "DISCORD", name: "Discord", rentalDurationMinutes: 20, cooldownMinutes: 5,
        senderPatterns: ["discord"], subjectPatterns: ["verification"] });
      const netflix = await EmailOtpService.create({ code: "NETFLIX", name: "Netflix", rentalDurationMinutes: 20, cooldownMinutes: 5,
        senderPatterns: ["netflix"], subjectPatterns: ["code"] });
      const steam = await EmailOtpService.create({ code: "STEAM", name: "Steam", rentalDurationMinutes: 20, cooldownMinutes: 5,
        senderPatterns: ["steam"], subjectPatterns: ["code"] });
      await EmailRentalPrice.create({
        serviceId: GLOBAL_EMAIL_SERVICE_ID, providerId: String(provider._id), resourceType: "MAILBOX", price: 2000,
      });
      assert.equal((await getEmailRentalPrice({
        serviceId: String(discord._id), providerId: String(provider._id), resourceType: "MAILBOX",
      }))?.price, 2000, "global provider price applies without per-service setup");
      await EmailRentalPrice.create({
        serviceId: String(discord._id), providerId: String(provider._id), resourceType: "MAILBOX", price: 2500,
      });
      assert.equal((await getEmailRentalPrice({
        serviceId: String(discord._id), providerId: String(provider._id), resourceType: "MAILBOX",
      }))?.price, 2500, "service-specific price overrides the provider global price");
      const mailboxIds = [new Types.ObjectId(), new Types.ObjectId()];
      await Promise.all(mailboxIds.map((id, index) => EmailMailbox.create({
        _id: id, providerId: String(provider._id), email: `m${index + 1}@example.invalid`, username: `m${index + 1}@example.invalid`,
        credentialEncrypted: encryptSecret("test-only-password", `email-mailbox:${String(id)}:credential`),
        status: "AVAILABLE", enabled: true,
      })));
      await EmailUsage.create([
        { emailResourceType: "MAILBOX", emailResourceId: "m1@example.invalid", serviceId: String(discord._id), rentalId: "r1", usedBy: "1" },
        { emailResourceType: "MAILBOX", emailResourceId: "m1@example.invalid", serviceId: String(steam._id), rentalId: "r2", usedBy: "2" },
      ]);

      assert.equal(await getEligibleMailboxCount(String(discord._id), String(provider._id)), 1);
      assert.equal(await getEligibleMailboxCount(String(netflix._id), String(provider._id)), 2);
      await assert.rejects(EmailUsage.create({
        emailResourceType: "MAILBOX", emailResourceId: "m1@example.invalid", serviceId: String(discord._id), rentalId: "r3", usedBy: "3",
      }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === 11000);

      // Re-importing an address with a new mailbox document cannot reset its
      // permanent service history.
      await EmailMailbox.deleteOne({ _id: mailboxIds[0] });
      await EmailMailbox.create({
        _id: new Types.ObjectId(), providerId: String(provider._id), email: "m1@example.invalid", username: "m1@example.invalid",
        credentialEncrypted: encryptSecret("test-only-password", "email-mailbox:replacement:credential"), status: "AVAILABLE", enabled: true,
      });
      assert.equal(await getEligibleMailboxCount(String(discord._id), String(provider._id)), 1);
      assert.equal(await getEligibleMailboxCount(String(netflix._id), String(provider._id)), 2);

      const results = await Promise.allSettled(["user_a", "user_b"].map((userId) => reserveMailboxCandidate({
        serviceId: String(steam._id), providerId: String(provider._id), userId, reservationExpiresAt: new Date(Date.now() + 60_000),
      })));
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const winner = results.find((result) => result.status === "fulfilled");
      assert.ok(winner && winner.status === "fulfilled");
      assert.equal(String(winner.value._id), String(mailboxIds[1]));
      assert.equal(await EmailUsage.exists({ emailResourceId: "m2@example.invalid", serviceId: String(steam._id) }), null,
        "an unpaid reservation does not commit permanent service usage");

      const winningUser = results[0]?.status === "fulfilled" ? "user_a" : "user_b";
      await releaseReservedResource("MAILBOX", String(mailboxIds[1]), winningUser);
      const released = await EmailMailbox.findById(mailboxIds[1]).lean();
      assert.equal(released?.status, "AVAILABLE", "released reservation returns to stock");
    });
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    if (savedKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
  }
});
