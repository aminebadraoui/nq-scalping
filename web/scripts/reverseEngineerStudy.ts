/* ------------------------------------------------------------------ *
 * REVERSE-ENGINEERED PATTERN FAMILIES (SCRATCH STUDY — research input)
 *
 * Five new strategy hypotheses mined from the missed-beautiful-trades
 * audit (docs/research/missed-beautiful-trades-2026-10-15.md), tested
 * over the full 656-session archive with engine-standard scoring
 * (scoreTrade: market fill at the trigger close, 0.5 pt cost inside
 * P&L, pessimistic stop-first, 60-bar time exit), train/test split at
 * 2026-01-01, and the Rapid EOD 50k account sim (propViability).
 *
 *   A. shockBarContinuation — the 08:30 ET bar is a shock (range ≥ X
 *      pts); trade its delta sign at the 08:41 ET close (past the
 *      10-min news blackout), stop 1×ATR14, target 1R. One per day.
 *   B. failedBreakdownReclaim — a flush makes a NEW session low
 *      (sell-frac ≥ 70%, vol-gated, range ≥ 1×ATR14) then a strong
 *      one-sided reclaim bar (buy-frac ≥ Y) clears the flush bar's
 *      high → long at the reclaim close; stop = flush low − 0.5
 *      (3.5-pt floor); target 1R. Mirror for shorts.
 *   C. trendMarketRTH — SOFT_PROD cards with the session cumulative
 *      delta agreeing AND |cumD| ≥ Z → marketable at the close with
 *      the SOFT_PROD structural bracket (0.75R target). The marketable
 *      RTH arm was rejected globally (PF 0.74); this asks whether the
 *      trend-gated subset survives.
 *   D. firstBigBarContinuation — the session's FIRST bar with range ≥
 *      X pts; trade its delta sign at the close, stop 1×ATR14, target
 *      1R. One per day.
 *   E. flushLimitHourFilter — MOM_PROD flush cards replayed with the
 *      live flushLimit mechanics (resting limit at the close, TTL 9,
 *      brackets from the fill), split by entry hour ET (evening
 *      18:00-01:59 vs core 02:00-09:29) vs the all-hours baseline.
 *
 * Stats from lib/backtestEngine only (coreStats / wilson95 / byYear /
 * propViability / renderT1 / renderT2 / renderT4 / renderVerdict).
 *
 * Run from web/:
 *   GC_REMOTE_URL=… node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/reverseEngineerStudy.ts
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, MOM_PROD, closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { scoreTrade, coreStats, wilson95, byYear, propViability, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const SPLIT = "2026-01-01";
const COST = 0.5;
const HOLD = 60;
const LOCAL_DATA = path.resolve(process.cwd(), "..", "gcdata", "data");

/* ---------------- helpers ---------------- */

const mid = (m: MomMinute): number => (m.high + m.low) / 2;

/** rolling ATR14 (mean of last 14 ranges) + trailing 60-bar median volume,
 *  prefix cumD and session extremes — all lookahead-free (prefix only). */
function prefixFeatures(mins: MomMinute[]): { atr: number[]; med60: number[]; cumD: number[]; sLow: number[]; sHigh: number[] } {
  const n = mins.length;
  const atr = new Array(n).fill(0);
  const med60 = new Array(n).fill(0);
  const cumD = new Array(n).fill(0);
  const sLow = new Array(n).fill(Infinity);
  const sHigh = new Array(n).fill(-Infinity);
  let cd = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let rsum = 0;
  const rbuf: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = mins[i].high - mins[i].low;
    rbuf.push(r);
    rsum += r;
    if (rbuf.length > 14) rsum -= rbuf.shift()!;
    atr[i] = rsum / Math.max(1, rbuf.length);
    const vols: number[] = [];
    for (let j = Math.max(0, i - 60); j < i; j++) vols.push(mins[j].buy + mins[j].sell);
    vols.sort((a, b) => a - b);
    med60[i] = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
    cd += mins[i].buy - mins[i].sell;
    cumD[i] = cd;
    lo = Math.min(lo, mins[i].low);
    hi = Math.max(hi, mins[i].high);
    sLow[i] = lo;
    sHigh[i] = hi;
  }
  return { atr, med60, cumD, sLow, sHigh };
}

