/* Unit tests for lib/liveReads.ts — the per-strategy live read behind
 * the dashboard's live signal board.
 *
 * What is pinned here:
 *   1. the tail-bar gauge math (buy-frac, med60, ATR14, rangeR, delta
 *      frac, dominant clusters) matches the detectors' definitions;
 *   2. the read's FIRE truth is the detector's own output — firedNow is
 *      non-null exactly when the memoized detector fires on the tail
 *      bar, and null otherwise (the read can never disagree with what
 *      the feed trades);
 *   3. the open-drive window/cumD gauges;
 *   4. the armed-state cast is null-safe and formats the pending
 *      expansion retrace. */
import { test } from "node:test";
import assert from "node:assert";
import {
  tailMetrics,
  firedNow,
  gapSince,
  openStartIdx,
  openGauges,
  rthGauges,
  armedNotes,
} from "../lib/liveReads";
import { detectSoftMomentumMemo, detectOpenDriveMemo } from "../lib/detectorCache";
import { SOFT_PROD } from "../lib/softMomentum";
import { OPEN_PROD } from "../lib/openDrive";
import type { FootprintMinute } from "../lib/gcdata";
import type { FPLevel } from "../lib/imbalance";

const mkLevel = (price: number, buy: number, sell: number): FPLevel => ({
  price,
  buy,
  sell,
  bTrades: buy,
  sTrades: sell,
  dBuy: false,
  dSell: false,
  hBuy: false,
  hSell: false,
  ratio: 1,
  dBuyRatio: 0,
  dSellRatio: 0,
});

/** a synthetic session. `t` is the FEED clock (UTC "HH:mm"); hourET = (hh+1)%24. */
function mkBar(partial: Partial<FootprintMinute> & Pick<FootprintMinute, "t" | "high" | "low">): FootprintMinute {
  return {
    d: "2026-10-11",
    o: 20000,
    c: 20001,
    buy: 50,
    sell: 50,
    delta: 0,
    vwap: 20000,
    levels: [],
    imb: { buy: 0, sell: 0, dBuy: 0, dSell: 0, stacked: null, biased: null },
    src: "candle",
    ...partial,
  };
}

/** 40 quiet two-sided RTH bars + an optional tail override */
function rthSession(tail: Partial<FootprintMinute> = {}): FootprintMinute[] {
  const fp: FootprintMinute[] = [];
  for (let i = 0; i < 39; i++) {
    fp.push(mkBar({ t: `14:${String(i).padStart(2, "0")}`, high: 20001.5, low: 19998.5, buy: 50, sell: 50 }));
  }
  fp.push(mkBar({ t: "14:40", high: 20001.5, low: 19998.5, buy: 50, sell: 50, ...tail }));
  return fp;
}

test("tailMetrics: gauge math matches the detectors' definitions", () => {
  const fp: FootprintMinute[] = [];
  for (let i = 0; i < 15; i++) {
    fp.push(mkBar({ t: "01:00", high: 20002, low: 20000, buy: 100 + i, sell: 100 }));
  }
  fp.push(
    mkBar({
      t: "01:15",
      high: 20006,
      low: 20000,
      c: 20003,
      buy: 60,
      sell: 40,
      levels: [
        mkLevel(20001, 4, 1),
        mkLevel(20002, 4, 1),
        mkLevel(20003, 4, 1),
        mkLevel(20004, 1, 4),
      ],
    }),
  );
  const g = tailMetrics(fp);
  assert.ok(g, "metrics computed");
  assert.strictEqual(g.vol, 100);
  assert.strictEqual(g.buyFrac, 0.6);
  assert.strictEqual(g.range, 6);
  assert.strictEqual(g.atr14, 2); // median of the previous 14 ranges (all 2)
  assert.strictEqual(g.rangeR, 3); // 6 / 2
  assert.strictEqual(g.deltaFrac, 0.2); // |60-40| / 100
  assert.strictEqual(g.domBuy, 3); // three rows ≥3 lots and ≥2× opposite
  assert.strictEqual(g.domSell, 1);
  // med60: median of the 15 previous volumes (200..214 → median 207)
  assert.strictEqual(g.med60, 207);
  assert.strictEqual(g.volGateNeed, 103.5); // max(15, min(0.5×207, 250))
});

test("firedNow: exactly the detector's fire on the just-closed bar (RTH)", () => {
  // tail bar satisfies every SOFT_PROD gate: buy-frac 0.7, volume 100
  // (= 0.5×med60 exactly), 3 dominant rows, rangeR 2.0, risk 6 pts
  const fp = rthSession({
    high: 20002,
    low: 19996,
    c: 20001,
    buy: 70,
    sell: 30,
    levels: [
      mkLevel(20000, 4, 1),
      mkLevel(20000.5, 4, 1),
      mkLevel(20001, 4, 1),
    ],
  });
  const sigs = detectSoftMomentumMemo(fp, SOFT_PROD, 0);
  const fired = firedNow(sigs, fp);
  assert.ok(fired, "detector fires on the tail bar → the read says so");
  assert.strictEqual(fired.dir, "long");
  assert.strictEqual(fired.entry, 20001);
  assert.strictEqual(fired.stop, 19995); // low − stopPad 1
  assert.strictEqual(gapSince(sigs, fp.length - 1), null); // no earlier fire

  // a two-sided tail bar fires nothing → the read says nothing
  const quiet = rthSession();
  assert.strictEqual(firedNow(detectSoftMomentumMemo(quiet, SOFT_PROD, 0), quiet), null);
});

