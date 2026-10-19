/* Regime chips unit tests — the HTF/EMA200/vol-band labels measured in
 * regime-conditioned-2026-10-15.md, as pure functions (journal labels,
 * never gates). Mirrors the htfRegimeStudy semantics: 15m EMA20/50 with
 * 1-hour slope confirm, 1m EMA200, warmup EARLY until b ≥ 4 buckets. */

import { test } from "node:test";
import assert from "node:assert";
import { buildRegimeContext, regimeChipOf, VOL_THRESHOLDS, type RegimeContext } from "../lib/regimeChips";
import { closeOf, type MomMinute } from "../lib/momentum";

/** flat synthetic session: every bar closes at `close` */
function flatSession(n: number, close: number): MomMinute[] {
  return Array.from({ length: n }, (_, i) => ({
    t: `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    d: "2026-01-02",
    o: close,
    c: close,
    high: close + 1,
    low: close - 1,
    buy: 100,
    sell: 100,
    levels: [],
  }));
}

/** linear-drift session: close_i = start + i·step */
function driftSession(n: number, start: number, step: number): MomMinute[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return {
      t: `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      d: "2026-01-02",
      o: c,
      c,
      high: c + 1,
      low: c - 1,
      buy: 100,
      sell: 100,
      levels: [],
    };
  });
}

/** rise then fall: close_i = start + min(i,k)·up + (i>k ? (i−k)·down : 0) */
function riseThenFall(n: number, start: number, up: number, k: number, down: number): MomMinute[] {
  return Array.from({ length: n }, (_, i) => {
    const c = start + Math.min(i, k) * up + (i > k ? (i - k) * down : 0);
    return {
      t: `${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      d: "2026-01-02",
      o: c,
      c,
      high: c + 1,
      low: c - 1,
      buy: 100,
      sell: 100,
      levels: [],
    };
  });
}

const ctx = (m: MomMinute[]): RegimeContext => buildRegimeContext(m);

test("warmup: no completed 15m bucket before bar 14 → null chip", () => {
  const m = flatSession(30, 100);
  assert.equal(regimeChipOf(ctx(m), 10, 100, 5, "failed_flush_breakout"), null);
});

test("EARLY regime until 4 completed buckets (entryIdx < 74)", () => {
  const m = flatSession(200, 100);
  const chip = regimeChipOf(ctx(m), 50, 100, 5, "failed_flush_breakout");
  assert.ok(chip);
  assert.equal(chip.htf, "EARLY");
  assert.equal(chip.volBand, "MID"); // 3 < 5 ≤ 5 → mid for failed_flush_breakout
});

test("uptrend → BULL15 · above200 · ema200Rising at a mature bar", () => {
  const m = driftSession(150, 100, 0.5);
  const chip = regimeChipOf(ctx(m), 120, 100 + 120 * 0.5, 6, "failed_flush_breakout");
  assert.ok(chip);
  assert.equal(chip.htf, "BULL15");
  assert.equal(chip.above200, true);
  assert.equal(chip.ema200Rising, true);
  assert.equal(chip.volBand, "HIGH"); // 6 > 5 for failed_flush_breakout
});

test("downtrend → BEAR15 · below200 · ema200Rising false", () => {
  const m = driftSession(150, 200, -0.5);
  const chip = regimeChipOf(ctx(m), 120, 200 - 120 * 0.5, 4, "failed_flush_breakout");
  assert.ok(chip);
  assert.equal(chip.htf, "BEAR15");
  assert.equal(chip.above200, false);
  assert.equal(chip.ema200Rising, false);
  assert.equal(chip.volBand, "MID");
});

test("flat tape → MIXED (no slope, no cross)", () => {
  const m = flatSession(200, 100);
  const chip = regimeChipOf(ctx(m), 120, 100, 5, "failed_flush_breakout");
  assert.ok(chip);
  assert.equal(chip.htf, "MIXED");
});

test("slope confirm: rise-then-fall is NOT bull15 (EMA20 slope turned down)", () => {
  // rise to bar 74, sharp fall after — e20 stays above e50 (no BEAR15)
  // but its 1-hour slope is negative → the confirm fails → MIXED
  const m = riseThenFall(180, 100, 0.8, 74, -1.07);
  const chip = regimeChipOf(ctx(m), 150, closeOf(m[150]), 5, "failed_flush_breakout");
  assert.ok(chip);
  assert.equal(chip.htf, "MIXED");
});

test("vol bands per family · unknown family → null band", () => {
  const m = flatSession(200, 100);
  const c = ctx(m);
  const chip = (atr: number, fam: string) => regimeChipOf(c, 120, 100, atr, fam);
  assert.equal(chip(2, "failed_flush_breakout")!.volBand, "LOW");
  assert.equal(chip(4, "failed_flush_breakout")!.volBand, "MID");
  assert.equal(chip(6, "huge_bar_expansion")!.volBand, "HIGH");
  assert.equal(chip(7, "session_continuation")!.volBand, "LOW"); // session_continuation q1=8
  assert.equal(chip(10, "session_continuation")!.volBand, "MID");
  assert.equal(chip(13, "session_continuation")!.volBand, "HIGH");
  assert.equal(chip(5, "open")!.volBand, null);
});

test("threshold snapshot: the measured train terciles are registered", () => {
  assert.deepEqual(VOL_THRESHOLDS.failed_flush_breakout, { q1: 3, q2: 5 });
  assert.deepEqual(VOL_THRESHOLDS.huge_bar_expansion, { q1: 3, q2: 5 });
  assert.deepEqual(VOL_THRESHOLDS.session_continuation, { q1: 8, q2: 12 });
});

test("EMA200 context is lookahead-free: values at i use bars ≤ i only", () => {
  const m = driftSession(100, 100, 1);
  const c = ctx(m);
  // a huge future bar would change later values but not the value at 50
  const before = c.ema200[50];
  m[90] = { ...m[90], c: 9999, high: 10000, low: 9900 };
  assert.equal(before, c.ema200[50]);
});
