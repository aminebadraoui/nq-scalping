/* Unit tests for the live exec status derivation (display-only): the
 * dashboard's status strip mirrors the guard's inputs — never the gate. */
import { test } from "node:test";
import assert from "node:assert";
import { deriveExecStatus, type ExecProtections } from "../lib/execStatus";

const P = (over: Partial<ExecProtections> = {}): ExecProtections => ({
  stage: "eval",
  startBalance: 50_000,
  profitTarget: 3_000,
  floor: 48_000,
  highWater: 50_000,
  locked: false,
  dayKey: "2026-10-05",
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
  giveback: { armed: true, pct: 0.5, floor: 250, haltAt: -250 },
  ...over,
});

const SNAP = { equity: 50_100, realized: 50_100 };
const OPTS = { executeLive: true, crosstradeConfigured: true, guardMargin: 500 };

test("live: all gates clear when the account and day are healthy", () => {
  const s = deriveExecStatus(P(), SNAP, OPTS);
  assert.equal(s.state, "live");
  assert.equal(s.halts.length, 0);
});

test("dry-run: executor switch off or CrossTrade unconfigured", () => {
  assert.equal(deriveExecStatus(P(), SNAP, { ...OPTS, executeLive: false }).state, "dry");
  assert.equal(deriveExecStatus(P(), SNAP, { ...OPTS, crosstradeConfigured: false }).state, "dry");
});

test("halted: unreadable account snapshot fails closed", () => {
  const s = deriveExecStatus(P(), null, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.includes("no-data"));
});

test("halted: near the trailing floor", () => {
  const s = deriveExecStatus(P({ floor: 49_900, highWater: 51_900 }), { equity: 50_100, realized: 50_100 }, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("floor:")));
});

test("halted: profit target reached (pass)", () => {
  const s = deriveExecStatus(P(), { equity: 53_001, realized: 53_001 }, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("target:")));
});

test("halted: eval consistency cap", () => {
  const s = deriveExecStatus(P({ dayPnl: 900 }), SNAP, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("consistency:")));
});

test("halted: day-plan −$250 daily floor (default)", () => {
  const s = deriveExecStatus(P({ dayPnl: -260 }), SNAP, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("daily floor:")));
});

test("halted: profit arm — first loss after arming at +$400", () => {
  const s = deriveExecStatus(P({ profitArmed: true, lastDayPnl: 420, dayPnl: 250 }), SNAP, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("profit arm:")));
});

test("live: a WIN after arming keeps the day going", () => {
  const s = deriveExecStatus(P({ profitArmed: true, lastDayPnl: 420, dayPnl: 700 }), SNAP, OPTS);
  assert.equal(s.state, "live");
});

test("halted: give-back protection fires on green-day givebacks", () => {
  const s = deriveExecStatus(P({ dayPeak: 600, dayPnl: 300 }), SNAP, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("give-back:")));
});

test("funded: target is measured from zero, not the nominal start", () => {
  const funded = { stage: "funded" as const, startBalance: 0, profitTarget: 3000, floor: -2000, highWater: 0 };
  const s = deriveExecStatus(P(funded), { equity: 2_900, realized: 2_900 }, OPTS);
  assert.equal(s.state, "live");
  const t = deriveExecStatus(P(funded), { equity: 3_100, realized: 3_100 }, OPTS);
  assert.equal(t.state, "halted");
});

test("halted: a DEFINITE hydration failure with realized ≠ 0 fails closed", () => {
  const s = deriveExecStatus(P({ dayKey: "", dayBaselineOk: false }), { equity: 50_300, realized: 300 }, OPTS);
  assert.equal(s.state, "halted");
  assert.ok(s.halts.some((x) => x.startsWith("baseline:")));
});

test("live: dayKey empty BEFORE the first hydration attempt is not a halt", () => {
  // boot race: the seed has no day reference yet and hydration has not
  // run — the status bar must not false-alarm; the GATE is the real
  // fail-closed check, applied only after a failed hydration attempt
  const s = deriveExecStatus(P({ dayKey: "" }), { equity: 50_300, realized: 300 }, OPTS);
  assert.equal(s.state, "live");
});

test("live: hydration success with an empty dayKey (fresh account) stays live", () => {
  const s = deriveExecStatus(P({ dayKey: "", dayBaselineOk: true }), { equity: 50_300, realized: 300 }, OPTS);
  assert.equal(s.state, "live");
});
