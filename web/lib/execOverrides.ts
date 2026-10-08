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
export const EXEC_OVERRIDE_KEYS = ["CROSSTRADE_ACCOUNT", "CROSSTRADE_KEY", "CROSSTRADE_URL"] as const;

export type ExecOverrides = Partial<Record<(typeof EXEC_OVERRIDE_KEYS)[number], string>>;

/** per-key value shapes — a value failing its shape is DROPPED by the
 *  loader (fail-safe: the Coolify base env governs instead) */
export const ACCOUNT_NAME_RE = /^[A-Za-z0-9_.\- ]{1,64}$/;
/** CrossTrade secret keys are ~43-char alnum+dash tokens */
export const CT_KEY_RE = /^[A-Za-z0-9\-]{16,128}$/;
/** the personal webhook URL — host-locked so a typo can never route
 *  orders (or the key) to a non-CrossTrade endpoint */
export const CT_URL_RE = /^https:\/\/app\.crosstrade\.io\/[\w\-.]+[\w\-./]*$/;

const VALUE_RE: Record<(typeof EXEC_OVERRIDE_KEYS)[number], RegExp> = {
  CROSSTRADE_ACCOUNT: ACCOUNT_NAME_RE,
  CROSSTRADE_KEY: CT_KEY_RE,
  CROSSTRADE_URL: CT_URL_RE,
};

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
      if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= 256 && VALUE_RE[key].test(v.trim())) {
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

/** secret masking for display — only the tail is ever shown. */
export function maskSecret(v: string | undefined | null): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  return s.length <= 6 ? "••••••" : `••••${s.slice(-4)}`;
}

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

/* ---- same-account detection ------------------------------------------- *
 * `CROSSTRADE_ACCOUNT` is only a NAME addressing a linked Tradovate
 * account — renaming it (or pointing a different CrossTrade label at
 * the same Tradovate account) changes nothing about the underlying
 * account data. Resetting the guard in that case would re-baseline the
 * day mid-session (consistency counter + daily floor restart at the
 * current realized) — the fail-closed machinery exists to prevent
 * exactly that. So before switching, read the live snapshot and decide:
 *
 *   - the typed name is not visible under the current CrossTrade key
 *     → a different account → RESET.
 *   - the old AND new names are both visible with the SAME realized
 *     P&L → the same underlying account → KEEP.
 *   - the old name is gone (renamed in CrossTrade) and the typed
 *     account's realized P&L continues the guard's day reference
 *     (dayStartRealized + dayPnl, flat accounts don't drift) → KEEP.
 *   - otherwise: re-read once to rule out fills in flight; stable but
 *     unexplained → KEEP (fail-safe for the consistency counter) with
 *     an "unverified" note — the operator's force-reset checkbox is
 *     the tie-breaker.
 * ---------------------------------------------------------------------- */

export type GuardResetAdvice = {
  action: "reset" | "keep" | "unverified";
  reason: string;
};

const CT_SNAPSHOT_URL = "https://app.crosstrade.io/v1/api/tv/accounts/snapshot";
const SAME_ACCOUNT_TOL = 25; // $ — realized is fill-based; a flat account doesn't drift

type SnapshotAccount = { name?: string; netLiq?: number; realizedPnl?: number };

