/* ---------------------------------------------------------------------------
 * Theory lab — evaluate an entry theory against the collected sessions.
 *
 *   import { LAB_FEATURES, buildLabSamples, evaluateTheory } from "@/lib/lab";
 *
 * Design rules, learned the hard way:
 *
 *  1. NOTHING here is allowed to read the future. Every feature is computed from
 *     bars up to and including the reclaim bar, because a filter you cannot
 *     evaluate in real time is not a filter.
 *  2. Win rate alone is not a result. Every evaluation reports n, a naive
 *     interval AND a session-clustered interval (trades inside one session are
 *     not independent), per-session breakdown, the share of trades whose
 *     outcome was decided by the tie-break convention rather than the market,
 *     and a chronological holdout.
 *  3. Absolute quantities are trusted; anything divided by the trade's own risk
 *     is flagged as a ratio feature, because that construction has already
 *     produced two phantom edges in this project (a sweep-depth effect that
 *     vanished when measured by the wick, and a VWAP-in-R effect that only
 *     survived in its absolute form).
 * ------------------------------------------------------------------------- */
import { analyze, computeSheet, extractFootprint, listUsableSessions, type AbsorbEvent, type AlertEvent } from "./gcdata";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXPECTED_ETH_MINUTES = 1380;
const TICK = 0.25;
const LOOKAHEAD = 60;
const EDGE_TOL = 2.5;
const ABS_BARS = 3;
const ABS_PTS = 3;
const DIV_BARS = 10;

export type LabSample = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  /** target hit before the stop, with ambiguous bars resolved as losses */
  win: boolean;
  /** true when stop and target both fall inside the next bar — convention decides it */
  ambiguous: boolean;
  mfeR: number;
  maeR: number;
  // ── features, all known at the reclaim bar's close ──
  lvnEdge: boolean;
  distVwapPts: number;
  distVwapR: number;
  sweepWickPts: number;
  sweepMidPts: number;
  sweepDepthR: number;
  snapBackPts: number;
  riskPts: number;
  hourET: number;
  isRTH: boolean;
  hasDiv: boolean;
  hasAbs: boolean;
  atrPts: number;
  reclaimOrdinal: number;
  rvol: number;
  absDeltaPct: number;
  withVwapSlope: boolean;
  barRangePts: number;
  oneSidedEntry: boolean;
};

export type FeatureMeta = {
  id: keyof LabSample & string;
  label: string;
  unit: string;
  kind: "number" | "boolean" | "enum";
  /** ratio features divide by the trade's own risk — treat as suspect */
  ratio?: boolean;
  note: string;
  /** suggested condition, offered as a starting point in the UI */
  suggest?: { op: Op; value: number | boolean | string };
};

export type Op = ">=" | "<=" | ">" | "<" | "==" | "!=";

