import { promises as fs } from "fs";
import path from "path";
import { imbalanceFor, summarizeImb, type FPLevel, type ImbSummary } from "./imbalance";
import { dbEnabled, dbListDatasets, dbLoadDay, dbLoadOhlc, dbLoadSheet } from "./gcdb";
import { parseChain, inferSpot, computeGamma, computeGammaByExpiry, type GammaRead, type OptionRow } from "./options";

export type { ImbSide, ImbStack, ImbSummary } from "./imbalance";

/* ------------------------------------------------------------------ */
/* Server-side GC data layer: mirrors gcdata/profiles.py               */
/* ------------------------------------------------------------------ */

const DATA_DIR =
  process.env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");

const OHLC_DIR = path.join(DATA_DIR, "ohlc");

const OPTIONS_DIR = path.join(DATA_DIR, "options");

const TICK = 25; // cents per tick (0.25 pt)

export type Candle = {
  t: string; // "2026-09-25T08:30:00-05:00"
  high: number;
  low: number;
  total: number;
  buy: number;
  sell: number;
  levels: Record<string, [number, number, number, number, number]>; // priceCents -> [total,buy,sell,bTrades,sTrades]
};

export type Session = "RTH" | "ETH";

const SAFE = /^(\d{4}-\d{2}-\d{2})_(RTH|ETH)\.json$/;

async function loadDay(date: string, session: Session): Promise<Candle[] | null> {
  if (dbEnabled()) return dbLoadDay(date, session);
  const file = `${date}_${session}.json`;
  if (!SAFE.test(file)) return null;
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), "utf8");
    const j = JSON.parse(raw);
    return j.candles ?? null;
  } catch {
    return null;
  }
}

/* ---------------- real 1-minute OHLC (TS/V2 OHLCV) ---------------- */
/* The footprint feed gives per-minute high/low only. collect_ohlc.py    */
/* backfills true open/close/volume so the chart can draw real candles.  */
/* Keys are "HH:mm" in the feed's own (US Central) wall clock.          */

export type OHLCBar = { o: number; h: number; l: number; c: number; v: number };

