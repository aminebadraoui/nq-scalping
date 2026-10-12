/* ------------------------------------------------------------------ *
 * Account guard — enforces the MyFundedFutures Rapid EOD 50k account
 * limits that the executor must never cross:
 *
 *   1. End-of-Day trailing Max Loss ($2,000): the floor trails UP only at
 *      the end-of-day close, never intraday, never down. It locks at $100
 *      once reached (funded stage) — below that the account is breached.
 *   2. Profit target ($3,000 over start): reaching it = pass — stop trading.
 *   3. Consistency (+$900/day cap on EVERY stage — the same rules apply
 *      on funded, 2026-10-11): no single day's realized profit may exceed
 *      30% of the total target → $900/day cap. A $901 day breaks the rule
 *      even if every other day is tiny, so the guard halts once today's
 *      realized P&L reaches the cap.
 *   4. T1 news window ban (funded stage only) — MFF disallows T1 news
 *      trading on the Sim Funded account.
 *
 * There is NO MFF daily loss limit on this plan — the day-plan layers
 * here (daily −$250 floor, +$400 profit arm, dd600→half sizing) are OUR
 * rules, measured in docs/research/ap-full-pool-2026-10-05.md.
 *
 * Persists EOD high-water mark + the day's realized-P&L reference to a local
 * JSON file so a process restart never forgets the trailing floor or the
 * daily consistency budget. Client-safe — the account snapshot comes from
 * the CrossTrade API via lib/crossGuard.ts (crossGuardGate).
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { RAPID_EOD_50K } from "./propRules";
import { dbEnabled, getDb } from "./gcdb";
import { withTimeout } from "./asyncTimeout";
import { appendDaybook } from "./daybook";
import {
  guardConfigFromEnv,
  targetReached,
  floorMarginHalts,
  consistencyHalts,
  dailyFloorHalts,
  profitArmStep,
  givebackStep,
  ddHalfStep,
} from "./risk/guardCore";
import { rulesForStage, stageForAccountName } from "./risk/challengeRules";
import { flattenArmStep, flattenArmEnabled } from "./flattenArm";

export type GuardStage = "eval" | "funded";

export type GuardDecision =
  | { verdict: "ok"; reason: string }
  | { verdict: "halt-floor"; reason: string }
  | { verdict: "halt-target"; reason: string }
  | { verdict: "halt-consistency"; reason: string }
  | { verdict: "halt-news"; reason: string }
  | { verdict: "halt-giveback"; reason: string }
  | { verdict: "halt-daily-floor"; reason: string }
  | { verdict: "halt-profit-arm"; reason: string }
  | { verdict: "flatten"; reason: string }
  | { verdict: "halt-baseline"; reason: string }
  | { verdict: "no-data"; reason: string };

export type GuardState = {
  stage: GuardStage;
  /** the linked account name this state belongs to ("" = legacy file) */
  account: string;
  startBalance: number;
  maxLoss: number;
  profitTarget: number;
  /** eval-only consistency cap: max realized $ in one day (30% of target) */
  consistencyCap: number;
  /** funded stage only: the floor locks here once reached */
  lockAt: number;
  /** highest end-of-day close balance seen (the trailing reference) */
  highWater: number;
  /** current max-loss floor (never moves down intraday) */
  floor: number;
  /** true once the floor locked at lockAt and stopped trailing */
  locked: boolean;
  /** New York date of the last EOD close commit */
  lastCommitDay: string;
  /** New York date whose realized P&L we are currently tracking */
  dayKey: string;
  /** realized balance at the start of the current day (consistency reference) */
  dayStartRealized: number;
  /** realized P&L so far today (realized − dayStartRealized) */
  dayPnl: number;
  /** best single-day realized P&L observed (consistency audit) */
  bestDayPnl: number;
  /** today's peak realized P&L (the give-back protection reference) */
  dayPeak: number;
  /** day-plan profit arm: true once today's P&L crossed PROFIT_ARM */
  profitArmed: boolean;
  /** the last observed day P&L (the arm halts on the first LOSS after arming) */
  lastDayPnl: number | null;
  /** flatten arm (FLATTEN_AT_*): the day key on which the arm already fired
   *  ("" = never) — the once-per-day latch, persisted so a redeploy mid-day
   *  cannot flatten a second time */
  flattenFiredDay: string;
  /** day-plan drawdown halving: true while the challenge drawdown from the
   *  trailing reference is >= DD_HALF_AT (sizing halves until DD_FULL_AT) */
  ddHalved: boolean;
  /** runtime flag (not persisted semantics): false once a hydration
   *  attempt hit an unreachable DB; true after a successful round-trip.
   *  Undefined before the first attempt — the display only halts on a
   *  DEFINITE failure, never on "not tried yet". */
  dayBaselineOk?: boolean;
};

