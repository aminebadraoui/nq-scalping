/* ------------------------------------------------------------------ *
 * Signal engine — the server-side mirror of the dashboard's final
 * signal, built from the LIVE GoCharting feed + collected levels.
 *
 * The dashboard computes this in the browser; this module computes the
 * same thing in Node so the Telegram notifier can run without a browser
 * being open. The only difference is the data source: here the minutes
 * come straight from lib/live.ts (the server-side tick feed) instead of
 * the SSE endpoint, and the analysis (absorption / divergence / reclaim
 * / imbalance) is run against those live minutes via the shared
 * `analyzeMinutes` core, so it is genuinely intraday — not yesterday's
 * nightly snapshot.
 *
 * Collected data is used for the STATIC context only: the LVN-edge /
 * POC level stack (RTH-defined, valid all day). The minutes and every
 * event (absorption / divergence / reclaim / imbalance) come from the
 * live tick feed — never from the collected snapshot, so no signal is
 * ever produced while the market is closed.
 * ------------------------------------------------------------------ */

import {
  listDatasets,
  computeSheet,
  analyzeMinutes,
  aggregate,
  stats,
  type FootprintMinute,
  type Analysis,
  type LevelSheet,
} from "./gcdata";
import { imbalanceFor, summarizeImb } from "./imbalance";
import { readMechanism, type MechanismRead } from "./mechanism";
import { readPullback, type PullbackRead } from "./pullback";
import { readPriceAction, type PriceActionRead } from "./priceaction";
import {
  composeSignals,
  boxFromMechanism,
  boxFromPriceAction,
  boxFromOptions,
  type Signal,
} from "./signals";
import {
  readOptionsFromSnapshot,
  wallsFromRead,
  type OptionsRead,
  type GammaRead,
} from "./options";
import { utcToFeedStamp, cdtToET } from "./times";
import type { LiveMinute } from "./live";

export type Level = {
  label: string;
  poc: number;
  vah: number;
  val: number;
  lvns: [number, number][];
};

export type CollectedContext = {
  date: string;
  /** the level stack (LVN edges / POC) — static RTH-defined context, valid all day */
  levels: Level[];
};

export type SignalSnapshot = {
  signal: Signal;
  mech: MechanismRead;
  pb: PullbackRead;
  pa: PriceActionRead;
  opt: OptionsRead | null;
  analysis: Analysis | null;
  lastPrice: number;
  timeET: string;
  /** feed-calendar day of the last minute (session identity for dedupe) */
  day: string;
  symbol: string;
  source: "live" | "collected";
  minutes: number;
  vwap: number;
};

/** A completed sweep-reclaim whose reclaim bar was strongly one-sided in the
 *  entry direction — the 67%-win setup measured in the theory lab. */
export type ReclaimSetup = {
  dir: "long" | "short";
  /** the swept swing extreme (the stop's reference) */
  extreme: number;
  /** entry = the reclaim bar's close (or mid when no OHLC) */
  entry: number;
  stop: number;
  target: number;
  risk: number;
  /** buy share of the reclaim bar's volume (0..1) — the confirmation */
  buyPct: number;
  /** feed-clock "HH:mm" of the reclaim bar (dedupe key) */
  t: string;
  timeET: string;
  day: string;
};

const PROFILE_LABELS: Record<string, string> = {
  P0_developing_rth: "P0 Today",
  P1_opening_range: "P1 OpenRange",
  P2_full_session: "P2 FullDay",
  P3_overnight: "P3 Overnight",
  P4_prev_day_rth: "P4 PriorDay",
  P5_5day_composite: "P5 5Day",
};