type Card = {
  date: string;
  dir: 1 | -1;
  entryIdx: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  fam: string;
};

/* ---------------- A. shock-bar continuation ---------------- */

function familyA(mins: MomMinute[], date: string, threshold: number): Card[] {
  const f = prefixFeatures(mins);
  const i0 = mins.findIndex((m) => m.t === "07:30"); // 08:30 ET
  const i1 = mins.findIndex((m) => m.t === "07:41"); // 08:41 ET (past the 10-min blackout)
  if (i0 < 0 || i1 < 0 || i1 >= mins.length - 1) return [];
  const b = mins[i0];
  if (b.high - b.low < threshold) return [];
  const delta = b.buy - b.sell;
  if (delta === 0) return [];
  const dir: 1 | -1 = delta > 0 ? 1 : -1;
  const entry = closeOf(mins[i1]);
  const risk = Math.max(3.5, f.atr[i1]);
  return [{ date, dir, entryIdx: i1, entry, stop: entry - dir * risk, target: entry + dir * risk, risk, fam: "A" }];
}

/* ---------------- B. failed-breakdown reclaim ---------------- */

function familyB(mins: MomMinute[], date: string, reclaimFrac: number, window: number): Card[] {
  const f = prefixFeatures(mins);
  const n = mins.length;
  const out: Card[] = [];
  for (let k = 20; k < n - 1; k++) {
    const m = mins[k];
    const vol = m.buy + m.sell;
    if (vol < Math.max(15, Math.min(0.5 * f.med60[k], 250))) continue;
    const buyFrac = vol > 0 ? m.buy / vol : 0;
    const range = m.high - m.low;
    if (range < 1.0 * f.atr[k]) continue;
    if (buyFrac <= 0.3 && m.low < f.sLow[k - 1] - 0.5) {
      // LONG: sell flush made a REAL new session low → strong buy reclaim
      for (let j = k + 1; j <= Math.min(n - 1, k + window); j++) {
        const r = mins[j];
        const rv = r.buy + r.sell;
        if (rv < Math.max(15, Math.min(0.5 * f.med60[j], 250))) continue;
        if (rv > 0 && r.buy / rv < reclaimFrac) continue;
        if (r.high < m.high) continue; // reclaim must clear the flush bar's high
        const entry = closeOf(r);
        const risk = Math.max(3.5, entry - (m.low - 0.5));
        out.push({ date, dir: 1, entryIdx: j, entry, stop: entry - risk, target: entry + risk, risk, fam: "B" });
        break;
      }
      continue;
    }
    if (buyFrac >= 0.7 && m.high > f.sHigh[k - 1] + 0.5) {
      // SHORT: buy flush made a REAL new session high → strong sell reclaim
      for (let j = k + 1; j <= Math.min(n - 1, k + window); j++) {
        const r = mins[j];
        const rv = r.buy + r.sell;
        if (rv < Math.max(15, Math.min(0.5 * f.med60[j], 250))) continue;
        if (rv > 0 && r.buy / rv > 1 - reclaimFrac) continue;
        if (r.low > m.low) continue;
        const entry = closeOf(r);
        const risk = Math.max(3.5, m.high + 0.5 - entry);
        out.push({ date, dir: -1, entryIdx: j, entry, stop: entry + risk, target: entry - risk, risk, fam: "B" });
        break;
      }
    }
  }
  return out;
}

/* ---------------- C. trend-gated marketable RTH ---------------- */

function familyC(mins: MomMinute[], date: string, cumFloor: number): Card[] {
  const f = prefixFeatures(mins);
  return detectSoftMomentum(mins, SOFT_PROD)
    .filter((s) => {
      const cd = f.cumD[s.entryIdx];
      if (Math.abs(cd) < cumFloor) return false;
      if (s.dir === "long" && cd < 0) return false;
      if (s.dir === "short" && cd > 0) return false;
      return true;
    })
    .map((s) => ({
      date,
      dir: (s.dir === "long" ? 1 : -1) as 1 | -1,
      entryIdx: s.entryIdx,
      entry: s.entry,
      stop: s.stop,
      target: s.target,
      risk: s.risk,
      fam: "C",
    }));
}

