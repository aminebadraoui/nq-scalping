/* ------------------------------------------------------------------ *
 * ES cross-asset join — the ES twin of every NQ session.
 *
 * The ES archive (gcdata/data/es, R2 data/es/* + manifest-es.json) holds
 * 1-min ES footprint data for the same dates as the NQ store, served by
 * the same vendor with the same feed-clock timestamps. That makes the
 * join a pure same-minute alignment on the candle's internal (date, time)
 * key — no clock gymnastics.
 *
 * Everything here is computed from completed bars only: the context arrays
 * are running/cumulative through minute i, so any feature asked at index k
 * (the NQ flush bar or entry bar) sees only information available at k.
 *
 * ES is a CONTEXT layer, never a trigger: the features here tier and gate
 * the footprint-native NQ signals — flush agreement, breakdown veto, delta
 * divergence, relative strength. See ES_DATA.md + DATA_DIMENSIONS_RESEARCH.md
 * §4.2.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const REMOTE = process.env.GC_REMOTE_URL?.replace(/\/+$/, "") ?? "";
const ES_CACHE = process.env.ES_CACHE_DIR || path.join(os.homedir(), ".cache", "nq-archive", "es");

export type EsMinute = {
  t: string; // feed clock "HH:mm"
  d: string; // feed calendar date "YYYY-MM-DD"
  high: number; // pts
  low: number;
  buy: number;
  sell: number;
  total: number;
  mid: number; // (high+low)/2 — the archive has no true closes
};

/** Per-NQ-minute ES context. Every array is indexed by NQ minute index and
 *  carries the value known through that minute (no lookahead). */
export type EsContext = {
  /** true when at least one aligned ES minute exists */
  has: boolean;
  /** per-minute alignment: ES minute exists for this NQ minute */
  ok: boolean[];
  mid: number[];
  high: number[];
  low: number[];
  buy: number[];
  sell: number[];
  total: number[];
  /** buy − sell per minute */
  delta: number[];
  /** session cumulative delta through the minute */
  cumDelta: number[];
  /** one-sided fractions: buy/total, sell/total (0 when total = 0) */
  buyFrac: number[];
  sellFrac: number[];
  /** trailing 60-min median total (0 when no history) */
  med60: number[];
  /** this minute printed a NEW session low/high (strictly beyond the
   *  running extreme known at the previous minute) */
  newLow: boolean[];
  newHigh: boolean[];
  /** running session extremes through the minute */
  sessionLow: number[];
  sessionHigh: number[];
  /** NQ minutes lacking an ES twin (coverage honesty) */
  missing: number;
};

/* ---------------- loading ---------------- */

function localEsPaths(): string[] {
  const cwd = process.cwd();
  const here = import.meta.dirname; // web/lib
  const roots = [cwd, here, path.resolve(here, ".."), path.resolve(here, "../..")];
  const out: string[] = [];
  for (const r of roots) {
    out.push(path.join(r, "gcdata", "data", "es"));
    out.push(path.join(r, "data", "es"));
  }
  return [...new Set(out)];
}

async function readLocalEs(date: string): Promise<EsMinute[] | null> {
  for (const dir of localEsPaths()) {
    try {
      const raw = await fs.readFile(path.join(dir, `${date}_ETH.json`), "utf8");
      return parseEsRaw(raw);
    } catch {
      /* try next */
    }
  }
  return null;
}

function parseEsRaw(raw: string): EsMinute[] {
  const j = JSON.parse(raw) as { candles?: { t: string; high: number; low: number; buy: number; sell: number; total: number }[] };
  const candles = j.candles ?? [];
  if (candles.length < 60) return [];
  return candles.map((c) => ({
    t: c.t.slice(11, 16),
    d: c.t.slice(0, 10),
    high: c.high / 100,
    low: c.low / 100,
    buy: c.buy,
    sell: c.sell,
    total: c.total,
    mid: (c.high + c.low) / 200,
  }));
}