const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function loadOhlc(date: string): Promise<Map<string, OHLCBar>> {
  if (dbEnabled()) return dbLoadOhlc(date);
  const out = new Map<string, OHLCBar>();
  if (!SAFE_DATE.test(date)) return out;
  try {
    const raw = await fs.readFile(path.join(OHLC_DIR, `${date}.json`), "utf8");
    const j = JSON.parse(raw);
    for (const b of j.bars ?? []) {
      out.set(String(b.t).slice(11, 16), { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  } catch {
    /* no OHLC file for this date — callers fall back to mid-price bars */
  }
  return out;
}

/* ---------------- free CBOE option chain (gamma box) ---------------- */
/* Collected by gcdata/collect_options.py → data/options/<SYMBOL>_<date>.json.
 * QQQ is the liquid, free proxy for NQ (NDX/SPX return 403 from CBOE). */

export async function loadOptionsChain(symbol = "QQQ"): Promise<{ options: OptionRow[]; asOf: string } | null> {
  try {
    const files = await fs.readdir(OPTIONS_DIR);
    const matches = files
      .filter((f) => f.startsWith(`${symbol}_`) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (matches.length === 0) return null;
    const j = JSON.parse(await fs.readFile(path.join(OPTIONS_DIR, matches[0]), "utf8"));
    const asOf = (matches[0].match(/\d{4}-\d{2}-\d{2}/) ?? [])[0] ?? (j.timestamp ?? "").slice(0, 10);
    return { options: j.options ?? [], asOf };
  } catch {
    return null;
  }
}

export async function optionsSnapshot(symbol = "QQQ"): Promise<GammaRead | null> {
  const file = await loadOptionsChain(symbol);
  if (!file || file.options.length === 0) return null;
  const rows = parseChain(file.options);
  const spot = inferSpot(rows);
  const g = computeGamma(rows, spot);
  g.buckets = computeGammaByExpiry(rows, spot, file.asOf);
  return g;
}

export async function listDatasets(): Promise<
  { date: string; sessions: Session[]; candles: Record<Session, number> }[]
> {
  if (dbEnabled()) return dbListDatasets();
  let files: string[] = [];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const map = new Map<string, { sessions: Session[]; candles: Record<Session, number> }>();
  for (const f of files) {
    const m = SAFE.exec(f);
    if (!m) continue;
    const [, date, session] = m;
    const s = session as Session;
    const e = map.get(date) ?? { sessions: [], candles: { RTH: 0, ETH: 0 } };
    if (!e.sessions.includes(s)) e.sessions.push(s);
    try {
      const j = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), "utf8"));
      e.candles[s] = j.candles?.length ?? 0;
    } catch {
      /* ignore */
    }
    map.set(date, e);
  }
  return [...map.entries()]
    .map(([date, v]) => ({ date, sessions: v.sessions, candles: v.candles }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ---------------- aggregation ---------------- */

function inWindow(c: Candle, start?: string, end?: string, before?: string) {
  const hhmm = c.t.slice(11, 16);
  if (before && hhmm >= before) return false;
  if (start && hhmm < start) return false;
  if (end && hhmm > end) return false;
  return true;
}

export function aggregate(
  candles: Candle[],
  rowTicks = 4,
): Map<number, { buy: number; sell: number }> {
  const rows = new Map<number, { buy: number; sell: number }>();
  for (const c of candles) {
    for (const [lvl, [, bv, sv]] of Object.entries(c.levels)) {
      const price = Number(lvl);
      const bucket = Math.round(price / (TICK * rowTicks)) * TICK * rowTicks;
      const r = rows.get(bucket) ?? { buy: 0, sell: 0 };
      r.buy += bv;
      r.sell += sv;
      rows.set(bucket, r);
    }
  }
  return rows;
}

export type ProfileStats = {
  total: number;
  poc: number;
  pocVolume: number;
  vah: number;
  val: number;
  lvns: [number, number][];
  nRows: number;
};

export function stats(
  rows: Map<number, { buy: number; sell: number }>,
  valueArea = 0.7,
  lvnRatio = 0.35,
): ProfileStats | null {
  const buckets = [...rows.keys()].sort((a, b) => a - b);
  if (buckets.length === 0) return null;
  const vol = (b: number) => rows.get(b)!.buy + rows.get(b)!.sell;
  let total = 0;
  for (const b of buckets) total += vol(b);
  const poc = buckets.reduce((a, b) => (vol(b) > vol(a) ? b : a), buckets[0]);
  const order = [...buckets].sort((a, b) => vol(b) - vol(a));
  const va = new Set<number>();
  let acc = 0;
  for (const b of order) {
    va.add(b);
    acc += vol(b);
    if (acc >= valueArea * total) break;
  }
  const med = [...buckets].map(vol).sort((a, b) => a - b)[buckets.length >> 1];
  const lvnLevels = buckets.filter((b) => vol(b) <= Math.max(1, lvnRatio * med));
  const zones: [number, number][] = [];
  for (const b of lvnLevels.sort((a, b) => a - b)) {
    const last = zones[zones.length - 1];
    if (last && b <= last[1] + TICK * 4) last[1] = b;
    else zones.push([b, b]);
  }
  // keep only zones at least 1 pt wide (thin single rows are noise as "zones")
  const wide = zones.filter(([a, b]) => b - a >= TICK * 4);
  return {
    total,
    poc,
    pocVolume: vol(poc),
    vah: Math.max(...va),
    val: Math.min(...va),
    lvns: wide,
    nRows: buckets.length,
  };
}

/* ---------------- level sheet ---------------- */

export type SheetProfile = {
  total: number;
  POC: string;
  VAH: string;
  VAL: string;
  LVNs: string[];
  rows: number;
  rowSizeTicks: number;
};

export type LevelSheet = {
  asof: string;
  prevTradingDay: string | null;
  profiles: Record<string, SheetProfile | null>;
  nakedPOCZone: string | null;
};

export async function computeSheet(date: string, compositeDays = 5): Promise<LevelSheet> {
  if (dbEnabled()) {
    const stored = await dbLoadSheet(date);
    // only trust the store when every profile the UI needs is present
    if (stored && Object.values(stored.profiles).filter(Boolean).length >= 6) return stored;
  }
  const rth = (d: string) => loadDay(d, "RTH");
  const eth = (d: string) => loadDay(d, "ETH");

  let prevTrading: string | null = null;
  {
    const base = new Date(date + "T00:00:00Z");
    for (let i = 1; i < 9 && !prevTrading; i++) {
      const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
      const c = await rth(d);
      if (c && c.length) prevTrading = d;
    }
  }

  const todayRth = (await rth(date)) ?? [];
  const todayEth = (await eth(date)) ?? [];

  const or = todayRth.filter((c) => inWindow(c, "08:30", "08:59"));
  const on = todayEth.filter((c) => inWindow(c, undefined, undefined, "08:30"));

  const comp: Candle[] = [];
  const compDays: string[] = [];
  {
    const base = new Date(date + "T00:00:00Z");
    for (let i = 0; i < 12 && compDays.length < compositeDays; i++) {
      const d = new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10);
      const c = await rth(d);
      if (c && c.length) {
        comp.push(...c);
        compDays.push(d);
      }
    }
  }

  const fmt = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

  const mk = (rows: Map<number, { buy: number; sell: number }>, rowTicks = 4): SheetProfile | null => {
    const s = stats(rows);
    if (!s) return null;
    return {
      total: s.total,
      POC: fmt(s.poc),
      VAH: fmt(s.vah),
      VAL: fmt(s.val),
      LVNs: s.lvns.slice(0, 10).map(([a, b]) => `${fmt(a)}–${fmt(b)}`),
      rows: s.nRows,
      rowSizeTicks: rowTicks,
    };
  };

  // Keys are RENUMBERED BY RECENCY: P0 = most recent profile, P5 = oldest.
  // (The old P3/P2/P4/P1/P0 order was arbitrary and unreadable.)
  const profiles: Record<string, SheetProfile | null> = {
    P0_developing_rth: mk(aggregate(todayRth)), // today, live from 9:30 ET
    P1_opening_range: mk(aggregate(or)), // today, fixed 9:30-10:00
    P2_full_session: mk(aggregate(todayEth)), // today incl. overnight
    P3_overnight: mk(aggregate(on)), // last night 18:00 -> 9:30
    P4_prev_day_rth: prevTrading ? mk(aggregate((await rth(prevTrading)) ?? [])) : null, // yesterday
    [`P5_${compositeDays}day_composite`]: mk(aggregate(comp)), // trailing sessions (oldest)
  };

  let nakedPOCZone: string | null = null;
  if (prevTrading) {
    const pdRows = aggregate((await rth(prevTrading)) ?? []);
    const pd = stats(pdRows);
    const todayRows = aggregate(todayRth);
    if (pd) {
      const step = TICK * 4;
      const missing: string[] = [];
      for (let lvl = pd.poc - 3 * step; lvl <= pd.poc + 3 * step; lvl += step) {
        if (!(todayRows.get(lvl) && todayRows.get(lvl)!.buy + todayRows.get(lvl)!.sell > 0)) {
          missing.push(fmt(lvl));
        }
      }
      nakedPOCZone = missing.length ? `${fmt(pd.poc)} (unrevisited: ${missing.join(", ")})` : fmt(pd.poc);
    }
  }

  return { asof: date, prevTradingDay: prevTrading, profiles, nakedPOCZone };
}

/* ---------------- profile rows + footprint window ---------------- */

export type ProfileRows = {
  rows: { price: number; buy: number; sell: number }[];
  stats: ProfileStats;
};

export async function computeProfile(
  date: string,
  session: Session,
  start?: string,
  end?: string,
  rowTicks = 4,
): Promise<ProfileRows | null> {
  const candles = (await loadDay(date, session)) ?? [];
  const sel = candles.filter((c) => inWindow(c, start, end));
  const rows = aggregate(sel, rowTicks);
  const s = stats(rows);
  if (!s) return null;
  return {
    rows: [...rows.entries()]
      .map(([price, v]) => ({ price: price / 100, buy: v.buy, sell: v.sell }))
      .sort((a, b) => b.price - a.price),
    stats: {
      total: s.total,
      poc: s.poc / 100,
      pocVolume: s.pocVolume,
      vah: s.vah / 100,
      val: s.val / 100,
      lvns: s.lvns.map(([a, b]) => [a / 100, b / 100] as [number, number]),
      nRows: s.nRows,
    },
  };
}

export type FootprintMinute = {
  t: string;
  /** calendar date of this bar, in the feed's own clock. Needed because the
   *  overnight session spans two dates (18:00 → 17:00) while `t` is only HH:mm */
  d: string;
  o: number; // true open (0 when no OHLC for this date)
  c: number; // true close (0 when no OHLC)
  high: number;
  low: number;
  buy: number;
  sell: number;
  delta: number;
  vwap: number; // single-print VWAP of the minute (Σ price x vol / Σ vol)
  levels: FPLevel[];
  imb: ImbSummary;
};

export async function extractFootprint(
  date: string,
  session: Session,
  start?: string,
  end?: string,
): Promise<{ minutes: FootprintMinute[]; minPrice: number; maxPrice: number; ohlcBars: number } | null> {
  const candles = (await loadDay(date, session)) ?? [];
  const sel = candles.filter((c) => inWindow(c, start, end));
  if (sel.length === 0) return null;
  const ohlc = await loadOhlc(date);
  let ohlcBars = 0;
  const minutes: FootprintMinute[] = sel.map((c) => {
    const key = c.t.slice(11, 16);
    const bar = ohlc.get(key);
    if (bar) ohlcBars++;
    const levels = imbalanceFor(
      Object.entries(c.levels)
        .map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2], bTrades: v[3], sTrades: v[4] }))
        .sort((a, b) => b.price - a.price),
    );
    let num = 0;
    let den = 0;
    for (const l of levels) {
      const v = l.buy + l.sell;
      num += l.price * v;
      den += v;
    }
    return {
      t: key,
      d: c.t.slice(0, 10),
      o: bar?.o ?? 0,
      c: bar?.c ?? 0,
      high: c.high / 100,
      low: c.low / 100,
      buy: c.buy,
      sell: c.sell,
      delta: c.buy - c.sell,
      vwap: den > 0 ? num / den : (c.high + c.low) / 200,
      levels,
      imb: summarizeImb(levels),
    };
  });
  const minPrice = Math.min(...minutes.map((m) => m.low));
  const maxPrice = Math.max(...minutes.map((m) => m.high));
  return { minutes, minPrice, maxPrice, ohlcBars };
}