/** C0: the UNGATED SOFT_PROD baseline — market at the close, structural
 *  bracket (the same scorer as the gated arms; the fair lift baseline). */
function familyC0(mins: MomMinute[], date: string): Card[] {
  return detectSoftMomentum(mins, SOFT_PROD).map((s) => ({
    date,
    dir: (s.dir === "long" ? 1 : -1) as 1 | -1,
    entryIdx: s.entryIdx,
    entry: s.entry,
    stop: s.stop,
    target: s.target,
    risk: s.risk,
    fam: "C0",
  }));
}

/** C-tape: the gated card filled at the DISPATCH TAPE (next-bar mid) with
 *  signal-anchored brackets — the marketable arm's honest fill model
 *  (rthLimitFillDriftStudy convention). */
function cTapeTrade(mins: MomMinute[], c: Card): EngineTrade | null {
  if (c.entryIdx + 1 >= mins.length) return null;
  const nb = mins[c.entryIdx + 1];
  const fill = mid(nb);
  const sc = scoreTrade(
    mins.map((m) => ({ high: m.high, low: m.low, c: m.c })),
    { dir: c.dir, entry: fill, stop: c.stop, target: c.target, entryIdx: c.entryIdx, risk: c.risk },
    { costPts: COST, holdBars: HOLD, onNoBars: "drop" },
  );
  return sc ? { date: c.date, pnl: sc.pnl, risk: c.risk } : null;
}

/** C-limit: the gated card with the LIVE limit mechanics (resting limit at
 *  the signal, TTL 9, fill-or-better at bar open, 0.5× stop from the fill,
 *  2.5R target, 60-bar horizon from the signal bar). */