/** Load the ES ETH session for a date: local gcdata/data/es first, then a
 *  persistent gzip cache, then R2. Returns null when the date has no ES data. */
export async function loadEsMinutes(date: string): Promise<EsMinute[] | null> {
  const local = await readLocalEs(date);
  if (local) return local;

  await fs.mkdir(ES_CACHE, { recursive: true }).catch(() => {});
  const gzFile = path.join(ES_CACHE, `${date}_ETH.json.gz`);
  try {
    const raw = gunzipSync(await fs.readFile(gzFile));
    return parseEsRaw(raw.toString("utf8"));
  } catch {
    /* fall through */
  }
  if (!REMOTE) return null;
  const r = await fetch(`${REMOTE}/data/es/${date}_ETH.json`);
  if (!r.ok) return null;
  const raw = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(gzFile, gzipSync(raw)).catch(() => {});
  return parseEsRaw(raw.toString("utf8"));
}

/* ---------------- context ---------------- */

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildEsContext(
  nq: { t: string; d: string; high: number; low: number }[],
  es: EsMinute[],
): EsContext {
  const n = nq.length;
  const byKey = new Map<string, number>();
  es.forEach((m, i) => byKey.set(`${m.d}|${m.t}`, i));

  const ok: boolean[] = new Array(n).fill(false);
  const mid: number[] = new Array(n).fill(0);
  const high: number[] = new Array(n).fill(0);
  const low: number[] = new Array(n).fill(0);
  const buy: number[] = new Array(n).fill(0);
  const sell: number[] = new Array(n).fill(0);
  const total: number[] = new Array(n).fill(0);
  const delta: number[] = new Array(n).fill(0);
  const cumDelta: number[] = new Array(n).fill(0);
  const buyFrac: number[] = new Array(n).fill(0);
  const sellFrac: number[] = new Array(n).fill(0);
  const med60: number[] = new Array(n).fill(0);
  const newLow: boolean[] = new Array(n).fill(false);
  const newHigh: boolean[] = new Array(n).fill(false);
  const sessionLow: number[] = new Array(n).fill(0);
  const sessionHigh: number[] = new Array(n).fill(0);

  const win: number[] = [];
  let cum = 0;
  let runLow = Infinity;
  let runHigh = -Infinity;
  let missing = 0;

  for (let i = 0; i < n; i++) {
    const m = nq[i];
    const e = byKey.get(`${m.d}|${m.t}`);
    if (e === undefined) {
      missing++;
      win.push(0);
      continue;
    }
    ok[i] = true;
    const x = es[e];
    mid[i] = x.mid;
    high[i] = x.high;
    low[i] = x.low;
    buy[i] = x.buy;
    sell[i] = x.sell;
    total[i] = x.total;
    delta[i] = x.buy - x.sell;
    cum += x.buy - x.sell;
    cumDelta[i] = cum;
    buyFrac[i] = x.total ? x.buy / x.total : 0;
    sellFrac[i] = x.total ? x.sell / x.total : 0;
    win.push(x.total);
    if (win.length > 60) win.shift();
    med60[i] = med(win);
    newLow[i] = runLow !== Infinity && x.low < runLow - 0.25;
    newHigh[i] = runHigh !== -Infinity && x.high > runHigh + 0.25;
    runLow = Math.min(runLow, x.low);
    runHigh = Math.max(runHigh, x.high);
    sessionLow[i] = runLow;
    sessionHigh[i] = runHigh;
  }
  return { has: es.length > 0, ok, mid, high, low, buy, sell, total, delta, cumDelta, buyFrac, sellFrac, med60, newLow, newHigh, sessionLow, sessionHigh, missing };
}

/* ---------------- features (indexed by NQ minute) ---------------- */

const ES_FLUSH_FRAC = 0.7; // one-sided share for an ES flush (mirror of NQ's 0.70)
const FLUSH_WINDOW = 2; // lookback bars from the NQ flush bar
const VETO_WINDOW = 5; // entry-neighborhood bars for the breakdown veto
const DELTA_FLAT = 100; // |cumDelta| below this is "flat" (ES contracts)
const RS_WINDOW = 60;
const RS_MIN_SAMPLES = 30;
const RS_Z = 1.0; // band threshold in z units