async function fetchCrossTradeAccounts(key: string, fetchFn: typeof fetch = fetch): Promise<SnapshotAccount[]> {
  const res = await fetchFn(CT_SNAPSHOT_URL, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const j = (await res.json()) as { accounts?: SnapshotAccount[] };
  return j.accounts ?? [];
}

const realized = (a: SnapshotAccount | undefined): number | null =>
  a && Number.isFinite(a.realizedPnl) ? Number(a.realizedPnl) : null;

export async function detectGuardResetFor(
  typedAccount: string,
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<GuardResetAdvice> {
  const key = (env.CROSSTRADE_KEY ?? "").trim();
  const oldName = (env.CROSSTRADE_ACCOUNT ?? "").trim();
  if (!key) return { action: "unverified", reason: "no CROSSTRADE_KEY — cannot read the account; protections kept" };
  const name = (n: string) => n.toUpperCase();

  let accounts: SnapshotAccount[];
  try {
    accounts = await fetchCrossTradeAccounts(key, fetchFn);
  } catch {
    return { action: "unverified", reason: "CrossTrade snapshot unreadable — protections kept (force-reset if this is a new account)" };
  }

  const typed = accounts.find((a) => name(a.name ?? "") === name(typedAccount));
  const typedRealized = realized(typed);
  if (typedRealized === null) {
    // not visible under THIS key — the executor wouldn't find it either
    // (crossGuard matches by name), so it must belong to a different
    // CrossTrade login → a different account.
    return { action: "reset", reason: `"${typedAccount}" not visible under the current CrossTrade key — different account` };
  }

  const old = accounts.find((a) => name(a.name ?? "") === name(oldName));
  const oldRealized = realized(old);
  if (oldRealized !== null) {
    if (oldRealized === typedRealized) {
      return { action: "keep", reason: "old and new names report the same realized P&L — same Tradovate account, protections kept" };
    }
    return { action: "reset", reason: `realized P&L ${oldRealized.toFixed(2)} → ${typedRealized.toFixed(2)} — different account` };
  }

  // the old name is gone from the list (renamed in CrossTrade): the typed
  // account must continue the guard's day reference to count as "same"
  const s = guardState();
  const expected = s.dayStartRealized + s.dayPnl;
  if (Math.abs(typedRealized - expected) <= SAME_ACCOUNT_TOL) {
    return { action: "keep", reason: "realized P&L continues the current day reference — same account under a new name, protections kept" };
  }
  // diverges from the day reference: either a fill landed since the last
  // poll (same account) or a genuinely different account. Re-read once —
  // a stable value that still doesn't explain itself is ambiguous, and
  // the safe side is to KEEP (a wrong reset undercounts the consistency
  // cap); the operator's force-reset checkbox breaks the tie.
  try {
    const again = await fetchCrossTradeAccounts(key, fetchFn);
    const againRealized = realized(again.find((a) => name(a.name ?? "") === name(typedAccount)));
    if (againRealized !== null && againRealized !== typedRealized) {
      return { action: "keep", reason: "realized P&L moving (fills in flight) — same account, protections kept" };
    }
  } catch {
    /* fall through to the conservative keep */
  }
  return {
    action: "unverified",
    reason: "realized P&L diverges from the day reference but cannot be confirmed as a new account — protections kept (check force-reset for a new account)",
  };
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

export async function resolveEffectiveCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<{ account: string; key: string; url: string }> {
  const local = loadExecOverrides(env);
  const account = local.CROSSTRADE_ACCOUNT ?? (env.CROSSTRADE_ACCOUNT ?? "").trim();
  const key = local.CROSSTRADE_KEY ?? (env.CROSSTRADE_KEY ?? "").trim();
  const url = local.CROSSTRADE_URL ?? (env.CROSSTRADE_URL ?? "").trim();
  // the dashboard's overrides win when it can confirm them (the jobs
  // container shares no volume with the dashboard process)
  const base = (env.DASHBOARD_URL || "https://nq-dashboard.31.97.138.30.sslip.io").replace(/\/+$/, "");
  const auth = key || ((env.ADMIN_PASSWORD ?? "").trim() ? (env.ADMIN_PASSWORD ?? "").trim() : "");
  if (auth) {
    try {
      const res = await fetch(`${base}/api/exec-settings?raw=1`, {
        headers: { Authorization: `Bearer ${auth}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { account?: unknown; key?: unknown; url?: unknown };
        const pick = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
        return { account: pick(j.account, account), key: pick(j.key, key), url: pick(j.url, url) };
      }
    } catch {
      /* dashboard unreachable — the container's own env/override governs */
    }
  }
  return { account, key, url };
}

export async function resolveEffectiveAccount(env: Record<string, string | undefined> = process.env): Promise<string> {
  return (await resolveEffectiveCredentials(env)).account;
}
