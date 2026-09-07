export type StartupStage =
  | "environment"
  | "database"
  | "migration"
  | "provider-data"
  | "platform-bot"
  | "rental-runtime"
  | "rental-webhook"
  | "ready";

const GENERIC_GUIDANCE: Record<StartupStage, string> = {
  environment: "Check BOT_TOKEN, MONGODB_URI, RENTAL_ENABLED, and CREDENTIAL_ENCRYPTION_KEY in .env.",
  database: "Check MONGODB_URI, DATABASE_NAME, MongoDB credentials, DNS, and the server IP allowlist.",
  migration: "Back up MongoDB, run npm run migrate:tenants as a dry-run, then apply the reviewed migration.",
  "provider-data": "Check SMSBOWER_API_KEY and outbound provider connectivity.",
  "platform-bot": "Check BOT_TOKEN and connectivity to api.telegram.org.",
  "rental-runtime": "Check CREDENTIAL_ENCRYPTION_KEY and the encrypted tokens of active rentals.",
  "rental-webhook": "Check RENTAL_WEBHOOK_PORT, RENTAL_WEBHOOK_SECRET, and whether the loopback port is available.",
  ready: "Check the preceding startup logs for the last completed component.",
};

/** Returns actionable startup diagnostics without serializing provider errors or credentials. */
export function formatStartupFailure(stage: StartupStage, error: unknown): string {
  const message = error instanceof Error ? error.message : "";

  if (stage === "migration" && message.startsWith("Tenant migration required")) return message;
  if (stage === "environment" && message === "BOT_TOKEN and MONGODB_URI are required.") {
    return "Startup failed during environment validation: BOT_TOKEN and MONGODB_URI are required in .env.";
  }
  if (stage === "environment" && message.startsWith("CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes")) {
    return "Startup failed during environment validation: CREDENTIAL_ENCRYPTION_KEY must contain 32 random bytes encoded as 64 hex characters or base64. Keep this key unchanged after rental credentials are stored.";
  }
  if (stage === "rental-webhook" && message === "Invalid RENTAL_WEBHOOK_PORT.") {
    return "Startup failed during rental webhook setup: RENTAL_WEBHOOK_PORT must be 0 or an integer from 1 to 65535.";
  }

  return `Startup failed during ${stage}: ${GENERIC_GUIDANCE[stage]}`;
}
