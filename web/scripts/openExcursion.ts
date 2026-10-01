/* ------------------------------------------------------------------ *
 * Open excursion study — "touch TP fast with approximate direction?"
 *
 * For every 9:30 open in the archive, enter under several direction rules
 * (strict drive, loose drive, fixed 9:31 bar in the delta direction, and
 * an always-long baseline) and measure, over the next 60 minutes:
 *   · hit% for small take-profits before a wide stop (TP-first)
 *   · median bars/time to the TP touch
 *   · median adverse excursion before the TP (the drawdown to tolerate)
 *
 * GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *   scripts/openExcursion.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";

const TPS = [3, 5, 8, 10];
const SLS = [10, 15, 20, 25, 30];

type Entry = { name: string; i: number; dir: 1 | -1; entry: number; cumD: number };

function entries(minutes: MomMinute[], kind: string): Entry[] {
  const n = minutes.length;
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));
  let i0 = -1;
  for (let i = 0; i < n; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
  if (i0 < 0 || i0 + 2 >= n) return [];

  const out: Entry[] = [];
  let cumD = 0;
  if (kind === "fixed931") {
    cumD = minutes[i0].buy - minutes[i0].sell + (minutes[i0 + 1].buy - minutes[i0 + 1].sell);
    const dir: 1 | -1 = cumD >= 0 ? 1 : -1;
    out.push({ name: "fixed931", i: i0 + 1, dir, entry: closeOf(minutes[i0 + 1]), cumD });
    return out;
  }
  if (kind === "alwaysLong") {
    out.push({ name: "alwaysLong", i: i0 + 1, dir: 1, entry: closeOf(minutes[i0 + 1]), cumD: 0 });
    return out;
  }
  // drive-style: first bar in the window where |cumD| >= floor
  const floor = kind === "drive300" ? 300 : 100;
  for (let k = i0; k < Math.min(n - 1, i0 + 30); k++) {
    cumD += minutes[k].buy - minutes[k].sell;
    if (Math.abs(cumD) >= floor) {
      out.push({ name: kind, i: k, dir: cumD >= 0 ? 1 : -1, entry: closeOf(minutes[k]), cumD });
      break;
    }
  }
  return out;
}

async function main() {
  const dates = await archiveDates();
  console.log(`open excursion study over ${dates.length} sessions…`);
  const t0 = Date.now();

  type Row = {
    kind: string;
    tp: number;
    sl: number;
    n: number;
    hitPct: number;
    medBars: number;
    medMae: number;
    expPts: number;
    exp2u: number;
    exp5u: number;
  };
  const rows: Row[] = [];

  for (const kind of ["drive300", "drive100", "fixed931", "alwaysLong"]) {
    // accumulate per (tp, sl): hits, bars sums, mae sums, n
    const agg = new Map<string, { n: number; hits: number; bars: number[]; maes: number[] }>();
    for (const date of dates) {
      const minutes = await loadSessionMinutes(date);
      if (!minutes) continue;
      for (const e of entries(minutes, kind)) {
        const end = Math.min(minutes.length - 1, e.i + 60);
        for (const tp of TPS) {
          for (const sl of SLS) {
            const key = `${tp}|${sl}`;
            const a = agg.get(key) ?? { n: 0, hits: 0, bars: [], maes: [] };
            let hit = false;
            let barsTo = 0;
            let mae = 0;
            let hitPts = 0;
            for (let j = e.i + 1; j <= end; j++) {
              const m = minutes[j];
              const fav = e.dir > 0 ? m.high - e.entry : e.entry - m.low;
              const adv = e.dir > 0 ? e.entry - m.low : m.high - e.entry;
              mae = Math.max(mae, adv);
              if (adv >= sl) break; // stop touched first — loss
              if (fav >= tp) {
                hit = true;
                barsTo = j - e.i;
                hitPts = fav;
                break;
              }
            }
            a.n++;
            if (hit) {
              a.hits++;
              a.bars.push(barsTo);
              a.maes.push(mae);
            }
            agg.set(key, a);
            void hitPts;
          }
        }
      }
    }
    for (const tp of TPS) {
      for (const sl of SLS) {
        const a = agg.get(`${tp}|${sl}`);
        if (!a || a.n === 0) continue;
        const hitPct = (100 * a.hits) / a.n;
        const medBars = a.bars.length ? a.bars.sort((x, y) => x - y)[Math.floor(a.bars.length / 2)] : 0;
        const medMae = a.maes.length ? a.maes.sort((x, y) => x - y)[Math.floor(a.maes.length / 2)] : 0;
        const expPts = (hitPct / 100) * tp - (1 - hitPct / 100) * sl;
        rows.push({
          kind,
          tp,
          sl,
          n: a.n,
          hitPct,
          medBars,
          medMae,
          expPts,
          exp2u: expPts * 2 * 2, // 2 micros × $2/pt
          exp5u: expPts * 2 * 5,
        });
      }
    }
  }

  console.log(`\n${(Date.now() - t0) / 1000}s\n`);
  console.log("kind      | TP | SL | n   | hit%  | med bars | med MAE | exp pts | $/trade @2u | $/trade @5u");
  // show the frontier per kind: for each TP, the SL with the best expectancy
  for (const kind of ["drive300", "drive100", "fixed931", "alwaysLong"]) {
    for (const tp of TPS) {
      const best = rows
        .filter((r) => r.kind === kind && r.tp === tp)
        .sort((a, b) => b.expPts - a.expPts)[0];
      if (!best) continue;
      console.log(
        `${best.kind.padEnd(9)} | ${String(best.tp).padStart(2)} | ${String(best.sl).padStart(2)} | ${String(best.n).padStart(3)} | ${best.hitPct.toFixed(0).padStart(4)}% | ${String(best.medBars).padStart(8)} | ${best.medMae.toFixed(0).padStart(7)} | ${best.expPts.toFixed(1).padStart(7)} | ${best.exp2u.toFixed(1).padStart(9)} | ${best.exp5u.toFixed(1).padStart(10)}`,
      );
    }
    console.log("");
  }
  // a few specific cells of interest
  console.log("selected cells (hit% / exp pts / med MAE):");
  for (const kind of ["drive300", "fixed931"]) {
    for (const [tp, sl] of [[5, 20], [5, 15], [8, 25], [10, 30]] as const) {
      const r = rows.find((x) => x.kind === kind && x.tp === tp && x.sl === sl);
      if (r) console.log(`  ${kind} TP${tp}/SL${sl}: ${r.hitPct.toFixed(0)}% · exp ${r.expPts.toFixed(1)} pts · med MAE ${r.medMae.toFixed(0)} pts · n=${r.n}`);
    }
  }
}



/* ---------------- daily rules: a 9:30 setup available EVERY day ---------------- */