function cLimitTrade(mins: MomMinute[], c: Card): EngineTrade | null {
  const dir = c.dir;
  let fillBar = -1;
  let fill = 0;
  for (let j = c.entryIdx + 1; j <= Math.min(mins.length - 1, c.entryIdx + 9); j++) {
    const b = mins[j];
    if (!(dir > 0 ? b.low <= c.entry : b.high >= c.entry)) continue;
    const open = b.o > 0 ? b.o : mid(b);
    fill = dir > 0 ? Math.min(open, c.entry) : Math.max(open, c.entry);
    fillBar = j;
    break;
  }
  if (fillBar < 0) return null;
  const risk = c.risk * 0.5;
  const stop = fill - dir * risk;
  const target = fill + dir * risk * 2.5;
  const end = Math.min(mins.length - 1, c.entryIdx + HOLD);
  let exit = closeOf(mins[end]);
  for (let j = fillBar + 1; j <= end; j++) {
    const b = mins[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return { date: c.date, pnl: (exit - fill) * dir - COST, risk };
}

/* ---------------- D. first big-bar continuation ---------------- */

function familyD(mins: MomMinute[], date: string, threshold: number): Card[] {
  const f = prefixFeatures(mins);
  for (let k = 30; k < mins.length - 1; k++) {
    const m = mins[k];
    if (m.high - m.low < threshold) continue;
    const delta = m.buy - m.sell;
    if (delta === 0) continue;
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    const entry = closeOf(m);
    const risk = Math.max(3.5, f.atr[k]);
    return [{ date, dir, entryIdx: k, entry, stop: entry - dir * risk, target: entry + dir * risk, risk, fam: "D" }];
  }
  return [];
}

/** D-limit: family D harvested the flushLimit way — resting limit at the
 *  big bar's close, TTL 9, fill-or-better at bar open, brackets from the
 *  fill (risk = 1×ATR14 at the signal, 1R target). */
function dLimitTrade(mins: MomMinute[], c: Card): EngineTrade | null {
  const dir = c.dir;
  let fillBar = -1;
  let fill = 0;
  for (let j = c.entryIdx + 1; j <= Math.min(mins.length - 1, c.entryIdx + 9); j++) {
    const b = mins[j];
    if (!(dir > 0 ? b.low <= c.entry : b.high >= c.entry)) continue;
    const open = b.o > 0 ? b.o : mid(b);
    fill = dir > 0 ? Math.min(open, c.entry) : Math.max(open, c.entry);
    fillBar = j;
    break;
  }
  if (fillBar < 0) return null;
  const stop = fill - dir * c.risk;
  const target = fill + dir * c.risk;
  const end = Math.min(mins.length - 1, c.entryIdx + HOLD);
  let exit = closeOf(mins[end]);
  for (let j = fillBar; j <= end; j++) {
    const b = mins[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return { date: c.date, pnl: (exit - fill) * dir - COST, risk: c.risk };
}

/* ---------------- E. flushLimit replay (limit mechanics) ---------------- */

function flushLimitReplay(mins: MomMinute[], s: MomentumSignal): { pnl: number; risk: number; hit: string } | null {
  const dir = s.dir === "long" ? 1 : -1;
  const level = s.entry;
  let fillBar = -1;
  let fill = 0;
  for (let j = s.entryIdx + 1; j <= Math.min(mins.length - 1, s.entryIdx + 9); j++) {
    const b = mins[j];
    if (!(dir > 0 ? b.low <= level : b.high >= level)) continue;
    const open = b.o > 0 ? b.o : mid(b);
    fill = dir > 0 ? Math.min(open, level) : Math.max(open, level);
    fillBar = j;
    break;
  }
  if (fillBar < 0) return null;
  const risk = s.risk;
  const stop = fill - dir * risk;
  const target = fill + dir * risk;
  const end = Math.min(mins.length - 1, s.entryIdx + HOLD);
  let exit = closeOf(mins[end]);
  let hit = "time";
  for (let j = fillBar; j <= end; j++) {
    const b = mins[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      hit = "stop";
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      hit = "target";
      break;
    }
  }
  return { pnl: (exit - fill) * dir - COST, risk, hit };
}

/* ---------------- main ---------------- */

async function loadMinutes(date: string): Promise<MomMinute[] | null> {
  if (date >= "2026-10-14") {
    try {
      const raw = readFileSync(path.join(LOCAL_DATA, `${date}_ETH.json`), "utf8");
      const j = JSON.parse(raw) as { candles?: { t: string; high: number; low: number; buy: number; sell: number; levels?: Record<string, [number, number, number, number, number]> }[] };
      const candles = j.candles ?? [];
      if (candles.length < 60) return null;
      return candles.map((c) => ({
        t: c.t.slice(11, 16),
        d: c.t.slice(0, 10),
        o: 0,
        c: 0,
        high: c.high / 100,
        low: c.low / 100,
        buy: c.buy,
        sell: c.sell,
        levels: Object.entries(c.levels ?? {}).map(([p, v]) => ({ price: Number(p) / 100, buy: v[1], sell: v[2] })),
      }));
    } catch {
      return null;
    }
  }
  return loadSessionMinutes(date, { withOhlc: true });
}

function scoreCard(mins: MomMinute[], c: Card): EngineTrade | null {
  const sc = scoreTrade(
    mins.map((m) => ({ high: m.high, low: m.low, c: m.c })),
    { dir: c.dir, entry: c.entry, stop: c.stop, target: c.target, entryIdx: c.entryIdx, risk: c.risk },
    { costPts: COST, holdBars: HOLD, onNoBars: "drop" },
  );
  return sc ? { date: c.date, pnl: sc.pnl, risk: c.risk } : null;
}

/** one-position-at-a-time per session day (60-bar occupancy) */
function sequence(cards: Card[], scored: (EngineTrade | null)[]): EngineTrade[] {
  const out: EngineTrade[] = [];
  const idx = cards.map((c, i) => ({ c, i })).sort((a, b) => a.c.entryIdx - b.c.entryIdx);
  let openUntil = -1;
  let lastDate = "";
  for (const { c, i } of idx) {
    if (c.date !== lastDate) {
      openUntil = -1;
      lastDate = c.date;
    }
    if (c.entryIdx < openUntil) continue;
    const t = scored[i];
    if (t) {
      out.push(t);
      openUntil = c.entryIdx + HOLD;
    }
  }
  return out;
}

async function main() {
  const dates = (await archiveDates()).sort();
  const trainDates = dates.filter((d) => d < SPLIT);
  const testDates = dates.filter((d) => d >= SPLIT);
  console.log(`archive: ${dates.length} sessions · train ${trainDates.length} (< ${SPLIT}) · test ${testDates.length}`);

  const famKeys = ["A75", "A100", "A150", "B070", "B080", "C0", "C300", "C500", "C800", "C500T", "C500L", "D100", "D150", "D200", "D100L"];
  const famLabels: Record<string, string> = {
    A75: "A shock≥75pts", A100: "A shock≥100pts", A150: "A shock≥150pts",
    B070: "B reclaim bf≥0.70", B080: "B reclaim bf≥0.80",
    C0: "C ungated (baseline)", C300: "C cumD≥300", C500: "C cumD≥500", C800: "C cumD≥800",
    C500T: "C cumD≥500 @dispatch-tape", C500L: "C cumD≥500 @limit",
    D100: "D first≥100pts", D150: "D first≥150pts", D200: "D first≥200pts", D100L: "D first≥100pts @limit",
  };
  const famTrades: Record<string, EngineTrade[]> = Object.fromEntries(famKeys.map((k) => [k, []]));
  const eTagged: { date: string; pnl: number; risk: number; hourET: number }[] = [];

  let i = 0;
  const t0 = Date.now();
  for (const date of dates) {
    const mins = await loadMinutes(date);
    if (!mins) continue;

    // per-family cards for this session, scored immediately
    const mk = (k: string, gen: () => Card[]): void => {
      const cards = gen();
      if (!cards.length) return;
      const perCard = cards.map((c) => scoreCard(mins, c));
      famTrades[k].push(...sequence(cards, perCard));
    };
    mk("A75", () => familyA(mins, date, 75));
    mk("A100", () => familyA(mins, date, 100));
    mk("A150", () => familyA(mins, date, 150));
    mk("B070", () => familyB(mins, date, 0.7, 6));
    mk("B080", () => familyB(mins, date, 0.8, 6));
    mk("C0", () => familyC0(mins, date));
    mk("C300", () => familyC(mins, date, 300));
    mk("C500", () => familyC(mins, date, 500));
    mk("C800", () => familyC(mins, date, 800));
    const c500 = familyC(mins, date, 500);
    famTrades.C500T.push(...sequence(c500, c500.map((c) => cTapeTrade(mins, c))));
    famTrades.C500L.push(...sequence(c500, c500.map((c) => cLimitTrade(mins, c))));
    mk("D100", () => familyD(mins, date, 100));
    mk("D150", () => familyD(mins, date, 150));
    mk("D200", () => familyD(mins, date, 200));
    const d100 = familyD(mins, date, 100);
    famTrades.D100L.push(...sequence(d100, d100.map((c) => dLimitTrade(mins, c))));

    // E: flushLimit replay, one-position-at-a-time within the session
    const flushes = detectMomentum(mins, MOM_PROD)
      .filter((x) => x.kind === "flush")
      .sort((a, b) => a.entryIdx - b.entryIdx);
    let openUntil = -1;
    for (const s of flushes) {
      if (s.entryIdx < openUntil) continue;
      const r = flushLimitReplay(mins, s);
      if (r) {
        eTagged.push({ date, pnl: r.pnl, risk: r.risk, hourET: (Number(s.t.slice(0, 2)) + 1) % 24 });
        openUntil = s.entryIdx + HOLD;
      }
    }
    if (++i % 150 === 0) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · detection + scoring done`);
  const eTrades: EngineTrade[] = eTagged.map(({ date, pnl, risk }) => ({ date, pnl, risk }));

  const famGroups: { fam: string; keys: string[]; prim: string }[] = [
    { fam: "A", keys: ["A75", "A100", "A150"], prim: "A100" },
    { fam: "B", keys: ["B070", "B080"], prim: "B070" },
    { fam: "C", keys: ["C0", "C300", "C500", "C800", "C500T", "C500L"], prim: "C500" },
    { fam: "D", keys: ["D100", "D150", "D200", "D100L"], prim: "D100" },
    { fam: "E", keys: ["E"], prim: "E" },
  ];

  const tradesOf = (k: string): EngineTrade[] => (k === "E" ? eTrades : famTrades[k]);

  for (const g of famGroups) {
    console.log(`\n################ ${g.fam} ################`);
    const primTrades = tradesOf(g.prim);
    const allKeys = g.fam === "E" ? ["E"] : g.keys;
    const allTrades = allKeys.flatMap((k) => tradesOf(k));
    const rows = [
      { label: `${g.fam} primary (${g.prim})`, stats: coreStats(primTrades, { sessionUniverse: dates }) },
      { label: `${g.fam} train`, stats: coreStats(primTrades.filter((t) => t.date < SPLIT), { sessionUniverse: trainDates }) },
      { label: `${g.fam} test`, stats: coreStats(primTrades.filter((t) => t.date >= SPLIT), { sessionUniverse: testDates }) },
    ];
    console.log(renderT1(rows));

    if (g.fam === "E") {
      const cells = [
        { label: "E evening 18:00-01:59", trades: eTagged.filter((t) => t.hourET >= 18 || t.hourET < 2) },
        { label: "E core 02:00-09:29", trades: eTagged.filter((t) => t.hourET >= 2 && t.hourET < 18) },
      ];
      console.log(
        renderT2(
          cells.map((cell) => {
            const s = coreStats(cell.trades, { sessionUniverse: dates });
            const st = coreStats(cell.trades.filter((t) => t.date < SPLIT), { sessionUniverse: trainDates });
            const se = coreStats(cell.trades.filter((t) => t.date >= SPLIT), { sessionUniverse: testDates });
            return {
              rule: cell.label,
              n: s.n,
              wr: s.wr,
              ci: s.wrCi,
              pf: s.pf,
              expPts: s.expPts,
              trainTest: `${st.wr.toFixed(0)}% / ${se.wr.toFixed(0)}%`,
              compare: `all-hours WR ${coreStats(eTrades, { sessionUniverse: dates }).wr.toFixed(1)}% · PF ${coreStats(eTrades, { sessionUniverse: dates }).pf.toFixed(2)}`,
            };
          }),
        ),
      );
    } else {
      console.log(
        renderT2(
          g.keys.map((k) => {
            const s = coreStats(tradesOf(k), { sessionUniverse: dates });
            const st = coreStats(tradesOf(k).filter((t) => t.date < SPLIT), { sessionUniverse: trainDates });
            const se = coreStats(tradesOf(k).filter((t) => t.date >= SPLIT), { sessionUniverse: testDates });
            const prim = coreStats(primTrades, { sessionUniverse: dates });
            return {
              rule: famLabels[k],
              n: s.n,
              wr: s.wr,
              ci: s.wrCi,
              pf: s.pf,
              expPts: s.expPts,
              trainTest: `${st.wr.toFixed(0)}% / ${se.wr.toFixed(0)}%`,
              compare: k === g.prim ? "—" : `${g.prim} WR ${prim.wr.toFixed(1)}% · PF ${prim.pf.toFixed(2)}`,
            };
          }),
        ),
      );
    }

    const viab = propViability(primTrades, { splitDate: SPLIT });
    console.log("\n" + renderT4(viab));
    const trS = coreStats(primTrades.filter((t) => t.date < SPLIT), { sessionUniverse: trainDates });
    const teS = coreStats(primTrades.filter((t) => t.date >= SPLIT), { sessionUniverse: testDates });
    console.log(
      renderVerdict({
        edge: teS.n >= 100 ? (teS.netPts > 0 && teS.expR > 0 ? "real" : "absent") : "unproven",
        significance: teS.n >= 100 ? (teS.wrCi[0] > 0.5 ? "PASS" : "weak") : "—",
        stability: `train/test WR ${trS.wr.toFixed(1)}/${teS.wr.toFixed(1)}`,
        holdout: "n/a (70/30 OOS)",
        viability: viab.pPass === null ? "n/a" : `${viab.pPass >= 0.9 ? "PASS" : viab.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viab.pPass.toFixed(2)})`,
      }),
    );
    for (const y of byYear(primTrades)) {
      console.log(`  ${y.year}: n=${y.stats.n} wr=${y.stats.wr.toFixed(1)}% pf=${y.stats.pf.toFixed(2)} exp=${y.stats.expPts >= 0 ? "+" : ""}${y.stats.expPts.toFixed(2)} net=${y.stats.netPts.toFixed(0)}`);
    }
  }
}

main().catch((e) => {
  console.error("reverseEngineerStudy failed:", e);
  process.exit(1);
});
