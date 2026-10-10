/* Unit tests for the consolidated backtest engine (lib/backtestEngine.ts).
 * Run: node --import ./tests/ts-loader.mjs --test tests/backtestEngine.test.ts */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreTrade,
  scoreSequential,
  wilson95,
  coreStats,
  byYear,
  earlyLate,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  renderT0,
  DEFAULT_COST,
  DEFAULT_HOLD,
} from "../lib/backtestEngine";

/* ---------------- scoring ---------------- */

const flatBars = (n: number, high: number, low: number, c: number) =>
  Array.from({ length: n }, () => ({ high, low, c }));

describe("scoreTrade", () => {
  it("long hits target cleanly, net of cost", () => {
    // entry bar at idx 0; next bar trades to the target without touching the stop
    const minutes = flatBars(5, 110, 107, 109);
    const r = scoreTrade(minutes, { dir: 1, entry: 108, stop: 106, target: 110, entryIdx: 0, risk: 2 });
    assert.ok(r);
    assert.equal(r.hit, "target");
    assert.equal(r.exit, 110);
    assert.equal(r.pnl, 110 - 108 - DEFAULT_COST); // 1.5
    assert.equal(r.heldBars, 1);
  });

  it("pessimistic rule: stop wins when both stop and target are in the same bar", () => {
    // bar 0 = entry bar (never evaluated); bar 1 spans both stop and target
    const minutes = [{ high: 108.5, low: 107.5, c: 108 }, { high: 112, low: 104, c: 109 }];
    const r = scoreTrade(minutes, { dir: 1, entry: 108, stop: 105, target: 110, entryIdx: 0, risk: 3 });
    assert.ok(r);
    assert.equal(r.hit, "stop");
    assert.equal(r.pnl, 105 - 108 - DEFAULT_COST);
    assert.equal(r.ambiguous, true);
  });

  it("time exit uses the close rule and deducts cost", () => {
    const minutes = flatBars(10, 108.5, 107.5, 108);
    const r = scoreTrade(minutes, { dir: 1, entry: 108, stop: 104, target: 112, entryIdx: 0, risk: 4 });
    assert.ok(r);
    assert.equal(r.hit, "time");
    assert.equal(r.heldBars, Math.min(minutes.length - 1, DEFAULT_HOLD));
    assert.equal(r.exit, 108); // close > 0
    assert.equal(r.pnl, 108 - 108 - DEFAULT_COST);
  });

  it("rejects invalid geometry", () => {
    const minutes = flatBars(5, 110, 105, 109);
    assert.equal(scoreTrade(minutes, { dir: 1, entry: 108, stop: 110, target: 112, entryIdx: 0, risk: 2 }), null);
    assert.equal(scoreTrade(minutes, { dir: 1, entry: 108, stop: 106, target: 107, entryIdx: 0, risk: 2 }), null);
    assert.equal(scoreTrade(minutes, { dir: 1, entry: 108, stop: 106, target: 110, entryIdx: 0, risk: 0 }), null);
  });

  it("tracks MFE/MAE/2R/3R on the way", () => {
    // long: first bar after entry runs to +2R, the next bar stops out.
    // The entry bar itself is never evaluated (scoring starts at entryIdx+1).
    const minutes = [
      { high: 108.5, low: 107.5, c: 108 },
      { high: 114, low: 107, c: 112 },
      { high: 110, low: 104, c: 105 },
    ];
    const r = scoreTrade(minutes, { dir: 1, entry: 108, stop: 105, target: 120, entryIdx: 0, risk: 3 });
    assert.ok(r);
    assert.equal(r.hit, "stop");
    assert.equal(r.hit2R, true); // 114 >= 108 + 2*3
    assert.equal(r.hit3R, false);
    assert.ok(Math.abs(r.mfeR - (114 - 108) / 3) < 1e-9);
    assert.ok(Math.abs(r.maeR - (108 - 104) / 3) < 1e-9);
  });
});

describe("scoreSequential", () => {
  it("skips signals inside an open trade (held occupancy)", () => {
    let calls = 0;
    const scored = scoreSequential(
      [{ entryIdx: 1 }, { entryIdx: 2 }, { entryIdx: 10 }],
      (s) => {
        calls++;
        // entry 108, stop 105, target 111: bar 1 hits stop at bar 2 → heldBars 1
        return { exit: s.entryIdx === 1 ? 105 : 110, pnl: 1, hit: s.entryIdx === 1 ? "stop" : "target", heldBars: 1, risk: 3, mfeR: 0, maeR: 0, runPts: 0, hit2R: false, hit3R: false, ambiguous: false };
      },
    );
    assert.equal(calls, 2); // entryIdx 2 skipped (open until bar 2), 10 scored
    assert.equal(scored.length, 2);
  });

  it("full occupancy holds the whole window", () => {
    let calls = 0;
    const scored = scoreSequential(
      [{ entryIdx: 1 }, { entryIdx: 5 }, { entryIdx: 20 }],
      () => {
        calls++;
        return { exit: 110, pnl: 1, hit: "target", heldBars: 1, risk: 3, mfeR: 0, maeR: 0, runPts: 0, hit2R: false, hit3R: false, ambiguous: false };
      },
      { occupy: "full", window: 10 },
    );
    assert.equal(calls, 2); // entryIdx 5 inside 1+10 window; 20 scored
    assert.equal(scored.length, 2);
  });
});

