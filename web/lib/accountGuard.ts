/* ------------------------------------------------------------------ *
 * Account guard — enforces the MyFundedFutures Rapid EOD 50k account
 * limits that the executor must never cross:
 *
 *   1. End-of-Day trailing Max Loss ($2,000): the floor trails UP only at
 *      the end-of-day close, never intraday, never down. It locks at $100
 *      once reached (funded stage) — below that the account is breached.
 *   2. Profit target ($3,000 over start): reaching it = pass — stop trading.
 *   3. Consistency (eval only): no single day's realized profit may exceed
 *      30% of the total target → $900/day cap. A $901 day breaks the rule
 *      even if every other day is tiny, so the guard halts once today's
 *      realized P&L reaches the cap.
 *   4. T1 news window ban (funded stage only) — MFF disallows T1 news
 *      trading on the Sim Funded account.
 *
 * There is NO daily loss limit on this plan (correctly not enforced here).
 *
 * Persists EOD high-water mark + the day's realized-P&L reference to a local
 * JSON file so a process restart never forgets the trailing floor or the
 * daily consistency budget. Client-safe (no Playwright import) — the
 * page-reading lives in lib/executor.ts (readAccount).
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { RAPID_EOD_50K } from "./propRules";
import { dbEnabled, getDb } from "./gcdb";

export type GuardStage = "eval" | "funded";

export type GuardDecision =
  | { verdict: "ok"; reason: string }
  | { verdict: "halt-floor"; reason: string }
  | { verdict: "halt-target"; reason: string }
  | { verdict: "halt-consistency"; reason: string }
  | { verdict: "halt-news"; reason: string }
  | { verdict: "halt-giveback"; reason: string }
  | { verdict: "no-data"; reason: string };

export type GuardState = {
  stage: GuardStage;
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
};

/* ── config (env overrides the Rapid EOD 50k defaults) ─────────────── */
function num(env: string | undefined, fallback: number): number {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
}

export function guardStage(): GuardStage {
  return process.env.MFF_STAGE === "funded" ? "funded" : "eval";
}

/** New York close hour (default 17 = the Globex/maintenance close) */
const EOD_HOUR = () => num(process.env.MFF_EOD_HOUR, 17);

/** halt new entries once equity is within this many $ of the floor */
const GUARD_MARGIN = () => num(process.env.MFF_GUARD_MARGIN, 500);

/** eval consistency cap = 30% of the profit target (default $900). Env override. */
const CONSISTENCY_CAP = () => num(process.env.MFF_CONSISTENCY_CAP, Math.round(RAPID_EOD_50K.profitTarget * RAPID_EOD_50K.consistency));

const STATE_FILE = () => path.join(process.cwd(), ".executor-guard.json");

function seed(): GuardState {
  const stage = guardStage();
  const startBalance = stage === "funded" ? num(process.env.MFF_START_BALANCE, 0) : num(process.env.MFF_START_BALANCE, 50_000);
  const maxLoss = num(process.env.MFF_MAX_LOSS, RAPID_EOD_50K.maxLoss);
  const profitTarget = num(process.env.MFF_PROFIT_TARGET, RAPID_EOD_50K.profitTarget);
  const lockAt = num(process.env.MFF_LOCK_AT, 100);
  const floor = startBalance - maxLoss;
  // The $100 lock only applies to the FUNDED stage (which starts at $0 and
  // trails up). Eval starts at $50k, so its floor starts at $48k — no lock.
  const applyLock = stage === "funded";
  return {
    stage,
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
  };
}

/* ── persistence ────────────────────────────────────────────────────── */
const g = globalThis as unknown as { __gcGuard?: GuardState };
function mem(): GuardState {
  if (!g.__gcGuard) g.__gcGuard = seed();
  return g.__gcGuard;
}

function load() {
  try {
    const p = STATE_FILE();
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      const s = seed();
      g.__gcGuard = { ...s, ...j };
    }
  } catch {
    /* corrupt/absent state — fall back to a fresh seed */
  }
}
load();

