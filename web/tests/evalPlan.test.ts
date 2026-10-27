/* lib/evalPlan.ts — the eval plan v1 decision logic (noise area + gap fade). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapDecision, isCheckBar, noiseBands, noiseEntry, noiseSigma, noiseStop, rthIndex, rthOpen, rthVwap, sessionMoves, sessionClose, RTH_BARS } from "../lib/evalPlan";

test("rthIndex: feed-clock 08:30 is minute 0, 14:59 is the last RTH bar", () => {
  assert.equal(rthIndex("08:30"), 0);
  assert.equal(rthIndex("14:59"), RTH_BARS - 1);
  assert.equal(rthIndex("08:29"), -1);
  assert.equal(rthIndex("15:00"), -1);
});

test("check bars end on :00/:30 ET from 10:30 to 15:30 (the backtested schedule)", () => {
  assert.equal(isCheckBar("08:59"), false); // ends 10:00 — not in the backtest
  assert.equal(isCheckBar("09:29"), true); // ends 10:30
  assert.equal(isCheckBar("08:29"), false); // before RTH
  assert.equal(isCheckBar("08:44"), false);
  assert.equal(isCheckBar("09:29"), true);
  assert.equal(isCheckBar("14:29"), true); // ends 15:30
  assert.equal(isCheckBar("14:59"), false); // the close bar is not a check
});

test("gap fade: > 0.25% gap fades back toward the prior close, stop = gap, capped at 150 pt", () => {
  assert.equal(gapDecision(20040, 20000), null); // 0.2%
  const up = gapDecision(20080, 20000); // +0.4%
  assert.deepEqual([up?.dir, up?.stopPts], [-1, 80]);
  const dn = gapDecision(19900, 20000);
  assert.deepEqual([dn?.dir, dn?.stopPts], [1, 100]);
  assert.equal(gapDecision(20200, 20000), null); // 200-pt stop > 150 cap
});

test("noise bands: max/min of open and prior close, widened by sigma", () => {
  const sig = new Array(RTH_BARS).fill(0.001);
  const b = noiseBands(20100, 20000, sig);
  assert.equal(b.ub[0], 20100 * 1.001);
  assert.equal(b.lb[0], 20000 * 0.999);
  assert.equal(noiseEntry(30, 20125, b), 1);
  assert.equal(noiseEntry(30, 19975, b), -1);
  assert.equal(noiseEntry(30, 20050, b), 0);
  // trailing stop: the tighter of band and VWAP
  assert.equal(noiseStop(1, 30, b, 20130), 20130);
  assert.equal(noiseStop(1, 30, b, 20000), b.ub[30]);
  assert.equal(noiseStop(-1, 30, b, 19970), 19970);
});

test("noiseSigma needs 14 sessions and averages per minute", () => {
  const day = (v: number) => new Array(RTH_BARS).fill(v);
  assert.equal(noiseSigma([day(0.001)]), null);
  const s = noiseSigma([...Array(13).fill(day(0.001)), day(0.003)]);
  assert.ok(s && Math.abs(s[0] - (13 * 0.001 + 0.003) / 14) < 1e-12);
});

test("session helpers: open from the 09:29 bar estimate, close of the 14:59 bar, VWAP", () => {
  const bars = [
    { t: "08:29", high: 101, low: 99, buy: 50, sell: 50 },
    { t: "08:30", high: 102, low: 100, buy: 50, sell: 50, vwap: 101 },
    { t: "14:59", high: 105, low: 103, buy: 50, sell: 50, c: 104.5 },
  ];
  assert.equal(rthOpen(bars), 100); // p50 next-open from 99–101 at 50/50 = 99 + 0.51·2 → 100
  assert.equal(sessionClose(bars), 104.5);
  const mv = sessionMoves(bars);
  assert.ok(mv && Math.abs(mv[RTH_BARS - 1] - (104.5 / 100 - 1)) < 1e-12);
  assert.equal(rthVwap(bars).get(0), 101);
});

test("executor: legacy callers are signal-only unless LEGACY_EXEC=1; the eval plan may place", async () => {
  const { placeOrder, placeScaleOut } = await import("../lib/executor");
  const intent = { symbol: "NQZ26", dir: "long" as const, contracts: 1, entry: 100, stop: 95, target: 110, timeET: "10:30" };
  const prev = process.env.LEGACY_EXEC;
  delete process.env.LEGACY_EXEC;
  const a = await placeOrder(intent);
  assert.equal(a.ok, false);
  assert.match(a.reason, /signal-only/);
  const s = await placeScaleOut(intent);
  assert.equal(s.ok, false);
  const b = await placeOrder(intent, { plan: "eval_v1" });
  assert.doesNotMatch(b.reason, /signal-only/);
  if (prev !== undefined) process.env.LEGACY_EXEC = prev;
});
