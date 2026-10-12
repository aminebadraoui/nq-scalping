/* ------------------------------------------------------------------ *
 * Daybook — the DB-less system journal (2026-10-07).
 *
 * One append-only JSONL file per NY trading day at
 * `GC_DATA_DIR/daybook/<day>.jsonl`. Every record is one line:
 *
 *   boot    the variation fingerprint: git SHA (Coolify SOURCE_COMMIT →
 *           BUILD_SHA) + the FULL settings snapshot (every strategy /
 *           risk / feed knob, secrets masked to a stable hash) + the
 *           derived variationId. Written once per process.
 *   signal  every card emitted AND every veto/skip, with entry/stop/
 *           target + features — the same fields recordSignal persists
 *           to Neon, so the insight loop keeps its full decision set
 *           even with no DATABASE_URL (skips were DB-only before).
 *   exec    every order attempt/watch decision (mirrors exec_log —
 *           the evidence that container redeploys used to destroy).
 *   guard   day reference + protection state on every meaningful save
 *           (rollover, profit arm, dd flag) — makes "was the day-P&L
 *           protection blind today?" answerable from the file.
 *   heal    every tape-gap stall episode closed, with its ladder steps
 *           (the durable per-day stall count the health counter can't
 *           give while the process lives).
 *   dayend  the consolidated day summary (wins/losses/net, per family,
 *           cap-skip replay, expRetrace quality) — written by the
 *           nightly consolidation (scripts/daybookConsolidate.ts).
 *
 * Persistence chain: dashboard writes the live file (Coolify volume on
 * /app/data), the nightly jobs container pulls it via /api/daybook,
 * appends the consolidation records, and r2_sync.py uploads the daybook
 * dir to R2 (free egress — the DB-less variation log the operator reads).
 *
 * NEVER throws, NEVER blocks an order, NEVER contains raw secrets.
 * Pure helpers are unit-tested (tests/daybook.test.ts).
 * ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/* ---- settings snapshot ---------------------------------------------- */

/** the canonical knob list for the variation fingerprint. New strategy or
 *  risk knobs MUST be added here when they are introduced — the whole
 *  point of the daybook is that a variation's knobs are reproducible. */
const SETTINGS_KEYS = [
  // execution + account
  "EXECUTE_LIVE",
  "CROSSTRADE_URL",
  "CROSSTRADE_ACCOUNT",
  "CROSSTRADE_INSTRUMENT",
  "CROSSTRADE_KEY",
  "CROSSTRADE_LIMIT_ENTRIES",
  "CROSSTRADE_REST",
  "CROSSTRADE_REQUIRE_FLAT",
  "CROSSTRADE_SCALEOUT",
  "CROSSTRADE_SCALEOUT_REST",
  "AUTO_RETRY_VERIFIED",
  "FIXED_CONTRACTS",
  // market data
  "GOCHARTING_EMAIL",
  "GOCHARTING_PASSWORD",
  "GOCHARTING_COGNITO_CLIENT",
  "GOCHARTING_DC",
  "GOCHARTING_EXCHANGE",
  "GOCHARTING_SEGMENT",
  "GOCHARTING_SYMBOL",
  "GOCHARTING_ES_SYMBOL",
  "GC_DATA_DIR",
  "GC_REMOTE_URL",
  // feed toggles (feedFlag names)
  "FEED_REVERSAL",
  "FEED_SWEEP_RECLAIM",
  "FEED_UNUSUAL_VOLUME",
  "FEED_PULLBACK_TICKET",
  "FEED_MOMENTUM",
  "FEED_RTH",
  "FEED_OPEN",
  "FEED_OPEN_DRIVE",
  "FEED_OPEN_PULLBACK",
  "FEED_OPEN_SNIPER",
  "FEED_GAP_ALERTS",
  "EXP_RETRACE",
  // family profiles + sizing
  "MOM_PROFILE",
  "MOM_STOP_MULT",
  "MOM_TARGET_R",
  "MOM_SIZE_MULT",
  "MOM_TIME_EXIT_BARS",
  "MOM_VERIFY_SHA",
  "MOM_CACHE_DIR",
  "RTH_PROFILE",
  "RTH_STOP_MULT",
  "RTH_TARGET_R",
  "RTH_SIZE_MULT",
  "RTH_TIME_EXIT_BARS",
  "RTH_LIMIT_ENTRIES",
  "RTH_MAX_CARDS_PER_DAY",
  "RTH_RISK_CAP",
  "RTH_COUNTER_GATE_MIN",
  "RTH_COUNTER_GATE_PTS",
  "PROP_RISK_PER_TRADE",
  "OPEN_RISK_CAP",
  "SIZE_TIERS",
  "TICKET_MIN_EXP_PTS",
  "WALL_STOP",
  // risk management / account guard
  "DAILY_LOSS_FLOOR",
  "PROFIT_ARM",
  "GUARD_GIVEBACK_PCT",
  "GUARD_GIVEBACK_FLOOR",
  "DD_HALF_AT",
  "DD_FULL_AT",
  "DD_HALF_MULT",
  "MFF_STAGE",
  "MFF_START_BALANCE",
  "MFF_MAX_LOSS",
  "MFF_PROFIT_TARGET",
  "MFF_CONSISTENCY_CAP",
  "MFF_LOCK_AT",
  "MFF_EOD_HOUR",
  "MFF_GUARD_MARGIN",
  "MFF_T1_NEWS",
  "ACCOUNT_START_BALANCE",
  // support feeds
  "ANALYSIS_LLM_URL",
  "ANALYSIS_LLM_MODEL",
  "ANALYSIS_LLM_KEY",
  "BRIEFING_LLM_MODEL",
  "FINNHUB_API_KEY",
  "OPTIONS_SYMBOL",
  "OPTIONS_REFRESH_SECONDS",
  "SIGNAL_REFRESH_SECONDS",
  "TELEGRAM_ALLOW_DRYRUN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "LIVE_WRITE",
  "DATABASE_URL",
];

