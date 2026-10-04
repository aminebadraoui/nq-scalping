/* Seasonal chip tests — pure calendar facts, no network. Rules re-derived
 * from the docstrings in lib/seasonal.ts and the almanac verdicts in
 * docs/research/seasonal-almanac-2026-10-05.md §6, so a regression in the
 * implementation cannot make a test pass by definition. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonalChips, sessionDateOf, FOMC_DAYS } from "../lib/seasonal";

/** signal fixture: t = feed clock "HH:mm" CT, d = minute calendar date,
 *  hourET computed exactly like the detector (CT + 1). */
function sig(t: string, d: string) {
  return { t, d, hourET: (Number(t.slice(0, 2)) + 1) % 24 };
}

/* ---------------- session-date attribution ---------------- */

test("session date: daytime minutes keep their own date, evening minutes roll forward", () => {
  assert.equal(sessionDateOf("00:00", "2026-10-28"), "2026-10-28");
  assert.equal(sessionDateOf("08:30", "2026-10-28"), "2026-10-28");
  assert.equal(sessionDateOf("15:59", "2026-10-28"), "2026-10-28");
  assert.equal(sessionDateOf("17:00", "2026-10-28"), "2026-10-29"); // Globex reopen → next session
  assert.equal(sessionDateOf("23:59", "2026-10-28"), "2026-10-29");
});

test("session date rolls the year", () => {
  assert.equal(sessionDateOf("23:30", "2026-12-31"), "2027-01-01");
});

/* ---------------- FOMC day ---------------- */

test("FOMC day chip on the decision day (daytime bar)", () => {
  const c = seasonalChips(sig("09:30", "2026-10-28")); // 10:30 ET
  assert.deepEqual(c.labels, ["FOMC DAY 84%"]);
  assert.equal(c.features.seasonalFomcDay, true);
  assert.equal(c.features.seasonalPreFomc, undefined);
});

test("FOMC day chip for the evening leg of the session that ends on the decision day", () => {
  // 18:00 CT on 10-27 belongs to the 10-28 session file (RTH date = FOMC day)
  const c = seasonalChips(sig("18:00", "2026-10-27"));
  assert.ok(c.labels.includes("FOMC DAY 84%"));
  assert.equal(c.features.seasonalFomcDay, true);
});

test("historical FOMC days still chip (backtest replay)", () => {
  assert.ok(FOMC_DAYS.has("2025-03-19"));
  const c = seasonalChips(sig("10:00", "2025-03-19"));
  assert.ok(c.labels.includes("FOMC DAY 84%"));
});

/* ---------------- pre-FOMC day ---------------- */

test("pre-FOMC chip the trading day before a decision", () => {
  const c = seasonalChips(sig("10:00", "2026-10-27")); // FOMC on 10-28
  assert.deepEqual(c.labels, ["PRE-FOMC 67%"]);
  assert.equal(c.features.seasonalPreFomc, true);
  assert.equal(c.features.seasonalFomcDay, undefined);
});

test("evening bar before the pre-FOMC day also chips PRE-FOMC", () => {
  // 18:00 CT on 10-26 → session 10-27 (the pre-FOMC day itself)
  const c = seasonalChips(sig("18:00", "2026-10-26"));
  assert.deepEqual(c.labels, ["PRE-FOMC 67%"]);
});

test("no FOMC chips on an ordinary release day (CPI is not FOMC)", () => {
  const c = seasonalChips(sig("10:00", "2026-10-13"));
  assert.deepEqual(c.labels, []);
});

/* ---------------- hour 3–7 ET prime window ---------------- */

test("hour chip inside the 3–7 ET window", () => {
  assert.ok(seasonalChips(sig("02:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 3 ET
  assert.ok(seasonalChips(sig("03:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 4 ET
  assert.ok(seasonalChips(sig("06:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 7 ET
});

test("hour chip absent outside the window", () => {
  assert.ok(!seasonalChips(sig("01:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 2 ET
  assert.ok(!seasonalChips(sig("07:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 8 ET
  assert.ok(!seasonalChips(sig("12:00", "2026-10-14")).labels.includes("HOUR 3–7 ET 80%")); // 13 ET
});

/* ---------------- combinations ---------------- */

test("FOMC day inside the prime window prints both chips", () => {
  const c = seasonalChips(sig("03:00", "2026-10-28")); // 4 ET, FOMC day
  assert.deepEqual(c.labels, ["FOMC DAY 84%", "HOUR 3–7 ET 80%"]);
  assert.equal(c.features.seasonalFomcDay, true);
  assert.equal(c.features.seasonalHour37, true);
});

test("pre-FOMC inside the prime window prints both chips", () => {
  const c = seasonalChips(sig("03:00", "2026-10-27")); // 4 ET, day before FOMC
  assert.deepEqual(c.labels, ["PRE-FOMC 67%", "HOUR 3–7 ET 80%"]);
});

test("an ordinary day inside the prime window prints only the hour chip", () => {
  const c = seasonalChips(sig("04:00", "2026-10-14"));
  assert.deepEqual(c.labels, ["HOUR 3–7 ET 80%"]);
});