/* ── config (env overrides the Rapid EOD 50k defaults) ─────────────── */
function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

export function guardStage(): GuardStage {
  const env = process.env.MFF_STAGE;
  if (env === "funded" || env === "eval") return env; // explicit operator override
  // no override: derive from the linked account name — MFFU encodes the
  // product in the id (MFFUSFREOD… = Sim Funded · MFFUEVREOD… = Eval),
  // so a dashboard account switch adapts the rules automatically.
  return stageForAccountName(process.env.CROSSTRADE_ACCOUNT);
}

/** the linked account this guard state belongs to (the override file or
 *  the Coolify base env) — persisted with the state so a stale row/file
 *  from a previous account is recognized and ignored on hydrate. */
function currentAccountName(): string {
  return (process.env.CROSSTRADE_ACCOUNT ?? "").trim();
}

/** New York close hour (default 17 = the Globex/maintenance close) */
const EOD_HOUR = () => num(process.env.MFF_EOD_HOUR, 17);

/** a snapshot older than this is too stale for the day rollover / EOD
 *  commit — the penalty cooldown serves cached reads, and rebaselining a
 *  new session on the old session's realized would phantom the day P&L
 *  (2026-10-12: the 18:00 ET Globex rollover during vendor pacing). */
export const STALE_SNAPSHOT_MS = 60_000;

/** halt new entries once equity is within this many $ of the floor */
const GUARD_MARGIN = () => num(process.env.MFF_GUARD_MARGIN, 500);

/** eval consistency cap = 30% of the profit target (default $900). Env override. */
const CONSISTENCY_CAP = () => num(process.env.MFF_CONSISTENCY_CAP, Math.round(RAPID_EOD_50K.profitTarget * RAPID_EOD_50K.consistency));

const STATE_FILE = () => guardStateFile();

/** the guard state file lives in GC_DATA_DIR (a persistent volume on the
 *  VPS) so container REDEPLOYS keep the trailing floor + day reference —
 *  the old cwd path died with every replaced container, which silently
 *  re-baselined the day mid-session (2026-10-07 08:37 redeploy). */
export function guardStateFile(env: Record<string, string | undefined> = process.env): string {
  const data = env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
  return path.join(data, ".executor-guard.json");
}

function seed(): GuardState {
  const stage = guardStage();
  // challenge rules: the single source for the firm's per-stage numbers
  // (lib/risk/challengeRules.ts) — env overrides stay on top
  const r = rulesForStage(stage);
  const startBalance = num(process.env.MFF_START_BALANCE, r.startBalance);
  const maxLoss = num(process.env.MFF_MAX_LOSS, r.maxLoss);
  const profitTarget = num(process.env.MFF_PROFIT_TARGET, r.profitTarget);
  const lockAt = num(process.env.MFF_LOCK_AT, r.lockAt ?? 100);
  const floor = startBalance - maxLoss;
  // The $100 lock only applies to the FUNDED stage (which starts at $0 and
  // trails up). Eval starts at $50k, so its floor starts at $48k — no lock.
  const applyLock = stage === "funded";
  return {
    stage,
    account: currentAccountName(),
    startBalance,
    maxLoss,
    profitTarget,
    consistencyCap: CONSISTENCY_CAP(),
    lockAt,
    highWater: startBalance,
    floor: applyLock && floor < lockAt ? floor : floor,
    locked: applyLock ? floor >= lockAt : false,
    lastCommitDay: "",
    dayKey: "",
    dayStartRealized: 0,
    dayPnl: 0,
    bestDayPnl: 0,
    dayPeak: 0,
    profitArmed: false,
    lastDayPnl: null,
    flattenFiredDay: "",
    ddHalved: false,
  };
}