export const LAB_FEATURES: FeatureMeta[] = [
  {
    id: "lvnEdge",
    label: "At an LVN edge",
    unit: "bool",
    kind: "boolean",
    note: "entry within 2.5 pt of a low-volume node from any profile in the stack — the strategy's location premise",
    suggest: { op: "==", value: true },
  },
  {
    id: "distVwapPts",
    label: "Distance from session VWAP",
    unit: "pt",
    kind: "number",
    note: "absolute points from the cumulative session VWAP (HLC3) at entry. Prefer this over distVwapR.",
    suggest: { op: "<=", value: 50 },
  },
  {
    id: "distVwapR",
    label: "Distance from VWAP ÷ risk",
    unit: "R",
    kind: "number",
    ratio: true,
    note: "RATIO: dividing by the trade's own risk mixes the signal with the stop definition. Measured at 60% vs 49.5% but flagged suspect.",
  },
  {
    id: "sweepWickPts",
    label: "Sweep penetration (wick)",
    unit: "pt",
    kind: "number",
    note: "how far the break bar's wick reached beyond the prior extreme — the clean measure of sweep depth",
    suggest: { op: "<=", value: 2 },
  },
  {
    id: "sweepMidPts",
    label: "Sweep penetration (break-bar midpoint)",
    unit: "pt",
    kind: "number",
    note: "same break measured from the bar's midpoint; more conservative than the wick",
  },
  {
    id: "sweepDepthR",
    label: "Sweep depth ÷ risk",
    unit: "R",
    kind: "number",
    ratio: true,
    note: "RATIO, and the source of a withdrawn finding: it scores 74% but collapses to nothing when penetration is measured by the wick. Kept only so the artifact is visible.",
    suggest: { op: "<=", value: 0.3 },
  },
  {
    id: "snapBackPts",
    label: "Reclaim snap-back",
    unit: "pt",
    kind: "number",
    note: "how far the confirmation bar closed back inside from the failed extreme. risk = snap-back + 2 ticks, so this is stop width seen from the other end.",
    suggest: { op: ">=", value: 1.6 },
  },
  {
    id: "riskPts",
    label: "Risk (stop distance)",
    unit: "pt",
    kind: "number",
    note: "distance from entry to the stop, which is 2 ticks beyond the failed extreme",
  },
  {
    id: "hourET",
    label: "Hour of entry (New York)",
    unit: "h",
    kind: "number",
    note: "feed clock is US Central, converted +1h. 18 = the Globex open, 9 = the RTH open.",
    suggest: { op: ">=", value: 18 },
  },
  {
    id: "isRTH",
    label: "Inside RTH hours",
    unit: "bool",
    kind: "boolean",
    note: "09:30–15:59 New York; the weakest bucket measured so far",
  },
  {
    id: "hasDiv",
    label: "Matching CVD divergence",
    unit: "bool",
    kind: "boolean",
    note: "D2 for longs, D4 for shorts, within 10 bars of entry. Was 'fuel' in the playbook; measured +5 pt, not significant.",
    suggest: { op: "==", value: true },
  },
  {
    id: "hasAbs",
    label: "Absorption nearby",
    unit: "bool",
    kind: "boolean",
    note: "the playbook marks this required, but the detector fires on ~3 of 449 reclaims, so it is effectively untestable here",
  },
  {
    id: "atrPts",
    label: "ATR(15) at entry",
    unit: "pt",
    kind: "number",
    note: "median range of the previous 15 bars — a volatility regime proxy",
  },
  {
    id: "reclaimOrdinal",
    label: "Nth reclaim of the session",
    unit: "n",
    kind: "number",
    note: "1 = the first reclaim of that session",
    suggest: { op: "<=", value: 2 },
  },
  {
    id: "rvol",
    label: "RVOL on the reclaim bar",
    unit: "x",
    kind: "number",
    note: "bar volume ÷ the session's median minute volume. Measured as no help; RVOL ≥ 1.5 was slightly worse.",
  },
  {
    id: "absDeltaPct",
    label: "|delta| share of volume",
    unit: "frac",
    kind: "number",
    note: "absolute delta divided by the reclaim bar's volume",
  },
  {
    id: "withVwapSlope",
    label: "Aligned with VWAP slope",
    unit: "bool",
    kind: "boolean",
    note: "trade direction matches the direction the session VWAP has been moving over 30 bars",
  },
  {
    id: "barRangePts",
    label: "Reclaim bar range",
    unit: "pt",
    kind: "number",
    note: "high minus low of the confirmation bar",
  },
  {
    id: "oneSidedEntry",
    label: "One-sided aggression on the reclaim bar",
    unit: "bool",
    kind: "boolean",
    note: "reclaim bar volume >= session median AND >=65% of it is on the entry side (buy for long, sell for short) — the reversal is being actively bought/sold, not just faded",
    suggest: { op: "==", value: true },
  },
];

export type Condition = { feature: string; op: Op; value: number | boolean | string };
export type ExitSpec = { targetR: number; stopTicks: number };
export type Theory = {
  name: string;
  conditions: Condition[];
  exit?: ExitSpec;
  note?: string;
  registeredAt?: string;
  /** sessions on or before this date were visible when the theory was written */
  dataCutoff?: string;
};

export type SessionRow = { date: string; n: number; wins: number; wr: number };

