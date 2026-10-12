/* Guard-replay unit tests — pin the backtest model of the live day-plan
 * guard stack (lib/accountGuard.ts guardCheck semantics + the documented
 * one-more-trade rule) so the two can never drift silently. */

import { test } from "node:test";
import assert from "node:assert";
import { guardReplay, guardConfigFromEnv, type GuardConfig } from "../lib/guardReplay";
import type { DollarizedTrade } from "../lib/propAccount";

const CFG: GuardConfig = {
  dailyFloor: 250,
  profitArm: 400,
  flattenAtProfit: 0,
  flattenAtLoss: 0,
  givebackPct: 0.5,
  givebackFloor: 250,
  consistencyCap: 900,
  guardMargin: 500,
  ddHi: 600,
  ddLo: 300,
  ddMult: 0.5,
  target: 3000,
  maxLoss: 2000,
  lockAt: 100,
};

const cfg = (over: Partial<GuardConfig> = {}): GuardConfig => ({ ...CFG, ...over });

/** one trade: $2/pt MNQ at the given contracts, pnl recomputed by the replay */
const tr = (date: string, pnlPts: number, riskPts = 5, contracts = 1): DollarizedTrade => ({
  date,
  pnlPts,
  riskPts,
  contracts,
  pnl: 0,
});

test("daily floor: the crossing trade stands, everything after halts", () => {
  // three −$100 trades (day −$300), then two more cards the same day
  const rows = [
    tr("2026-01-01", -50),
    tr("2026-01-01", -50),
    tr("2026-01-01", -50),
    tr("2026-01-01", 50),
    tr("2026-01-01", 50),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.loss, 1, "one daily-floor halt");
  assert.equal(g.stats.traded, 3, "the three −$100 trades stand; the −$300 crossing happens on the third");
  assert.equal(g.stats.skippedByHalt, 2, "the two remaining cards are skipped");
});

test("profit arm: +$400 arms; the first LOSS after arming ends the day", () => {
  // +$400 (arms), +$200 (win grants one more), −$100 (first loss → day over)
  const rows = [
    tr("2026-01-02", 200), // +$400
    tr("2026-01-02", 100), // +$200
    tr("2026-01-02", -50), // −$100 → halt-profit
    tr("2026-01-02", 200),
    tr("2026-01-02", 200),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.profit, 1, "one profit-arm halt");
  assert.equal(g.stats.traded, 3, "the losing trade stands; the rest are skipped");
  assert.equal(g.stats.skippedByHalt, 2);
});

test("profit arm: a win after arming grants another, no halt", () => {
  const rows = [
    tr("2026-01-03", 200), // arm
    tr("2026-01-03", 100), // win → one more
    tr("2026-01-03", 100), // win → one more
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.profit, 0);
  assert.equal(g.stats.traded, 3);
});

test("give-back: 0.5 × dayPeak from a green peak halts new entries", () => {
  // +$300 peak (below the $400 arm), give back to dayPnl $40:
  // dayPeak 300 → limit max(250, 150) = 250 → 40 ≤ 300 − 250 → halt
  const rows = [
    tr("2026-01-04", 150), // +$300
    tr("2026-01-04", -130), // −$260 → dayPnl $40
    tr("2026-01-04", 50),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.giveback, 1);
  assert.equal(g.stats.traded, 2);
});

test("consistency: the +$900/day cap halts EVERY stage (same rules on funded)", () => {
  const rows = [
    tr("2026-01-05", 450), // +$900 — reaches the cap exactly
    tr("2026-01-05", 50), // never entered: the gate halts at day P&L ≥ $900
    tr("2026-01-05", 50),
  ];
  const ev = guardReplay(rows, "eval", cfg());
  assert.equal(ev.stats.halts.consistency, 1, "eval halts at the $900 cap");
  assert.equal(ev.stats.traded, 1, "the crossing trade stands; the rest are skipped");
  assert.equal(ev.stats.skippedByHalt, 2);
  const fu = guardReplay(rows, "funded", cfg());
  assert.equal(fu.stats.halts.consistency, 1, "funded halts too — the same rules apply");
  assert.equal(fu.stats.traded, 1);
  assert.equal(fu.stats.skippedByHalt, 2);
});

test("guard margin: entries halt within $500 of the trailing floor", () => {
  // −$1,550 on day 1 → equity −$1,550 ≤ floor(−$2,000) + 500 = −$1,500 → halt
  const rows = [
    tr("2026-01-06", -775), // −$1,550
    tr("2026-01-06", 50),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.margin, 1);
  assert.equal(g.stats.traded, 1);
});

