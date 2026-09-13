import assert from "node:assert/strict";
import test from "node:test";
import { ThrottledWarningLogger } from "./retryLogger.js";

test("throttled warnings include the cause once and summarize repeats", () => {
  let now = 0;
  const lines: string[] = [];
  const logger = new ThrottledWarningLogger(60_000, () => now, line => lines.push(line));

  logger.warn("rental:abc", "Scheduled reconciliation failed", new Error("provider unavailable"));
  logger.warn("rental:abc", "Scheduled reconciliation failed", new Error("provider unavailable"));
  assert.deepEqual(lines, [
    "Scheduled reconciliation failed: provider unavailable",
  ]);

  now = 60_000;
  logger.warn("rental:abc", "Scheduled reconciliation failed", new Error("provider unavailable"));
  assert.deepEqual(lines, [
    "Scheduled reconciliation failed: provider unavailable",
    "Scheduled reconciliation failed: provider unavailable (1 repeat suppressed)",
  ]);
});