export type Metrics = {
  n: number;
  wins: number;
  wr: number;
  /** naive Wilson interval, assumes independent trades (it does not hold) */
  wilson: [number, number];
  /** session-clustered bootstrap interval — the honest one */
  clustered: [number, number];
  exp: number;
  tradesPerSession: number;
  ambiguousShare: number;
  sessions: SessionRow[];
  daysAbove50: number;
  daysTotal: number;
};

export type TheoryResult = {
  name: string;
  /** ambiguous same-bar trades counted as LOSSES (the conservative read) */
  all: Metrics;
  /** ambiguous trades dropped — flatters the result, kept for comparison */
  clean: Metrics;
  /** ambiguous same-bar trades counted as WINS (the permissive read) */
  optimistic: Metrics;
  holdout: { splitAt: string; train: Metrics; test: Metrics } | null;
  forward: Metrics | null;
  warnings: string[];
  featureUse: { id: string; label: string; ratio: boolean; conditions: number }[];
};

/* ── data discovery (complete sessions only) ─────────────────────────────── */

export function dataDir(): string {
  if (process.env.GC_DATA_DIR) return process.env.GC_DATA_DIR;
  // cwd differs between `next dev` (web/) and a script run from the repo root,
  // so try both rather than assuming.
  const candidates = [
    path.resolve(process.cwd(), "..", "gcdata", "data"),
    path.resolve(process.cwd(), "gcdata", "data"),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      /* not here */
    }
  }
  return candidates[0];
}


/** A session is usable only if CONTIGUOUS — see backfill.py session_usable. */
export function sessionUsable(candles: { t: string }[]): boolean {
  if (candles.length < 1360) return false;
  const ts = candles.map((c) => c.t).sort();
  const base = Number(ts[0].slice(8, 10));
  const mins = ts.map((t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) + (Number(t.slice(8, 10)) - base) * 1440);
  const first = mins[0] % 1440;
  const last = mins[mins.length - 1] % 1440;
  let maxgap = 0;
  for (let i = 1; i < mins.length; i++) maxgap = Math.max(maxgap, mins[i] - mins[i - 1]);
  return first >= 1020 && first <= 1035 && last === 959 && maxgap <= 5;
}

export async function discoverCompleteSessions() {
  // R2 is the sole data source: the manifest's per-session usable flag
  // (computed at upload with the same contiguity/window rules) is the
  // inventory. The local-fs scan below is the offline dev fallback.
  const remote = await listUsableSessions();
  if (remote) return remote;

  const dir = dataDir();
  const dates: string[] = [];
  const skipped: { date: string; minutes: number }[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { dates, skipped };
  }
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})_ETH\.json$/.exec(f);
    if (!m) continue;
    let candles: { t: string }[] = [];
    try {
      candles = JSON.parse(readFileSync(path.join(dir, f), "utf8")).candles ?? [];
    } catch {
      continue;
    }
    if (sessionUsable(candles)) dates.push(m[1]);
    else skipped.push({ date: m[1], minutes: candles.length });
  }
  return { dates: dates.sort(), skipped: skipped.sort((a, b) => a.date.localeCompare(b.date)) };
}

/* ── sample construction ─────────────────────────────────────────────────── */

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

type Cache = { key: string; samples: LabSample[]; dates: string[]; skipped: { date: string; minutes: number }[]; at: number };
const g = globalThis as unknown as { __labCache?: Cache };

/** Rebuilding the sample set runs the full engine over ~570 sessions
 *  (several minutes of CPU + R2 fetches), so the built set is persisted to
 *  disk keyed by the session inventory and reused until the inventory
 *  changes. The in-process cache handles the repeat-request fast path. */
const CACHE_FILE = path.join(os.tmpdir(), "nq-lab-cache.json");

/** Building the sample set runs the full engine per session; cache it in-process. */
let building: Promise<{
  samples: LabSample[];
  dates: string[];
  skipped: { date: string; minutes: number }[];
}> | null = null;

