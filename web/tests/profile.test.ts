/* Unit tests for the trade profiles (lib/profile.ts) — the backtested
 * stop/target/size/time-exit settings wired into the live feed. The math
 * must match the backtest scorer exactly: stop = entry ∓ risk×stopMult,
 * target = entry ± risk×stopMult×targetR, size = budget×sizeMult at the
 * profile stop with the 30-micro cap. */

import { test } from "node:test";
import assert from "node:assert";
import {
  momentumProfile,
  rthProfile,
  applyProfile,
  profileContracts,
  timeExitAt,
  timeExitDecision,
} from "../lib/profile";

test("momentumProfile defaults are the validated pick (0.35× / 2.25R / ×1 / 60-bar)", () => {
  const p = momentumProfile({});
  assert.equal(p.enabled, true);
  assert.equal(p.stopMult, 0.35);
  assert.equal(p.targetR, 2.25);
  assert.equal(p.sizeMult, 1);
  assert.equal(p.timeExitBars, 60);
});

test("rthProfile defaults are the validated pick (0.45× / 1.75R / ×1 / 45-bar)", () => {
  const p = rthProfile({});
  assert.equal(p.stopMult, 0.45);
  assert.equal(p.targetR, 1.75);
  assert.equal(p.sizeMult, 1);
  assert.equal(p.timeExitBars, 45);
});

test("profiles read env overrides and disable on *_PROFILE=0", () => {
  const p = momentumProfile({ MOM_PROFILE: "0", MOM_STOP_MULT: "0.5", MOM_TARGET_R: "2" });
  assert.equal(p.enabled, false);
  assert.equal(p.stopMult, 0.5); // knobs still parsed
  assert.equal(rthProfile({ RTH_PROFILE: "0" }).enabled, false);
});

test("applyProfile: long stop/target distances match the backtest scorer", () => {
  const p = momentumProfile({});
  const b = applyProfile("long", 21850.0, 4.0, p);
  // riskPts = 4 × 0.35 = 1.4 · stop 21848.6 · target = 21850 + 1.4 × 2.25 = 21853.15
  assert.equal(b.riskPts, 1.4);
  assert.equal(b.stop, 21848.6);
  assert.equal(b.target, 21853.15);
  assert.ok(b.stop < 21850.0 && 21850.0 < b.target);
});

test("applyProfile: short mirrors the math below the entry", () => {
  const b = applyProfile("short", 21850.0, 4.0, rthProfile({}));
  // riskPts = 1.8 · stop 21851.8 · target = 21850 − 1.8 × 1.75 = 21846.85
  assert.equal(b.riskPts, 1.8);
  assert.equal(b.stop, 21851.8);
  assert.equal(b.target, 21846.85);
  assert.ok(b.target < 21850.0 && 21850.0 < b.stop);
});

test("profileContracts: budget × sizeMult at the profile stop, 30-micro cap", () => {
  const p = momentumProfile({}); // stop 0.35×, size ×1 → budget 170
  // risk 4.5 → riskPts 1.575 → 170 / (1.575×2) = 53.9 → capped 30
  assert.equal(profileContracts(4.5, p, 170), 30);
  // risk 20 → riskPts 7 → 170 / 14 = 12 (under the cap)
  assert.equal(profileContracts(20, p, 170), 12);
  // ×2 doubles the budget: 340 / 14 = 24
  assert.equal(profileContracts(20, { ...p, sizeMult: 2 }, 170), 24);
});

test("timeExitAt: bars × 60s", () => {
  assert.equal(timeExitAt(1_000_000, momentumProfile({})), 1_000_000 + 60 * 60_000);
  assert.equal(timeExitAt(1_000_000, rthProfile({})), 1_000_000 + 45 * 60_000);
});

test("timeExitDecision: wait before the window, hold on unreadable book, fire past it", () => {
  assert.equal(timeExitDecision(1_000_000, 1_100_000, 9), "wait");
  assert.equal(timeExitDecision(1_100_001, 1_100_000, 9), "fire");
  assert.equal(timeExitDecision(1_100_001, 1_100_000, null), "hold"); // never guess
  assert.equal(timeExitDecision(1_100_001, 1_100_000, 0), "hold"); // already flat
});