test("target halt: $3,000 reached → everything after is skipped", () => {
  const rows = [
    tr("2026-01-07", 1500), // +$3,000
    tr("2026-01-07", 100),
    tr("2026-01-08", 100),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.target, 2, "the two post-target cards are skipped");
  assert.equal(g.stats.traded, 1);
});

test("dd600→half: contracts halve at ddHi and restore at ddLo (hysteresis)", () => {
  // funded (no consistency cap) with the floor/margin/consistency guards
  // neutralized so only the dd rule acts
  const c = cfg({ ddHi: 200, ddLo: 100, ddMult: 0.5, dailyFloor: 10_000, guardMargin: -10_000, consistencyCap: 10_000, target: 10_000 });
  const rows = [
    tr("2026-01-09", -100, 5, 10), // −$2,000 → dd 2,000 ≥ 200 at the next EOD
    tr("2026-01-10", 95, 5, 10), // halved: 5 contracts → +$950
    tr("2026-01-10", 95, 5, 10), // halved: +$950 → equity −$100
    tr("2026-01-11", 10, 5, 10), // dd 100 ≤ 100 → restored: 10 contracts → +$200
  ];
  const g = guardReplay(rows, "funded", c);
  assert.equal(g.rows[0].contracts, 10, "before the drawdown: full size");
  assert.equal(g.rows[1].contracts, 5, "dd ≥ ddHi: halved");
  assert.equal(g.rows[2].contracts, 5, "still halved while dd > ddLo");
  assert.equal(g.rows[3].contracts, 10, "dd ≤ ddLo: restored (hysteresis)");
  assert.equal(g.rows[1].pnl, 950);
  assert.equal(g.rows[3].pnl, 200);
});

test("stand-aside rows (0 contracts) pass through untouched and move no state", () => {
  const rows = [
    tr("2026-01-12", -50),
    tr("2026-01-12", 50, 5, 0), // Kelly stand-aside
    tr("2026-01-12", -50),
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.standAsides, 1);
  assert.equal(g.rows.length, 2, "the stand-aside is not a trade");
  // the stand-aside did not consume the day: the two −$100 trades stand
  assert.equal(g.stats.traded, 2);
  assert.equal(g.stats.halts.loss, 0, "day P&L −$200 never crossed −$250");
});

test("daily floor resets each day; halts are per-day", () => {
  const rows = [
    tr("2026-01-13", -50),
    tr("2026-01-13", -50),
    tr("2026-01-13", -50), // −$300 → halt for the day
    tr("2026-01-13", 50),
    tr("2026-01-14", 50), // new day trades again
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.halts.loss, 1);
  assert.equal(g.stats.traded, 4);
});

test("drawdown diagnostics: worst day, max drawdown, streaks", () => {
  const rows = [
    tr("2026-01-15", 100), // +$200
    tr("2026-01-16", -300), // −$600 worst day
    tr("2026-01-17", -50), // −$100
    tr("2026-01-17", -50), // −$100 → equity −$600
    tr("2026-01-18", 200), // +$400
  ];
  const g = guardReplay(rows, "eval", cfg());
  assert.equal(g.stats.worstDayUsd, -600);
  assert.equal(g.stats.maxDdUsd, 800); // peak $200 → trough −$600
  assert.equal(g.stats.longestRedDays, 2);
  assert.equal(g.stats.longestLoseStreak, 3); // −600, −100, −100
});

test("guardConfigFromEnv mirrors the live env knobs and their fallbacks", () => {
  const live = guardConfigFromEnv({});
  assert.equal(live.dailyFloor, 250);
  assert.equal(live.profitArm, 400);
  assert.equal(live.givebackPct, 0.5);
  assert.equal(live.givebackFloor, 250);
  assert.equal(live.consistencyCap, 900);
  assert.equal(live.guardMargin, 500);
  assert.equal(live.ddHi, 600);
  assert.equal(live.ddLo, 300);
  assert.equal(live.ddMult, 0.5);
  assert.equal(live.target, 3000);
  assert.equal(live.maxLoss, 2000);
  assert.equal(live.lockAt, 100);
  const over = guardConfigFromEnv({ DAILY_LOSS_FLOOR: "500", PROFIT_ARM: "600", DD_HALF_MULT: "0.25" });
  assert.equal(over.dailyFloor, 500);
  assert.equal(over.profitArm, 600);
  assert.equal(over.ddMult, 0.25);
});
