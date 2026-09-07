import assert from "node:assert/strict";
import test from "node:test";
import { normalizeImapStatusDates, type ImapStatusSummary } from "./imapOtp.js";

function baseStatus(overrides: Partial<ImapStatusSummary>): ImapStatusSummary {
  return {
    connected: true,
    listening: true,
    configured: true,
    host: "imap.example.test",
    user: "use***",
    targetSender: "service@example.test",
    mailbox: "INBOX",
    totalOtpForwarded: 1,
    ...overrides,
  };
}

test("IMAP IPC status date strings are restored to Date instances", () => {
  const status = normalizeImapStatusDates(baseStatus({
    lastConnectedAt: "2026-09-07T05:00:00.000Z" as unknown as Date,
    lastReceivedAt: "2026-09-07T05:01:02.000Z" as unknown as Date,
  }));

  assert.ok(status.lastConnectedAt instanceof Date);
  assert.equal(status.lastConnectedAt.toISOString(), "2026-09-07T05:00:00.000Z");
  assert.ok(status.lastReceivedAt instanceof Date);
  assert.equal(status.lastReceivedAt.toISOString(), "2026-09-07T05:01:02.000Z");
});

test("IMAP IPC status drops invalid date values instead of keeping crashy truthy strings", () => {
  const status = normalizeImapStatusDates(baseStatus({
    lastConnectedAt: "not-a-date" as unknown as Date,
    lastReceivedAt: "Invalid Date" as unknown as Date,
  }));

  assert.equal(status.lastConnectedAt, undefined);
  assert.equal(status.lastReceivedAt, undefined);
});
