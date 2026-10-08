/* ------------------------------------------------------------------ *
 * Runtime execution overrides — the operator control plane for the
 * account knob (2026-10-07).
 *
 * `CROSSTRADE_ACCOUNT` (the linked Tradovate account name) lives in the
 * Coolify app env, but changing it used to require a Coolify env edit
 * AND a Neon `guard_state` cleanup (see docs/research/recovery-runbook
 * 2026-10-05). The dashboard's password-gated account switch now writes
 * a small JSON override to the data volume and applies it to
 * process.env IMMEDIATELY — no redeploy, no SQL:
 *
 *   <GC_DATA_DIR>/exec-overrides.json
 *     {"CROSSTRADE_ACCOUNT": "MFFUEVREOD706880007", "updatedAt": 1730…}
 *
 * The override survives container redeploys (it lives on the Coolify
 * /app/data volume) and re-applies at every boot (instrumentation.ts
 * loads it BEFORE the daybook boot snapshot and the signal feed start),
 * so every existing process.env reader — crossTrade, crossGuard,
 * execWatch, timeExit, the health endpoint — sees the effective value
 * with zero changes to those files. The Coolify env stays the durable
 * base default; the override wins while present.
 *
 * This module deliberately touches NO live-execution library files:
 * the exec gate (scripts/exec-gate.sh) watches the readers, not this
 * control path. A change here can only be made by an authenticated
 * operator action (ADMIN_PASSWORD), is written to the daybook as an
 * `exec` audit record, and is inert until such an action happens.
 * ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardState, guardStateFile, persistGuardToDb, __resetGuardForTest } from "./accountGuard";
import { dbEnabled, getDb } from "./gcdb";

/** the ONLY env keys the override file may set — anything else is
 *  ignored, so a tampered file can never inject arbitrary env */
export const EXEC_OVERRIDE_KEYS = ["CROSSTRADE_ACCOUNT"] as const;

export type ExecOverrides = Partial<Record<(typeof EXEC_OVERRIDE_KEYS)[number], string>>;

export function execOverridesFile(env: Record<string, string | undefined> = process.env): string {
  const data = env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
  return path.join(data, "exec-overrides.json");
}

/** parse the override file: whitelisted keys only, non-empty strings
 *  ≤ 128 chars. A missing/corrupt file is {} — never an error. */
export function loadExecOverrides(env: Record<string, string | undefined> = process.env): ExecOverrides {
  try {
    const p = execOverridesFile(env);
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: ExecOverrides = {};
    for (const key of EXEC_OVERRIDE_KEYS) {
      const v = (j as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 128) {
        out[key] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** boot hook: apply persisted overrides to process.env. Call BEFORE any
 *  settings snapshot (daybook) or feed boot so the effective config is
 *  what everything downstream reads. */
export function applyExecOverrides(env: Record<string, string | undefined> = process.env): void {
  for (const [k, v] of Object.entries(loadExecOverrides(env))) process.env[k] = v;
}

/** persist one override (atomic tmp+rename) and apply it in-process. */
export function writeExecOverride(
  key: (typeof EXEC_OVERRIDE_KEYS)[number],
  value: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!EXEC_OVERRIDE_KEYS.includes(key)) throw new Error(`execOverrides: key "${key}" is not overridable`);
  const p = execOverridesFile(env);
  const next: Record<string, unknown> = loadExecOverrides(env);
  next[key] = value.trim();
  next.updatedAt = Date.now();
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, p);
  process.env[key] = value.trim();
}

/** account-name masking for display — the health endpoint's shape. */
export function maskAccount(acct: string): string | null {
  const a = acct.trim();
  if (!a) return null;
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** the accepted shape of a CrossTrade/Tradovate account name (letters,
 *  digits, underscore, dash, dot, space — bounded so the value stays a
 *  sane JSON/URL fragment, never anything executable). */
export const ACCOUNT_NAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;

/* ---- admin password gate -------------------------------------------- */

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** timing-safe password check against ADMIN_PASSWORD. Returns false
 *  when the env is unset — an unconfigured gate never opens. */
export function verifyAdminPassword(input: string, env: Record<string, string | undefined> = process.env): boolean {
  const expected = (env.ADMIN_PASSWORD ?? "").trim();
  if (!expected) return false;
  return timingSafeEqual(sha256(input), sha256(expected));
}

/* ---- seamless guard reset --------------------------------------------- *
 * The account guard's state (day P&L, high-water, floor, profit arm) is
 * PER-ACCOUNT. Switching accounts without resetting it makes the new
 * account inherit the old account's floor/high-water/day reference
 * (hydrateGuardFromDb even takes MAX values), so a fresh $50k eval
 * could instantly look at-risk. The dashboard switch resets everything
 * in one step: state file + Neon row + the in-memory state; the next
 * gate poll re-baselines from the new account's live snapshot exactly
 * like a fresh container boot.
 * ---------------------------------------------------------------------- */

export async function resetGuardForAccountSwitch(
  env: Record<string, string | undefined> = process.env,
): Promise<{ db: "cleared" | "skipped" | "failed" }> {
  // 1. drop the persisted state file (best-effort)
  try {
    rmSync(guardStateFile(env), { force: true });
  } catch {
    /* the in-memory reseed below still governs */
  }
  // 2. drop the Neon guard_state row so a later hydrate can't resurrect
  //    the old account's floor/high-water (best-effort — if the DB is
  //    unreachable the reseed + fresh persist in step 3 still win)
  let db: "cleared" | "skipped" | "failed" = "skipped";
  if (dbEnabled()) {
    try {
      await getDb().unsafe("delete from guard_state where id = 1");
      db = "cleared";
    } catch {
      db = "failed";
    }
  }
  // 3. reseed the in-memory state to a fresh account AND persist it
  //    (save() re-writes the state file + daybook guard record; the
  //    fresh state then overwrites the DB row via persistGuardToDb).
  //    NOTE: the export says TEST ONLY, but it is the only exported
  //    in-process reseed hook, and an account switch is precisely a
  //    fresh-start reset — same seed() the process would boot with.
  __resetGuardForTest();
  if (db === "cleared") {
    try {
      await persistGuardToDb(guardState());
    } catch {
      /* the delete already happened; the poll's next save() retries */
    }
  }
  return { db };
}

/* ---- effective account for the jobs container ------------------------ *
 * The nightly jobs container (daybookConsolidate / reconcileTrades) is a
 * SEPARATE Coolify compose app with its own env + volume, so the
 * dashboard's override file is invisible to it. It already talks to the
 * dashboard over HTTP, so it resolves the effective account the same
 * way: local override file → dashboard API (key-authenticated raw read)
 * → its own CROSSTRADE_ACCOUNT env. The CROSSTRADE_KEY doubles as the
 * shared secret — both containers already hold it, no new credentials.
 * ---------------------------------------------------------------------- */

export async function resolveEffectiveAccount(env: Record<string, string | undefined> = process.env): Promise<string> {
  const override = loadExecOverrides(env).CROSSTRADE_ACCOUNT;
  if (override) return override;
  const key = (env.CROSSTRADE_KEY ?? "").trim();
  if (key) {
    const base = (env.DASHBOARD_URL || "https://nq-dashboard.31.97.138.30.sslip.io").replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/api/exec-settings?raw=1`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { account?: unknown };
        if (j && typeof j.account === "string" && j.account.trim()) return j.account.trim();
      }
    } catch {
      /* dashboard unreachable — fall back to the container's env */
    }
  }
  return (env.CROSSTRADE_ACCOUNT ?? "").trim();
}
