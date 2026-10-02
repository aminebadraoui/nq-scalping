/* Unit tests for the trade analysis framework (lib/tradeStats.ts):
 * family/hour classification, the per-trade anatomy (MFE/MAE, target
 * reached, stop-run / recovery detection), first-of-day marking, and
 * the aggregate stat math. Pure functions — no network, no DB. */
import { test } from "node:test";
import assert from "node:assert";
import {
  familyOf,
  hourBucketOf,
  computeFeatures,
  markFirstOfDay,
  aggregateTrades,
  type TradeForAnalysis,
  type Bar,
  type EnrichedTrade,
} from "../lib/tradeStats";

const MINUTE = 60_000;

const baseTrade = (over: Partial<TradeForAnalysis> = {}): TradeForAnalysis => ({
  signalKey: "k1",
  day: "2026-10-02",
  timeET: "22:00",
  ts: Date.parse("2026-10-02T02:00:00Z"),
  side: "long",
  contracts: 9,
  verdict: "momentum (failed-flush breakout)",
  sigEntry: 100,
  sigStop: 95,
  sigTarget: 105,
  fillEntry: 100,
  fillEntryAt: Date.parse("2026-10-02T02:00:30Z"),
  exitAvg: 105,
  exitTs: Date.parse("2026-10-02T02:05:00Z"),
  grossUsd: 90,
  netUsd: 81,
  commissions: 9,
  result: "win",
  ...over,
});

const bar = (tsMs: number, high: number, low: number): Bar => ({ ts: tsMs, high, low });

test("familyOf maps verdicts to analysis families", () => {
  assert.equal(familyOf("momentum (failed-flush breakout)"), "momentum_flush");
  assert.equal(familyOf("momentum (huge-bar expansion)"), "momentum_expansion");
  assert.equal(familyOf("rth soft-continuation (experimental)"), "rth");
  assert.equal(familyOf("open drive (experimental)"), "open_drive");
  assert.equal(familyOf("sweep-reclaim (one-sided)"), "sweep_reclaim");
  assert.equal(familyOf("something else"), "other");
});

test("hourBucketOf splits the day at the documented boundaries", () => {
  assert.equal(hourBucketOf("18:00"), "globex_early");
  assert.equal(hourBucketOf("20:59"), "globex_early");
  assert.equal(hourBucketOf("21:00"), "globex_core");
  assert.equal(hourBucketOf("23:59"), "globex_core");
  assert.equal(hourBucketOf("00:00"), "globex_late");
  assert.equal(hourBucketOf("02:59"), "globex_late");
  assert.equal(hourBucketOf("03:00"), "globex_dawn");
  assert.equal(hourBucketOf("05:59"), "globex_dawn");
  assert.equal(hourBucketOf("06:00"), "premkt");
  assert.equal(hourBucketOf("09:00"), "premkt");
  assert.equal(hourBucketOf("09:29"), "premkt");
  assert.equal(hourBucketOf("09:30"), "rth");
  assert.equal(hourBucketOf("15:59"), "rth");
  assert.equal(hourBucketOf("16:00"), "close");
});

test("computeFeatures: long win reaching the target zone", () => {
  const t = baseTrade();
  const bars = [
    bar(t.fillEntryAt + MINUTE, 103, 99),
    bar(t.fillEntryAt + 2 * MINUTE, 105.5, 101),
    bar(t.fillEntryAt + 3 * MINUTE, 105.2, 102),
  ];
  const f = computeFeatures(t, bars, true);
  assert.equal(f.riskPts, 5);
  assert.equal(f.targetPts, 5);
  assert.equal(f.entryAdversePts, 0);
  assert.ok(f.mfePts !== null && f.mfePts >= 5.25);
  assert.equal(f.targetReached, true);
  assert.equal(f.stopRun, false);
  assert.equal(f.lossLabel, "");
  assert.equal(f.firstOfDay, true);
  assert.equal(f.family, "momentum_flush");
  assert.equal(f.hourBucket, "globex_core");
});

test("computeFeatures: entry adverse drift is signed against direction", () => {
  // long filled ABOVE the signal price = adverse (positive)
  const long = baseTrade({ fillEntry: 101.5 });
  assert.equal(computeFeatures(long, [], false).entryAdversePts, 1.5);
  // short filled BELOW the signal price = adverse (positive)
  const short = baseTrade({ side: "short", sigEntry: 100, sigStop: 105, sigTarget: 95, fillEntry: 98.5 });
  assert.equal(computeFeatures(short, [], false).entryAdversePts, 1.5);
});

