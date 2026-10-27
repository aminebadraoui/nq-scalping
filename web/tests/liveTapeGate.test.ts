/* Unit tests for the live tape gate (../lib/live.ts mergeCandleMinutes +
 * ../lib/signalEngine.ts liveMinutesToFootprint src mapping).
 * Run as part of `npm test`.
 *
 * Clock convention: live buffer minutes are keyed by UTC HH:mm (du = UTC
 * calendar date); candle timestamps are ISO and convert to the same UTC
 * key. nowKey uses the buffer's "YYYY-MM-DD|HH:mm" separator form. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCandleMinutes, tapeTailStale, type LiveMinute } from "../lib/live";
import { liveMinutesToFootprint } from "../lib/signalEngine";
import { tapeGateDecision, tapeTailCount, TAPE_GATE_TAIL_ALERT, TAPE_GATE_REALERT_MS, tapePageDecision, TAPE_PAGE_DELAY_MS, tapeGateTickFireMs, tapeGateTimeoutFire, tapeGateFireNotice, staleTailBar, barCloseMs, cardGateDecision, tapeGateDiagnostics, quietSessionDecision, QUIET_SESSION_PAGE_MS, STALE_SIGNAL_VETO_MS } from "../lib/signalFeed";
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

test("tapeGateTickFireMs: default 300s (above the normal ~2min confirm lag), env override, 0 = never, garbage = default", () => {
  assert.equal(tapeGateTickFireMs({}), 300_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "60000" }), 60_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "0" }), 0);
  // an empty / blank value is "unset", not 0 (= never fire) — Number("") is 0
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "" }), 300_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "  " }), 300_000);
  assert.equal(tapeGateTickFireMs({ TAPE_GATE_TICK_FIRE_MS: "x" }), 300_000);
});

test("tapeGateTimeoutFire: releases at/after the threshold, never below, never when off", () => {
  assert.equal(tapeGateTimeoutFire(299_999, 300_000), false);
  assert.equal(tapeGateTimeoutFire(300_000, 300_000), true);
  assert.equal(tapeGateTimeoutFire(999_000, 300_000), true);
  assert.equal(tapeGateTimeoutFire(999_000, 0), false); // 0 = the old infinite hold
});

test("tapeGateFireNotice: only stall-grade lag pages (a 2min confirm is silent)", () => {
  assert.equal(tapeGateFireNotice(120_000), false);
  assert.equal(tapeGateFireNotice(10 * 60_000), true);
  assert.equal(tapeGateFireNotice(6 * 3600_000), true);
});

test("staleTailBar: a bar older than the veto window can never fire (the 02:54-on-22:52 case)", () => {
  const bars = [{ t: "22:52", d: "2026-10-14" }];
  // the footprint clock is America/Chicago: 22:52 CDT Oct 14 = 03:52 UTC Oct 15
  const close = Date.UTC(2026, 9, 15, 3, 52) + 60_000;
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 9 * 60_000), false);
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 11 * 60_000), true);
  assert.equal(staleTailBar(bars, 10 * 60_000, close + 4 * 3600_000), true); // 4h late — veto
});

test("barCloseMs: footprint bars are Chicago-stamped — 10:28 CDT Oct 15 = 15:28 UTC (the clock-mix bug)", () => {
  assert.equal(barCloseMs({ t: "10:28", d: "2026-10-15" }), Date.UTC(2026, 9, 15, 15, 28) + 60_000);
  // live minutes carry the UTC date and are passed through as-is
  assert.equal(barCloseMs({ t: "14:28", du: "2026-10-15" }), Date.UTC(2026, 9, 15, 14, 28) + 60_000);
});

/* ---- the composed gate chain (cardGateDecision) — the healthy-flow
 * matrix that pins "healthy data flows through untouched" (2026-10-15:
 * each gate passed its unit tests while the composition killed every
 * card). ---- */

test("cardGateDecision: HEALTHY FLOW — a fresh candle-confirmed tail never holds and never vetoes", () => {
  // a bar that just closed, candle-confirmed (tail 0)
  const close = barCloseMs({ t: "10:28", d: "2026-10-15" })!;
  const d = cardGateDecision({ tail: 0, totalBars: 120, tailAgeMs: 30_000, now: close + 30_000, lastAlertAt: 0 });
  assert.deepEqual(d, { hold: false, veto: false });
});

test("cardGateDecision: the unconfirmed tail holds until the fallback age, then releases", () => {
  const now = Date.now();
  assert.deepEqual(cardGateDecision({ tail: 2, totalBars: 120, tailAgeMs: 60_000, now, lastAlertAt: 0 }), { hold: true, veto: false });
  assert.deepEqual(cardGateDecision({ tail: 2, totalBars: 120, tailAgeMs: 60_000 + 300_000, now, lastAlertAt: 0 }), { hold: false, veto: false });
});

