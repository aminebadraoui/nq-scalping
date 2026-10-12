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
  CT_KEY_RE,
  CT_URL_RE,
  detectGuardResetFor,
  execOverridesFile,
  loadExecOverrides,
  maskAccount,
  maskSecret,
  resetGuardForAccountSwitch,
  resolveEffectiveAccount,
  resolveEffectiveCredentials,
  stageChangeAdvice,
  stageConsistencyWarning,
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

test("loadExecOverrides: whitelist only, non-empty valid strings only", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "exec-overrides.json"),
    JSON.stringify({
      CROSSTRADE_ACCOUNT: "  MFFUEVREOD706880007  ",
      CROSSTRADE_KEY: "this-key-is-43-characters-long-enough-1234",
      CROSSTRADE_URL: "https://app.crosstrade.io/v1/send/uid123/channel",
      CROSSTRADE_KEY_SHORT: "short",
      CROSSTRADE_URL_EVIL: "https://evil.example.com/v1/send/x/y",
      DATABASE_URL: "postgres://evil",
      NUMBER: 123,
    }),
  );
  const out = loadExecOverrides(env);
  assert.deepEqual(out, {
    CROSSTRADE_ACCOUNT: "MFFUEVREOD706880007",
    CROSSTRADE_KEY: "this-key-is-43-characters-long-enough-1234",
    CROSSTRADE_URL: "https://app.crosstrade.io/v1/send/uid123/channel",
  });
});

test("loadExecOverrides: out-of-shape key/url values are dropped (fail-safe)", (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "exec-overrides.json"),
    JSON.stringify({
      CROSSTRADE_KEY: "too-short",
      CROSSTRADE_URL: "https://evil.example.com/v1/send/x/y",
      CROSSTRADE_ACCOUNT: "OK-ACCT",
    }),
  );
  assert.deepEqual(loadExecOverrides(env), { CROSSTRADE_ACCOUNT: "OK-ACCT" });
});

test("validators: key token + host-locked webhook URL shapes", () => {
  assert.match("abc123-abc123-abc123-abc123", CT_KEY_RE);
  assert.doesNotMatch("short", CT_KEY_RE);
  assert.doesNotMatch("bad;chars!", CT_KEY_RE);
  assert.match("https://app.crosstrade.io/v1/send/uid123/channel", CT_URL_RE);
  assert.doesNotMatch("https://evil.example.com/v1/send/x/y", CT_URL_RE);
  assert.doesNotMatch("http://app.crosstrade.io/v1/send/x/y", CT_URL_RE);
});

test("maskSecret: only the tail is shown", () => {
  assert.equal(maskSecret(""), null);
  assert.equal(maskSecret("short"), "••••••");
  assert.equal(maskSecret("abcdefghijklmnop"), "••••mnop");
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
  assert.throws(() => writeExecOverride("DATABASE_URL" as never, "x", env));
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

test("resolveEffectiveCredentials: local overrides win without any fetch", async (t) => {
  const { env, dir } = tmpEnv();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(
    path.join(dir, "exec-overrides.json"),
    JSON.stringify({
      CROSSTRADE_ACCOUNT: "OVERRIDE-ACCT",
      CROSSTRADE_KEY: "override-key-abcdefghijklmnop",
      CROSSTRADE_URL: "https://app.crosstrade.io/v1/send/u/c",
    }),
  );
  const out = await resolveEffectiveCredentials({ ...env, CROSSTRADE_ACCOUNT: "ENV-ACCT", CROSSTRADE_KEY: "env-key" });
  assert.equal(out.account, "OVERRIDE-ACCT");
  assert.equal(out.key, "override-key-abcdefghijklmnop");
  assert.equal(out.url, "https://app.crosstrade.io/v1/send/u/c");
});

/* ---- same-account detection ------------------------------------------ */

function fakeFetch(
  accounts: Array<{ name: string; realizedPnl?: number; accountId?: string | number; netLiq?: number }>,
  ok = true,
): typeof fetch {
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

test("stageChangeAdvice: an SF↔EV account change forces a reset; same stage does not", () => {
  assert.equal(stageChangeAdvice("MFFUEVREOD706880007", "MFFUEVREOD706880006"), null, "eval→eval keeps");
  assert.equal(stageChangeAdvice("MFFUSFREOD706880008", "MFFUSFREOD706880009"), null, "funded→funded keeps");
  assert.equal(stageChangeAdvice("MFFUEVREOD706880007", "MFFUSFREOD706880008")?.action, "reset", "eval→funded resets");
  assert.equal(stageChangeAdvice("MFFUSFREOD706880008", "MFFUEVREOD706880009")?.action, "reset", "funded→eval resets");
  assert.match(stageChangeAdvice("MFFUEVREOD706880007", "MFFUSFREOD706880008")!.reason, /eval → funded/);
});

test("stageConsistencyWarning: the snapshot's netLiq cross-checks the name-derived stage", () => {
  assert.equal(stageConsistencyWarning({ netLiq: 76.8 }, "funded"), null, "fresh funded balance is consistent");
  assert.equal(stageConsistencyWarning({ netLiq: 5_000 }, "funded"), null, "a growing funded balance is fine");
  assert.match(stageConsistencyWarning({ netLiq: 50_000 }, "funded") ?? "", /eval starting balance/);
  assert.equal(stageConsistencyWarning({ netLiq: 50_000 }, "eval"), null, "eval starting balance is consistent");
  assert.match(stageConsistencyWarning({ netLiq: 0 }, "eval") ?? "", /funded start/);
  assert.equal(stageConsistencyWarning(undefined, "eval"), null);
  assert.equal(stageConsistencyWarning({}, "eval"), null, "missing netLiq → no opinion");
});

test("detectGuardResetFor: the Tradovate account id decides same-vs-different exactly", async () => {
  const same = await detectGuardResetFor(
    "NEW-LABEL",
    ENV,
    fakeFetch([
      { name: "OLD-ACCT", realizedPnl: 10, accountId: "69251688" },
      { name: "NEW-LABEL", realizedPnl: 10, accountId: "69251688" },
    ]),
  );
  assert.equal(same.action, "keep", "same id = same account even if names differ");
  const diff = await detectGuardResetFor(
    "NEW-ACCT",
    ENV,
    fakeFetch([
      { name: "OLD-ACCT", realizedPnl: 10, accountId: "69251688" },
      { name: "NEW-ACCT", realizedPnl: 10, accountId: "69251699" },
    ]),
  );
  assert.equal(diff.action, "reset", "different ids = different account even if realized matches");
});

test("detectGuardResetFor: a balance contradicting the name stage downgrades a continuation-keep to unverified", async () => {
  const s = guardState();
  s.dayStartRealized = 0;
  s.dayPnl = 50;
  const r = await detectGuardResetFor(
    "MFFUSFREOD706880008",
    { ...ENV, CROSSTRADE_ACCOUNT: "MFFUEVREOD706880007" },
    fakeFetch([{ name: "MFFUSFREOD706880008", realizedPnl: 50, accountId: "69251688", netLiq: 50_000 }]),
  );
  assert.equal(r.action, "unverified", "funded-named account reporting a $50k balance needs eyes");
  assert.match(r.reason, /netLiq/);
});
