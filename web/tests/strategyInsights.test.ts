/* Unit tests for the strategy insight miner (lib/strategyInsights.ts):
 * proposals fire only with enough evidence, gates map to the right
 * families/values, and small datasets stay silent. */
import { test } from "node:test";
import assert from "node:assert";
import { mineInsights, renderDeterministicNarrative, type AnalyzedTrade } from "../lib/strategyInsights";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-02T02:00:00Z");

function mk(over: Partial<AnalyzedTrade> = {}): AnalyzedTrade {
  const side = over.side ?? "long";
  const dir = side === "long" ? 1 : -1;
  return {
    signalKey: `k${Math.random().toString(36).slice(2, 8)}`,
    day: "2026-10-02",
    timeET: "22:00",
    ts: T0,
    side,
    contracts: 9,
    verdict: "momentum (huge-bar expansion)",
    sigEntry: 100,
    sigStop: side === "long" ? 95 : 105,
    sigTarget: side === "long" ? 105 : 95,
    fillEntry: 100,
    fillEntryAt: T0 + MINUTE,
    exitAvg: side === "long" ? 105 : 95,
    exitTs: T0 + 3 * MINUTE,
    grossUsd: 90,
    netUsd: 81,
    commissions: 9,
    result: "win",
    family: "momentum_expansion",
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
    features: { breakFrac: 0.8, breakRangeR: 1.6, riskPts: 5, cumDelta: dir * 500 },
    ...over,
  };
}

const loss = (over: Partial<AnalyzedTrade> = {}) =>
  mk({
    result: "loss",
    exitAvg: 95,
    grossUsd: -90,
    netUsd: -99,
    mfePts: 0.5,
    maePts: 5,
    targetReached: false,
    recovered: false,
    stopRun: false,
    lossLabel: "gave back",
    ...over,
  });

test("mineInsights stays silent on tiny datasets", () => {
  assert.deepEqual(mineInsights([]), []);
  assert.deepEqual(mineInsights([mk(), mk(), loss()]), []);
});

test("losing hour bucket with enough evidence → hour veto proposal", () => {
  const rows = [
    ...Array.from({ length: 2 }, () => mk({ hourBucket: "globex_late" })),
    ...Array.from({ length: 6 }, () => loss({ hourBucket: "globex_late" })),
  ];
  const ins = mineInsights(rows);
  const veto = ins.find((i) => i.kind === "rule_proposal" && i.proposedAction?.gate === "hour_veto");
  assert.ok(veto, "expected an hour_veto proposal");
  assert.equal(veto!.proposedAction!.family, "momentum_expansion");
  assert.deepEqual(veto!.proposedAction!.value, { hours: [0, 1, 2], bucket: "globex_late" });
  assert.equal(veto!.autoApply, false); // n < 10
});

test("weak expansion family → trend filter proposal", () => {
  const rows = [
    ...Array.from({ length: 2 }, () => mk({ hourBucket: "globex_core" })),
    ...Array.from({ length: 6 }, () => loss({ hourBucket: "globex_core" })),
  ];
  const ins = mineInsights(rows);
  const tf = ins.find((i) => i.kind === "rule_proposal" && i.proposedAction?.gate === "trend_filter");
  assert.ok(tf, "expected a trend_filter proposal");
  assert.equal(tf!.proposedAction!.family, "momentum_expansion");
});

test("all-losses-are-stop-runs family → observation", () => {
  const rows = Array.from({ length: 6 }, () =>
    loss({ stopRun: true, lossLabel: "stop-run", recovered: true, hourBucket: "globex_core" }),
  );
  const ins = mineInsights(rows);
  assert.ok(ins.some((i) => i.kind === "observation" && i.title.includes("stop-run")));
});

test("feature tier split → min_break_frac proposal", () => {
  const rows = [
    ...Array.from({ length: 8 }, () => loss({ features: { breakFrac: 0.78, breakRangeR: 1.5, riskPts: 5, cumDelta: -500 } })),
    ...Array.from({ length: 8 }, () => mk({ features: { breakFrac: 0.9, breakRangeR: 1.7, riskPts: 5, cumDelta: 500 } })),
  ];
  const ins = mineInsights(rows);
  const gate = ins.find((i) => i.kind === "rule_proposal" && i.proposedAction?.gate === "min_break_frac");
  assert.ok(gate, "expected a min_break_frac proposal");
  const v = gate!.proposedAction!.value as { min: number };
  assert.equal(v.min, 0.9);
  assert.equal(gate!.autoApply, false);
});

test("deterministic narrative covers the dataset even with no proposals", () => {
  const rows = [mk(), loss()];
  const txt = renderDeterministicNarrative(rows, mineInsights(rows));
  assert.ok(txt.includes("2 traded signals"));
  assert.ok(txt.includes("momentum_expansion"));
});

test("walk-forward: a veto proposal must also lose on the newest third", () => {
  const mkRow = (i: number, win: boolean) =>
    win
      ? mk({ hourBucket: "globex_late", ts: T0 + i * MINUTE })
      : loss({ hourBucket: "globex_late", ts: T0 + i * MINUTE });

  // 3 wins / 9 losses overall (25%); newest third = 3 losses + 1 win → holds
  const rows = [
    mkRow(0, true), mkRow(1, true),
    ...Array.from({ length: 6 }, (_, i) => mkRow(2 + i, false)),
    ...Array.from({ length: 3 }, (_, i) => mkRow(8 + i, false)),
    mkRow(11, true),
  ];
  const ins = mineInsights(rows, { walkForward: true });
  const veto = ins.find((i) => i.proposedAction?.gate === "hour_veto");
  assert.ok(veto, "expected the hour veto proposal");
  assert.equal(veto!.kind, "rule_proposal");
  assert.equal((veto!.evidence.walkForward as { holds?: boolean }).holds, true);

  // newest third now WINS → the proposal is downgraded to an observation
  const rows2 = [
    ...Array.from({ length: 8 }, (_, i) => mkRow(i, false)),
    ...Array.from({ length: 3 }, (_, i) => mkRow(8 + i, true)),
    mkRow(11, false),
  ];
  const ins2 = mineInsights(rows2, { walkForward: true });
  const downgraded = ins2.find((i) => i.title.includes("loses in"));
  assert.ok(downgraded, "expected the downgraded insight");
  assert.equal(downgraded!.kind, "observation");
  assert.equal(downgraded!.proposedAction, null);
  assert.match(downgraded!.finding, /FAILED walk-forward/);
});
