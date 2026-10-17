/* Kelly sizing unit tests — grounding the arithmetic in the documentary's
 * own numbers (50.75% even-money → 1.5% edge) and in the day plan:
 * thin evidence = flat risk, f ≤ 0 = stand aside, no lookahead. */

import { test } from "node:test";
import assert from "node:assert";
import {
  KELLY_DEFAULTS,
  KELLY_PRIORS,
  applyKellyOutcome,
  dollarizeKelly,
  kellyEstimate,
  kellyFraction,
  type KellyConfig,
  type KellyFamilyState,
  type KellyPrior,
} from "../lib/kelly";
import { momentumSize } from "../lib/propRules";

const cfg = (over: Partial<KellyConfig>): KellyConfig => ({ ...KELLY_DEFAULTS, ...over });
const st = (wins: number, losses: number, winR = 1, lossR = 1): KellyFamilyState => ({
  wins,
  losses,
  sumWinR: wins * winR,
  sumLossR: losses * lossR,
});

test("kellyFraction: the documentary's 50.75% even-money edge = 1.5% of capital", () => {
  assert.ok(Math.abs(kellyFraction(0.5075, 1) - 0.015) < 1e-9);
});

test("kellyFraction: 77.5% at 1R = 0.55; a coin flip = 0; below the coin flip = negative", () => {
  assert.ok(Math.abs(kellyFraction(0.775, 1) - 0.55) < 1e-9);
  assert.ok(Math.abs(kellyFraction(0.5, 1)) < 1e-9);
  assert.ok(kellyFraction(0.4, 1) < 0);
});

test("kellyEstimate: thin evidence equals the prior — risk is exactly the flat anchor at mult 1", () => {
  const est = kellyEstimate({ wins: 0, losses: 0, sumWinR: 0, sumLossR: 0 }, cfg({ kellyMult: 1 }));
  assert.equal(est.n, 0);
  assert.ok(Math.abs(est.p - 8 / 11) < 1e-9, "prior win rate 8/11");
  assert.ok(Math.abs(est.ratio - 1) < 1e-9, "ratio 1 → flat risk");
  assert.equal(est.risk, 100);
  assert.equal(est.skip, false);
});

test("kellyEstimate: shrinkage pulls a hot streak back toward the prior", () => {
  // 10W/3L raw = 76.9% — the prior (77.5%-ish for momentum) keeps the
  // shrunk estimate inside the anchor band instead of letting one streak
  // double the size
  const prior: KellyPrior = KELLY_PRIORS.momentum_flush;
  const est = kellyEstimate(st(10, 3), cfg({ kellyMult: 1, prior }));
  assert.ok(est.p < 0.775 + 1e-9 && est.p > 0.7, `shrunk p ${est.p} stays near the prior`);
  assert.ok(est.risk >= 90 && est.risk <= 110, `risk ${est.risk} stays near flat`);
});

test("kellyEstimate: a losing streak that kills the edge → stand aside, risk 0", () => {
  const est = kellyEstimate(st(0, 20), cfg({}));
  assert.equal(est.f, 0);
  assert.equal(est.skip, true);
  assert.equal(est.risk, 0);
});

test("kellyEstimate: b folds realized R multiples (1.25R wins vs 0.5R losses)", () => {
  // prior 50% @ 1R/1R; evidence one 1.25R win and one 0.5R loss →
  // shrunk b = 1.5, f = 0.5 − 0.5/1.5 = 1/6
  const est = kellyEstimate(
    { wins: 1, losses: 1, sumWinR: 1.25, sumLossR: 0.5 },
    cfg({ prior: { wins: 1, losses: 1, winR: 1, lossR: 1 } }),
  );
  assert.ok(Math.abs(est.b - 1.5) < 1e-9, `b = ${est.b}`);
  assert.ok(Math.abs(est.f - 1 / 6) < 1e-9, `f = ${est.f}`);
});

test("kellyEstimate: maxRisk and minRisk bind, ratio < 1 floors at minRisk", () => {
  const c = cfg({ kellyMult: 1, maxRisk: 120, minRisk: 30, maxFrac: 0.8 });
  const hot = kellyEstimate(st(50, 5), c); // ratio > 1.2 → cap at 120
  assert.equal(hot.risk, 120);
  const cold = kellyEstimate(st(3, 7), c); // raw risk ≈ $10 → floor at 30
  assert.ok(cold.f > 0, "edge still positive");
  assert.equal(cold.risk, 30);
});

test("dollarizeKelly: no lookahead — trade 1 is sized from the prior alone", () => {
  const trades = Array.from({ length: 10 }, (_, i) => ({
    date: "2026-01-" + String(i + 1).padStart(2, "0"),
    pnlPts: 1,
    riskPts: 3.5,
  }));
  const out = dollarizeKelly(trades, cfg({ kellyMult: 1 }));
  const flat = momentumSize(3.5, 100, { maxMicro: 10, pointValue: 2 });
  assert.equal(out[0].contracts, flat.contracts, "first trade = flat size under the owner μ10 cap");
  assert.equal(out[0].pnl, Math.round(1 * 2 * flat.contracts * 100) / 100);
});