/* ── persistence ────────────────────────────────────────────────────── */
const g = globalThis as unknown as { __gcGuard?: GuardState };
function mem(): GuardState {
  if (!g.__gcGuard) g.__gcGuard = seed();
  return g.__gcGuard;
}

let restoredFromFile = false;

function load() {
  try {
    const p = STATE_FILE();
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8")) as Partial<GuardState>;
      // a file from a DIFFERENT account (e.g. an account switch whose
      // reset's file delete failed) is stale — ignore it and start from
      // the fresh seed so the new account never inherits the old one's
      // floor/high-water/day reference.
      if (j.account && j.account !== currentAccountName()) return;
      const s = seed();
      g.__gcGuard = { ...s, ...j };
      restoredFromFile = true;
    }
  } catch {
    /* corrupt/absent state — fall back to a fresh seed */
  }
}
load();

/** did the in-memory state come from a persisted file at boot? The entry
 *  gate uses this to refuse a silent mid-day re-baseline when BOTH the DB
 *  and the file are gone (fail closed — the consistency counter is the
 *  thing being protected). */
export function guardRestoredFromFile(): boolean {
  return restoredFromFile;
}

function save() {
  try {
    writeFileSync(STATE_FILE(), JSON.stringify(mem(), null, 2));
  } catch {
    /* best-effort — the in-memory state still governs */
  }
  // daybook hook: protection-state events (rollover, arm, dd flag) become
  // answerable from the journal — "was the day-P&L protection blind?"
  try {
    const s = mem();
    appendDaybook({
      t: "guard",
      at: Date.now(),
      dayKey: s.dayKey,
      dayPnl: Math.round(s.dayPnl * 100) / 100,
      dayPeak: Math.round(s.dayPeak * 100) / 100,
      dayStartRealized: Math.round(s.dayStartRealized * 100) / 100,
      bestDayPnl: Math.round(s.bestDayPnl * 100) / 100,
      profitArmed: s.profitArmed,
      lastDayPnl: s.lastDayPnl === null ? null : Math.round(s.lastDayPnl * 100) / 100,
      floor: Math.round(s.floor * 100) / 100,
      locked: s.locked,
      stage: s.stage,
    });
  } catch {
    /* journaling is best-effort */
  }
  void persistGuardToDb(mem());
}

/* ── Neon persistence — the guard state survives container redeploys ── */
const GUARD_DB_SQL = `
create table if not exists guard_state (
  id int primary key default 1,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
`;

/** best-effort upsert of the guard state (fire-and-forget) */
export async function persistGuardToDb(state: GuardState): Promise<void> {
  if (!dbEnabled()) return;
  try {
    await getDb().unsafe(GUARD_DB_SQL);
    await getDb()`
      insert into guard_state (id, state, updated_at)
      values (1, ${JSON.stringify(state)}, now())
      on conflict (id) do update set state = excluded.state, updated_at = now()`;
  } catch {
    /* best-effort — the file + memory still govern */
  }
}

/** Pick the restorable fields from a persisted row. Returns NULL when the
 *  row belongs to a DIFFERENT account than the one currently configured —
 *  a stale row (a switch whose reset's DB delete failed, or a redeploy
 *  after a dashboard account change) must never leak the old account's
 *  floor, high-water, stage or day reference into the new guard.
 *  Only TRAILING/day state is restorable: the derived rule fields
 *  (stage, startBalance, maxLoss, profitTarget, consistencyCap, lockAt)
 *  always come from the current env + account at seed time. */
