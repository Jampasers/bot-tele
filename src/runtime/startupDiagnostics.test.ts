import assert from "node:assert/strict";
import test from "node:test";
import { formatStartupFailure, type StartupStage } from "./startupDiagnostics.js";

test("startup diagnostics expose safe configuration guidance", () => {
  assert.match(
    formatStartupFailure("environment", new Error("BOT_TOKEN and MONGODB_URI are required.")),
    /BOT_TOKEN and MONGODB_URI are required in \.env/,
  );
  assert.match(
    formatStartupFailure("environment", new Error("CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes encoded as 64 hex characters or base64.")),
    /CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes/,
  );
  assert.match(
    formatStartupFailure("rental-webhook", new Error("Invalid RENTAL_WEBHOOK_PORT.")),
    /must be 0 or an integer from 1 to 65535/,
  );
});

test("startup diagnostics never expose arbitrary provider or credential errors", () => {
  const secret = "super-secret-token-and-password";
  const stages: StartupStage[] = [
    "environment",
    "database",
    "migration",
    "provider-data",
    "platform-bot",
    "rental-runtime",
    "rental-webhook",
    "ready",
  ];

  for (const stage of stages) {
    const output = formatStartupFailure(stage, new Error(secret));
    assert.doesNotMatch(output, /super-secret-token-and-password/);
    assert.match(output, new RegExp(`during ${stage}`));
  }
});

test("tenant migration diagnostics preserve the actionable collection report", () => {
  const message = "Tenant migration required. users: legacy documents need a tenantId";
  assert.equal(formatStartupFailure("migration", new Error(message)), message);
});
