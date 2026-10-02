/* Unit tests for the edge monitor (lib/edgeMonitor.ts): expR math and
 * the ok/watch/breach/insufficient classification. */
import { test } from "node:test";
import assert from "node:assert";
import { edgeStatuses, tradeExpR, type REPLAY_EXPR_BASELINES } from "../lib/edgeMonitor";
import type { EnrichedTrade } from "../lib/tradeStats";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-02T02:00:00Z");
let seq = 0;

function mk(over: Partial<EnrichedTrade> = {}): EnrichedTrade {
  const side = over.side ?? "long";
  seq++;
  return {
    signalKey: `k${seq}`,
    day: "2026-10-02",
    timeET: "22:00",
    ts: T0 + seq * MINUTE,
    side,
    contracts: 9,
    verdict: "momentum (failed-flush breakout)",
    sigEntry: 100,
    sigStop: side === "long" ? 95 : 105,
    sigTarget: side === "long" ? 105 : 95,
    fillEntry: 100,
    fillEntryAt: T0 + seq * MINUTE,
    exitAvg: 105,
    exitTs: T0 + (seq + 3) * MINUTE,
    grossUsd: 90,
    netUsd: 81,
    commissions: 9,
    result: "win",
    family: "momentum_flush",
    hourBucket: "globex_core",
    firstOfDay: false,
    riskPts: 5,
    targetPts: 5,
    entryAdversePts: 0,
    heldMin: 2,
    mfePts: 5,
    maePts: 1,
    targetReached: true,
    recovered: false,
    stopRun: false,
    lossLabel: "",
    exitVsPlanPts: 0,
    ...over,
  };
}

test("tradeExpR: gross R = grossUsd ÷ (contracts × riskPts × $2)", () => {
  const t = mk({ grossUsd: 90 }); // 9 × 5 × 2 = 90 → expR 1.0
  assert.ok(Math.abs((tradeExpR(t) ?? 0) - 1.0) < 1e-9);
  const l = mk({ grossUsd: -90, result: "loss" });
  assert.ok(Math.abs((tradeExpR(l) ?? 0) + 1.0) < 1e-9);
});

test("insufficient below 8 trades", () => {
  const rows = Array.from({ length: 7 }, () => mk());
  const s = edgeStatuses(rows)[0];
  assert.equal(s.status, "insufficient");
});

test("live expR above baseline → ok; below half → watch; ≤ 0 → breach", () => {
  const good = Array.from({ length: 10 }, () => mk({ grossUsd: 80 })); // expR 0.89
  assert.equal(edgeStatuses(good)[0].status, "ok");

  const weak = Array.from({ length: 10 }, () => mk({ grossUsd: 15 })); // expR 0.17 < 0.5×0.44
  assert.equal(edgeStatuses(weak)[0].status, "watch");

  const dead = Array.from({ length: 10 }, () => mk({ grossUsd: -45, result: "loss" })); // expR -0.5
  assert.equal(edgeStatuses(dead)[0].status, "breach");
});

test("only the most recent window of trades is judged", () => {
  const rows = [
    ...Array.from({ length: 30 }, () => mk({ grossUsd: 80 })), // old, healthy
    ...Array.from({ length: 30 }, () => mk({ grossUsd: -45, result: "loss" })), // recent, dead
  ];
  const s = edgeStatuses(rows)[0];
  assert.equal(s.status, "breach");
  assert.equal(s.n, 30); // the rolling window covers only the recent trades
});

/* execWatch pure pieces (same test file, framework family) */
import { fillMatches } from "../lib/execWatch";

test("execWatch fillMatches: side, size and window must all match", () => {
  const e = { ts: 100_000, intent: { dir: "short" as const, contracts: 9 } };
  const fills = [
    { ts: 100_500, action: "Buy", qty: 9 }, // wrong side
    { ts: 150_000, action: "Sell", qty: 9 }, // right side, right size, right window
    { ts: 100_200, action: "Sell", qty: 3 }, // too small
  ];
  assert.ok(fillMatches(e, fills, 200_000));
  assert.ok(!fillMatches(e, fills.filter((f) => f.action !== "Sell"), 200_000));
  assert.ok(!fillMatches({ ...e, intent: { dir: "short", contracts: 9 } }, [
    { ts: 100_200, action: "Sell", qty: 6 },
  ], 200_000));
});
