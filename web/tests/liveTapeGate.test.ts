/* Unit tests for the live tape gate (../lib/live.ts mergeCandleMinutes +
 * ../lib/signalEngine.ts liveMinutesToFootprint src mapping).
 * Run as part of `npm test`.
 *
 * Clock convention: live buffer minutes are keyed by UTC HH:mm (du = UTC
 * calendar date); candle timestamps are ISO and convert to the same UTC
 * key. nowKey uses the buffer's "YYYY-MM-DD|HH:mm" separator form. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCandleMinutes, type LiveMinute } from "../lib/live";
import { liveMinutesToFootprint } from "../lib/signalEngine";
import { tapeGateDecision, TAPE_GATE_STALL_MS, TAPE_GATE_REALERT_MS } from "../lib/signalFeed";
import type { BootCandle } from "../lib/footprintProto";

const nowKey = "2026-10-05|18:00";

test("mergeCandleMinutes replaces a completed tick bar with the candle bar", () => {
  const minutes: LiveMinute[] = [
    { t: "17:58", du: "2026-10-05", o: 1, h: 105, l: 95, c: 104, vol: 10, buy: 3, sell: 7, live: true, source: "tick" },
  ];
  const candles: BootCandle[] = [
    {
      t: "2026-10-05T17:58:00.000Z",
      high: 10600,
      low: 9400,
      buy: 30,
      sell: 43,
      levels: [
        { level: 10400, buy: 20, sell: 10 },
        { level: 9500, buy: 10, sell: 33 },
      ],
    },
  ];
  const r = mergeCandleMinutes(minutes, candles, nowKey);
  assert.equal(r.replaced, 1);
  assert.equal(r.added, 0);
  const m = minutes[0];
  assert.equal(m.source, "candle");
  assert.equal(m.buy, 30);
  assert.equal(m.sell, 43);
  assert.equal(m.h, 106);
  assert.equal(m.l, 94);
  assert.equal(m.c, 0); // footprint candles carry no close — mid fallback like the archive
  assert.deepEqual(m.levels, { "104.00": [20, 10], "95.00": [10, 33] });
});

test("mergeCandleMinutes leaves the developing minute to the ticks", () => {
  const minutes: LiveMinute[] = [
    { t: "18:00", du: "2026-10-05", o: 1, h: 105, l: 95, c: 104, vol: 10, buy: 3, sell: 7, live: true, source: "tick" },
  ];
  const candles: BootCandle[] = [
    { t: "2026-10-05T18:00:00.000Z", high: 10600, low: 9400, buy: 30, sell: 43 },
  ];
  const r = mergeCandleMinutes(minutes, candles, nowKey);
  assert.equal(r.replaced, 0);
  assert.equal(minutes[0].buy, 3);
  assert.equal(minutes[0].source, "tick");
});

test("mergeCandleMinutes appends missing candle bars and sorts them", () => {
  const minutes: LiveMinute[] = [
    { t: "17:56", du: "2026-10-05", o: 0, h: 100, l: 99, c: 0, vol: 5, buy: 2, sell: 3, live: true, source: "candle" },
  ];
  const candles: BootCandle[] = [
    { t: "2026-10-05T17:57:00.000Z", high: 10100, low: 9950, buy: 10, sell: 6 },
    { t: "2026-10-05T17:56:00.000Z", high: 10000, low: 9900, buy: 2, sell: 3 },
  ];
  const r = mergeCandleMinutes(minutes, candles, nowKey);
  assert.equal(r.added, 1);
  assert.equal(r.replaced, 1);
  assert.deepEqual(minutes.map((m) => m.t), ["17:56", "17:57"]);
  assert.equal(minutes[1].source, "candle");
});

test("mergeCandleMinutes keeps tick-built levels when the candle has none", () => {
  const minutes: LiveMinute[] = [
    { t: "17:58", du: "2026-10-05", o: 1, h: 105, l: 95, c: 104, vol: 10, buy: 3, sell: 7, live: true, source: "tick", levels: { "100.00": [3, 7] } },
  ];
  const candles: BootCandle[] = [
    { t: "2026-10-05T17:58:00.000Z", high: 10500, low: 9500, buy: 30, sell: 43 },
  ];
  mergeCandleMinutes(minutes, candles, nowKey);
  assert.deepEqual(minutes[0].levels, { "100.00": [3, 7] });
  assert.equal(minutes[0].source, "candle");
});

test("liveMinutesToFootprint carries the bar source through", () => {
  const mins: LiveMinute[] = [
    { t: "17:58", du: "2026-10-05", o: 0, h: 106, l: 94, c: 0, vol: 73, buy: 30, sell: 43, live: true, source: "candle" },
    { t: "17:59", du: "2026-10-05", o: 0, h: 106, l: 94, c: 0, vol: 9, buy: 4, sell: 5, live: true, source: "tick" },
  ];
  const fp = liveMinutesToFootprint(mins);
  assert.equal(fp[0].src, "candle");
  assert.equal(fp[1].src, "tick");
});

test("liveMinutesToFootprint defaults missing source to tick (fail closed)", () => {
  const mins: LiveMinute[] = [
    { t: "17:58", du: "2026-10-05", o: 0, h: 106, l: 94, c: 0, vol: 73, buy: 30, sell: 43, live: true },
  ];
  const fp = liveMinutesToFootprint(mins);
  assert.equal(fp[0].src, "tick");
});

/* ------------------------------------------------------------------ *
 * Tape-gate watchdog (tapeGateDecision — pure): cards hold on
 * unconfirmed bars and the operator is paged only after a real stall,
 * never on the boot-time arm or the normal 1–2 min merge lag.
 * ------------------------------------------------------------------ */

test("tapeGateDecision: confirmed bar releases and refreshes the clock", () => {
  const d = tapeGateDecision(true, 1_000, 20_000, 0);
  assert.deepEqual(d, { hold: false, alert: false, lastConfirmedAt: 20_000 });
});

test("tapeGateDecision: never-confirmed boot arms the clock silently (no alert)", () => {
  const d = tapeGateDecision(false, 0, 20_000, 0);
  assert.deepEqual(d, { hold: true, alert: false, lastConfirmedAt: 20_000 });
});

test("tapeGateDecision: short lag holds without paging", () => {
  const d = tapeGateDecision(false, 10_000, 10_000 + TAPE_GATE_STALL_MS - 1, 0);
  assert.deepEqual(d, { hold: true, alert: false, lastConfirmedAt: 10_000 });
});

test("tapeGateDecision: past the stall threshold the operator is paged", () => {
  const d = tapeGateDecision(false, 10_000, 10_000 + TAPE_GATE_STALL_MS, 0);
  assert.deepEqual(d, { hold: true, alert: true, lastConfirmedAt: 10_000 });
});

test("tapeGateDecision: a persistent stall re-pages only after the re-alert window", () => {
  const now = 10_000 + TAPE_GATE_STALL_MS;
  assert.equal(tapeGateDecision(false, 10_000, now + TAPE_GATE_REALERT_MS - 1, now).alert, false);
  assert.equal(tapeGateDecision(false, 10_000, now + TAPE_GATE_REALERT_MS, now).alert, true);
});

test("tapeGateDecision: recovery clears the stall and the alert cadence", () => {
  const d = tapeGateDecision(true, 10_000, 10_000 + TAPE_GATE_STALL_MS + 60_000, 10_000);
  assert.equal(d.hold, false);
  assert.equal(d.alert, false);
});