function save() {
  try {
    writeFileSync(STATE_FILE(), JSON.stringify(mem(), null, 2));
  } catch {
    /* best-effort — the in-memory state still governs */
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

/** restore the persisted state after a restart (called by crossGuard
 *  before the first gate check). Floor/high-water take the MAX of the
 *  persisted and the freshly bootstrapped values; the day reference is
 *  restored only when it still matches (preserves the $900 counter). */
export async function hydrateGuardFromDb(): Promise<void> {
  if (!dbEnabled()) return;
  try {
    await getDb().unsafe(GUARD_DB_SQL);
    const rows = (await getDb()`select state from guard_state where id = 1`) as unknown as Array<{
      state: unknown;
    }>;
    if (!rows.length) return;
    const raw = rows[0].state;
    const db = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<GuardState>;
    const s = mem();
    if (db.stage) s.stage = db.stage;
    if (db.startBalance) s.startBalance = db.startBalance;
    if (db.maxLoss) s.maxLoss = db.maxLoss;
    if (db.profitTarget) s.profitTarget = db.profitTarget;
    if (db.consistencyCap) s.consistencyCap = db.consistencyCap;
    if (db.lockAt) s.lockAt = db.lockAt;
    s.highWater = Math.max(Number(db.highWater ?? 0), s.highWater);
    s.floor = Math.max(Number(db.floor ?? 0), s.floor);
    if (db.locked !== undefined) s.locked = db.locked;
    if (db.lastCommitDay) s.lastCommitDay = db.lastCommitDay;
    if (db.dayKey) {
      s.dayKey = db.dayKey;
      s.dayStartRealized = Number(db.dayStartRealized ?? 0);
    }
    s.bestDayPnl = Math.max(Number(db.bestDayPnl ?? 0), s.bestDayPnl);
    s.dayPeak = Math.max(Number(db.dayPeak ?? 0), s.dayPeak);
    s.dayPnl = 0; // recomputed by guardCheck from dayStartRealized
  } catch {
    /* best-effort — the bootstrapped state still governs */
  }
}

/* ── EOD clock helpers (America/New_York) ───────────────────────────── */
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
  const p = nyParts(now);
  if (state.dayKey === p.date) return;
  if (state.dayKey !== "" && state.dayPnl > state.bestDayPnl) {
    state.bestDayPnl = state.dayPnl;
  }
  state.dayKey = p.date;
  state.dayStartRealized = realized;
  state.dayPnl = 0;
  state.dayPeak = 0; // the give-back reference belongs to the new day only
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

/** The single entry point: feed it the current account snapshot (from
 *  readAccount) each poll; it returns whether the executor may open a new
 *  trade right now. */
export function guardCheck(snap: { equity: number; realized: number } | null, now = new Date()): GuardDecision {
  const s = mem();
  const isNews = inNewsWindow(now);

  if (snap === null || !Number.isFinite(snap.equity) || !Number.isFinite(snap.realized)) {
    return { verdict: "no-data", reason: "account equity unreadable — halting" };
  }
  const { equity, realized } = snap;

  // consistency day rollover (calendar date) + today's realized P&L
  maybeRolloverDay(s, realized, now);
  s.dayPnl = realized - s.dayStartRealized;
  maybeCommitEod(s, equity, now);

  // profit target: reached = pass — stop (eval: start+target; funded: target from 0)
  const targetPx = s.stage === "funded" ? s.profitTarget : s.startBalance + s.profitTarget;
  if (equity >= targetPx) {
    return {
      verdict: "halt-target",
      reason: `equity $${equity.toFixed(0)} ≥ target $${targetPx.toFixed(0)} — target reached, stop`,
    };
  }

  // EOD floor: never let a new trade risk crossing it
  if (equity <= s.floor + GUARD_MARGIN()) {
    return {
      verdict: "halt-floor",
      reason: `equity $${equity.toFixed(0)} within $${GUARD_MARGIN()} of floor $${s.floor.toFixed(0)} — halt (${s.locked ? "locked" : "trailing"})`,
    };
  }

  // consistency (eval only): today's realized profit must stay under the cap —
  // a single day over 30% of target fails the eval no matter what other days do
  if (s.stage === "eval" && s.dayPnl >= s.consistencyCap) {
    return {
      verdict: "halt-consistency",
      reason: `today's realized P&L $${s.dayPnl.toFixed(0)} ≥ consistency cap $${s.consistencyCap} — stop for the day`,
    };
  }

  // give-back protection: halt new entries once today's P&L has given back
  // more than max(floor, pct × dayPeak) from the day's peak — the 648-session
  // replay found pct 0.5 / floor $250 keeps 90% of total profit while cutting
  // the worst day from −$742 to −$496 (see research/daily-giveback rules).
  s.dayPeak = Math.max(s.dayPeak, s.dayPnl);
  const gbPct = num(process.env.GUARD_GIVEBACK_PCT, 0.5);
  const gbFloor = num(process.env.GUARD_GIVEBACK_FLOOR, 250);
  if (gbPct > 0 && s.dayPeak > gbFloor) {
    const givebackLimit = Math.max(gbFloor, gbPct * s.dayPeak);
    if (s.dayPnl <= s.dayPeak - givebackLimit) {
      return {
        verdict: "halt-giveback",
        reason:
          `day P&L $${s.dayPnl.toFixed(0)} gave back $${(s.dayPeak - s.dayPnl).toFixed(0)} from peak $${s.dayPeak.toFixed(0)} ` +
          `(limit $${givebackLimit.toFixed(0)}) — halt new entries for the day`,
      };
    }
  }

  if (s.stage === "funded" && isNews) {
    return { verdict: "halt-news", reason: "T1 news window — no trading on funded (MFF rule)" };
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