/* ---------------- analysis: LVNs, absorption, alerts ---------------- */

export type AbsorbEvent = {
  t: string;
  price: number;
  side: "bid" | "ask";
  bias: "bull" | "bear";
  volume: number;
  imbalance: number; // 0..1 dominance of the aggressive side
  defendedBars: number;
};

export type AlertEvent = {
  t: string;
  kind: "LVN_ENTER" | "LVN_EXIT" | "DIVERGENCE_D2" | "DIVERGENCE_D4" | "ABSORPTION" | "INITIATIVE";
  price: number;
  side: "bid" | "ask" | null;
  vwapSide: "above" | "below";
  bias: "bull" | "bear" | null;
  deltaPct: number | null;
  message: string;
};

export type Reclaim = { t: string; price: number; dir: "low" | "high" };

export type ImbalanceRollup = {
  buyRows: number; // rows with any buy-side imbalance across the window
  sellRows: number;
  dBuyRows: number;
  dSellRows: number;
  stackedMinutes: number; // minutes containing a >=3-row same-side stack
  stacks: { t: string; side: "buy" | "sell"; from: number; to: number; len: number }[];
  lastStack: { t: string; side: "buy" | "sell"; from: number; to: number; len: number } | null;
  lastMinute: ImbSummary | null;
};

