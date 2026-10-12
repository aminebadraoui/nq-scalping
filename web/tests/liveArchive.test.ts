/* Unit tests for the live archive aggregation (lib/liveArchive.ts) —
 * the LIVE half of the study cards and the backtest page: daybook
 * `dayend` summaries → per-family totals, expR, edge status, and the
 * per-day series. Pure functions only — no I/O, no Next runtime. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateLiveArchive,
  liveFamilyOf,
  liveEdgeStatus,
  tradeLiveExpR,
  CANONICAL_FAMILIES,
  type LiveFamily,
} from "../lib/liveArchive";
import type { DaybookDaySummary, DaybookTradeSummary } from "../lib/daybook";

const trade = (over: Partial<DaybookTradeSummary>): DaybookTradeSummary => ({
  day: "2026-10-06",
  timeET: "10:15",
  side: "long",
  contracts: 1,
  family: "other",
  verdict: "",
  entry: 100,
  exit: 101,
  stop: 95,
  target: 105,
  grossUsd: 10,
  netUsd: 8.6,
  commissions: 1.4,
  result: "win",
  heldMin: 5,
  exitReason: "target",
  ...over,
});

const summary = (trades: DaybookTradeSummary[]): DaybookDaySummary => ({
  day: "2026-10-06",
  source: "crossTrade+daybook",
  tradesN: trades.length,
  wins: trades.filter((t) => t.result === "win").length,
  losses: trades.filter((t) => t.result === "loss").length,
  flats: trades.filter((t) => t.result === "flat").length,
  grossUsd: trades.reduce((s, t) => s + t.grossUsd, 0),
  netUsd: trades.reduce((s, t) => s + t.netUsd, 0),
  commissions: trades.reduce((s, t) => s + t.commissions, 0),
  healEpisodes: 0,
  capSkips: 0,
  capReplay: [],
  expRetrace: { expiries: 0, fills: 0, avgAdverseDriftPts: null },
  trades,
});

test("empty input: all canonical families zero-filled, no lastDay", () => {
  const a = aggregateLiveArchive([]);
  assert.equal(a.lastDay, null);
  assert.equal(a.sessions, 0);
  assert.equal(a.families.length, CANONICAL_FAMILIES.length);
  for (const f of a.families) {
    assert.equal(f.n, 0);
    assert.equal(f.status, "insufficient");
    assert.deepEqual(f.byDay, []);
  }
});

test("one day, one family: totals, wr, pf, per-day series", () => {
  const a = aggregateLiveArchive([
    {
      day: "2026-10-06",
      summary: summary([
        trade({ family: "rth", verdict: "rth soft", grossUsd: 20, netUsd: 17, result: "win" }),
        trade({ family: "rth", verdict: "rth soft", grossUsd: -10, netUsd: -12, result: "loss" }),
        trade({ family: "rth", verdict: "rth soft", grossUsd: 0, netUsd: -0.5, result: "flat" }),
      ]),
    },
  ]);
  const rth = a.families.find((f) => f.family === "rth")!;
  assert.equal(a.lastDay, "2026-10-06");
  assert.equal(a.sessions, 1);
  assert.equal(rth.n, 3);
  assert.equal(rth.wins, 1);
  assert.equal(rth.losses, 1);
  assert.equal(rth.flats, 1);
  assert.equal(rth.wr, 0.5, "flats stay out of the WR denominator");
  assert.equal(rth.pf, 2, "20 / 10");
  assert.equal(rth.netUsd, 4.5);
  assert.equal(rth.daysTraded, 1);
  assert.equal(rth.byDay.length, 1);
  assert.equal(rth.byDay[0].netUsd, 4.5);
});

test("sessions count days with a summary even when trades are missing", () => {
  const a = aggregateLiveArchive([
    { day: "2026-10-06", summary: summary([trade({})]) },
    { day: "2026-10-07", summary: { ...summary([]), trades: undefined as unknown as DaybookTradeSummary[] } },
  ]);
  assert.equal(a.sessions, 2);
  assert.equal(a.lastDay, "2026-10-07");
});

test("multiple days accumulate in ascending order", () => {
  const a = aggregateLiveArchive([
    { day: "2026-10-08", summary: summary([trade({ family: "rth", netUsd: 5, grossUsd: 8, result: "win" })]) },
    { day: "2026-10-06", summary: summary([trade({ family: "rth", netUsd: 3, grossUsd: 6, result: "win" })]) },
  ]);
  const rth = a.families.find((f) => f.family === "rth")!;
  assert.equal(rth.n, 2);
  assert.deepEqual(rth.byDay.map((d) => d.day), ["2026-10-06", "2026-10-08"]);
  assert.equal(rth.firstDay, "2026-10-06");
  assert.equal(rth.lastDay, "2026-10-08");
});

test("tradeLiveExpR: gross ÷ (contracts × risk pts × $2), null when underivable", () => {
  // 2 contracts, 5-pt risk → denominator 20 → expR 1.0
  assert.equal(tradeLiveExpR({ entry: 100, stop: 95, contracts: 2, grossUsd: 20 }), 1);
  assert.equal(tradeLiveExpR({ entry: 95, stop: 100, contracts: 1, grossUsd: -10 }), -1);
  assert.equal(tradeLiveExpR({ entry: 100, stop: 0, contracts: 1, grossUsd: 10 }), null, "no stop → no risk pts");
  assert.equal(tradeLiveExpR({ entry: 0, stop: 95, contracts: 1, grossUsd: 10 }), null, "no entry");
  assert.equal(tradeLiveExpR({ entry: 100, stop: 95, contracts: 0, grossUsd: 10 }), null, "no contracts");
});

test("liveEdgeStatus thresholds mirror the edge monitor", () => {
  assert.equal(liveEdgeStatus(3, 0.5, 0.44), "insufficient", "n < 8");
  assert.equal(liveEdgeStatus(8, null, 0.44), "insufficient", "no expR");
  assert.equal(liveEdgeStatus(8, -0.01, 0.44), "breach");
  assert.equal(liveEdgeStatus(8, 0, 0.44), "breach", "zero is a breach");
  assert.equal(liveEdgeStatus(8, 0.1, 0.44), "watch", "below half the baseline");
  assert.equal(liveEdgeStatus(8, 0.21, 0.44), "watch", "just under half still watches");
  assert.equal(liveEdgeStatus(8, 0.22, 0.44), "ok", "exactly half is ok (strict <, same as the edge monitor)");
  assert.equal(liveEdgeStatus(8, 0.45, 0.44), "ok");
});

test("liveFamilyOf: consolidation label wins, verdict maps, unknown → other", () => {
  assert.equal(liveFamilyOf({ family: "rth", verdict: "momentum whatever" }), "rth");
  assert.equal(liveFamilyOf({ family: "other", verdict: "huge-bar expansion card" }), "momentum_expansion");
  assert.equal(liveFamilyOf({ family: "other", verdict: "" }), "other");
  assert.equal(liveFamilyOf({ family: "", verdict: "OPEN DRIVE scan" }), "open_drive");
});

test("unknown families in the data appear after the canonical ones", () => {
  const a = aggregateLiveArchive([
    { day: "2026-10-06", summary: summary([trade({ family: "some_new_family", netUsd: 1, grossUsd: 2, result: "win" })]) },
  ]);
  const labels = a.families.map((f) => f.family);
  assert.ok(labels.includes("some_new_family"));
  assert.ok(labels.indexOf("some_new_family") > labels.indexOf("other"));
});

test("mean expR aggregates only trades with derivable risk", () => {
  const a = aggregateLiveArchive([
    {
      day: "2026-10-06",
      summary: summary([
        // risk 5 pts × 1 contract → denom 10 → expR 2
        trade({ family: "rth", entry: 100, stop: 95, contracts: 1, grossUsd: 20, result: "win" }),
        // stop 0 → excluded from the mean
        trade({ family: "rth", stop: 0, contracts: 1, grossUsd: -10, result: "loss" }),
      ]),
    },
  ]);
  const rth = a.families.find((f) => f.family === "rth")!;
  assert.equal(rth.meanExpR, 2);
  assert.equal(rth.baselineExpR, 0.44);
});

test("default baseline falls back to other for unknown families", () => {
  const a = aggregateLiveArchive([
    { day: "2026-10-06", summary: summary([trade({ family: "some_new_family", result: "win" })]) },
  ]);
  const fam = a.families.find((f) => f.family === "some_new_family")!;
  assert.equal(fam.baselineExpR, 0.2);
});

test("custom baselines override the defaults", () => {
  const a = aggregateLiveArchive([], { rth: 0.99 });
  const rth = a.families.find((f) => f.family === "rth")!;
  assert.equal(rth.baselineExpR, 0.99);
});

test("malformed numeric fields never throw and read as zero", () => {
  const a = aggregateLiveArchive([
    {
      day: "2026-10-06",
      summary: summary([
        {
          ...trade({ family: "rth" }),
          grossUsd: Number.NaN,
          netUsd: Number.NaN,
          commissions: Number.NaN,
          contracts: Number.NaN,
        },
      ]),
    },
  ]);
  const rth = a.families.find((f) => f.family === "rth")!;
  assert.equal(rth.n, 1);
  assert.equal(rth.grossUsd, 0);
  assert.equal(rth.netUsd, 0);
  assert.equal(rth.commissions, 0);
});

test("wins-only family has no PF; losses-only family has no WR", () => {
  const a = aggregateLiveArchive([
    {
      day: "2026-10-06",
      summary: summary([
        trade({ family: "rth", grossUsd: 5, result: "win" }),
        trade({ family: "open_sniper", grossUsd: -5, result: "loss" }),
      ]),
    },
  ]);
  const rth = a.families.find((f) => f.family === "rth")!;
  const sniper = a.families.find((f) => f.family === "open_sniper")!;
  assert.equal(rth.pf, null, "no losses → no PF");
  assert.equal(rth.wr, 1);
  assert.equal(sniper.wr, 0);
  assert.equal(sniper.pf, 0, "no wins → PF 0");
});

test("family ordering is the canonical catalog order", () => {
  const a = aggregateLiveArchive([]);
  const labels = a.families.map((f) => f.family);
  for (let i = 0; i < CANONICAL_FAMILIES.length; i++) {
    assert.equal(labels[i], CANONICAL_FAMILIES[i]);
  }
});

test("family row shape is stable for the UI (byDay sorted, money rounded)", () => {
  const a = aggregateLiveArchive([
    {
      day: "2026-10-06",
      summary: summary([trade({ family: "rth", netUsd: 1.234, grossUsd: 2.345, result: "win" })]),
    },
  ]);
  const rth: LiveFamily = a.families.find((f) => f.family === "rth")!;
  assert.equal(rth.netUsd, 1.23);
  assert.equal(rth.grossUsd, 2.35);
  assert.equal(rth.byDay[0].netUsd, 1.23);
});
