/* Unit tests for lib/execOverrides.ts — the runtime override control
 * plane: file load/apply/write round-trip, masking, the account-name
 * shape gate, the admin-password check, the seamless guard reset, and
 * the jobs-container effective-account resolution. */

import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACCOUNT_NAME_RE,
  applyExecOverrides,
  detectGuardResetFor,
  execOverridesFile,
  loadExecOverrides,
  maskAccount,
  resetGuardForAccountSwitch,
  resolveEffectiveAccount,
  verifyAdminPassword,
  writeExecOverride,
} from "../lib/execOverrides";
import { guardState } from "../lib/accountGuard";

function tmpEnv(): { env: Record<string, string | undefined>; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "execov-"));
  return { env: { GC_DATA_DIR: dir }, dir };
}

test("loadExecOverrides: missing / corrupt / non-object files → {}", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.deepEqual(loadExecOverrides(env), {});
  writeFileSync(path.join(dir, "exec-overrides.json"), "{not json");
  assert.deepEqual(loadExecOverrides(env), {});
  writeFileSync(path.join(dir, "exec-overrides.json"), JSON.stringify([1, 2]));
  assert.deepEqual(loadExecOverrides(env), {});
});

test("loadExecOverrides: whitelist only, non-empty strings only", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "exec-overrides.json"),
    JSON.stringify({
      CROSSTRADE_ACCOUNT: "  MFFUEVREOD706880007  ",
      CROSSTRADE_KEY: "evil",
      DATABASE_URL: "postgres://evil",
      CROSSTRADE_ACCOUNT2: "",
      NUMBER: 123,
    }),
  );
  const out = loadExecOverrides(env);
  assert.deepEqual(out, { CROSSTRADE_ACCOUNT: "MFFUEVREOD706880007" });
});

test("writeExecOverride + load round-trip, and it applies to process.env", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.CROSSTRADE_ACCOUNT;
  t.after(() => {
    if (prev === undefined) delete process.env.CROSSTRADE_ACCOUNT;
    else process.env.CROSSTRADE_ACCOUNT = prev;
  });

  writeExecOverride("CROSSTRADE_ACCOUNT", "MFFUEVREOD706880008", env);
  assert.equal(loadExecOverrides(env).CROSSTRADE_ACCOUNT, "MFFUEVREOD706880008");
  assert.equal(process.env.CROSSTRADE_ACCOUNT, "MFFUEVREOD706880008");
  const raw = JSON.parse(readFileSync(execOverridesFile(env), "utf8")) as Record<string, unknown>;
  assert.equal(raw.CROSSTRADE_ACCOUNT, "MFFUEVREOD706880008");
  assert.equal(typeof raw.updatedAt, "number");

  // non-whitelisted keys are refused loudly
  assert.throws(() => writeExecOverride("CROSSTRADE_KEY" as never, "x", env));
});

test("applyExecOverrides: boot hook merges the file into process.env", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.CROSSTRADE_ACCOUNT;
  t.after(() => {
    if (prev === undefined) delete process.env.CROSSTRADE_ACCOUNT;
    else process.env.CROSSTRADE_ACCOUNT = prev;
  });

  writeFileSync(path.join(dir, "exec-overrides.json"), JSON.stringify({ CROSSTRADE_ACCOUNT: "OVERRIDE-ACCT" }));
  applyExecOverrides(env);
  assert.equal(process.env.CROSSTRADE_ACCOUNT, "OVERRIDE-ACCT");
});

test("maskAccount: short passthrough, long first4…last4, empty → null", () => {
  assert.equal(maskAccount(""), null);
  assert.equal(maskAccount("AB12"), "AB12");
  assert.equal(maskAccount("MFFUEVREOD706880007"), "MFFU…0007");
});

test("ACCOUNT_NAME_RE: the accepted account-name shape", () => {
  assert.match("MFFUEVREOD706880007", ACCOUNT_NAME_RE);
  assert.match("My Account 42.x", ACCOUNT_NAME_RE);
  assert.doesNotMatch("bad;semicolon", ACCOUNT_NAME_RE);
  assert.doesNotMatch("bad/slash", ACCOUNT_NAME_RE);
  assert.doesNotMatch("x".repeat(65), ACCOUNT_NAME_RE);
});

test("verifyAdminPassword: unset gate never opens; wrong refuses; right opens", () => {
  assert.equal(verifyAdminPassword("anything", {}), false);
  const env = { ADMIN_PASSWORD: "correct horse" };
  assert.equal(verifyAdminPassword("wrong", env), false);
  assert.equal(verifyAdminPassword("correct horse", env), true);
});