const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)$/;

/** mask a knob value: secrets become a stable short hash (a change is
 *  visible in the fingerprint without exposing the secret); everything
 *  else is kept verbatim so the variation diff reads naturally. */
export function maskSetting(key: string, value: string | undefined): string {
  if (value === undefined) return "";
  if (SECRET_RE.test(key)) {
    return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
  }
  return value;
}

/** the full settings snapshot: canonical keys → masked values. */
export function settingsSnapshot(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTINGS_KEYS) out[k] = maskSetting(k, env[k]);
  return out;
}

/** variation fingerprint = hash(git SHA + sorted settings). Two boots
 *  with the same fingerprint ran the same system configuration. */
export function variationFingerprint(sha: string, settings: Record<string, string>): string {
  const canon = Object.keys(settings)
    .sort()
    .map((k) => `${k}=${settings[k]}`)
    .join("\n");
  return createHash("sha256").update(`${sha}\n${canon}`).digest("hex").slice(0, 12);
}

/* ---- trading day + files -------------------------------------------- */

/** the NY trading-day key (mirrors accountGuard.tradingDayKey — before
 *  18:00 ET the day belongs to YESTERDAY's session date). */
export function daybookDayKey(now: Date = new Date()): string {
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
  const today = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (Number(p.hour) * 60 + Number(p.minute) >= 18 * 60) return today.toISOString().slice(0, 10);
  const prev = new Date(today.getTime() - 24 * 3_600_000);
  return prev.toISOString().slice(0, 10);
}

export function daybookDir(env: Record<string, string | undefined> = process.env): string {
  const data = env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
  return path.join(data, "daybook");
}

export function daybookFile(day: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(daybookDir(env), `${day}.jsonl`);
}

/* ---- records --------------------------------------------------------- */

export type DaybookBoot = {
  t: "boot";
  at: number;
  sha: string;
  buildId: string;
  variationId: string;
  settings: Record<string, string>;
};

export type DaybookSignal = {
  t: "signal";
  at: number;
  day: string;
  timeET: string;
  symbol: string;
  side: string;
  price: string | number;
  entry: string;
  stop: string;
  target: string;
  size: string;
  verdict: string;
  headline: string;
  source: string;
  sent: boolean;
  reason: string;
  features?: Record<string, unknown> | null;
};

export type DaybookExec = {
  t: "exec";
  at: number;
  key: string;
  label: string;
  attempt: string;
  outcome: string;
  reason: string;
};

export type DaybookGuard = {
  t: "guard";
  at: number;
  dayKey: string;
  dayPnl: number;
  dayPeak: number;
  dayStartRealized: number;
  bestDayPnl: number;
  profitArmed: boolean;
  lastDayPnl: number | null;
  floor: number;
  locked: boolean;
  stage: string;
};

export type DaybookHeal = {
  t: "heal";
  at: number;
  episode: number;
  sinceAt: number;
  closedAt: number;
  forcedFetches: number;
  reconnects: number;
  reseeds: number;
};

/** execution-ledger record (lib/execTracker.ts) — one per state change
 *  of an executed signal: placed → filled → closed (win/loss/flat) /
 *  failed, with the Tradovate order/fill identity and the $ result. */
export type DaybookExecTrade = {
  t: "execTrade";
  at: number;
  key: string;
  signalId: string;
  day: string;
  timeET: string;
  label: string;
  family: string;
  side: string;
  contracts: number;
  sigEntry: number;
  sigStop: number;
  sigTarget: number;
  orderId: string;
  status: string;
  fillEntry: number | null;
  fillEntryAt: number | null;
  exitAvg: number | null;
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: string;
};

export type DaybookEnd = {
  t: "dayend";
  at: number;
  summary: Record<string, unknown>;
};

/** execution-latency telemetry (lib/execLatency.ts) — fill legs only;
 *  per-cycle rows are too high-frequency for the journal */