test("computeFeatures: short loss stopped at the low, then price recovers → stop-run", () => {
  const t = baseTrade({
    side: "short",
    sigEntry: 100,
    sigStop: 104,
    sigTarget: 96,
    fillEntry: 100,
    fillEntryAt: Date.parse("2026-10-02T02:00:30Z"),
    exitAvg: 104.2,
    exitTs: Date.parse("2026-10-02T02:04:00Z"),
    grossUsd: -50,
    netUsd: -56,
    result: "loss",
  });
  const bars = [
    bar(t.fillEntryAt + MINUTE, 103.5, 100.5), // adverse
    bar(t.fillEntryAt + 2 * MINUTE, 104.5, 102), // stop zone
    bar(t.fillEntryAt + 3 * MINUTE, 103, 98.5), // exit, then prints below entry
    bar(t.exitTs + 5 * MINUTE, 99, 95.5), // recovery: crossed back through entry (below 100)
  ];
  const f = computeFeatures(t, bars, false);
  assert.equal(f.lossLabel, "stop-run");
  assert.equal(f.stopRun, true);
  assert.equal(f.recovered, true);
  assert.ok(f.maePts !== null && f.maePts >= 4);
});

test("computeFeatures: long loss that never reached the target → never worked", () => {
  const t = baseTrade({
    exitAvg: 95,
    exitTs: Date.parse("2026-10-02T02:06:00Z"),
    grossUsd: -90,
    netUsd: -99,
    result: "loss",
  });
  const bars = [bar(t.fillEntryAt + MINUTE, 100.2, 97), bar(t.fillEntryAt + 2 * MINUTE, 99, 94.8)];
  const f = computeFeatures(t, bars, false);
  assert.equal(f.lossLabel, "never worked");
  assert.equal(f.stopRun, false);
  assert.equal(f.targetReached, false);
});

test("markFirstOfDay returns the earliest signal ts per day", () => {
  const rows = [
    { day: "2026-10-01", ts: 300 },
    { day: "2026-10-01", ts: 100 },
    { day: "2026-10-02", ts: 50 },
    { day: "2026-10-02", ts: 200 },
  ];
  const s = markFirstOfDay(rows);
  assert.deepEqual([...s].sort((a, b) => a - b), [50, 100]);
});

test("aggregateTrades: win rate, PF, expectancy and stop-run rate", () => {
  const mk = (over: Partial<TradeForAnalysis>, feats: Partial<EnrichedTrade>): EnrichedTrade => ({
    ...baseTrade(over),
    family: "momentum_flush",
    hourBucket: "globex_core",
    firstOfDay: false,
    riskPts: 5,
    targetPts: 5,
    entryAdversePts: 0,
    heldMin: 3,
    mfePts: 5,
    maePts: 2,
    targetReached: true,
    recovered: false,
    stopRun: false,
    lossLabel: "",
    exitVsPlanPts: 0,
    ...feats,
  });
  const rows: EnrichedTrade[] = [
    mk({ grossUsd: 100, netUsd: 90, result: "win", signalKey: "w1" }, {}),
    mk({ grossUsd: 80, netUsd: 71, result: "win", signalKey: "w2" }, {}),
    mk({ grossUsd: -60, netUsd: -66, result: "loss", signalKey: "l1" }, { stopRun: true, lossLabel: "stop-run", maePts: 5 }),
    mk({ grossUsd: -40, netUsd: -45, result: "loss", signalKey: "l2" }, {}),
  ];
  const stats = aggregateTrades(rows);
  const all = stats.find((s) => s.group === "overall")!;
  assert.equal(all.n, 4);
  assert.equal(all.wins, 2);
  assert.equal(all.losses, 2);
  assert.ok(Math.abs((all.winRate ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((all.profitFactor ?? 0) - (180 / 100)) < 1e-9);
  assert.equal(all.grossUsd, 80);
  assert.equal(all.netUsd, 50);
  assert.equal(all.expectancyUsd, 12.5);
  assert.equal(all.stopRuns, 1);
  assert.ok(Math.abs((all.stopRunRate ?? 0) - 0.5) < 1e-9);
  const fam = stats.find((s) => s.group === "family" && s.label === "momentum_flush")!;
  assert.equal(fam.n, 4);
});