test("cardGateDecision: the stale veto is the last word — a dead tail is never tradeable", () => {
  const now = Date.now();
  assert.deepEqual(cardGateDecision({ tail: 1, totalBars: 120, tailAgeMs: STALE_SIGNAL_VETO_MS + 1, now, lastAlertAt: 0 }), { hold: false, veto: true });
  // even an unconfirmed, old tail is vetoed, not held forever
  assert.deepEqual(cardGateDecision({ tail: 5, totalBars: 120, tailAgeMs: STALE_SIGNAL_VETO_MS + 1, now, lastAlertAt: 0 }), { hold: false, veto: true });
});

test("cardGateDecision: an unparseable tail never vetoes (empty/seed buffers)", () => {
  assert.deepEqual(cardGateDecision({ tail: 0, totalBars: 120, tailAgeMs: null, now: Date.now(), lastAlertAt: 0 }), { hold: false, veto: false });
});

test("round-trip: a bar whose age comes from barCloseMs itself is never stale when fresh (clock-regression tripwire)", () => {
  // if anyone reverts the Chicago conversion, this round-trip breaks:
  // the SAME helper that computes the age also computes the freshness —
  // a clock mix inflates the age and flips the veto.
  const bar = { t: "10:28", d: "2026-10-15" };
  const close = barCloseMs(bar)!;
  assert.equal(close, Date.UTC(2026, 9, 15, 15, 28) + 60_000);
  assert.equal(staleTailBar([bar], STALE_SIGNAL_VETO_MS, close + 60_000), false); // fresh bar passes
  assert.equal(staleTailBar([bar], STALE_SIGNAL_VETO_MS, close + STALE_SIGNAL_VETO_MS + 60_000), true); // actually stale vetoes
});

test("tapeGateDiagnostics: a healthy live buffer reads veto:false (the post-deploy smoke contract)", () => {
  const minute = (t: string, src: "candle" | "tick"): LiveMinute => ({
    t,
    du: "2026-10-15",
    o: 29650,
    h: 29660,
    l: 29640,
    c: 29655,
    vol: 100,
    buy: 60,
    sell: 40,
    live: false,
    source: src,
    levels: {},
  });
  const now = Date.UTC(2026, 9, 15, 14, 0); // 14:00 UTC
  const fresh = tapeGateDiagnostics([minute("13:50", "candle"), minute("13:51", "candle")], now);
  // the 13:51 bar closed at 13:52 UTC — 8 min before `now`
  assert.deepEqual(fresh, { totalBars: 2, tail: 0, tailAgeMs: 480_000, hold: false, veto: false, lastBarClose: Date.UTC(2026, 9, 15, 13, 51) + 60_000 });

  // a genuinely stale tail (20 min) must veto — the real dead-bar case
  const stale = tapeGateDiagnostics([minute("13:50", "candle"), minute("13:51", "candle")], now + 20 * 60_000);
  assert.equal(stale.veto, true);
});

test("tapeTailStale: a frozen tail older than the recovery window trips (the 6-hour vendor freeze)", () => {
  const tail = { t: "09:33", du: "2026-10-15" };
  const close = Date.UTC(2026, 9, 15, 9, 33) + 60_000;
  assert.equal(tapeTailStale([tail], close + 60_000), false); // fresh
  assert.equal(tapeTailStale([tail], close + 3 * 60_000 + 1), true); // frozen
  assert.equal(tapeTailStale([], close + 60_000), false); // no bars — not stale (boot)
  assert.equal(tapeTailStale([{ t: "bad", du: "" }], close + 99_000), false); // unparseable — never stale
});

test("quietSessionDecision: pages ONLY when RTH is open, the feed is healthy, and no card fired for the stretch", () => {
  const now = Date.now();
  // no cards all session + healthy + RTH -> page
  assert.deepEqual(quietSessionDecision({ now, lastCardAtMs: null, inRthWindow: true, feedHealthy: true }), { page: true });
  // a recent card -> silent
  assert.deepEqual(quietSessionDecision({ now, lastCardAtMs: now - 60_000, inRthWindow: true, feedHealthy: true }), { page: false });
  // an old card (past the threshold) -> page
  assert.deepEqual(quietSessionDecision({ now, lastCardAtMs: now - QUIET_SESSION_PAGE_MS - 60_000, inRthWindow: true, feedHealthy: true }), { page: true });
  // outside RTH hours -> silent (quiet ETH nights are normal)
  assert.deepEqual(quietSessionDecision({ now, lastCardAtMs: null, inRthWindow: false, feedHealthy: true }), { page: false });
  // unhealthy feed -> silent (the stall alarms own that state)
  assert.deepEqual(quietSessionDecision({ now, lastCardAtMs: null, inRthWindow: true, feedHealthy: false }), { page: false });
});
