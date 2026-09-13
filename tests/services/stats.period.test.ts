import assert from "node:assert/strict";
import test from "node:test";
import { getRevenuePeriodRange } from "./stats.js";

const now = new Date(2026, 7, 31, 15, 20, 0);

test("revenue periods use the current day, Monday week start, and month start", () => {
  const today = getRevenuePeriodRange("today", undefined, now);
  const week = getRevenuePeriodRange("week", undefined, now);
  const month = getRevenuePeriodRange("month", undefined, now);

  assert.equal(today.start.getDate(), 31);
  assert.equal(week.start.getDate(), 31);
  assert.equal(month.start.getDate(), 1);
  assert.equal(month.start.getMonth(), 7);
  assert.equal(today.end.getTime(), now.getTime());
});

test("a selected date covers exactly one local calendar day", () => {
  const range = getRevenuePeriodRange("date", "2026-08-29", now);

  assert.equal(range.start.getFullYear(), 2026);
  assert.equal(range.start.getMonth(), 7);
  assert.equal(range.start.getDate(), 29);
  assert.equal(range.end.getTime() - range.start.getTime(), 24 * 60 * 60 * 1000);
});

test("invalid selected dates are rejected", () => {
  assert.throws(
    () => getRevenuePeriodRange("date", "2026-02-30", now),
    /Tanggal tidak valid/
  );
});
