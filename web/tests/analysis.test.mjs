/* Event-detection regression tests: VWAP, divergence, reclaims, initiative,
 * absorption, LVN alerts. Every rule is recomputed independently and the
 * counts are pinned so the 2026 audit's fixes cannot silently regress. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDay, loadOhlc, analysisIndependent, vwapIndependent, statsIndependent, median, inWindow, DATE } from "./helpers.mjs";
import * as gc from "../lib/gcdata.ts";

const candles = loadDay(DATE, "RTH");
const ohlcMap = new Map((loadOhlc(DATE) ?? []).map((b) => [b.t.slice(11, 16), b]));
const A = await gc.analyze(DATE, "RTH", undefined, undefined, 2);
const ind = analysisIndependent(candles);
const key = (x) => `${x.t}|${x.price}`;
const byKind = (k) => A.alerts.filter((a) => a.kind === k);

test("session VWAP equals an independent HLC3 computation", () => {
  const want = vwapIndependent(candles, ohlcMap);
  assert.ok(Math.abs(A.vwap - want) < 1e-9, `${A.vwap} vs ${want}`);
  assert.ok(Math.abs(A.vwap - 30844.595620476815) < 1e-6, "golden session VWAP");
});

test("a windowed request uses the WINDOW's VWAP, not the session's", async () => {
  const orCandles = candles.filter((c) => inWindow(c, "08:30", "08:59"));
  const win = await gc.analyze(DATE, "RTH", "08:30", "08:59", 4);
  const want = vwapIndependent(orCandles, ohlcMap);
  assert.ok(Math.abs(win.vwap - want) < 1e-9, "windowed VWAP");
  assert.ok(Math.abs(win.vwap - A.vwap) > 1, "differs from the session VWAP");
});

test("divergence D2: every qualifying pivot pair is reported", () => {
  const got = byKind("DIVERGENCE_D2").map(key).sort();
  const want = ind.d2.map(key).sort();
  assert.deepEqual(got, want, "D2 sets must match the independent scan");
  assert.equal(got.length, 9, "golden D2 count");
  for (const a of byKind("DIVERGENCE_D2")) assert.ok(a.bias === "bull");
});

test("divergence D4: every qualifying pivot pair is reported", () => {
  const got = byKind("DIVERGENCE_D4").map(key).sort();
  const want = ind.d4.map(key).sort();
  assert.deepEqual(got, want, "D4 sets must match the independent scan");
  assert.equal(got.length, 5, "golden D4 count");
  for (const a of byKind("DIVERGENCE_D4")) assert.ok(a.bias === "bear");
});

test("divergence conditions really hold (price LL/HH with CVD HL/LH)", () => {
  const cvdAt = new Map(candles.map((c, i) => [c.t.slice(11, 16), ind.cvd[i]]));
  for (const a of byKind("DIVERGENCE_D2")) {
    const i = candles.findIndex((c) => c.t.slice(11, 16) === a.t);
    const prevLow = ind.pLows.filter((p) => p < i).pop();
    assert.ok(prevLow !== undefined && ind.lo[i] < ind.lo[prevLow], `D2 at ${a.t}: price lower low`);
    assert.ok(ind.cvd[i] > ind.cvd[prevLow], `D2 at ${a.t}: CVD higher low`);
    assert.ok(cvdAt.has(a.t));
  }
  for (const a of byKind("DIVERGENCE_D4")) {
    const i = candles.findIndex((c) => c.t.slice(11, 16) === a.t);
    const prevHigh = ind.pHighs.filter((p) => p < i).pop();
    assert.ok(prevHigh !== undefined && ind.hi[i] > ind.hi[prevHigh], `D4 at ${a.t}: price higher high`);
    assert.ok(ind.cvd[i] < ind.cvd[prevHigh], `D4 at ${a.t}: CVD lower high`);
  }
});

test("reclaims match the independent scan (a 1-tick break counts)", () => {
  const got = A.reclaims.map((r) => `${r.t}|${r.price.toFixed(2)}|${r.dir}`).sort();
  const want = ind.reclaims.map((r) => `${r.t}|${r.price.toFixed(2)}|${r.dir}`).sort();
  assert.deepEqual(got, want);
  assert.equal(got.length, 11, "golden reclaim count");
});

test("initiative bars: aggression + a strict new extreme vs the previous bar", () => {
  const got = byKind("INITIATIVE").map((a) => `${a.t}|${Number(a.price).toFixed(2)}|${a.side}`).sort();
  const want = ind.initiative.map((x) => `${x.t}|${x.price.toFixed(2)}|${x.side}`).sort();
  assert.deepEqual(got, want);
  assert.equal(got.length, 44, "golden initiative count (an exact tie is NOT a new extreme)");
});

test("absorption matches the documented rule, independently recomputed", () => {
  const rows = candles;
  const levelVols = [];
  for (const c of rows) for (const v of Object.values(c.levels)) levelVols.push(v[1] + v[2]);
  const med = median(levelVols);
  const floor = Math.max(20, med * 1.5);
  assert.equal(floor, 20, "the median term now sets the floor (the old hard 50 sat ~4× above the median)");
  const want = [];
  const seen = new Set();
  rows.forEach((c, i) => {
    // the "near extreme" test uses a trailing LOCAL window (last ~hour), not
    // the full-session range — a mid-session swing is still near ITS extreme
    let localLow = Infinity;
    let localHigh = -Infinity;
    const from = Math.max(0, i - 60);
    for (let k = from; k <= i; k++) {
      if (rows[k].low / 100 < localLow) localLow = rows[k].low / 100;
      if (rows[k].high / 100 > localHigh) localHigh = rows[k].high / 100;
    }
    const localRange = localHigh - localLow;
    const lv = Object.entries(c.levels)
      .map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] }))
      .sort((a, b) => b.price - a.price);
    for (const l of lv) {
      const total = l.buy + l.sell;
      if (total < floor) continue;
      const dom = Math.abs(l.buy - l.sell) / total;
      if (dom < 0.6) continue;
      const ask = l.buy > l.sell;
      const pos = localRange > 0.25 ? (l.price - localLow) / localRange : 0.5;
      if (ask && pos < 0.7) continue;
      if (!ask && pos > 0.3) continue;
      let broke = false;
      for (let j = i + 1; j < Math.min(rows.length, i + 4); j++) {
        if (ask && rows[j].high / 100 >= l.price + 0.5) broke = true;
        if (!ask && rows[j].low / 100 <= l.price - 0.5) broke = true;
      }
      if (broke) continue;
      const k = `${l.price}|${ask ? "a" : "b"}`;
      if (seen.has(k)) continue;
      seen.add(k);
      want.push(`${c.t.slice(11, 16)}|${l.price}|${ask ? "ask" : "bid"}|${total}|${dom.toFixed(4)}`);
    }
  });
  const got = A.absorption.map((a) => `${a.t}|${a.price}|${a.side}|${a.volume}|${a.imbalance.toFixed(4)}`);
  assert.deepEqual(got, want);
  assert.equal(got.length, 37, "golden absorption event count (recalibrated floor + local window)");
  assert.equal(got[0], "08:32|30779.5|bid|46|0.6957", "first golden event");
  assert.equal(got[got.length - 1], "14:55|30913|ask|20|0.6000", "last golden event");
});

test("LVN_ENTER / LVN_EXIT fire exactly on zone crossings", () => {
  const zones = A.stats.lvns;
  const inLvn = (p) => zones.some(([a, b]) => p >= a && p <= b);
  const want = { ENTER: [], EXIT: [] };
  const mid = candles.map((c) => (c.high + c.low) / 200);
  candles.forEach((c, i) => {
    const was = i > 0 && inLvn(mid[i - 1]);
    const is = inLvn(mid[i]);
    if (is && !was) want.ENTER.push(c.t.slice(11, 16));
    if (!is && was) want.EXIT.push(c.t.slice(11, 16));
  });
  assert.deepEqual(byKind("LVN_ENTER").map((a) => a.t), want.ENTER);
  assert.deepEqual(byKind("LVN_EXIT").map((a) => a.t), want.EXIT);
  assert.equal(want.ENTER.length, 3);
  assert.equal(want.EXIT.length, 3);
});

test("every alert's vwapSide matches the session VWAP reference", () => {
  for (const a of A.alerts) {
    const want = a.price >= A.vwap ? "above" : "below";
    assert.equal(a.vwapSide, want, `${a.kind} @ ${a.price}`);
  }
});

test("alert counts are pinned (regression guard)", () => {
  const counts = {};
  for (const a of A.alerts) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  assert.deepEqual(counts, {
    DIVERGENCE_D2: 9, DIVERGENCE_D4: 5, INITIATIVE: 44,
    LVN_ENTER: 3, LVN_EXIT: 3, ABSORPTION: 10,
  });
});

test("imbalance rollup is pinned", () => {
  assert.deepEqual(A.imbalance, {
    buyRows: 2313, sellRows: 2093, dBuyRows: 1282, dSellRows: 1172,
    stackedMinutes: 177, stacks: A.imbalance.stacks, lastStack: A.imbalance.lastStack,
    lastMinute: A.imbalance.lastMinute,
  });
  assert.equal(A.imbalance.stacks.length, 177);
  assert.deepEqual(A.imbalance.lastStack, { t: "14:57", side: "buy", from: 30901.75, to: 30901.25, len: 3 });
});

test("the profile rows returned by analyze() are consistent with stats()", () => {
  const w = statsIndependent(candles, 2);
  assert.equal(A.rows.length, w.nRows);
  assert.equal(A.stats.poc, w.poc / 100);
  assert.equal(A.stats.vah, w.vah / 100);
  assert.equal(A.stats.val, w.val / 100);
});
