/* Shared test fixtures + INDEPENDENT reimplementations of the documented rules.
 * Nothing here imports the app's engine: the point is to re-derive the numbers
 * a second time so a regression in lib/ cannot make a test pass by definition. */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const WEB = path.resolve(import.meta.dirname, "..");
export const DATA = path.join(WEB, "..", "gcdata", "data");
export const TICK = 25; // cents
export const DATE = "2026-09-25";

export function loadDay(date = DATE, session = "RTH") {
  const f = path.join(DATA, `${date}_${session}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")).candles ?? [];
}

export function loadOhlc(date = DATE) {
  const f = path.join(DATA, "ohlc", `${date}.json`);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8")).bars ?? [];
}

export function inWindow(candle, start, end) {
  const hhmm = candle.t.slice(11, 16);
  if (start && hhmm < start) return false;
  if (end && hhmm > end) return false;
  return true;
}

/** half-up bucketing — the convention both engines must share */
export function buckets(candles, rowTicks = 4) {
  const step = TICK * rowTicks;
  const rows = new Map();
  for (const c of candles) {
    for (const [lvl, v] of Object.entries(c.levels)) {
      const b = Math.floor(Number(lvl) / step + 0.5) * step;
      const cur = rows.get(b) ?? { total: 0, buy: 0, sell: 0 };
      cur.total += v[0];
      cur.buy += v[1];
      cur.sell += v[2];
      rows.set(b, cur);
    }
  }
  return rows;
}

export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** independent POC / 70% value area / LVN zones (documented rule) */
export function statsIndependent(candles, rowTicks = 4, va = 0.7, lvnRatio = 0.35) {
  const rows = buckets(candles, rowTicks);
  const keys = [...rows.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;
  const vol = (k) => rows.get(k).total;
  const total = keys.reduce((s, k) => s + vol(k), 0);
  const poc = keys.reduce((best, k) => (vol(k) > vol(best) ? k : best), keys[0]);
  const order = [...keys].sort((a, b) => vol(b) - vol(a) || a - b);
  const set = new Set();
  let acc = 0;
  for (const k of order) {
    set.add(k);
    acc += vol(k);
    if (acc >= va * total) break;
  }
  const inVa = [...set].sort((a, b) => a - b);
  const med = median(keys.map(vol));
  const lvnRows = keys.filter((k) => vol(k) <= Math.max(1, Math.floor(lvnRatio * med)));
  const zones = [];
  for (const k of lvnRows.sort((a, b) => a - b)) {
    if (zones.length && k <= zones[zones.length - 1][1] + 4 * TICK) zones[zones.length - 1][1] = k;
    else zones.push([k, k]);
  }
  return {
    total,
    poc,
    pocVolume: vol(poc),
    vah: Math.max(...inVa),
    val: Math.min(...inVa),
    vaVolume: acc,
    vaRows: inVa.length,
    vaSet: set,
    nRows: keys.length,
    rows,
    lvns: zones.filter(([a, b]) => b - a >= 4 * TICK),
    lvnsRaw: zones,
  };
}

/** independent cumulative delta + 2-bar-confirmed price pivots + divergences */
export function analysisIndependent(candles) {
  const lo = candles.map((c) => c.low / 100);
  const hi = candles.map((c) => c.high / 100);
  const mid = candles.map((_, i) => (hi[i] + lo[i]) / 2);
  let cum = 0;
  const cvd = candles.map((c) => (cum += c.buy - c.sell));
  const n = candles.length;
  const pLows = [];
  const pHighs = [];
  for (let i = 2; i < n - 2; i++) {
    if (lo[i] < Math.min(lo[i - 1], lo[i - 2], lo[i + 1], lo[i + 2])) pLows.push(i);
    if (hi[i] > Math.max(hi[i - 1], hi[i - 2], hi[i + 1], hi[i + 2])) pHighs.push(i);
  }
  const d2 = [];
  for (let k = 1; k < pLows.length; k++) {
    const [i1, i2] = [pLows[k - 1], pLows[k]];
    if (lo[i2] < lo[i1] && cvd[i2] > cvd[i1]) d2.push({ i: i2, t: candles[i2].t.slice(11, 16), price: lo[i2] });
  }
  const d4 = [];
  for (let k = 1; k < pHighs.length; k++) {
    const [i1, i2] = [pHighs[k - 1], pHighs[k]];
    if (hi[i2] > hi[i1] && cvd[i2] < cvd[i1]) d4.push({ i: i2, t: candles[i2].t.slice(11, 16), price: hi[i2] });
  }
  // reclaims: a break of at least one tick beyond the running extreme, then
  // the mid trades back inside within the next 2 bars
  const reclaims = [];
  let runLo = Infinity;
  let runHi = -Infinity;
  for (let i = 1; i < n; i++) {
    const pl = Math.min(runLo, lo[i - 1]);
    const ph = Math.max(runHi, hi[i - 1]);
    runLo = pl;
    runHi = ph;
    if (lo[i] <= pl - 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) if (mid[j] > pl) { reclaims.push({ t: candles[i].t.slice(11, 16), price: +pl.toFixed(2), dir: "low" }); break; }
    }
    if (hi[i] >= ph + 0.25) {
      for (let j = i + 1; j < Math.min(n, i + 3); j++) if (mid[j] < ph) { reclaims.push({ t: candles[i].t.slice(11, 16), price: +ph.toFixed(2), dir: "high" }); break; }
    }
  }
  // initiative: |delta| >= 20% of volume AND a strict new extreme vs the previous bar
  const initiative = [];
  for (let i = 1; i < n; i++) {
    const v = candles[i].buy + candles[i].sell;
    const dp = (candles[i].buy - candles[i].sell) / Math.max(1, v);
    if (dp <= -0.2 && lo[i] < lo[i - 1]) initiative.push({ t: candles[i].t.slice(11, 16), price: lo[i], side: "bid" });
    else if (dp >= 0.2 && hi[i] > hi[i - 1]) initiative.push({ t: candles[i].t.slice(11, 16), price: hi[i], side: "ask" });
  }
  return { lo, hi, mid, cvd, pLows, pHighs, d2, d4, reclaims, initiative };
}

/** independent HLC3 VWAP weighted by OHLC volume (falls back to the bar mid) */
export function vwapIndependent(candles, ohlcByHHmm) {
  let num = 0;
  let den = 0;
  for (const c of candles) {
    const bar = ohlcByHHmm?.get(c.t.slice(11, 16));
    const v = bar?.v || c.total || c.buy + c.sell;
    if (!v) continue;
    const px = bar ? (bar.h + bar.l + bar.c) / 3 : (c.high + c.low) / 200;
    num += px * v;
    den += v;
  }
  return den ? num / den : 0;
}