/* ---------------- statistics ---------------- */

describe("wilson95", () => {
  it("matches known reference values", () => {
    const [lo, hi] = wilson95(10, 20);
    assert.ok(Math.abs(lo - 29.93) < 0.05, `lo=${lo}`);
    assert.ok(Math.abs(hi - 70.07) < 0.05, `hi=${hi}`);
    assert.deepEqual(wilson95(0, 0), [0, 0]);
  });
});

describe("coreStats", () => {
  // hand-computable cohort: 4 trades
  //  d1: +4 (risk 4), d1: -2 (risk 2), d2: +2 (risk 2), d3: -1 (risk 2)
  const trades = [
    { date: "2026-01-01", pnl: 4, risk: 4 },
    { date: "2026-01-01", pnl: -2, risk: 2 },
    { date: "2026-01-02", pnl: 2, risk: 2 },
    { date: "2026-01-03", pnl: -1, risk: 2 },
  ];

  it("computes the full T1 row correctly", () => {
    const s = coreStats(trades);
    assert.equal(s.n, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.wr, 50);
    assert.equal(s.avgWin, 3); // (4+2)/2
    assert.equal(s.avgLoss, 1.5); // (2+1)/2
    assert.equal(s.payoff, 2);
    assert.equal(s.netPts, 3);
    assert.equal(s.expPts, 0.75);
    // R multiples: +1, -1, +1, -0.5 → mean 0.125, sd = ?
    assert.ok(Math.abs(s.expR - 0.125) < 1e-9);
    // PF = grossWin 6 / grossLoss 3 = 2
    assert.equal(s.pf, 2);
    // maxDD: equity 4 → 2 → 4 → 3, peak 4 → dd 2 (at the second trade)
    assert.equal(s.maxDdPts, 2);
    // per-session ror: d1 2/6=0.3333, d2 2/2=1, d3 -1/2=-0.5 → mean 0.2778, sd …
    const m = (0.3333333333333333 + 1 - 0.5) / 3;
    const sdv = Math.sqrt(((0.3333333333333333 - m) ** 2 + (1 - m) ** 2 + (-0.5 - m) ** 2) / 3);
    assert.ok(Math.abs(s.sharpeSess - m / sdv) < 1e-9, `sharpe=${s.sharpeSess}`);
    // concentration: sessions net [2, 2, -1] → only 3 sessions, so the
    // top-10 slice holds everything: 3 / 3 = 100%
    assert.ok(Math.abs(s.concTop10 - 100) < 1e-9);
    // SQN: mean R 0.125, sd of [1, -1, 1, -0.5] = ?
    const rm = 0.125;
    const rsd = Math.sqrt(((1 - rm) ** 2 + (-1 - rm) ** 2 + (1 - rm) ** 2 + (-0.5 - rm) ** 2) / 4);
    assert.ok(Math.abs(s.sqn - (rm / rsd) * 2) < 1e-9, `sqn=${s.sqn}`);
  });

  it("pads per-session Sharpe with the session universe", () => {
    const s = coreStats(trades, { sessionUniverse: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"] });
    const m = (0.3333333333333333 + 1 - 0.5 + 0) / 4;
    const sdv = Math.sqrt(((0.3333333333333333 - m) ** 2 + (1 - m) ** 2 + (-0.5 - m) ** 2 + (0 - m) ** 2) / 4);
    assert.ok(Math.abs(s.sharpeSess - m / sdv) < 1e-9);
  });

  it("handles no-loss and empty cohorts", () => {
    const s = coreStats([{ date: "2026-01-01", pnl: 5, risk: 2 }]);
    assert.equal(s.pf, Infinity);
    assert.equal(s.payoff, Infinity);
    assert.equal(s.avgLoss, 0);
    const e = coreStats([]);
    assert.equal(e.n, 0);
    assert.equal(e.wr, 0);
    assert.deepEqual(e.wrCi, [0, 0]);
    assert.equal(e.sqn, 0);
  });
});

describe("byYear / earlyLate", () => {
  const trades = [
    { date: "2025-01-01", pnl: 1, risk: 1 },
    { date: "2025-06-01", pnl: 2, risk: 1 },
    { date: "2026-01-01", pnl: -1, risk: 1 },
  ];
  it("groups by year in order", () => {
    const ys = byYear(trades);
    assert.deepEqual(ys.map((y) => y.year), ["2025", "2026"]);
    assert.equal(ys[0].stats.n, 2);
  });
  it("splits early/late halves on date order", () => {
    const { early, late } = earlyLate(trades);
    assert.equal(early.n, 1);
    assert.equal(late.n, 2);
    assert.equal(early.netPts, 1);
  });
});

/* ---------------- viability ---------------- */

describe("propViability", () => {
  // budget $4 × risk 2 pts → 1 contract → dollars = pnlPts × $2.
  // Daily dollars: four +$1000 days, two −$1200 days, two +$1000 days.
  // Some orderings pass (target $3,000 by day 4, consistency 25% ≤ 30%),
  // some breach (two −$1200 days in a row dip below the trailing floor).
  const trades = [
    { date: "2026-01-01", pnl: 500, risk: 2 },
    { date: "2026-01-02", pnl: 500, risk: 2 },
    { date: "2026-01-03", pnl: 500, risk: 2 },
    { date: "2026-01-04", pnl: 500, risk: 2 },
    { date: "2026-01-05", pnl: -600, risk: 2 },
    { date: "2026-01-06", pnl: -600, risk: 2 },
    { date: "2026-01-07", pnl: 500, risk: 2 },
    { date: "2026-01-08", pnl: 500, risk: 2 },
  ];

  it("runs eval + funded sims and the pass-before-breach bootstrap deterministically", () => {
    const v1 = propViability(trades, { iters: 400, seed: 7, budget: 4 });
    const v2 = propViability(trades, { iters: 400, seed: 7, budget: 4 });
    assert.equal(v1.pPass, v2.pPass);
    assert.equal(v1.medianDaysToPass, v2.medianDaysToPass);
    assert.ok(v1.pPass !== null && v1.pPass > 0 && v1.pPass < 1, `pPass=${v1.pPass}`);
    assert.ok(v1.medianDaysToPass !== null && v1.medianDaysToPass >= 4, `days=${v1.medianDaysToPass}`);
    assert.equal(v1.evalSim.rules, "Rapid EOD 50k");
    assert.equal(v1.evalSim.nTrades, 8);
    // maxDD on the dollarized curve; mllRatio is against the $2,000 MLL
    assert.ok(v1.maxDdUsd >= 0);
    assert.equal(v1.mllRatio, v1.maxDdUsd / 2000);
  });

  it("splitDate produces test-only sims", () => {
    const v = propViability(trades, { splitDate: "2026-01-07", iters: 20, budget: 4 });
    assert.ok(v.evalTest);
    assert.equal(v.evalTest!.nTrades, 2);
    assert.equal(v.fundedTest!.nTrades, 2);
  });
});

/* ---------------- renderers ---------------- */

describe("renderers", () => {
  it("renderT1 emits the exact standard column header", () => {
    const s = coreStats([{ date: "2026-01-01", pnl: 5, risk: 2 }]);
    const md = renderT1([{ label: "all", stats: s }]);
    assert.ok(md.startsWith("| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |"));
    assert.ok(md.includes("| all | 1 |"));
    const [lo, hi] = wilson95(1, 1);
    assert.ok(md.includes(`| 100.0% [${lo.toFixed(1)}%–${hi.toFixed(1)}%] |`));
  });

  it("renderT2 and renderT4 and renderVerdict match the standard", () => {
    const t2 = renderT2([{ rule: "only longs", n: 57, wr: 88, ci: [77, 94], pf: 4.1, expPts: 5.19, trainTest: "88% / 88%", compare: "72% / +2.12" }]);
    assert.ok(t2.startsWith("| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |"));
    const v = propViability([{ date: "2026-01-01", pnl: 5, risk: 2 }, { date: "2026-01-02", pnl: 3, risk: 2 }], { iters: 50, seed: 1 });
    const t4 = renderT4(v);
    assert.ok(t4.startsWith("| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |"));
    assert.ok(t4.includes("| eval |"));
    assert.ok(t4.includes("| funded |"));
    assert.ok(t4.includes("P(pass before breach) ="));
    const verdict = renderVerdict({ edge: "real", significance: "PASS (PSR 0.97)", stability: "stable", holdout: "PASS", viability: "PASS (P=0.93)" });
    assert.equal(verdict, "VERDICT: edge real · significance PASS (PSR 0.97) · stability stable · holdout PASS · viability PASS (P=0.93)");
  });

  it("renderT0 renders the study card", () => {
    const t0 = renderT0({ "Instrument / session": "NQ 1-min · ETH", "Cost model": "0.5 pt round-trip" });
    assert.ok(t0.startsWith("| Field | Value |"));
    assert.ok(t0.includes("| Cost model | 0.5 pt round-trip |"));
  });
});
