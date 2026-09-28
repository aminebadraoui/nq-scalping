/* Session-date keying for the live write-through path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionDateForUtc } from "../lib/liveStore.ts";

// The ETH session is keyed by the NY date it CLOSES on:
//   18:00 ET (reopen) .. next-day 16:59 ET  ->  the "next day" date.

test("Sunday 18:00 ET reopen belongs to Monday (EDT)", () => {
  // 2026-09-27 22:00Z = 18:00 ET Sunday
  assert.equal(sessionDateForUtc("22:00", "2026-09-27"), "2026-09-28");
});

test("Sunday 18:00 ET reopen belongs to Monday (EST)", () => {
  // 2026-12-13 23:00Z = 18:00 ET Sunday (EST is -5h)
  assert.equal(sessionDateForUtc("23:00", "2026-12-13"), "2026-12-14");
});

test("Monday 16:59 ET close belongs to Monday", () => {
  // 2026-09-28 20:59Z = 16:59 ET Monday (EDT)
  assert.equal(sessionDateForUtc("20:59", "2026-09-28"), "2026-09-28");
});

test("Monday 18:00 ET reopen belongs to Tuesday", () => {
  // 2026-09-28 22:00Z = 18:00 ET Monday
  assert.equal(sessionDateForUtc("22:00", "2026-09-28"), "2026-09-29");
});

test("Monday 00:00 ET (overnight) belongs to Monday", () => {
  // 2026-09-28 04:00Z = 00:00 ET Monday
  assert.equal(sessionDateForUtc("04:00", "2026-09-28"), "2026-09-28");
});

test("unparseable input returns empty string, never throws", () => {
  assert.equal(sessionDateForUtc("99:99", "not-a-date"), "");
});