export type DaybookLatency = {
  t: "latency";
  at: number;
  label: string;
  kind: "fill";
  dir: string;
  qty: number;
  submitMs: number;
  ackMs: number | null;
  fillMs: number | null;
  seenMs: number | null;
};

export type DaybookRecord =
  | DaybookBoot
  | DaybookSignal
  | DaybookExec
  | DaybookExecTrade
  | DaybookGuard
  | DaybookHeal
  | DaybookLatency
  | DaybookEnd;

/* ---- consolidated summary shapes (written by the nightly consolidation,
 * read by /api/trades' DB-less fallback and the variation index) -------- */

export type DaybookTradeSummary = {
  day: string;
  timeET: string;
  side: "long" | "short";
  contracts: number;
  family: string;
  verdict: string;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  grossUsd: number;
  netUsd: number;
  commissions: number;
  result: "win" | "loss" | "flat";
  heldMin: number;
  exitReason: "target" | "stop" | "time" | "other";
};

export type DaybookDaySummary = {
  day: string;
  source: string;
  tradesN: number;
  wins: number;
  losses: number;
  flats: number;
  grossUsd: number;
  netUsd: number;
  commissions: number;
  healEpisodes: number;
  capSkips: number;
  capReplay: Array<{
    timeET: string;
    side: "long" | "short";
    wouldHave: "win" | "loss" | "flat" | null;
    pts: number | null;
    grossUsd: number | null;
  }>;
  expRetrace: { expiries: number; fills: number; avgAdverseDriftPts: number | null };
  trades: DaybookTradeSummary[];
};

/* ---- append (best-effort, never throws) ------------------------------ */

export function appendDaybook(rec: DaybookRecord, day?: string, env: Record<string, string | undefined> = process.env): void {
  // DAYBOOK_OFF=1 silences journal writes (set by the test loader so the
  // suite never pollutes the real journal dir on developer machines)
  if (env.DAYBOOK_OFF === "1") return;
  try {
    const d = day ?? daybookDayKey();
    const dir = daybookDir(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(daybookFile(d, env), JSON.stringify(rec) + "\n");
  } catch {
    /* evidence is best-effort — never block execution on the journal */
  }
}

/* ---- boot record (once per process) ---------------------------------- */

const g = globalThis as unknown as { __gcDaybookBooted?: boolean };

export function bootDaybook(env: Record<string, string | undefined> = process.env): void {
  if (g.__gcDaybookBooted) return;
  g.__gcDaybookBooted = true;
  const settings = settingsSnapshot(env);
  const sha = (env.BUILD_SHA ?? "").trim();
  const buildId = (env.BUILD_ID ?? "").trim();
  appendDaybook(
    {
      t: "boot",
      at: Date.now(),
      sha,
      buildId,
      variationId: variationFingerprint(sha, settings),
      settings,
    },
    undefined,
    env,
  );
}

/* ---- reads (dashboard API + consolidation) --------------------------- */

export function listDaybookDays(env: Record<string, string | undefined> = process.env): string[] {
  try {
    const dir = daybookDir(env);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

export function readDaybookDay(day: string, env: Record<string, string | undefined> = process.env): DaybookRecord[] {
  try {
    const f = daybookFile(day, env);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as DaybookRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is DaybookRecord => r !== null);
  } catch {
    return [];
  }
}

/* ---- R2 readthrough (the archived variation log) --------------------- */

/** the public R2 base (the same bucket r2_sync.py archives the daybook to) */
export function daybookR2Base(env: Record<string, string | undefined> = process.env): string {
  return (env.GC_REMOTE_URL || "https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev").replace(/\/+$/, "");
}

function parseJsonl(text: string): DaybookRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as DaybookRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is DaybookRecord => r !== null);
}

/** local days ∪ R2 days (via the manifest) — the journal spans container
 *  redeploys: the volume holds the live day, R2 holds the archive. */
export async function listDaybookDaysRemote(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const local = listDaybookDays(env);
  try {
    const res = await fetch(`${daybookR2Base(env)}/manifest.json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return local;
    const m = (await res.json()) as { files?: Array<{ key: string }> };
    const remote = (m.files ?? [])
      .map((f) => f.key)
      .filter((k) => /^data\/daybook\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(k))
      .map((k) => k.slice(13, 23));
    return [...new Set([...local, ...remote])].sort();
  } catch {
    return local;
  }
}

/** local file first; falls back to the R2 archive for days that predate
 *  this container (or were consolidated on another machine). */
export async function readDaybookDayRemote(day: string, env: Record<string, string | undefined> = process.env): Promise<DaybookRecord[]> {
  const local = readDaybookDay(day, env);
  if (local.length) return local;
  try {
    const res = await fetch(`${daybookR2Base(env)}/data/daybook/${day}.jsonl`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    return parseJsonl(await res.text());
  } catch {
    return [];
  }
}