test("dollarizeKelly: losing runs shrink sizing; the μ10 cap keeps Kelly ≤ flat (shrink-only)", () => {
  const wins = Array.from({ length: 8 }, (_, i) => ({
    date: "2026-02-" + String(i + 1).padStart(2, "0"),
    pnlPts: 1,
    riskPts: 3.5,
  }));
  const losses = Array.from({ length: 8 }, (_, i) => ({
    date: "2026-02-" + String(i + 9).padStart(2, "0"),
    pnlPts: -1,
    riskPts: 3.5,
  }));
  const up = dollarizeKelly(wins, cfg({}));
  const down = dollarizeKelly(losses, cfg({}));
  const flat = momentumSize(3.5, 100, { maxMicro: 10, pointValue: 2 }).contracts;
  for (const t of up) assert.ok(t.contracts <= flat, `winning run ${t.contracts} > flat ${flat} — the owner cap is shrink-only`);
  assert.ok(up[up.length - 1].contracts >= up[0].contracts, "winning run never shrinks");
  assert.ok(down[down.length - 1].contracts < down[0].contracts, "losing run shrinks the bet");
  assert.ok(down[down.length - 1].contracts > 0, "edge survives the prior → still trading");
});

test("dollarizeKelly: stand-aside trades come back with 0 contracts and 0 pnl", () => {
  const trades = Array.from({ length: 30 }, (_, i) => ({
    date: "2026-03-" + String(i + 1).padStart(2, "0"),
    pnlPts: -1,
    riskPts: 3.5,
  }));
  const out = dollarizeKelly(trades, cfg({ prior: { wins: 1, losses: 1, winR: 1, lossR: 1 } }));
  const skips = out.filter((t) => t.contracts === 0);
  assert.ok(skips.length > 0, "eventually the edge is gone and the sizer stands aside");
  for (const s of skips) assert.equal(s.pnl, 0, "no position, no pnl");
});

test("dollarizeKelly: families keep independent edge books", () => {
  const trades = [
    ...Array.from({ length: 12 }, (_, i) => ({ date: "2026-04-" + String(i + 1).padStart(2, "0"), pnlPts: -1, riskPts: 3.5, family: "b" })),
    { date: "2026-04-13", pnlPts: 1, riskPts: 3.5, family: "a" },
  ];
  const out = dollarizeKelly(trades, cfg({ kellyMult: 1 }));
  const flat = momentumSize(3.5, 100, { maxMicro: 10, pointValue: 2 }).contracts;
  assert.equal(out[12].contracts, flat, "family a's first trade is untouched by b's losing run");
});

test("applyKellyOutcome: zero-pnl trades are ignored; R is signed correctly", () => {
  const s: KellyFamilyState = { wins: 0, losses: 0, sumWinR: 0, sumLossR: 0 };
  applyKellyOutcome(s, 0, 3.5);
  assert.equal(s.wins + s.losses, 0);
  applyKellyOutcome(s, 1.75, 3.5);
  applyKellyOutcome(s, -3.5, 3.5);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.ok(Math.abs(s.sumWinR - 0.5) < 1e-9);
  assert.ok(Math.abs(s.sumLossR - 1) < 1e-9);
});

test("owner defaults (2026-10-17 sweep): half-Kelly, $100 cap", () => {
  assert.equal(KELLY_DEFAULTS.kellyMult, 0.5);
  assert.equal(KELLY_DEFAULTS.maxRisk, 100);
});

test("owner μ10 rule: Kelly-sized cards cap at 10 micros and floor sub-micro at 1", () => {
  const prior: KellyPrior = { wins: 31, losses: 9, winR: 1, lossR: 1 };
  const trades = [
    { date: "2026-01-02", pnlPts: 5, riskPts: 5, family: "momentum_flush" },
    { date: "2026-01-03", pnlPts: -5, riskPts: 5, family: "momentum_flush" },
    { date: "2026-01-06", pnlPts: 5, riskPts: 5, family: "momentum_flush" },
  ];
  // huge risk budget → the μ10 cap binds (floor(5000/10) = 500 → 10)
  const big = dollarizeKelly(trades, { kellyMult: 1, maxRisk: 5000, flatRisk: 5000, prior });
  for (const t of big) assert.ok(t.contracts <= 10, `contracts ${t.contracts} > 10`);
  assert.ok(big.some((t) => t.contracts === 10), "the 10-micro cap must actually bind");
  // tiny positive budget → floored to 1 micro, never 0 (edge present)
  const small = dollarizeKelly(trades, { kellyMult: 0.01, maxRisk: 2, minRisk: 2, flatRisk: 2, prior });
  for (const t of small) assert.ok(t.contracts >= 1, `sub-micro size ${t.contracts} not floored to 1`);
});