export function hydrateFieldsFrom(db: Partial<GuardState>, currentAccount: string): Partial<GuardState> | null {
  if (db.account && db.account !== currentAccount) return null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const out: Partial<GuardState> = {};
  if (db.highWater !== undefined) out.highWater = num(db.highWater, 0);
  if (db.floor !== undefined) out.floor = num(db.floor, 0);
  if (db.locked !== undefined) out.locked = db.locked === true;
  if (db.lastCommitDay) out.lastCommitDay = String(db.lastCommitDay);
  if (db.dayKey) {
    out.dayKey = String(db.dayKey);
    out.dayStartRealized = num(db.dayStartRealized, 0);
  }
  if (db.bestDayPnl !== undefined) out.bestDayPnl = num(db.bestDayPnl, 0);
  if (db.dayPeak !== undefined) out.dayPeak = num(db.dayPeak, 0);
  if (db.profitArmed !== undefined) out.profitArmed = db.profitArmed === true;
  if (db.lastDayPnl !== undefined && db.lastDayPnl !== null) out.lastDayPnl = num(db.lastDayPnl, 0);
  if (db.ddHalved !== undefined) out.ddHalved = db.ddHalved === true;
  return out;
}

/** restore the persisted state after a restart (called by crossGuard
 *  before the first gate check). Floor/high-water take the MAX of the
 *  persisted and the freshly bootstrapped values; the day reference is
 *  restored only when it still matches (preserves the $900 counter).
 *  Returns TRUE when the DB round-trip succeeded (row applied, a fresh
 *  account with no row yet, or a stale row for another account that was
 *  correctly ignored) and FALSE when the DB was configured but
 *  unreachable — the caller treats a FALSE mid-day (realized ≠ 0)
 *  as a fail-closed halt instead of silently re-baselining the day.
 *
 *  SHORT-TTL LATCH (2026-10-12): the in-memory guard state is
 *  authoritative between reads — the DB round-trip exists only to sync
 *  a redeploy. Re-querying on EVERY placement put two Neon statements
 *  between detection and the order POST; the result is now latched for
 *  HYDRATE_TTL_MS (a latched failure keeps failing closed — a DB blip
 *  can never soften the gate). `force` re-reads (boot warm). */
const HYDRATE_TTL_MS = 10_000;
const HYDRATE_TIMEOUT_MS = 5_000;
let hydrateLatch: { at: number; ok: boolean } | null = null;

export function __resetHydrateLatchForTest(): void {
  hydrateLatch = null;
}

export async function hydrateGuardFromDb(opts?: { force?: boolean; timeoutMs?: number }): Promise<boolean> {
  if (!dbEnabled()) return true;
  if (!opts?.force && hydrateLatch && Date.now() - hydrateLatch.at < HYDRATE_TTL_MS) return hydrateLatch.ok;
  try {
    const ok = await withTimeout(
      (async () => {
        await getDb().unsafe(GUARD_DB_SQL);
        const rows = (await getDb()`select state from guard_state where id = 1`) as unknown as Array<{
          state: unknown;
        }>;
        if (!rows.length) {
          mem().dayBaselineOk = true; // fresh account — an empty baseline is legitimate
          return true;
        }
        const raw = rows[0].state;
        const db = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<GuardState>;
        const s = mem();
        const h = hydrateFieldsFrom(db, currentAccountName());
        if (h === null) {
          // another account's row — ignore it wholesale (see hydrateFieldsFrom)
          mem().dayBaselineOk = true;
          return true;
        }
        s.highWater = Math.max(Number(h.highWater ?? 0), s.highWater);
        s.floor = Math.max(Number(h.floor ?? 0), s.floor);
        if (h.locked !== undefined) s.locked = h.locked;
        if (h.lastCommitDay) s.lastCommitDay = h.lastCommitDay;
        if (h.dayKey) {
          s.dayKey = h.dayKey;
          s.dayStartRealized = Number(h.dayStartRealized ?? 0);
        }
        s.bestDayPnl = Math.max(Number(h.bestDayPnl ?? 0), s.bestDayPnl);
        s.dayPeak = Math.max(Number(h.dayPeak ?? 0), s.dayPeak);
        if (h.profitArmed !== undefined) s.profitArmed = h.profitArmed;
        if (h.lastDayPnl !== undefined && h.lastDayPnl !== null) s.lastDayPnl = Number(h.lastDayPnl);
        if (h.ddHalved !== undefined) s.ddHalved = h.ddHalved;
        s.dayPnl = 0; // recomputed by guardCheck from dayStartRealized
        s.dayBaselineOk = true;
        return true;
      })(),
      opts?.timeoutMs ?? HYDRATE_TIMEOUT_MS,
      "guard hydration",
    );
    hydrateLatch = { at: Date.now(), ok };
    return ok;
  } catch {
    // best-effort — the bootstrapped state still governs; the caller
    // decides whether a missing day baseline is safe. Latched FALSE keeps
    // the fail-closed posture for HYDRATE_TTL_MS (a timed-out DB must not
    // flip to "hydrated" on the next call inside the same dispatch).
    mem().dayBaselineOk = false;
    hydrateLatch = { at: Date.now(), ok: false };
    return false;
  }
}

