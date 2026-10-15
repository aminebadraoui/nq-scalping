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
import { tapeGateDecision, tapeTailCount, TAPE_GATE_TAIL_ALERT, TAPE_GATE_REALERT_MS, tapePageDecision, TAPE_PAGE_DELAY_MS, tapeGateTickFireMs, tapeGateTimeoutFire, staleTailBar } from "../lib/signalFeed";
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
 * Tape-gate watchdog (tapeTailCount + tapeGateDecision — pure): cards
 * hold on unconfirmed bars and the operator is paged when the TRAILING
 * run of unconfirmed completed bars grows past the alert threshold.
 * A fully-unconfirmed buffer (fresh boot, seed still in flight) holds
 * silently — it is not a stall.
 * ------------------------------------------------------------------ */

const tick = () => ({ t: "00:00", d: "2026-10-05", o: 0, c: 0, high: 100, low: 99, buy: 1, sell: 1, delta: 0, vwap: 99.5, levels: [], imb: { buy: 0, sell: 0, dBuy: 0, dSell: 0, stacked: null, biased: null }, src: "tick" as const });
const candle = () => ({ ...tick(), src: "candle" as const });

test("tapeTailCount: zero when the tail is candle-confirmed", () => {
  assert.equal(tapeTailCount([candle(), candle(), candle()]), 0);
});

test("tapeTailCount: counts only the TRAILING run of unconfirmed bars", () => {
  assert.equal(tapeTailCount([candle(), tick(), tick(), tick()]), 3);
  assert.equal(tapeTailCount([tick(), candle(), tick()]), 1);
});

test("tapeTailCount: a missing source counts as tick (fail closed)", () => {
  const m = tick() as { src?: string };
  delete m.src;
  assert.equal(tapeTailCount([candle(), m as never]), 1);
});

test("tapeGateDecision: confirmed tail releases the gate", () => {
  assert.deepEqual(tapeGateDecision(0, 120, 20_000, 0), { hold: false, alert: false });
});

test("tapeGateDecision: a short gap holds without paging", () => {
  assert.deepEqual(tapeGateDecision(3, 120, 20_000, 0), { hold: true, alert: false });
});

test("tapeGateDecision: a fully-unconfirmed boot buffer holds silently (seed in flight)", () => {
  assert.deepEqual(tapeGateDecision(30, 30, 20_000, 0), { hold: true, alert: false });
});

test("tapeGateDecision: past the alert threshold the operator is paged", () => {
  assert.deepEqual(tapeGateDecision(TAPE_GATE_TAIL_ALERT, 120, 20_000, 0), { hold: true, alert: true });
});

test("tapeGateDecision: a persistent gap re-pages only after the re-alert window", () => {
  const now = 20_000;
  assert.deepEqual(tapeGateDecision(10, 120, now + TAPE_GATE_REALERT_MS - 1, now), { hold: true, alert: false });
  assert.deepEqual(tapeGateDecision(10, 120, now + TAPE_GATE_REALERT_MS, now), { hold: true, alert: true });
});

test("tapeGateDecision: recovery releases; re-page follows the wall-clock cadence", () => {
  assert.deepEqual(tapeGateDecision(0, 120, 60_000, 10_000), { hold: false, alert: false });
  // a fresh gap still inside the re-alert window does not re-page
  assert.equal(tapeGateDecision(9, 120, 60_000, 10_000).alert, false);
  // past the window it pages again
  assert.equal(tapeGateDecision(9, 120, 10_000 + TAPE_GATE_REALERT_MS + 1, 10_000).alert, true);
});

/* ---- pager + self-heal ladder coordination (tapePageDecision) ------- */

test("tapePageDecision: no ladder (blind gate) always pages", () => {
  assert.equal(tapePageDecision(null, 100_000), true);
  assert.equal(tapePageDecision({ sinceAt: 0, step: 0 }, 100_000), true);
});

test("tapePageDecision: a young episode holds the page", () => {
  const now = 100_000;
  const heal = { sinceAt: now - 30_000, step: 1 };
  assert.equal(tapePageDecision(heal, now), false);
});

test("tapePageDecision: an episode that outlives the delay pages", () => {
  const now = 100_000;
  const heal = { sinceAt: now - TAPE_PAGE_DELAY_MS - 1, step: 1 };
  assert.equal(tapePageDecision(heal, now), true);
});

test("tapePageDecision: a ladder escalation pages immediately", () => {
  const now = 100_000;
  assert.equal(tapePageDecision({ sinceAt: now - 10_000, step: 2 }, now), true);
  assert.equal(tapePageDecision({ sinceAt: now - 10_000, step: 3 }, now), true);
});

/* ---- tick-fire fallback + stale-signal veto (2026-10-15) ------- */

test("tapePageDecision: 3+ healed episodes page despite the active ladder (the silent 801-deferral night)", () => {
  const now = 100_000;
  assert.equal(tapePageDecision({ sinceAt: now - 10_000, step: 1, episodes: 3 }, now), true);
  assert.equal(tapePageDecision({ sinceAt: now - 10_000, step: 1, episodes: 2 }, now), false);
});

test("tapeGateTickFireMs: default 120s, env override, 0 = never, garbage = default", () => {
  assert.equal(tapeGateTickFireMs({}), 120_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "60000" }), 60_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "0" }), 0);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "x" }), 120_000);
});

test("tapeGateTimeoutFire: releases at/after the threshold, never below, never when off", () => {
  assert.equal(tapeGateTimeoutFire(119_999, 120_000), false);
  assert.equal(tapeGateTimeoutFire(120_000, 120_000), true);
  assert.equal(tapeGateTimeoutFire(999_000, 120_000), true);
  assert.equal(tapeGateTimeoutFire(999_000, 0), false); // 0 = the old infinite hold
});

test("staleTailBar: a bar older than the veto window can never fire (the 02:54-on-22:52 case)", () => {
  const bars = [{ t: "22:52", d: "2026-10-14" }];
  const close = Date.UTC(2026, 9, 14, 22, 52) + 60_000;
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 9 * 60_000), false);
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 11 * 60_000), true);
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 4 * 3600_000), true); // 4h late — veto
});