function esVolumeFloor(ctx: EsContext, j: number): number {
  return Math.max(15, Math.min(0.5 * ctx.med60[j], 250));
}

/** ES flush agreement at the NQ flush bar k.
 *  long: agree = ES also flushed sell-side in [k−2,k] AND printed no new
 *        session low there; diverge = ES printed a new session low (broad
 *        tape breaking down while NQ "holds"); neutral = neither.
 *  Mirrored for shorts. */
export function flushAgreement(ctx: EsContext, k: number, dir: "long" | "short"): "agree" | "diverge" | "neutral" {
  if (!ctx.has || k < 0) return "neutral";
  const lo = Math.max(0, k - FLUSH_WINDOW);
  const hi = Math.min(ctx.ok.length - 1, k);
  if (hi < lo) return "neutral";
  let flushed = false;
  let broke = false;
  for (let j = lo; j <= hi; j++) {
    if (!ctx.ok[j]) continue;
    const floor = esVolumeFloor(ctx, j);
    if (dir === "long") {
      if (ctx.sellFrac[j] >= ES_FLUSH_FRAC && ctx.total[j] >= floor) flushed = true;
      if (ctx.newLow[j]) broke = true;
    } else {
      if (ctx.buyFrac[j] >= ES_FLUSH_FRAC && ctx.total[j] >= floor) flushed = true;
      if (ctx.newHigh[j]) broke = true;
    }
  }
  if (broke) return "diverge";
  return flushed ? "agree" : "neutral";
}

/** The ES session-extreme gate: skip NQ longs when ES printed a new session
 *  low in the 5 bars ending at the entry bar (mirror: new high for shorts).
 *  Account-protection veto — "never fade a broad-market breakdown". */
export function breakdownVeto(ctx: EsContext, entryIdx: number, dir: "long" | "short"): boolean {
  if (!ctx.has || entryIdx < 0) return false;
  const lo = Math.max(0, entryIdx - VETO_WINDOW);
  const hi = Math.min(ctx.ok.length - 1, entryIdx);
  for (let j = lo; j <= hi; j++) {
    if (!ctx.ok[j]) continue;
    if (dir === "long" && ctx.newLow[j]) return true;
    if (dir === "short" && ctx.newHigh[j]) return true;
  }
  return false;
}

/** ES cumulative-delta sign through the NQ flush bar — the cross-market
 *  absorption evidence (ES buyers absorbing while NQ prints the flush). */
export function esDeltaSign(ctx: EsContext, k: number): "pos" | "neg" | "flat" {
  if (!ctx.has || k < 0 || !ctx.ok[k]) return "flat";
  const cd = ctx.cumDelta[k];
  if (cd >= DELTA_FLAT) return "pos";
  if (cd <= -DELTA_FLAT) return "neg";
  return "flat";
}

/** Relative-strength band: z-score of the NQ−ES points spread over the
 *  trailing 60 min. strong = NQ gaining on ES (z > +1), weak = NQ losing
 *  (z < −1). nqMid = the NQ mid array (same length as the context). */
export function rsBand(ctx: EsContext, nqMid: number[], entryIdx: number): "strong" | "weak" | "neutral" {
  if (!ctx.has || entryIdx < 0) return "neutral";
  const lo = Math.max(0, entryIdx - RS_WINDOW + 1);
  const vals: number[] = [];
  for (let j = lo; j <= entryIdx; j++) {
    if (!ctx.ok[j]) continue;
    vals.push(nqMid[j] - ctx.mid[j]);
  }
  if (vals.length < RS_MIN_SAMPLES) return "neutral";
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (sd === 0) return "neutral";
  const z = (nqMid[entryIdx] - ctx.mid[entryIdx] - mean) / sd;
  if (z > RS_Z) return "strong";
  if (z < -RS_Z) return "weak";
  return "neutral";
}
