/* Unit tests for the market-hours calendar (lib/marketHours.ts): the one
 * place that knows when CME Globex is open — Sun 18:00 ET → Fri close,
 * the daily 17:00–18:00 halt, holidays and early closes. */
import { test } from "node:test";
import assert from "node:assert";
import { marketOpenAt, nextMarketEvent, signalWindowOpen, CME_HOLIDAYS_2026, etDate } from "../lib/marketHours";
import { etToEpoch } from "../lib/times";

/** New-York wall clock → epoch ms, DST-correct. */
const et = (dateISO: string, hhmm: string): number => etToEpoch(hhmm, dateISO) * 1000;

test("weekday rhythm: 17:00–18:00 halt, 18:00 reopen", () => {
  assert.equal(marketOpenAt(et("2026-10-01", "16:59")), true); // Thu
  assert.equal(marketOpenAt(et("2026-10-01", "17:00")), false); // halt
  assert.equal(marketOpenAt(et("2026-10-01", "17:59")), false);
  assert.equal(marketOpenAt(et("2026-10-01", "18:00")), true); // new session
  assert.equal(marketOpenAt(et("2026-10-02", "02:00")), true); // overnight Globex
});

test("weekend: Fri 17:00 → Sun 18:00 closed", () => {
  assert.equal(marketOpenAt(et("2026-10-02", "16:59")), true); // Fri
  assert.equal(marketOpenAt(et("2026-10-02", "17:00")), false);
  assert.equal(marketOpenAt(et("2026-10-03", "12:00")), false); // Sat
  assert.equal(marketOpenAt(et("2026-10-04", "17:59")), false); // Sun
  assert.equal(marketOpenAt(et("2026-10-04", "18:00")), true); // Sun open
});

test("holidays close the whole session", () => {
  assert.equal(marketOpenAt(et("2026-05-25", "10:00")), false); // Memorial Day (Mon)
  assert.equal(marketOpenAt(et("2026-11-26", "02:00")), false); // Thanksgiving overnight
  assert.equal(marketOpenAt(et("2026-12-25", "11:00")), false); // Christmas
  assert.equal(marketOpenAt(et("2026-01-19", "11:00")), false); // MLK
  assert.equal(marketOpenAt(et("2026-05-26", "10:00")), true); // day after
});

test("early closes shut at the listed minute", () => {
  assert.equal(marketOpenAt(et("2026-07-03", "12:59")), true); // Jul 3, Friday
  assert.equal(marketOpenAt(et("2026-07-03", "13:00")), false);
  assert.equal(marketOpenAt(et("2026-11-27", "13:14")), true); // day after Thanksgiving
  assert.equal(marketOpenAt(et("2026-11-27", "13:15")), false);
});

test("signal window: Sun 18:00 → Fri 16:00 ET + daily 16:00–18:00 halt", () => {
  // Friday shuts at 16:00 ET for signals — a full hour before the Globex close
  assert.equal(signalWindowOpen(et("2026-10-02", "15:59")), true);
  assert.equal(signalWindowOpen(et("2026-10-02", "16:00")), false);
  assert.equal(signalWindowOpen(et("2026-10-02", "16:59")), false); // market still open — window closed
  // Mon–Thu: the broker rejects entries after 16:00 → daily 16:00–18:00 halt
  assert.equal(signalWindowOpen(et("2026-10-01", "15:59")), true); // Thu
  assert.equal(signalWindowOpen(et("2026-10-01", "16:00")), false);
  assert.equal(signalWindowOpen(et("2026-10-01", "16:59")), false); // Globex open — window closed
  assert.equal(signalWindowOpen(et("2026-10-01", "17:30")), false); // Globex halt
  assert.equal(signalWindowOpen(et("2026-10-01", "18:00")), true); // Thu reopen
  // weekend
  assert.equal(signalWindowOpen(et("2026-10-03", "12:00")), false); // Sat
  assert.equal(signalWindowOpen(et("2026-10-04", "17:59")), false); // Sun pre-open
  assert.equal(signalWindowOpen(et("2026-10-04", "18:00")), true); // Sun open
  assert.equal(signalWindowOpen(et("2026-10-05", "00:30")), true); // Mon overnight
  // holidays still close the window
  assert.equal(signalWindowOpen(et("2026-05-25", "10:00")), false); // Memorial Day
  // a Friday early close (13:00 ET) also closes the signal window at 13:00
  assert.equal(signalWindowOpen(et("2026-07-03", "12:59")), true);
  assert.equal(signalWindowOpen(et("2026-07-03", "13:00")), false);
});

test("nextMarketEvent finds the next boundary", () => {
  // inside Thursday's session: next event is the 17:00 halt
  const e = nextMarketEvent(et("2026-10-01", "11:00"));
  assert.equal(e.kind, "close");
  assert.equal(etDate(e.atMs), "2026-10-01");
  // during the halt: next event is the 18:00 reopen
  const r = nextMarketEvent(et("2026-10-01", "17:30"));
  assert.equal(r.kind, "open");
  // Friday 17:00: next open is Sunday 18:00
  const w = nextMarketEvent(et("2026-10-02", "17:00"));
  assert.equal(w.kind, "open");
  assert.equal(etDate(w.atMs), "2026-10-04");
});

test("2026 holiday table covers the majors", () => {
  const labels = Object.values(CME_HOLIDAYS_2026).map((h) => h.label);
  for (const want of ["New Year's Day", "Good Friday", "Juneteenth", "Labor Day", "Christmas Day"]) {
    assert.ok(labels.includes(want), `missing ${want}`);
  }
});
