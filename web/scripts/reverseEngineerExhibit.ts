/* ------------------------------------------------------------------ *
 * REVERSE-ENGINEERED FAMILIES — RECENT-WINDOW EXHIBIT (scratch)
 * Runs families A–E from reverseEngineerStudy.ts over the six recent
 * sessions (2026-10-08 … 2026-10-15) and lists every card with its
 * replay outcome — the labeled exhibit for the report (n small, never
 * a validation cohort).
 * Run from web/: node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *   scripts/reverseEngineerExhibit.ts
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadSessionMinutes } from "../lib/archive";
import { detectMomentum, MOM_PROD, closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import { scoreTrade } from "../lib/backtestEngine";

const DATES = ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
const LOCAL_DATA = path.resolve(process.cwd(), "..", "gcdata", "data");
const COST = 0.5;

type Card = { fam: string; dir: 1 | -1; entryIdx: number; entry: number; stop: number; target: number; risk: number };

const mid = (m: MomMinute): number => (m.high + m.low) / 2;

function prefixFeatures(mins: MomMinute[]) {
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

function familyA(mins: MomMinute[], threshold: number): Card[] {
  const f = prefixFeatures(mins);
  const i0 = mins.findIndex((m) => m.t === "07:30");
  const i1 = mins.findIndex((m) => m.t === "07:41");
  if (i0 < 0 || i1 < 0 || i1 >= mins.length - 1) return [];
  const b = mins[i0];
  if (b.high - b.low < threshold) return [];
  const delta = b.buy - b.sell;
  if (delta === 0) return [];
  const dir: 1 | -1 = delta > 0 ? 1 : -1;
  const entry = closeOf(mins[i1]);
  const risk = Math.max(3.5, f.atr[i1]);
  return [{ fam: "A", dir, entryIdx: i1, entry, stop: entry - dir * risk, target: entry + dir * risk, risk }];
}

function familyB(mins: MomMinute[], reclaimFrac: number, window: number): Card[] {
  const f = prefixFeatures(mins);
  const n = mins.length;
  const out: Card[] = [];
  for (let k = 20; k < n - 1; k++) {
    const m = mins[k];
    const vol = m.buy + m.sell;
    if (vol < Math.max(15, Math.min(0.5 * f.med60[k], 250))) continue;
    const buyFrac = vol > 0 ? m.buy / vol : 0;
    if (m.high - m.low < 1.0 * f.atr[k]) continue;
    if (buyFrac <= 0.3 && m.low < f.sLow[k - 1] - 0.5) {
      for (let j = k + 1; j <= Math.min(n - 1, k + window); j++) {
        const r = mins[j];
        const rv = r.buy + r.sell;
        if (rv < Math.max(15, Math.min(0.5 * f.med60[j], 250))) continue;
        if (rv > 0 && r.buy / rv < reclaimFrac) continue;
        if (r.high < m.high) continue;
        const entry = closeOf(r);
        const risk = Math.max(3.5, entry - (m.low - 0.5));
        out.push({ fam: "B", dir: 1, entryIdx: j, entry, stop: entry - risk, target: entry + risk, risk });
        break;
      }
      continue;
    }
    if (buyFrac >= 0.7 && m.high > f.sHigh[k - 1] + 0.5) {
      for (let j = k + 1; j <= Math.min(n - 1, k + window); j++) {
        const r = mins[j];
        const rv = r.buy + r.sell;
        if (rv < Math.max(15, Math.min(0.5 * f.med60[j], 250))) continue;
        if (rv > 0 && r.buy / rv > 1 - reclaimFrac) continue;
        if (r.low > m.low) continue;
        const entry = closeOf(r);
        const risk = Math.max(3.5, m.high + 0.5 - entry);
        out.push({ fam: "B", dir: -1, entryIdx: j, entry, stop: entry + risk, target: entry - risk, risk });
        break;
      }
    }
  }
  return out;
}

function familyC(mins: MomMinute[], cumFloor: number): Card[] {
  const f = prefixFeatures(mins);
  return detectSoftMomentum(mins, SOFT_PROD)
    .filter((s) => {
      const cd = f.cumD[s.entryIdx];
      if (Math.abs(cd) < cumFloor) return false;
      if (s.dir === "long" && cd < 0) return false;
      if (s.dir === "short" && cd > 0) return false;
      return true;
    })
    .map((s) => ({ fam: "C", dir: (s.dir === "long" ? 1 : -1) as 1 | -1, entryIdx: s.entryIdx, entry: s.entry, stop: s.stop, target: s.target, risk: s.risk }));
}

function familyD(mins: MomMinute[], threshold: number): Card[] {
  const f = prefixFeatures(mins);
  for (let k = 30; k < mins.length - 1; k++) {
    const m = mins[k];
    if (m.high - m.low < threshold) continue;
    const delta = m.buy - m.sell;
    if (delta === 0) continue;
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    const entry = closeOf(m);
    const risk = Math.max(3.5, f.atr[k]);
    return [{ fam: "D", dir, entryIdx: k, entry, stop: entry - dir * risk, target: entry + dir * risk, risk }];
  }
  return [];
}

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
        levels: [],
      }));
    } catch {
      return null;
    }
  }
  return loadSessionMinutes(date, { withOhlc: true });
}

const etOf = (t: string): string => `${String((Number(t.slice(0, 2)) + 1) % 24).padStart(2, "0")}:${t.slice(3, 5)}`;

async function main() {
  for (const date of DATES) {
    const mins = await loadMinutes(date);
    if (!mins) {
      console.log(`${date}: no data`);
      continue;
    }
    const cards: Card[] = [
      ...familyA(mins, 100),
      ...familyB(mins, 0.7, 6),
      ...familyC(mins, 500),
      ...familyD(mins, 100),
    ];
    // drive baseline (already-live family)
    const drives = detectOpenDrive(mins, OPEN_PROD);
    console.log(`\n== ${date} ==`);
    console.log("fam tET     dir    entry      risk   outcome");
    for (const c of [...cards].sort((a, b) => a.entryIdx - b.entryIdx)) {
      const sc = scoreTrade(
        mins.map((m) => ({ high: m.high, low: m.low, c: m.c })),
        { dir: c.dir, entry: c.entry, stop: c.stop, target: c.target, entryIdx: c.entryIdx, risk: c.risk },
        { costPts: COST, holdBars: 60, onNoBars: "drop" },
      );
      const t = mins[c.entryIdx].t;
      const res = sc ? `${sc.hit} ${sc.pnl >= 0 ? "+" : ""}${sc.pnl.toFixed(1)} pts (${sc.heldBars}b)` : "no-bars";
      console.log(`${c.fam}   ${etOf(t).padEnd(7)} ${c.dir === 1 ? "long" : "short".padEnd(4)} ${c.entry.toFixed(2).padStart(9)} ${c.risk.toFixed(1).padStart(5)}  ${res}`);
    }
    for (const d of drives) {
      console.log(`DRV  ${etOf(d.t).padEnd(7)} ${d.dir.padEnd(6)} ${d.entry.toFixed(2).padStart(9)} ${"35.0".padStart(5)}  drive +15/−35 (live family, baseline)`);
    }
    // flush (E) cards with limit replay outcome
    const flushes = detectMomentum(mins, MOM_PROD).filter((s) => s.kind === "flush");
    for (const s of flushes) {
      const dir = s.dir === "long" ? 1 : -1;
      let fillBar = -1;
      let fill = 0;
      for (let j = s.entryIdx + 1; j <= Math.min(mins.length - 1, s.entryIdx + 9); j++) {
        const b = mins[j];
        if (!(dir > 0 ? b.low <= s.entry : b.high >= s.entry)) continue;
        const open = b.o > 0 ? b.o : mid(b);
        fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
        fillBar = j;
        break;
      }
      let res = "no-fill";
      if (fillBar >= 0) {
        const stop = fill - dir * s.risk;
        const target = fill + dir * s.risk;
        const end = Math.min(mins.length - 1, s.entryIdx + 60);
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
        res = `${hit} ${((exit - fill) * dir - COST) >= 0 ? "+" : ""}${((exit - fill) * dir - COST).toFixed(1)} pts`;
      }
      console.log(`E    ${etOf(s.t).padEnd(7)} ${s.dir.padEnd(6)} ${s.entry.toFixed(2).padStart(9)} ${s.risk.toFixed(1).padStart(5)}  ${res}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
