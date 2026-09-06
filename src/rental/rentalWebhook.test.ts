import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { verifyRentalWebhook } from "./rentalWebhook.js";

test("webhook signature rejects changed payload, secret, stale timestamp and malformed signature", () => {
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  const timestamp = String(now);
  const body = Buffer.from('{"providerReference":"test-invoice"}');
  const signature = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
  assert.equal(verifyRentalWebhook(body, timestamp, signature, secret, now), true);
  assert.equal(verifyRentalWebhook(Buffer.from("changed"), timestamp, signature, secret, now), false);
  assert.equal(verifyRentalWebhook(body, timestamp, signature, "x".repeat(32), now), false);
  assert.equal(verifyRentalWebhook(body, timestamp, signature, secret, now + 301_000), false);
  assert.equal(verifyRentalWebhook(body, timestamp, "invalid", secret, now), false);
  assert.equal(verifyRentalWebhook(body, timestamp, signature, "short", now), false);
});