test("gapSince: bars between the tail and the family's last fire", () => {
  // two RTH fires: bar 24 and bar 34 of a 40-bar session
  const fp = rthSession();
  const fire = {
    dir: "long" as const,
    kind: "flush" as const,
    breakIdx: 34,
    flushIdx: 33,
    respIdx: 34,
    entryIdx: 34,
    entry: 20001,
    stop: 19995,
    target: 20007,
    risk: 6,
    t: "14:34",
    d: "2026-10-11",
    hourET: 15,
    flushFrac: 0.5,
    flushVol: 100,
    flushRange: 3,
    failDepth: 0,
    respFrac: 0.7,
    respVol: 100,
    respDelay: 1,
    respProof: 0,
    breakFrac: 0.7,
    breakVol: 100,
    breakDelay: 0,
    refDist: 0,
    progressPts: 0,
    medVol: 100,
    distVwapPts: 0,
    cumDelta: 20,
    deltaFromFlush: 20,
    atr14: 3,
    riskPts: 6,
    trailLowDist: 0,
    trailHighDist: 0,
    breakRangeR: 2,
    breakStack: "none" as const,
    breakVwapPos: 0.5,
    flushRangeR: 0,
    domClusters: 3,
  };
  assert.strictEqual(gapSince([{ ...fire, breakIdx: 24 }, fire], fp.length - 1), 5);
  assert.strictEqual(gapSince([], fp.length - 1), null);
});

test("rthGauges: thresholds read live from SOFT_PROD and scored honestly", () => {
  const fp = rthSession({
    high: 20002,
    low: 19996,
    c: 20001,
    buy: 70,
    sell: 30,
    levels: [
      mkLevel(20000, 4, 1),
      mkLevel(20000.5, 4, 1),
      mkLevel(20001, 4, 1),
    ],
  });
  const g = tailMetrics(fp);
  assert.ok(g);
  const gauges = rthGauges(fp, g, detectSoftMomentumMemo(fp, SOFT_PROD, 0));
  const byKey = (k: string) => gauges.find((x) => x.key === k);
  assert.strictEqual(byKey("window")?.state, "pass"); // 14:40 UTC → 15:40 ET = RTH
  assert.strictEqual(byKey("frac")?.state, "pass");
  assert.strictEqual(byKey("vol")?.state, "pass");
  assert.strictEqual(byKey("clusters")?.state, "pass");
  assert.strictEqual(byKey("range")?.state, "pass");
  assert.strictEqual(byKey("risk")?.state, "pass");
  assert.strictEqual(byKey("gap")?.state, "pass");
  // a quiet tail: the one-sidedness gate fails and the window still passes
  const quiet = tailMetrics(rthSession());
  assert.ok(quiet);
  const quietGauges = rthGauges(rthSession(), quiet, []);
  assert.strictEqual(quietGauges.find((x) => x.key === "frac")?.state, "fail");
  assert.strictEqual(quietGauges.find((x) => x.key === "window")?.state, "pass");
});

test("openStartIdx + openGauges: the 9:30 window and cumD read", () => {
  // feed clock 08:30 = 9:30 ET
  const fp: FootprintMinute[] = [];
  for (let i = 0; i < 10; i++) fp.push(mkBar({ t: "07:30", high: 20002, low: 20000, buy: 50, sell: 50 }));
  fp.push(mkBar({ t: "08:30", high: 20002, low: 20000, buy: 60, sell: 30 }));
  for (let i = 1; i < 10; i++) fp.push(mkBar({ t: `08:3${i}`, high: 20002, low: 20000, buy: 60, sell: 30 }));
  assert.strictEqual(openStartIdx(fp), 10);

  const g = tailMetrics(fp);
  assert.ok(g);
  const gauges = openGauges(fp, g, detectOpenDriveMemo(fp, OPEN_PROD, 0));
  const byKey = (k: string) => gauges.find((x) => x.key === k);
  assert.strictEqual(byKey("window")?.state, "pass");
  // cumD from the 9:30 bar through the tail: 10 × +30 = +300 → at the floor
  assert.strictEqual(byKey("cumd")?.state, "pass");
  assert.match(byKey("cumd")?.value ?? "", /\+300/);
  // the tail prints a new extreme only when it beats the window's prior high
  const extreme = openGauges(fp, g, []);
  assert.strictEqual(extreme.find((x) => x.key === "extreme")?.state, "info");
});

test("armedNotes: null-safe cast, pending retrace formatted", () => {
  // no armed state → no notes, no throw (feed surfaces as an empty object)
  assert.deepStrictEqual(armedNotes({}, 40, 20000), []);
  assert.deepStrictEqual(armedNotes(null, 40, 20000), []);

  const feed = {
    expRetracePending: {
      key: "mom|2026-10-11|long|08:35",
      day: "2026-10-11",
      dir: "long" as const,
      level: 20005,
      armedIdx: 34,
      maxIdx: 38,
      sEntry: 20004,
      sStop: 19998,
      sTarget: 20010,
      risk: 6,
      fixed: 0,
      riskBudget: 100,
      scaleOut: false,
      t: "08:35",
      aPlus: false,
      firstToday: true,
      et: "09:35",
      features: {},
    },
    pullbackWatch: null,
  };
  const notes = armedNotes(feed, 40, 20002);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].tab, "expansion");
  assert.strictEqual(notes[0].hot, true);
  assert.match(notes[0].text, /EXPANSION RETRACE ARMED/);
  assert.match(notes[0].text, /20,005/);
  assert.match(notes[0].text, /0 bars left/); // maxIdx 38 vs tail 39
  assert.match(notes[0].text, /tape −3\.00 pts away/); // 20002 − 20005
});
