/* Profile engine regression tests.
 * Each field is recomputed by an independent implementation (helpers.mjs) and
 * then pinned to a golden value captured from the audited session. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDay, loadOhlc, statsIndependent, inWindow, DATE } from "./helpers.mjs";
import * as gc from "../lib/gcdata.ts";

const candles = loadDay(DATE, "RTH");
const ohlc = new Map((loadOhlc(DATE) ?? []).map((b) => [b.t.slice(11, 16), b]));

/* the engine returns prices in POINTS, the independent helper in CENTS
 * (the raw data is cents, so bucketing must stay exact there) */
const toCents = (st) => ({
  ...st,
  poc: st.poc * 100,
  vah: st.vah * 100,
  val: st.val * 100,
  lvns: st.lvns.map(([a, b]) => [a * 100, b * 100]),
});

const GOLDEN = {
  1: { total: 416282, poc: 30912, pocVolume: 1269, vah: 30930, val: 30740, rows: 1071, lvns: [[30684, 30701], [30702.5, 30722.75], [30938.25, 30951.5]] },
  2: { total: 416282, poc: 30912, pocVolume: 2429, vah: 30928, val: 30744, rows: 536, lvns: [[30684, 30701], [30703.5, 30723], [30939, 30951.5]] },
  4: { total: 416282, poc: 30912, pocVolume: 4444, vah: 30927, val: 30753, rows: 269, lvns: [[30684, 30700], [30703, 30723], [30939, 30952]] },
};

for (const row of [1, 2, 4]) {
  test(`row ${row} ticks: engine matches an independent reimplementation`, async () => {
    const got = await gc.computeProfile(DATE, "RTH", undefined, undefined, row);
    const want = statsIndependent(candles, row);
    const eng = toCents(got.stats);
    assert.equal(eng.total, want.total, "total volume");
    assert.equal(eng.poc, want.poc, "POC");
    assert.equal(eng.pocVolume, want.pocVolume, "POC volume");
    assert.equal(eng.vah, want.vah, "VAH");
    assert.equal(eng.val, want.val, "VAL");
    assert.equal(eng.nRows, want.nRows, "row count");
    assert.deepEqual(eng.lvns, want.lvns, "LVN zones");
  });

  test(`row ${row} ticks: golden values`, async () => {
    const got = await gc.computeProfile(DATE, "RTH", undefined, undefined, row);
    const g = GOLDEN[row];
    assert.equal(got.stats.total, g.total);
    assert.equal(got.stats.poc, g.poc);
    assert.equal(got.stats.pocVolume, g.pocVolume);
    assert.equal(got.stats.vah, g.vah);
    assert.equal(got.stats.val, g.val);
    assert.equal(got.stats.nRows, g.rows);
    assert.deepEqual(got.stats.lvns.map(([a, b]) => [a, b]), g.lvns);
  });
}

test("invariants: VAL <= POC <= VAH, POC is the max row, VA is >=70% and minimal", async () => {
  for (const row of [1, 2, 4]) {
    const p = await gc.computeProfile(DATE, "RTH", undefined, undefined, row);
    const w = statsIndependent(candles, row);
    assert.ok(p.stats.val <= p.stats.poc && p.stats.poc <= p.stats.vah, `ordering at row ${row}`);
    assert.equal(p.stats.pocVolume, Math.max(...[...w.rows.values()].map((r) => r.total)), `POC is the max row at row ${row}`);
    // The value area must cover 70% and be MINIMAL. The VA is not contiguous
    // (it is the top-volume rows), so minimality is tested against the smallest
    // row that is actually IN the area, not the smallest row in [VAL, VAH].
    const covered = w.vaVolume / w.total;
    assert.ok(covered >= 0.7, `VA covers >=70% (${covered})`);
    const smallestInVa = Math.min(...[...w.vaSet].map((k) => w.rows.get(k).total));
    assert.ok((w.vaVolume - smallestInVa) / w.total < 0.7, "removing the smallest VA row must drop below 70%");
  }
});

test("invariants: no volume is lost or double counted", async () => {
  const w = statsIndependent(candles, 4);
  const sumCandle = candles.reduce((s, c) => s + (c.total || c.buy + c.sell), 0);
  const sumLevels = candles.reduce((s, c) => s + Object.values(c.levels).reduce((x, v) => x + v[0], 0), 0);
  assert.equal(w.total, sumCandle, "bucket total == sum of candle totals");
  assert.equal(w.total, sumLevels, "bucket total == sum of level volumes");
});

test("LVN zones are non-overlapping, ordered and at least 1 point wide", async () => {
  for (const row of [1, 2, 4]) {
    const p = await gc.computeProfile(DATE, "RTH", undefined, undefined, row);
    let prev = -Infinity;
    for (const [a, b] of p.stats.lvns) {
      // engine prices are in POINTS (the independent helper is in cents)
      assert.ok(a > prev, "zones are ordered and disjoint");
      assert.ok(b - a >= 1, `zone ${a}-${b} is at least 1 pt wide`);
      prev = b;
    }
  }
});

test("golden: opening range 09:30-10:00 New York (feed 08:30-08:59), 1-pt rows", async () => {
  const or = candles.filter((c) => inWindow(c, "08:30", "08:59"));
  assert.equal(or.length, 30, "30 one-minute bars");
  const got = await gc.computeProfile(DATE, "RTH", "08:30", "08:59", 4);
  const want = statsIndependent(or, 4);
  const eng = toCents(got.stats);
  assert.equal(eng.total, 63260);
  assert.equal(eng.poc, want.poc);
  assert.equal(eng.vah, want.vah);
  assert.equal(eng.val, want.val);
  // audited reference band: POC 30,858-30,860, VAH 30,922, VAL 30,780
  assert.ok(got.stats.poc >= 30858 && got.stats.poc <= 30860, `OR POC ${got.stats.poc}`);
  assert.equal(got.stats.vah, 30922);
  assert.equal(got.stats.val, 30780);
});

test("level sheet: six recency-numbered profiles with golden levels", async () => {
  const sheet = await gc.computeSheet(DATE);
  const GOLD = {
    P0_developing_rth: ["30,912.00", "30,927.00", "30,753.00", 269, 3],
    P1_opening_range: ["30,859.00", "30,922.00", "30,780.00", 160, 6],
    P2_full_session: ["30,888.00", "30,928.00", "30,753.00", 322, 4],
    P3_overnight: ["30,888.00", "30,980.00", "30,857.00", 225, 5],
    P4_prev_day_rth: ["30,769.00", "30,778.00", "30,510.00", 336, 6],
    // the sheet lists at most 10 LVN zones; P5 has 11 filtered zones in total.
    // P5 golden = the five full sessions 09-25,24,23,22,18 (a Saturday vendor
    // artifact once slipped in as a 6th candidate; sessions <100 candles are
    // now excluded, so the composite is deterministic store-to-store)
    P5_5day_composite: ["30,740.00", "30,977.00", "29,708.00", 854, 10],
  };
  for (const [key, [poc, vah, val, rows, lvnCount]] of Object.entries(GOLD)) {
    const p = sheet.profiles[key];
    assert.ok(p, `${key} present`);
    assert.equal(p.POC, poc, `${key} POC`);
    assert.equal(p.VAH, vah, `${key} VAH`);
    assert.equal(p.VAL, val, `${key} VAL`);
    assert.equal(p.rows, rows, `${key} rows`);
    assert.equal(p.LVNs.length, lvnCount, `${key} LVN zones`);
  }
});