export async function buildLabSamples(opts: { force?: boolean } = {}): Promise<{
  samples: LabSample[];
  dates: string[];
  skipped: { date: string; minutes: number }[];
}> {
  const { dates, skipped } = await discoverCompleteSessions();
  const key = dates.join(",");
  if (!opts.force && g.__labCache && g.__labCache.key === key && Date.now() - g.__labCache.at < 10 * 60_000) {
    return { samples: g.__labCache.samples, dates, skipped };
  }
  if (!opts.force) {
    try {
      const disk = JSON.parse(await fs.readFile(CACHE_FILE, "utf8")) as {
        key: string;
        samples: LabSample[];
        dates: string[];
        skipped: { date: string; minutes: number }[];
      };
      if (disk.key === key && disk.samples.length > 0) {
        g.__labCache = { key, samples: disk.samples, dates: disk.dates, skipped: disk.skipped, at: Date.now() };
        return { samples: disk.samples, dates: disk.dates, skipped: disk.skipped };
      }
    } catch {
      /* no disk cache yet */
    }
  }

  if (building) return building;
  let resolveBuild!: (v: {
    samples: LabSample[];
    dates: string[];
    skipped: { date: string; minutes: number }[];
  }) => void;
  building = new Promise((res) => {
    resolveBuild = res;
  });

  const samples: LabSample[] = [];
  const CONCURRENCY = 12;
  for (let start = 0; start < dates.length; start += CONCURRENCY) {
    const chunk = dates.slice(start, start + CONCURRENCY);
    const built = await Promise.all(
      chunk.map(async (date) => {
        const fp = await extractFootprint(date, "ETH");
        const an = await analyze(date, "ETH", undefined, undefined, 4);
        if (!fp || !an) return [];
        const sheet = await computeSheet(date);
        return buildSessionSamples(date, fp, an, sheet);
      }),
    );
    samples.push(...built.flat());
  }

  /** one session's samples — the engine pass, isolated so the build loop can
   *  run sessions concurrently (12 at a time) instead of one slow round-trip
   *  at a time. */
  function buildSessionSamples(
    date: string,
    fp: Awaited<ReturnType<typeof extractFootprint>> | null,
    an: Awaited<ReturnType<typeof analyze>> | null,
    sheet: Awaited<ReturnType<typeof computeSheet>>,
  ): LabSample[] {
    if (!fp || !an) return [];
    const samples: LabSample[] = [];
    const m = fp.minutes;
    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);
    const vol = m.map((x) => (x.buy ?? 0) + (x.sell ?? 0));
    const medVol = q(vol, 0.5) || 1;

    // cumulative session VWAP (HLC3) as it stood at each bar
    const vwap: number[] = [];
    {
      let num = 0;
      let den = 0;
      for (let i = 0; i < m.length; i++) {
        const b = m[i];
        const v = (b.buy ?? 0) + (b.sell ?? 0);
        num += ((b.high + b.low + (b.c > 0 ? b.c : (b.high + b.low) / 2)) / 3) * v;
        den += v;
        vwap.push(den > 0 ? num / den : 0);
      }
    }

    const zones: [number, number][] = [];
    for (const p of Object.values(sheet.profiles)) {
      if (!p) continue;
      for (const z of (p as { LVNs?: string[] }).LVNs ?? []) {
        const [a, b] = String(z)
          .split("–")
          .map((x) => parseFloat(x.replace(/,/g, "")));
        if (Number.isFinite(a) && Number.isFinite(b)) zones.push([Math.min(a, b), Math.max(a, b)]);
      }
    }

    const absorption = (an.absorption ?? []) as AbsorbEvent[];
    const divs = (an.alerts ?? []).filter((a: AlertEvent) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
    const minuteOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

    let runLo = Infinity;
    let runHi = -Infinity;
    const reclaims: { i: number; dir: "low" | "high"; extreme: number; breakBar: number }[] = [];
    for (let i = 1; i < m.length; i++) {
      const pl = Math.min(runLo, lo[i - 1]);
      const ph = Math.max(runHi, hi[i - 1]);
      runLo = pl;
      runHi = ph;
      if (lo[i] <= pl - TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] > pl) {
            reclaims.push({ i: j, dir: "low", extreme: pl, breakBar: i });
            break;
          }
        }
      }
      if (hi[i] >= ph + TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] < ph) {
            reclaims.push({ i: j, dir: "high", extreme: ph, breakBar: i });
            break;
          }
        }
      }
    }

    let ordinal = 0;
    for (const r of reclaims) {
      const bar = m[r.i];
      const entry = bar.c > 0 ? bar.c : mid[r.i];
      const dir: "long" | "short" = r.dir === "low" ? "long" : "short";
      const stop = dir === "long" ? r.extreme - 2 * TICK : r.extreme + 2 * TICK;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      ordinal++;
      const long = dir === "long";

      let win = false;
      let ambiguous = false;
      let mfe = 0;
      let mae = 0;
      const target = long ? entry + risk : entry - risk;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        const b = m[k];
        const hitStop = long ? b.low <= stop : b.high >= stop;
        const hitTarget = long ? b.high >= target : b.low <= target;
        if (k === r.i + 1 && hitStop && hitTarget) ambiguous = true;
        if (hitStop) break; // pessimistic: the stop is resolved first
        mfe = Math.max(mfe, (long ? b.high - entry : entry - b.low) / risk);
        mae = Math.max(mae, (long ? entry - b.low : b.high - entry) / risk);
        if (hitTarget) {
          win = true;
          break;
        }
      }

      const atEdge = zones.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      const wantKind = long ? "DIVERGENCE_D2" : "DIVERGENCE_D4";
      const hasDiv = divs.some((d) => {
        if (d.kind !== wantKind) return false;
        const dm = minuteOf(d.t);
        const bm = minuteOf(bar.t);
        return bm - dm >= 0 && bm - dm <= DIV_BARS;
      });
      const hasAbs = absorption.some(
        (a) => Math.abs(minuteOf(a.t) - minuteOf(bar.t)) <= ABS_BARS && Math.abs(a.price - entry) <= ABS_PTS,
      );

      const w = vwap[r.i] || entry;
      const prior30 = Math.max(0, r.i - 30);
      const slope = (vwap[r.i] || 0) - (vwap[prior30] || 0);
      const atr = q(
        m.slice(Math.max(0, r.i - 15), r.i).map((x) => x.high - x.low),
        0.5,
      );
      const etHour = (Number(bar.t.slice(0, 2)) + 1) % 24; // feed clock is Central; NY is always +1
      const mm = Number(bar.t.slice(3, 5));
      const isRTH = (etHour === 9 && mm >= 30) || (etHour >= 10 && etHour <= 15);
      const entryBuyPct = vol[r.i] > 0 ? (bar.buy ?? 0) / vol[r.i] : 0.5;
      const oneSidedEntry = vol[r.i] >= medVol && (long ? entryBuyPct >= 0.65 : entryBuyPct <= 0.35);

      samples.push({
        date,
        t: bar.t,
        dir,
        entry,
        stop,
        risk,
        win,
        ambiguous,
        mfeR: mfe,
        maeR: mae,
        lvnEdge: atEdge,
        distVwapPts: Math.abs(entry - w),
        distVwapR: Math.abs(entry - w) / risk,
        sweepWickPts: dir === "long" ? r.extreme - lo[r.breakBar] : hi[r.breakBar] - r.extreme,
        sweepMidPts: Math.abs(mid[r.breakBar] - r.extreme),
        sweepDepthR: Math.abs(mid[r.breakBar] - r.extreme) / risk,
        snapBackPts: Math.abs(entry - r.extreme),
        riskPts: risk,
        hourET: etHour,
        isRTH,
        hasDiv,
        hasAbs,
        atrPts: atr,
        reclaimOrdinal: ordinal,
        rvol: vol[r.i] / medVol,
        absDeltaPct: Math.abs(bar.delta ?? 0) / Math.max(1, vol[r.i]),
        withVwapSlope: slope > 0 ? long : slope < 0 ? !long : false,
        barRangePts: bar.high - bar.low,
        oneSidedEntry,
      });
    }
    return samples;
  }

  g.__labCache = { key, samples, dates, skipped, at: Date.now() };
  fs.writeFile(CACHE_FILE, JSON.stringify({ key, samples, dates, skipped })).catch(() => {
    /* persistence is best-effort */
  });
  const result = { samples, dates, skipped };
  resolveBuild(result);
  building = null;
  return result;
}

