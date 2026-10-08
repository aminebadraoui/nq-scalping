/* Unit tests for the owner's manual trading halt (lib/tradingHalt.ts):
 * the kill-switch state machine — halt, persist, survive boot, resume,
 * audit. These are the rules that keep a dashboard STOP from silently
 * vanishing on the next redeploy. */
import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTradingHalt, setTradingHalt, tradingHalted, tradingHaltFile, __resetTradingHaltForTest } from "../lib/tradingHalt";

function tmpEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "trading-halt-"));
  const env: Record<string, string | undefined> = { GC_DATA_DIR: dir };
  return { env, dir };
}

test("halt: set → tradingHalted, persisted to the file, applied to env", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(tradingHalted(env), false);
  setTradingHalt(true, env);
  assert.equal(tradingHalted(env), true);
  assert.equal(env.TRADING_HALT, "1");
  const raw = JSON.parse(readFileSync(tradingHaltFile(env), "utf8")) as { halted: boolean };
  assert.equal(raw.halted, true);
});

test("resume: clears the env key and persists halted=false", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setTradingHalt(true, env);
  setTradingHalt(false, env);
  assert.equal(tradingHalted(env), false);
  const raw = JSON.parse(readFileSync(tradingHaltFile(env), "utf8")) as { halted: boolean };
  assert.equal(raw.halted, false);
});

test("boot: a persisted halt is re-applied after a redeploy", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setTradingHalt(true, env);
  const env2: Record<string, string | undefined> = { GC_DATA_DIR: dir }; // fresh process env
  assert.equal(tradingHalted(env2), false);
  loadTradingHalt(env2);
  assert.equal(tradingHalted(env2), true);
});

test("boot: no file → trading stays on, never throws", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  loadTradingHalt(env);
  assert.equal(tradingHalted(env), false);
  assert.equal(existsSync(tradingHaltFile(env)), false);
});

test("same-state flip is a no-op (no audit churn)", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setTradingHalt(true, env);
  const before = readFileSync(tradingHaltFile(env), "utf8");
  setTradingHalt(true, env); // no-op
  assert.equal(readFileSync(tradingHaltFile(env), "utf8"), before);
});

test("TEST helper resets the in-process key", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  setTradingHalt(true, env);
  __resetTradingHaltForTest(env);
  assert.equal(tradingHalted(env), false);
});

/* ---- resume-password check (UX fix: trim both sides, unset = open) ---- */

import { verifyResumePassword } from "../lib/tradingHalt";

test("verifyResumePassword: exact match opens", () => {
  assert.equal(verifyResumePassword("hunter2", "hunter2"), true);
});

test("verifyResumePassword: mismatch refuses", () => {
  assert.equal(verifyResumePassword("hunter2", "hunter3"), false);
  assert.equal(verifyResumePassword("", "hunter2"), false);
});

test("verifyResumePassword: trims both sides — a trailing space on the env var or a copy-pasted password never locks the owner out", () => {
  assert.equal(verifyResumePassword("hunter2 ", "hunter2"), true);
  assert.equal(verifyResumePassword(" hunter2", "hunter2"), true);
  assert.equal(verifyResumePassword("hunter2", " hunter2 "), true);
});

test("verifyResumePassword: no configured password → open (dashboard access is the gate)", () => {
  assert.equal(verifyResumePassword("", undefined), true);
  assert.equal(verifyResumePassword("anything", null), true);
});