export type Analysis = {
  rows: { price: number; buy: number; sell: number }[];
  stats: ProfileStats;
  hvns: [number, number][];
  vwap: number;
  absorption: AbsorbEvent[];
  alerts: AlertEvent[];
  reclaims: Reclaim[];
  imbalance: ImbalanceRollup;
  ohlc: { bars: number; minutes: number };
  window: { minutes: number };
};

const NEAR = 2.5; // pts: location tolerance

function sessionVwap(candles: Candle[], ohlc?: Map<string, OHLCBar>): number {
  let num = 0;
  let den = 0;
  for (const c of candles) {
    const bar = ohlc?.get(c.t.slice(11, 16));
    // typical price when real OHLC exists, otherwise the bar mid
    const px = bar ? (bar.h + bar.l + bar.c) / 3 : ((c.high ?? 0) + (c.low ?? 0)) / 2 / 100;
    const v = bar?.v || c.total || c.buy + c.sell;
    num += px * v;
    den += v;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The analysis core, factored out of `analyze()` so it can run against LIVE
 * minutes (built from the GoCharting tick feed) as well as collected files.
 * `minutes` are footprint-shaped rows (feed-clock keys); `minPrice`/`maxPrice`
 * bound the window the absorption "near extreme" check runs against; `rows`
 * and `s` are the aggregate profile (cents) used to tag alerts; `vwap` is the
 * session reference already resolved by the caller.
 */
export function analyzeMinutes(
  minutes: FootprintMinute[],
  minPrice: number,
  maxPrice: number,
  rows: Map<number, { buy: number; sell: number }>,
  s: ProfileStats,
  vwap: number,
  rowTicks: number,
  ohlcBars: number,
): Analysis {
  // HVN = top-volume rows (contiguous groups)
  const sorted = [...rows.entries()].sort((a, b) => b[1].buy + b[1].sell - (a[1].buy + a[1].sell));
  const hvnLevels = sorted.slice(0, 12).map(([p]) => p).sort((a, b) => a - b);
  const hvns: [number, number][] = [];
  for (const p of hvnLevels) {
    const last = hvns[hvns.length - 1];
    if (last && p <= last[1] + TICK * rowTicks) last[1] = p;
    else hvns.push([p, p]);
  }

  // ---- absorption: heavy one-sided row, price fails to move through it ----
  const levelVols: number[] = [];
  for (const m of minutes) for (const l of m.levels) levelVols.push(l.buy + l.sell);
  levelVols.sort((a, b) => a - b);
  const med = levelVols[levelVols.length >> 1] ?? 0;
  const volFloor = Math.max(50, med * 1.5);
  const range = maxPrice - minPrice;
  const absorption: AbsorbEvent[] = [];
  const seen = new Set<string>();

  minutes.forEach((m, mi) => {
    for (const l of m.levels) {
      const total = l.buy + l.sell;
      if (total < volFloor) continue;
      const dom = Math.abs(l.buy - l.sell) / total;
      if (dom < 0.6) continue;
      const askSide = l.buy > l.sell;
      // only near extremes: ask-dominant near top, bid-dominant near bottom
      const pos = (l.price - minPrice) / Math.max(range, 0.25);
      if (askSide && pos < 0.7) continue;
      if (!askSide && pos > 0.3) continue;
      // progress check over next 3 minutes
      let broke = false;
      for (let j = mi + 1; j < Math.min(minutes.length, mi + 4); j++) {
        if (askSide && minutes[j].high >= l.price + 0.5) { broke = true; break; }
        if (!askSide && minutes[j].low <= l.price - 0.5) { broke = true; break; }
      }
      if (broke) continue;
      const key = `${l.price}|${askSide ? "a" : "b"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      absorption.push({
        t: m.t,
        price: l.price,
        side: askSide ? "ask" : "bid",
        bias: askSide ? "bear" : "bull",
        volume: total,
        imbalance: dom,
        defendedBars: Math.min(3, minutes.length - mi - 1),
      });
    }
  });
  absorption.sort((a, b) => (a.t < b.t ? -1 : 1));

  // ---- pivots & divergence ----
  const n = minutes.length;
  const hi = minutes.map((m) => m.high);
  const lo = minutes.map((m) => m.low);
  const mid = minutes.map((m) => (m.high + m.low) / 2);
  let cum = 0;
  const cvd = minutes.map((m) => (cum += m.buy - m.sell));
  const pLows: number[] = [];
  const pHighs: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (lo[i] < Math.min(lo[i - 1], lo[i - 2], lo[i + 1], lo[i + 2])) pLows.push(i);
    if (hi[i] > Math.max(hi[i - 1], hi[i - 2], hi[i + 1], hi[i + 2])) pHighs.push(i);
  }

  const nearLevel = (p: number) => {
    if (Math.abs(p - s.poc / 100) <= NEAR) return "POC";
    if (Math.abs(p - s.vah / 100) <= NEAR) return "VAH";
    if (Math.abs(p - s.val / 100) <= NEAR) return "VAL";
    for (const [a, b] of s.lvns) if (p >= a / 100 - NEAR && p <= b / 100 + NEAR) return "LVN";
    for (const [a, b] of hvns) if (p >= a / 100 - NEAR && p <= b / 100 + NEAR) return "HVN";
    return null;
  };

  const alerts: AlertEvent[] = [];
  const vwapSide = (p: number): "above" | "below" => (p >= vwap ? "above" : "below");
  const deltaPct = (m: FootprintMinute) => (m.buy - m.sell) / Math.max(1, m.buy + m.sell);

  // LVN enter / exit
  const inLvn = (p: number) => s.lvns.some(([a, b]) => p >= a / 100 && p <= b / 100);
  minutes.forEach((m, i) => {
    const was = i > 0 ? inLvn(mid[i - 1]) : false;
    const is = inLvn(mid[i]);
    if (is && !was)
      alerts.push({ t: m.t, kind: "LVN_ENTER", price: mid[i], side: null, vwapSide: vwapSide(mid[i]), bias: null, deltaPct: deltaPct(m), message: `price entered an LVN zone (${s.lvns.length} zones in window)` });
    if (!is && was)
      alerts.push({ t: m.t, kind: "LVN_EXIT", price: mid[i], side: null, vwapSide: vwapSide(mid[i]), bias: null, deltaPct: deltaPct(m), message: "price exited the LVN zone" });
  });

  // Divergence D2 / D4 across EVERY consecutive pivot pair.
  for (let k = 1; k < pLows.length; k++) {
    const i1 = pLows[k - 1];
    const i2 = pLows[k];
    if (lo[i2] < lo[i1] && cvd[i2] > cvd[i1]) {
      const loc = nearLevel(lo[i2]);
      alerts.push({
        t: minutes[i2].t, kind: "DIVERGENCE_D2", price: lo[i2], side: null,
        vwapSide: vwapSide(lo[i2]), bias: "bull", deltaPct: deltaPct(minutes[i2]),
        message: `price lower low, CVD higher low ${loc ? `at ${loc}` : "(mid-range — weak)"}`,
      });
    }
  }
  for (let k = 1; k < pHighs.length; k++) {
    const i1 = pHighs[k - 1];
    const i2 = pHighs[k];
    if (hi[i2] > hi[i1] && cvd[i2] < cvd[i1]) {
      const loc = nearLevel(hi[i2]);
      alerts.push({
        t: minutes[i2].t, kind: "DIVERGENCE_D4", price: hi[i2], side: null,
        vwapSide: vwapSide(hi[i2]), bias: "bear", deltaPct: deltaPct(minutes[i2]),
        message: `price higher high, CVD lower high ${loc ? `at ${loc}` : "(mid-range — weak)"}`,
      });
    }
  }

  // absorption events → alerts
  for (const a of absorption.slice(-10)) {
    const loc = nearLevel(a.price);
    alerts.push({
      t: a.t, kind: "ABSORPTION", price: a.price, side: a.side,
      vwapSide: vwapSide(a.price), bias: a.bias, deltaPct: null,
      message: `${a.side === "bid" ? "sell aggression" : "buy aggression"} of ${a.volume} contracts (${(a.imbalance * 100).toFixed(0)}% one-sided) held ${a.defendedBars} bars ${loc ? `at ${loc}` : ""}`,
    });
  }

  // initiative bars
  minutes.forEach((m, i) => {
    const dp = deltaPct(m);
    if (i === 0) return;
    if (dp <= -0.2 && m.low < lo[i - 1]) {
      const loc = nearLevel(m.low);
      alerts.push({
        t: m.t, kind: "INITIATIVE", price: m.low, side: "bid", vwapSide: vwapSide(mid[i]),
        bias: "bear", deltaPct: dp,
        message: `delta ${(dp * 100).toFixed(0)}% of volume with a lower low${loc ? ` at ${loc}` : ""}`,
      });
    } else if (dp >= 0.2 && m.high > hi[i - 1]) {
      const loc = nearLevel(m.high);
      alerts.push({
        t: m.t, kind: "INITIATIVE", price: m.high, side: "ask", vwapSide: vwapSide(mid[i]),
        bias: "bull", deltaPct: dp,
        message: `delta +${(dp * 100).toFixed(0)}% of volume with a higher high${loc ? ` at ${loc}` : ""}`,
      });
    }
  });

  alerts.sort((a, b) => (a.t < b.t ? -1 : 1));

  // reclaims: new extreme beyond the prior extreme, then price traded back within 2 bars
  const reclaims: Reclaim[] = [];
  {
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
            reclaims.push({ t: minutes[i].t, price: pl, dir: "low" });
            break;
          }
        }
      }
      if (hi[i] >= ph + 0.25) {
        for (let j = i + 1; j < Math.min(n, i + 3); j++) {
          if (mid[j] < ph) {
            reclaims.push({ t: minutes[i].t, price: ph, dir: "high" });
            break;
          }
        }
      }
    }
  }

  // ---- imbalance rollup (footprint bid x ask pressure per tick) ----
  const imbalance: ImbalanceRollup = {
    buyRows: 0,
    sellRows: 0,
    dBuyRows: 0,
    dSellRows: 0,
    stackedMinutes: 0,
    stacks: [],
    lastStack: null,
    lastMinute: minutes[minutes.length - 1]?.imb ?? null,
  };
  for (const m of minutes) {
    imbalance.buyRows += m.imb.buy;
    imbalance.sellRows += m.imb.sell;
    imbalance.dBuyRows += m.imb.dBuy;
    imbalance.dSellRows += m.imb.dSell;
    if (m.imb.stacked) {
      imbalance.stackedMinutes++;
      const st = { t: m.t, ...m.imb.stacked };
      imbalance.stacks.push(st);
      imbalance.lastStack = st;
    }
  }

  return {
    rows: [...rows.entries()]
      .map(([price, v]) => ({ price: price / 100, buy: v.buy, sell: v.sell }))
      .sort((a, b) => b.price - a.price),
    stats: { ...s, poc: s.poc / 100, vah: s.vah / 100, val: s.val / 100, lvns: s.lvns.map(([a, b]) => [a / 100, b / 100] as [number, number]) },
    hvns: hvns.map(([a, b]) => [a / 100, b / 100] as [number, number]),
    vwap,
    absorption,
    alerts,
    reclaims,
    imbalance,
    ohlc: { bars: ohlcBars, minutes: minutes.length },
    window: { minutes: n },
  };
}

export async function analyze(
  date: string,
  session: Session,
  start?: string,
  end?: string,
  rowTicks = 4,
): Promise<Analysis | null> {
  const all = (await loadDay(date, session)) ?? [];
  const sel = all.filter((c) => inWindow(c, start, end));
  if (sel.length === 0) return null;
  const fp = await extractFootprint(date, session, start, end);
  if (!fp) return null;
  const minutes = fp.minutes;

  const rows = aggregate(sel, rowTicks);
  const s = stats(rows);
  if (!s) return null;
  const ohlcMap = await loadOhlc(date);
  // whole-session VWAP by default; a windowed request gets the VWAP OF THAT
  // WINDOW, otherwise every alert's vwapSide is judged against a reference the
  // caller never asked for
  const vwap = start || end ? sessionVwap(sel, ohlcMap) : sessionVwap(all, ohlcMap);

  return analyzeMinutes(minutes, fp.minPrice, fp.maxPrice, rows, s, vwap, rowTicks, fp.ohlcBars);
}
