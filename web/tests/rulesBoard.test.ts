/* Unit tests for the rules board derivation (lib/execStatus.ts
 * deriveRulesView) — the operator-facing list of every live rule with
 * threshold + live metric + state. Display-only; the real gate is
 * crossGuardGate. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRulesView, type ExecProtections } from "../lib/execStatus";

const P: ExecProtections = {
  stage: "eval",
  startBalance: 50_000,
  profitTarget: 3_000,
  floor: 48_000,
  highWater: 51_000,
  locked: false,
  dayKey: "2026-10-07",
  dayPnl: 0,
  dayPeak: 0,
  consistencyCap: 900,
  dailyFloor: 250,
  profitArm: 400,
  profitArmed: false,
  lastDayPnl: null,
  ddHi: 600,
  ddLo: 300,
  ddHalved: false,
  dayBaselineOk: true,
  giveback: { armed: true, pct: 0.5, floor: 250, haltAt: -250 },
};

const EXTRAS = {
  windowOpen: true,
  windowLabel: "Sun 18:00 ET → Fri 16:00 ET",
  newsNow: null,
  newsNote: "all stages",
  tapeTail: 0,
  tapeHolding: false,
  healStep: 0,
  healEpisodes: 0,
  rthCap: { count: 1, cap: 3 },
  counterGate: { enabled: true, min: 15, pts: 5, recentWinners: 0 },
};

const OPTS = { executeLive: true, crosstradeConfigured: true, guardMargin: 500 };

const row = (rows: ReturnType<typeof deriveRulesView>, id: string) => rows.find((r) => r.id === id)!;

test("healthy day: everything watching, nothing tripped", () => {
  const rows = deriveRulesView(P, { equity: 51_000, realized: 500 }, OPTS, EXTRAS);
  assert.equal(rows.filter((r) => r.state === "tripped").length, 0);
  assert.equal(row(rows, "target").threshold, "+$53,000");
  assert.equal(row(rows, "consistency").current, "+$0");
});

test("target reached trips and stops trading", () => {
  const rows = deriveRulesView(P, { equity: 53_100, realized: 3_000 }, OPTS, EXTRAS);
  assert.equal(row(rows, "target").state, "tripped");
  assert.equal(row(rows, "floor").state, "ok");
});

test("daily floor tripped on a red day", () => {
  const rows = deriveRulesView({ ...P, dayPnl: -260, dayPeak: 0 }, { equity: 49_700, realized: -260 }, OPTS, EXTRAS);
  assert.equal(row(rows, "daily-floor").state, "tripped");
  assert.equal(row(rows, "daily-floor").current, "−$260");
});

test("profit arm arms and then trips on the first loss after arming", () => {
  const armed = deriveRulesView(
    { ...P, dayPnl: 450, dayPeak: 450, profitArmed: true, lastDayPnl: 450 },
    { equity: 50_450, realized: 450 },
    OPTS,
    EXTRAS,
  );
  assert.equal(row(armed, "profit-arm").state, "warn");
  const tripped = deriveRulesView(
    { ...P, dayPnl: 350, dayPeak: 450, profitArmed: true, lastDayPnl: 450 },
    { equity: 50_350, realized: 350 },
    OPTS,
    EXTRAS,
  );
  assert.equal(row(tripped, "profit-arm").state, "tripped");
});

test("consistency cap is off on funded and tripped when reached on eval", () => {
  const funded = deriveRulesView(
    { ...P, stage: "funded", dayPnl: 1_200 },
    { equity: 52_000, realized: 1_200 },
    OPTS,
    EXTRAS,
  );
  assert.equal(row(funded, "consistency").state, "off");
  const evalTripped = deriveRulesView({ ...P, dayPnl: 950 }, { equity: 50_950, realized: 950 }, OPTS, EXTRAS);
  assert.equal(row(evalTripped, "consistency").state, "tripped");
});

test("closed window and active news blackout trip the session rules", () => {
  const rows = deriveRulesView(P, { equity: 51_000, realized: 500 }, OPTS, {
    ...EXTRAS,
    windowOpen: false,
    newsNow: "CPI",
  });
  assert.equal(row(rows, "window").state, "tripped");
  assert.equal(row(rows, "news").state, "tripped");
  assert.equal(row(rows, "news").current, "CPI");
});

test("tape gate warns while holding, and the counter-gate shows its state", () => {
  const rows = deriveRulesView(P, { equity: 51_000, realized: 500 }, OPTS, {
    ...EXTRAS,
    tapeTail: 9,
    tapeHolding: true,
    healStep: 1,
    counterGate: { enabled: true, min: 15, pts: 5, recentWinners: 1 },
  });
  assert.equal(row(rows, "tape-gate").state, "warn");
  assert.match(row(rows, "tape-gate").current, /tail 9/);
  assert.equal(row(rows, "counter-gate").state, "warn");
  assert.equal(row(rows, "counter-gate").threshold, "15 min · 5 pts");
});

test("unreadable snapshot collapses to a single no-data rule", () => {
  const rows = deriveRulesView(P, null, OPTS, EXTRAS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "no-data");
  assert.equal(rows[0].state, "tripped");
});