function fmt(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function parseLevels(sheet: LevelSheet): Level[] {
  const out: Level[] = [];
  for (const [key, v] of Object.entries(sheet.profiles)) {
    if (!v) continue;
    out.push({
      label: PROFILE_LABELS[key] ?? key,
      poc: parseFloat(v.POC.replace(/,/g, "")),
      vah: parseFloat(v.VAH.replace(/,/g, "")),
      val: parseFloat(v.VAL.replace(/,/g, "")),
      lvns: v.LVNs.map((z) => {
        const [a, b] = z.split("–").map((s) => parseFloat(s.replace(/,/g, "")));
        return [a, b ?? a] as [number, number];
      }),
    });
  }
  return out;
}

/** Load the collected LEVEL stack for the latest dataset. Levels are the only
 *  collected input the signal uses — the signal itself is live-only. */
export async function loadCollectedContext(): Promise<CollectedContext | null> {
  let datasets: { date: string }[] = [];
  try {
    datasets = await listDatasets();
  } catch {
    datasets = [];
  }
  const date = datasets[0]?.date;
  if (!date) return null;
  const sheet = await computeSheet(date);
  const levels = parseLevels(sheet);
  return { date, levels };
}

/** Convert live (UTC-keyed) minutes into footprint-shaped, feed-clock rows. */
export function liveMinutesToFootprint(mins: LiveMinute[]): FootprintMinute[] {
  const out: FootprintMinute[] = [];
  for (const m of mins) {
    if (!/^\d{2}:\d{2}$/.test(m.t)) continue; // the snapshot's "now" placeholder
    const stamp = utcToFeedStamp(m.t, m.du);
    if (!stamp.hhmm) continue;
    const levels = imbalanceFor(
      Object.entries(m.levels ?? {})
        .map(([p, v]) => ({ price: Number(p), buy: v[0], sell: v[1] }))
        .sort((a, b) => b.price - a.price),
    );
    let num = 0;
    let den = 0;
    for (const l of levels) {
      const v = l.buy + l.sell;
      num += l.price * v;
      den += v;
    }
    out.push({
      t: stamp.hhmm,
      d: stamp.day,
      o: m.o,
      c: m.c,
      high: m.h,
      low: m.l,
      buy: m.buy,
      sell: m.sell,
      delta: m.buy - m.sell,
      vwap: den > 0 ? num / den : (m.h + m.l) / 2,
      levels,
      imb: summarizeImb(levels),
    });
  }
  return out;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * Detect a completed sweep-reclaim whose reclaim bar is strongly one-sided in
 * the entry direction. Fires only when the reclaim bar is the LAST completed
 * minute (so the bar's buy/sell is final — no lookahead, no repaint).
 * Mirrors the theory-lab filter: volume ≥ session median AND ≥65% on the entry
 * side. Stop is 0.5pt beyond the swept extreme; target is 1R.
 */
export function detectOneSidedReclaim(minutes: FootprintMinute[]): ReclaimSetup | null {
  const n = minutes.length;
  if (n < 3) return null;
  const lo = minutes.map((m) => m.low);
  const hi = minutes.map((m) => m.high);
  const mid = minutes.map((m) => (m.high + m.low) / 2);
  const vol = minutes.map((m) => m.buy + m.sell);
  const med = Math.max(50, median(vol));

  let runLo = Infinity;
  let runHi = -Infinity;
  for (let i = 1; i < n; i++) {
    const pl = Math.min(runLo, lo[i - 1]);
    const ph = Math.max(runHi, hi[i - 1]);
    runLo = pl;
    runHi = ph;

    if (lo[i] <= pl - 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) {
        if (mid[j] > pl) {
          if (j === n - 1) {
            const bar = minutes[j];
            const total = bar.buy + bar.sell;
            const buyPct = total > 0 ? bar.buy / total : 0.5;
            if (total >= med && buyPct >= 0.65) {
              const entry = bar.c > 0 ? bar.c : mid[j];
              const stop = pl - 0.5;
              const risk = entry - stop;
              if (risk > 0) {
                return {
                  dir: "long", extreme: pl, entry, stop, target: entry + risk, risk, buyPct,
                  t: bar.t, timeET: cdtToET(bar.t), day: bar.d ?? "",
                };
              }
            }
          }
          break;
        }
      }
    }

    if (hi[i] >= ph + 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) {
        if (mid[j] < ph) {
          if (j === n - 1) {
            const bar = minutes[j];
            const total = bar.buy + bar.sell;
            const buyPct = total > 0 ? bar.buy / total : 0.5;
            if (total >= med && buyPct <= 0.35) {
              const entry = bar.c > 0 ? bar.c : mid[j];
              const stop = ph + 0.5;
              const risk = stop - entry;
              if (risk > 0) {
                return {
                  dir: "short", extreme: ph, entry, stop, target: entry - risk, risk, buyPct,
                  t: bar.t, timeET: cdtToET(bar.t), day: bar.d ?? "",
                };
              }
            }
          }
          break;
        }
      }
    }
  }
  return null;
}

/** cumulative session VWAP from live minutes (since the feed connected) */
export function liveVwap(mins: FootprintMinute[]): number {
  let num = 0;
  let den = 0;
  for (const m of mins) {
    const v = m.buy + m.sell;
    if (v <= 0) continue;
    const px = m.c > 0 ? (m.high + m.low + m.c) / 3 : (m.high + m.low) / 2;
    num += px * v;
    den += v;
  }
  return den > 0 ? num / den : 0;
}

function newsWindow(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etMin = et.getHours() * 60 + et.getMinutes();
  return [510, 600, 840].some((r) => Math.abs(etMin - r) <= 5);
}

const EMPTY_STATS = { total: 0, poc: 0, pocVolume: 0, vah: 0, val: 0, lvns: [] as [number, number][], nRows: 0 };

/**
 * Compute the full live signal from footprint-shaped minutes (feed clock).
 * Pure in the minutes/levels/gamma inputs; no network or file access.
 */
export function computeSignal(
  minutes: FootprintMinute[],
  ctx: CollectedContext | null,
  opts: {
    lastPrice: number;
    vwap: number;
    sessionHigh: number;
    sessionLow: number;
    gamma: GammaRead | null;
    symbol: string;
    source: "live" | "collected";
  },
): SignalSnapshot {
  const { lastPrice, vwap, sessionHigh, sessionLow, gamma, symbol, source } = opts;
  const levels = ctx?.levels ?? [];

  const byDist = (a: { p: number }, b: { p: number }) => Math.abs(a.p - lastPrice) - Math.abs(b.p - lastPrice);

  const minPrice = minutes.length ? Math.min(...minutes.map((m) => m.low)) : 0;
  const maxPrice = minutes.length ? Math.max(...minutes.map((m) => m.high)) : 0;

  // rebuild the cents-keyed aggregate so analyzeMinutes can tag alerts + run absorption
  const candles = minutes.map((m) => ({
    t: `${m.d ?? new Date().toISOString().slice(0, 10)}T${m.t}:00-05:00`,
    high: Math.round(m.high * 100),
    low: Math.round(m.low * 100),
    total: m.buy + m.sell,
    buy: m.buy,
    sell: m.sell,
    levels: Object.fromEntries(
      m.levels.map((l) => [String(Math.round(l.price * 100)), [l.buy + l.sell, l.buy, l.sell, l.bTrades, l.sTrades] as [number, number, number, number, number]]),
    ),
  }));
  const rows = aggregate(candles, 4);
  const s = stats(rows) ?? EMPTY_STATS;

  // Location candidates: the prior-day level stack PLUS a live-developing P0
  // profile. The aggregate `s` (in cents) IS today's developing footprint
  // profile, so merge its LVN edges + POC — otherwise a gapping/trending day
  // trades outside the prior sheet and "location" can never be "yes" at
  // today's actual turning points.
  const lvnEdges = levels.flatMap((l) =>
    l.lvns.flatMap(([a, b]) => [
      { label: l.label, p: a, zone: `${fmt(a)}–${fmt(b)}` },
      { label: l.label, p: b, zone: `${fmt(a)}–${fmt(b)}` },
    ]),
  );
  for (const [a, b] of s.lvns) {
    const pa = a / 100;
    const pb = b / 100;
    lvnEdges.push({ label: "P0 Live", p: pa, zone: `${fmt(pa)}–${fmt(pb)}` });
    lvnEdges.push({ label: "P0 Live", p: pb, zone: `${fmt(pa)}–${fmt(pb)}` });
  }
  const pocCands = levels.filter((l) => Number.isFinite(l.poc)).map((l) => ({ label: `${l.label} POC`, p: l.poc }));
  if (s.poc > 0) pocCands.unshift({ label: "P0 Live POC", p: s.poc / 100 });
  const nearestPoc = pocCands.length ? [...pocCands].sort(byDist)[0] : null;

  const analysis: Analysis | null = minutes.length
    ? analyzeMinutes(minutes, minPrice, maxPrice, rows, s, vwap, 4, 0)
    : null;

  const opt = gamma && lastPrice > 0 ? readOptionsFromSnapshot(gamma, lastPrice) : null;

  const mech = readMechanism({
    minutes: minutes.map((m) => ({ t: m.t, high: m.high, low: m.low, delta: m.buy - m.sell })),
    lastPrice,
    vwap,
    absorption: analysis?.absorption ?? [],
    alerts: analysis?.alerts ?? [],
    reclaims: analysis?.reclaims ?? [],
    imbalance: analysis?.imbalance ?? null,
    lvnEdges,
    poc: nearestPoc,
    sessionHigh,
    sessionLow,
    walls: opt ? wallsFromRead(opt) : undefined,
    newsWin: newsWindow(),
  });

  const pa = readPriceAction({
    minutes: minutes.map((m) => ({ high: m.high, low: m.low, t: m.t, d: m.d })),
    lastPrice,
    sessionHigh,
    sessionLow,
  });

  const pb = readPullback({
    minutes: minutes.map((m) => ({ t: m.t, high: m.high, low: m.low, delta: m.buy - m.sell })),
    lastPrice,
    vwap,
    poc: nearestPoc,
    sessionHigh,
    sessionLow,
    imbalance: analysis?.imbalance ?? null,
    newsWin: newsWindow(),
  });

  const signal = composeSignals([
    boxFromMechanism(mech),
    boxFromPriceAction(pa),
    ...(opt ? [boxFromOptions(opt)] : []),
  ]);

  const lastT = minutes.length ? minutes[minutes.length - 1].t : "—";
  const timeET = minutes.length ? cdtToET(lastT) : "—";
  const day = minutes.length ? minutes[minutes.length - 1].d ?? "" : "";

  return {
    signal,
    mech,
    pb,
    pa,
    opt,
    analysis,
    lastPrice,
    timeET,
    day,
    symbol,
    source,
    minutes: minutes.length,
    vwap,
  };
}
