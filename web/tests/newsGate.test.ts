/* Unit tests for the news blackout gate (lib/newsGate.ts): the pure
 * day+time blocking function and the DST-aware clock helper. */
import { test } from "node:test";
import assert from "node:assert";
import { newsBlockedAt, etDayAndClock, NEWS_EVENTS, type NewsEvent } from "../lib/newsGate";

const EV: NewsEvent[] = [
  { day: "2026-10-13", hourET: 8, minuteET: 30, label: "CPI", kind: "bls", beforeMin: 5, afterMin: 10 },
  { day: "2026-10-28", hourET: 14, minuteET: 0, label: "FOMC decision", kind: "fomc", beforeMin: 10, afterMin: 20 },
];

test("blocks inside the window, clears outside", () => {
  assert.equal(newsBlockedAt(EV, "2026-10-13", 8, 25), "CPI"); // 5 min before
  assert.equal(newsBlockedAt(EV, "2026-10-13", 8, 30), "CPI");
  assert.equal(newsBlockedAt(EV, "2026-10-13", 8, 40), "CPI"); // 10 min after
  assert.equal(newsBlockedAt(EV, "2026-10-13", 8, 41), null);
  assert.equal(newsBlockedAt(EV, "2026-10-13", 8, 24), null);
  assert.equal(newsBlockedAt(EV, "2026-10-14", 8, 30), null); // wrong day
});

test("FOMC has the wider window (14:00 ET, ±10/20)", () => {
  assert.equal(newsBlockedAt(EV, "2026-10-28", 13, 50), "FOMC decision");
  assert.equal(newsBlockedAt(EV, "2026-10-28", 14, 20), "FOMC decision");
  assert.equal(newsBlockedAt(EV, "2026-10-28", 14, 21), null);
  assert.equal(newsBlockedAt(EV, "2026-10-28", 13, 49), null);
});

test("the built-in calendar covers the rest of 2026 + FOMC dates", () => {
  const labels = NEWS_EVENTS.map((e) => e.label);
  assert.ok(labels.includes("CPI"));
  assert.ok(labels.includes("Employment Situation"));
  assert.ok(labels.includes("FOMC decision"));
  const fomcDays = NEWS_EVENTS.filter((e) => e.kind === "fomc").map((e) => e.day);
  assert.ok(fomcDays.includes("2026-10-28"));
  assert.ok(fomcDays.includes("2026-12-09"));
});

test("etDayAndClock converts an instant to the New York day + clock (EDT)", () => {
  // 2026-10-02 14:23 UTC = 10:23 EDT
  const t = etDayAndClock(Date.parse("2026-10-02T14:23:00Z"));
  assert.equal(t.day, "2026-10-02");
  assert.equal(t.hourET, 10);
  assert.equal(t.minuteET, 23);
  // 2026-12-09 19:30 UTC = 14:30 EST
  const t2 = etDayAndClock(Date.parse("2026-12-09T19:30:00Z"));
  assert.equal(t2.hourET, 14);
  assert.equal(t2.minuteET, 30);
});