async function dailyRules() {
  const dates = await archiveDates();
  const TPSL: [number, number][] = [[10, 30], [8, 25], [12, 30], [15, 35]];
  const RULES: { name: string; win: number }[] = [
    { name: "r930", win: 1 }, // 9:30 bar's own delta sign, entry at its close
    { name: "r2min", win: 2 }, // 2-bar cumD sign, entry at 9:31 close
    { name: "r5min", win: 5 },
    { name: "r10min", win: 10 },
    { name: "r15min", win: 15 },
  ];
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));

  console.log(`daily-rules study over ${dates.length} sessions…`);
  const t0 = Date.now();
  const agg = new Map<string, { n: number; hits: number; bars: number[]; maes: number[] }>();

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 16 >= minutes.length) continue;
    for (const r of RULES) {
      const last = i0 + r.win - 1;
      let cumD = 0;
      for (let k = i0; k <= last; k++) cumD += minutes[k].buy - minutes[k].sell;
      if (cumD === 0) continue;
      const dir: 1 | -1 = cumD > 0 ? 1 : -1;
      const entry = closeOf(minutes[last]);
      const end = Math.min(minutes.length - 1, last + 60);
      for (const [tp, sl] of TPSL) {
        const key = `${r.name}|${tp}|${sl}`;
        const a = agg.get(key) ?? { n: 0, hits: 0, bars: [], maes: [] };
        let hit = false;
        let barsTo = 0;
        let mae = 0;
        for (let j = last + 1; j <= end; j++) {
          const m = minutes[j];
          const fav = dir > 0 ? m.high - entry : entry - m.low;
          const adv = dir > 0 ? entry - m.low : m.high - entry;
          mae = Math.max(mae, adv);
          if (adv >= sl) break;
          if (fav >= tp) { hit = true; barsTo = j - last; break; }
        }
        a.n++;
        if (hit) { a.hits++; a.bars.push(barsTo); a.maes.push(mae); }
        agg.set(key, a);
      }
    }
  }
  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("rule  | TP | SL | n   | hit%  | med bars | med MAE | exp pts (gross)");
  for (const r of RULES) {
    for (const [tp, sl] of TPSL) {
      const a = agg.get(`${r.name}|${tp}|${sl}`);
      if (!a) continue;
      const hitPct = (100 * a.hits) / a.n;
      const medBars = a.bars.length ? a.bars.sort((x, y) => x - y)[Math.floor(a.bars.length / 2)] : 0;
      const medMae = a.maes.length ? a.maes.sort((x, y) => x - y)[Math.floor(a.maes.length / 2)] : 0;
      const expPts = (hitPct / 100) * tp - (1 - hitPct / 100) * sl;
      console.log(`${r.name.padEnd(5)} | ${String(tp).padStart(2)} | ${String(sl).padStart(2)} | ${String(a.n).padStart(3)} | ${hitPct.toFixed(0).padStart(4)}% | ${String(medBars).padStart(8)} | ${medMae.toFixed(0).padStart(7)} | ${expPts.toFixed(1).padStart(7)}`);
    }
    console.log("");
  }
}

const mode = process.argv.includes("--rules") ? "rules" : "excursion";
if (mode === "rules") {
  dailyRules().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