/* ── statistics ──────────────────────────────────────────────────────────── */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wilson(wins: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, ((c - s) / d) * 100), Math.min(100, ((c + s) / d) * 100)];
}

/** Bootstrap by resampling SESSIONS, not trades: trades inside one session are correlated. */
function clusterBootstrap(rows: LabSample[], iters = 800): [number, number] {
  const byDate = new Map<string, LabSample[]>();
  for (const r of rows) {
    const a = byDate.get(r.date) ?? [];
    a.push(r);
    byDate.set(r.date, a);
  }
  const sessions = [...byDate.values()];
  if (sessions.length < 2) return [0, 100];
  const rand = mulberry32(0x5eed);
  const rates: number[] = [];
  for (let it = 0; it < iters; it++) {
    let n = 0;
    let w = 0;
    for (let s = 0; s < sessions.length; s++) {
      const pick = sessions[Math.floor(rand() * sessions.length)];
      n += pick.length;
      w += pick.filter((x) => x.win).length;
    }
    if (n) rates.push((w / n) * 100);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(0.025 * rates.length)] ?? 0, rates[Math.floor(0.975 * rates.length)] ?? 100];
}

/**
 * Tie-break policy. When the stop and the 1R target both sit inside the first
 * bar after entry, the backtest's convention — not the market — decides the
 * trade. Every ambiguous trade is a loss under the pessimistic rule, so:
 *
 *   pessimistic (default) → count them as losses
 *   excluded              → drop them (this WAS mislabelled "the honest number";
 *                           it removes a set that is entirely losses and so
 *                           flatters the result)
 *   optimistic            → count them as wins
 *
 * The truth is bounded by the pessimistic and optimistic figures, and reporting
 * only the middle one hid a spread that reaches ~17 points.
 */