test("resetGuardForAccountSwitch: fresh guard state + state file + no DB", async (t) => {
  const { dir } = tmpEnv();
  const prevDir = process.env.GC_DATA_DIR;
  const prevDb = process.env.DATABASE_URL;
  process.env.GC_DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.GC_DATA_DIR;
    else process.env.GC_DATA_DIR = prevDir;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
  });

  const res = await resetGuardForAccountSwitch();
  assert.equal(res.db, "skipped"); // no DATABASE_URL in the test env

  const s = guardState();
  assert.equal(s.startBalance, 50_000); // fresh eval seed
  assert.equal(s.floor, 48_000);
  assert.equal(s.highWater, 50_000);
  assert.equal(s.dayPnl, 0);
  assert.equal(s.profitArmed, false);
  assert.equal(s.ddHalved, false);
  // the reseed persisted a fresh state file (re-baseline source on restart)
  assert.ok(existsSync(path.join(dir, ".executor-guard.json")));
});

test("resolveEffectiveAccount: local override file wins without any fetch", async (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(path.join(dir, "exec-overrides.json"), JSON.stringify({ CROSSTRADE_ACCOUNT: "OVERRIDE-ACCT" }));
  const out = await resolveEffectiveAccount({ ...env, CROSSTRADE_ACCOUNT: "ENV-ACCT" });
  assert.equal(out, "OVERRIDE-ACCT");
});

test("resolveEffectiveAccount: env fallback when no override and no key", async (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = await resolveEffectiveAccount({ ...env, CROSSTRADE_ACCOUNT: "ENV-ACCT" });
  assert.equal(out, "ENV-ACCT");
});

/* ---- same-account detection ------------------------------------------ */

function fakeFetch(accounts: Array<{ name: string; realizedPnl?: number }>, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => ({ accounts }) })) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

const ENV = { CROSSTRADE_KEY: "test-key", CROSSTRADE_ACCOUNT: "OLD-ACCT" };

test("detectGuardResetFor: no key → unverified", async () => {
  const r = await detectGuardResetFor("NEW", {}, fakeFetch([]));
  assert.equal(r.action, "unverified");
});

test("detectGuardResetFor: snapshot unreadable → unverified", async () => {
  const r = await detectGuardResetFor("NEW", ENV, throwingFetch());
  assert.equal(r.action, "unverified");
});

test("detectGuardResetFor: typed name not visible under this key → reset", async () => {
  const r = await detectGuardResetFor("NOT-LINKED", ENV, fakeFetch([{ name: "OLD-ACCT", realizedPnl: 100 }]));
  assert.equal(r.action, "reset");
});

test("detectGuardResetFor: old + new names report the same realized → keep", async () => {
  const r = await detectGuardResetFor(
    "NEW-LABEL",
    ENV,
    fakeFetch([
      { name: "OLD-ACCT", realizedPnl: 123.45 },
      { name: "NEW-LABEL", realizedPnl: 123.45 },
    ]),
  );
  assert.equal(r.action, "keep");
});

test("detectGuardResetFor: different realized between names → reset", async () => {
  const r = await detectGuardResetFor(
    "NEW-ACCT",
    ENV,
    fakeFetch([
      { name: "OLD-ACCT", realizedPnl: -500 },
      { name: "NEW-ACCT", realizedPnl: 0 },
    ]),
  );
  assert.equal(r.action, "reset");
});

test("detectGuardResetFor: renamed account continues the day reference → keep", async () => {
  const s = guardState();
  s.dayStartRealized = 100;
  s.dayPnl = 50;
  const r = await detectGuardResetFor("RENAMED", ENV, fakeFetch([{ name: "RENAMED", realizedPnl: 150 }]));
  assert.equal(r.action, "keep");
});

test("detectGuardResetFor: stable divergence from the day reference → unverified (conservative)", async () => {
  const s = guardState();
  s.dayStartRealized = 100;
  s.dayPnl = 50;
  const r = await detectGuardResetFor("RENAMED", ENV, fakeFetch([{ name: "RENAMED", realizedPnl: 0 }]));
  assert.equal(r.action, "unverified");
});

test("detectGuardResetFor: realized moving between reads → keep (fills in flight)", async () => {
  const s = guardState();
  s.dayStartRealized = 100;
  s.dayPnl = 50;
  let n = 0;
  const moving = (async () => ({
    ok: true,
    json: async () => ({ accounts: [{ name: "RENAMED", realizedPnl: n++ === 0 ? 0 : 900 }] }),
  })) as unknown as typeof fetch;
  const r = await detectGuardResetFor("RENAMED", ENV, moving);
  assert.equal(r.action, "keep");
});