/* ── EOD clock helpers (America/New_York) ───────────────────────────── */
/** the trading-day key: sessions start at the Globex open (18:00 ET).
 *  Before 18:00 the day belongs to YESTERDAY's session date — a 01:00
 *  card and a 22:00 card are the SAME trading day. */
export function tradingDayKey(now = new Date()): string {
  const p = nyParts(now);
  if (p.minute >= 18 * 60) return p.date;
  const prev = new Date(now.getTime() - 24 * 3_600_000);
  return nyParts(prev).date;
}

function nyParts(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** T1 news windows (funded only): comma-separated "YYYY-MM-DD HH:mm" ET.
 *  Each blocks ±3 minutes around the release. Empty = no news block. */
function inNewsWindow(now = new Date()): boolean {
  const raw = process.env.MFF_T1_NEWS;
  if (!raw) return false;
  const p = nyParts(now);
  for (const item of raw.split(",")) {
    const m = item.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
    if (!m) continue;
    if (m[1] !== p.date) continue;
    const [h, mn] = m[2].split(":").map(Number);
    const relMin = h * 60 + mn;
    const dist = Math.abs(p.minute - relMin);
    if (dist <= 3) return true;
  }
  return false;
}

/* ── the guard ──────────────────────────────────────────────────────── */

/** Roll the consistency day forward when the NY calendar date changes: record
 *  the previous day's realized P&L for the audit, then reset the reference to
 *  the current realized balance (the account is flat at the session boundary,
 *  so realized is the day-open baseline). */
function maybeRolloverDay(state: GuardState, realized: number, now = new Date()) {
  const dayKey = tradingDayKey(now);
  if (state.dayKey === dayKey) return;
  if (state.dayKey !== "" && state.dayPnl > state.bestDayPnl) {
    state.bestDayPnl = state.dayPnl;
  }
  state.dayKey = dayKey;
  state.dayStartRealized = realized;
  state.dayPnl = 0;
  state.dayPeak = 0; // the give-back reference belongs to the new day only
  state.profitArmed = false; // the profit arm re-arms each day from zero
  state.lastDayPnl = null;
  save(); // the day reference must survive a restart (consistency counter)
}

/** Commit the end-of-day close once per New York trading day: at/after the
 *  EOD hour, the floor trails up to (equity − maxLoss), and locks at lockAt. */
function maybeCommitEod(state: GuardState, equity: number, now = new Date()) {
  const p = nyParts(now);
  if (p.minute < EOD_HOUR() * 60) return; // not the close yet
  if (state.lastCommitDay === p.date) return; // already committed today
  state.lastCommitDay = p.date;

  // floor = equity − maxLoss, trailing UP only. Funded locks at $100 and never
  // moves after; eval just trails (starts at $48k, never near the lock).
  if (state.stage === "funded" && !state.locked) {
    const candidate = equity - state.maxLoss;
    if (candidate >= state.lockAt) {
      state.floor = state.lockAt;
      state.locked = true;
    } else if (candidate > state.floor) {
      state.floor = candidate;
    }
  } else if (state.stage === "eval") {
    const candidate = equity - state.maxLoss;
    if (candidate > state.floor) state.floor = candidate;
  }
  if (equity > state.highWater) state.highWater = equity;
  save();
}

/** The single entry point: feed it the current account snapshot (from the
 *  CrossTrade API via lib/crossGuard.ts) each poll; it returns whether the
 *  executor may open a new trade right now.
 *
 *  2026-10-12 — stale-snapshot fail-closed: `asOf` is the snapshot's read
 *  time. A snapshot older than STALE_SNAPSHOT_MS (the penalty cooldown
 *  serves cached reads) is treated as unreadable — the day rollover and
 *  the EOD floor commit must NEVER rebaseline on stale data (the 18:00 ET
 *  Globex rollover during a vendor pacing window would otherwise baseline
 *  the new day on the old session's realized, phantom-ing the day P&L).
 *  Snapshots without `asOf` (replay/tests) are never stale.
 *
 *  The day-plan RULES are pure predicates in lib/risk/guardCore.ts — this
 *  function only sequences them over the live state (architecture review
 *  P1: live and replay can no longer drift). */
export function guardCheck(
  snap: { equity: number; realized: number; openPnl?: number; asOf?: number } | null,
  now = new Date(),
): GuardDecision {
  const s = mem();
  const isNews = inNewsWindow(now);
  const cfg = guardConfigFromEnv();

  if (snap === null || !Number.isFinite(snap.equity) || !Number.isFinite(snap.realized)) {
    return { verdict: "no-data", reason: "account equity unreadable — halting" };
  }
  const { equity, realized } = snap;
  if (snap.asOf !== undefined && Number.isFinite(snap.asOf) && now.getTime() - snap.asOf > STALE_SNAPSHOT_MS) {
    const ageS = Math.round((now.getTime() - snap.asOf) / 1000);
    return {
      verdict: "no-data",
      reason: `snapshot stale (${ageS}s old — vendor pacing/poll pause) — deferring day rollover and verdicts until a fresh read`,
    };
  }

  // consistency day rollover (calendar date) + today's realized P&L
  maybeRolloverDay(s, realized, now);
  s.dayPnl = realized - s.dayStartRealized;
  maybeCommitEod(s, equity, now);

  // profit target: reached = pass — stop (eval: start+target; funded: target from 0)
  const targetPx = s.stage === "funded" ? s.profitTarget : s.startBalance + s.profitTarget;
  const targetHit = s.stage === "funded" ? targetReached(equity, s.profitTarget) : targetReached(equity - s.startBalance, s.profitTarget);
  if (targetHit) {
    return {
      verdict: "halt-target",
      reason: `equity $${equity.toFixed(0)} ≥ target $${targetPx.toFixed(0)} — target reached, stop`,
    };
  }

  // flatten arm (FLATTEN_AT_PROFIT / FLATTEN_AT_LOSS, both 0 = off): when
  // the day's LIVE P&L (realized + open) crosses either side, the account
  // is CLOSED at market instead of only halting new entries — the halt
  // semantics let the open bracket run, which is why the realized worst
  // day can overshoot the floor (measured 2026-10-12: −$339 at −$250).
  // Once-per-day latch; the ACTION lives in lib/crossGuard.ts + lib/
  // crossTrade.ts (flattenArmFire) — this verdict is the pure decision.
  if (flattenArmEnabled(cfg)) {
    const arm = flattenArmStep(cfg, s.dayPnl, snap.openPnl, s.flattenFiredDay, s.dayKey);
    if (arm.fire !== "none") {
      s.flattenFiredDay = s.dayKey;
      save();
      return { verdict: "flatten", reason: `${arm.reason} (was $${s.dayPnl.toFixed(0)} realized + $${(Number.isFinite(snap.openPnl) ? (snap.openPnl as number) : 0).toFixed(0)} open)` };
    }
  }

  // EOD floor: never let a new trade risk crossing it
  if (floorMarginHalts(equity, s.floor, cfg.guardMargin)) {
    return {
      verdict: "halt-floor",
      reason: `equity $${equity.toFixed(0)} within $${cfg.guardMargin} of floor $${s.floor.toFixed(0)} — halt (${s.locked ? "locked" : "trailing"})`,
    };
  }

  // consistency (+$900/day, every stage — the same rules apply on funded):
  // a single day over 30% of target fails the eval no matter what other
  // days do, so the guard halts once today's realized P&L reaches the cap
  if (consistencyHalts(s.dayPnl, s.consistencyCap)) {
    return {
      verdict: "halt-consistency",
      reason: `today's realized P&L $${s.dayPnl.toFixed(0)} ≥ consistency cap $${s.consistencyCap} — stop for the day`,
    };
  }

  // daily loss floor (the day plan's −$250 stop; env DAILY_LOSS_FLOOR
  // overrides, 0 = off): the give-back guard only protects GREEN days
  // (it needs a peak above its floor) — a red day bleeds with no
  // intraday floor. The 2026-10-04/05 session (−$1,405) motivated it;
  // the apPlan sweep (2026-10-05) made −$250 the measured default.
  if (dailyFloorHalts(s.dayPnl, cfg.dailyFloor)) {
    return {
      verdict: "halt-daily-floor",
      reason: `day P&L $${s.dayPnl.toFixed(0)} ≤ −$${cfg.dailyFloor.toFixed(0)} (DAILY_LOSS_FLOOR) — halt new entries for the day`,
    };
  }

  // day-plan profit arm (+$400): once today's P&L crosses the arm, ONE
  // more trade is allowed — a win grants another, the FIRST loss after
  // arming ends the day (apPlan full-pool study 2026-10-05). Realized P&L
  // only moves on fills, so a drop = a losing close (one position at a time).
  if (cfg.profitArm > 0) {
    const wasArmed = s.profitArmed;
    const pa = profitArmStep(s.profitArmed, s.lastDayPnl, s.dayPnl, cfg.profitArm);
    s.profitArmed = pa.armed;
    if (!wasArmed && pa.armed) save();
    if (pa.halt) {
      return {
        verdict: "halt-profit-arm",
        reason:
          `day P&L $${s.dayPnl.toFixed(0)} — first loss after arming at +$${cfg.profitArm.toFixed(0)} (peak since arm $${s.lastDayPnl!.toFixed(0)}) — stop for the day`,
      };
    }
    s.lastDayPnl = pa.lastDayPnl;
  }

  // give-back protection: halt new entries once today's P&L has given back
  // more than max(floor, pct × dayPeak) from the day's peak — the 648-session
  // replay found pct 0.5 / floor $250 keeps 90% of total profit while cutting
  // the worst day from −$742 to −$496 (see docs/research/daily-giveback-protection-2026-10-02.md).
  const gb = givebackStep(s.dayPeak, s.dayPnl, cfg.givebackPct, cfg.givebackFloor);
  s.dayPeak = gb.dayPeak;
  if (gb.halt) {
    return {
      verdict: "halt-giveback",
      reason:
        `day P&L $${s.dayPnl.toFixed(0)} gave back $${(s.dayPeak - s.dayPnl).toFixed(0)} from peak $${s.dayPeak.toFixed(0)} ` +
        `(limit $${gb.limit.toFixed(0)}) — halt new entries for the day`,
    };
  }

  if (s.stage === "funded" && isNews) {
    return { verdict: "halt-news", reason: "T1 news window — no trading on funded (MFF rule)" };
  }

  // day-plan drawdown halving (dd600→half): while the challenge drawdown
  // from the trailing reference is >= DD_HALF_AT, sizing halves (crossGuard
  // reads this flag); restored at DD_FULL_AT (hysteresis). DD_HALF_AT=0 off.
  const dd = Math.max(0, s.highWater - equity);
  const nextHalved = ddHalfStep(s.ddHalved, dd, cfg.ddHi, cfg.ddLo);
  if (nextHalved !== s.ddHalved) {
    s.ddHalved = nextHalved;
    save();
  }

  return {
    verdict: "ok",
    reason: `equity $${equity.toFixed(0)} · floor $${s.floor.toFixed(0)} · day P/L $${s.dayPnl.toFixed(0)} · target $${targetPx.toFixed(0)}`,
  };
}

/** current state (for logging / diagnostics) */
export function guardState(): GuardState {
  return mem();
}

/** TEST ONLY: reset to a fresh seed. */
export function __resetGuardForTest(): void {
  g.__gcGuard = seed();
  save();
}