type Policy = { dropAmbiguous?: boolean; ambiguousAsWin?: boolean };

function metrics(rowsIn: LabSample[], sessionCount: number, policy: Policy = {}): Metrics {
  const rows = policy.dropAmbiguous ? rowsIn.filter((r) => !r.ambiguous) : rowsIn;
  const winsFor = (r: LabSample) => (r.ambiguous && policy.ambiguousAsWin ? true : r.win);
  const n = rows.length;
  const wins = rows.filter(winsFor).length;
  const wr = n ? (wins / n) * 100 : 0;
  const exp = n ? rows.reduce((a, r) => a + (winsFor(r) ? 1 : -1), 0) / n : 0;
  const byDate = new Map<string, LabSample[]>();
  for (const r of rows) {
    const a = byDate.get(r.date) ?? [];
    a.push(r);
    byDate.set(r.date, a);
  }
  const sessions: SessionRow[] = [...byDate.entries()]
    .map(([date, list]) => ({
      date,
      n: list.length,
      wins: list.filter(winsFor).length,
      wr: (list.filter(winsFor).length / list.length) * 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    n,
    wins,
    wr,
    wilson: wilson(wins, n),
    clustered: n ? clusterBootstrap(rows) : [0, 0],
    exp,
    tradesPerSession: sessionCount ? n / sessionCount : 0,
    ambiguousShare: n ? (rowsIn.filter((r) => r.ambiguous).length / rowsIn.length) * 100 : 0,
    sessions,
    daysAbove50: sessions.filter((s) => s.wr > 50).length,
    daysTotal: sessions.length,
  };
}

export function matches(sample: LabSample, c: Condition): boolean {
  const v = sample[c.feature as keyof LabSample];
  switch (c.op) {
    case "==":
      return v === c.value;
    case "!=":
      return v !== c.value;
    case ">":
      return Number(v) > Number(c.value);
    case "<":
      return Number(v) < Number(c.value);
    case ">=":
      return Number(v) >= Number(c.value);
    case "<=":
      return Number(v) <= Number(c.value);
    default:
      return false;
  }
}

export function evaluateTheory(
  theory: Theory,
  samples: LabSample[],
  sessionDates: string[],
): TheoryResult {
  const conds = theory.conditions ?? [];
  const keep = (s: LabSample) => conds.every((c) => matches(s, c));
  const cohort = samples.filter(keep);

  // Only count sessions that are contemporaneous with the cohort, otherwise a
  // theory that fires on one day looks like it fires 0.1 times per session.
  const cohortDates = new Set(cohort.map((s) => s.date));
  const sessionsInUse = sessionDates.filter((d) => cohortDates.has(d)).length || sessionDates.length;

  const all = metrics(cohort, sessionsInUse);
  const clean = metrics(cohort, sessionsInUse, { dropAmbiguous: true });
  const optimistic = metrics(cohort, sessionsInUse, { ambiguousAsWin: true });

  const sorted = [...sessionDates].sort();
  const half = Math.floor(sorted.length / 2);
  const splitAt = sorted[half] ?? "";
  const trainDates = new Set(sorted.slice(0, half));
  const testDates = new Set(sorted.slice(half));
  const train = metrics(cohort.filter((s) => trainDates.has(s.date)), Math.max(1, trainDates.size));
  const test = metrics(cohort.filter((s) => testDates.has(s.date)), Math.max(1, testDates.size));

  // forward test: only sessions AFTER the theory was registered
  let forward: Metrics | null = null;
  if (theory.dataCutoff) {
    const fwdDates = sorted.filter((d) => d > theory.dataCutoff!);
    const fwd = cohort.filter((s) => s.date > theory.dataCutoff!);
    forward = metrics(fwd, Math.max(1, fwdDates.length));
  }

  const warnings: string[] = [];
  const ratioUsed = conds.filter((c) => LAB_FEATURES.find((f) => f.id === c.feature)?.ratio);
  if (ratioUsed.length) {
    warnings.push(
      `Uses a ratio feature (${ratioUsed.map((c) => c.feature).join(", ")}): dividing by the trade's own risk has already produced two phantom edges here. Re-test the same idea in absolute points.`,
    );
  }
  if (all.n === 0) warnings.push("No trades match these conditions.");
  if (all.n > 0 && all.n < 60) {
    warnings.push(`Only ${all.n} matching trades. Intervals this wide cannot distinguish a real edge from luck.`);
  }
  if (all.n === samples.length) warnings.push("This is the unfiltered baseline — no conditions applied.");
  if (all.ambiguousShare > 5) {
    warnings.push(
      `Tie-break matters here: ${all.ambiguousShare.toFixed(0)}% of these trades had stop and target inside the same bar, and every one of them scores as a loss under the conservative rule. The win rate is only pinned down to a range — ${all.wr.toFixed(0)}% (counted as losses) to ${optimistic.wr.toFixed(0)}% (counted as wins). Report the range, never one end of it.`,
    );
  }
  const naiveWidth = all.wilson[1] - all.wilson[0];
  const clusterWidth = all.clustered[1] - all.clustered[0];
  if (all.n > 30 && clusterWidth > naiveWidth * 1.4) {
    warnings.push(
      `Clustering inflates the interval ${(clusterWidth / Math.max(1, naiveWidth)).toFixed(1)}× versus the naive binomial one — the same-session trades are not independent observations.`,
    );
  }
  if (all.n > 0 && all.daysAbove50 <= all.daysTotal / 2) {
    warnings.push(
      `The edge appears in only ${all.daysAbove50} of ${all.daysTotal} sessions, which is what a lucky subset looks like.`,
    );
  }
  warnings.push(
    "Thresholds you pick while looking at this data are in-sample. Register the theory, then judge it only on sessions collected afterwards.",
  );

  return {
    name: theory.name || "untitled",
    all,
    clean,
    optimistic,
    holdout: splitAt ? { splitAt, train, test } : null,
    forward,
    warnings,
    featureUse: conds.map((c) => {
      const f = LAB_FEATURES.find((x) => x.id === c.feature);
      return { id: c.feature, label: f?.label ?? c.feature, ratio: !!f?.ratio, conditions: 1 };
    }),
  };
}
