/* ------------------------------------------------------------------ *
 * Pullback-entry study — translate "buy the pullback in the real
 * direction" into an objective footprint + price-action reading.
 *
 * Setup (long; short mirrors):
 *   TREND      the 15-bar cumulative delta before the pullback is positive
 *   PULLBACK   the last bar traded AGAINST the trend (sell), and it held
 *              above the prior 5-bar low (structure intact), and its
 *              counter-aggression SHRANK vs the prior counter-bar
 *              (|delta| falling = sellers exhausting)
 *   TRIGGER    the current bar closes back above the pullback bar's high
 *              with buy-side delta → enter at its close
 *   STOP       pullback bar's low − 0.5
 *   TARGET     1R (also measured fixed TP10/SL15)
 *
 * Scored first-touch over 60 bars, 0.5 pt cost in the expectancy line.
 * GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *   scripts/pullbackEntry.ts [--open]  (--open = 9:30-10:30 window only)
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";
import { scoreTrade, coreStats, renderT1, renderT2, renderT4, renderVerdict, propViability, type EngineTrade } from "../lib/backtestEngine";

type Scored = { n: number; wins: number; exp1r: number; hitTp10: number; medBars: number[]; mae: number[] };

async function main() {
  const onlyOpen = process.argv.includes("--open");
  const dates = await archiveDates();
  console.log(`pullback-entry study over ${dates.length} sessions${onlyOpen ? " (9:30-10:30 only)" : ""}…`);
  const t0 = Date.now();

  const r1r: Scored = { n: 0, wins: 0, exp1r: 0, hitTp10: 0, medBars: [], mae: [] };
  const f10: Scored = { n: 0, wins: 0, exp1r: 0, hitTp10: 0, medBars: [], mae: [] };
  const engineTrades1r: EngineTrade[] = [];
  const engineTradesF10: EngineTrade[] = [];
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    const n = minutes.length;
    const cumD15: number[] = new Array(n).fill(0);
    let c = 0;
    for (let i = 0; i < n; i++) {
      c += minutes[i].buy - minutes[i].sell;
      cumD15[i] = i >= 15 ? c - (minutes[i - 15] ? cumD15[i - 15] : 0) : 0;
      // simpler rolling: recompute
    }
    // rolling 15-bar delta (trailing, excluding the current bar)
    for (let i = 0; i < n; i++) {
      let s = 0;
      const from = Math.max(0, i - 15);
      for (let k = from; k < i; k++) s += minutes[k].buy - minutes[k].sell;
      cumD15[i] = s;
    }

    let lastSignal = -10_000;
    const startK = 20;
    for (let k = startK; k < n - 1; k++) {
      if (onlyOpen) {
        const h = hourET(minutes[k].t);
        if (!((h === 9 && mmOf(minutes[k].t) >= 30) || h === 10)) continue;
      }
      if (k - lastSignal < 5) continue;
      const D = cumD15[k]; // trend before the current bar
      if (D === 0) continue;
      const pb = minutes[k - 1]; // the pullback bar
      const pbD = pb.buy - pb.sell;
      const against = D > 0 ? pbD < 0 : pbD > 0;
      if (!against) continue; // last bar must be counter-trend
      // structure held: pullback low above the prior 5-bar low
      let lo5 = Infinity;
      for (let j = k - 6; j <= k - 2; j++) lo5 = Math.min(lo5, minutes[j].low);
      const held = D > 0 ? pb.low >= lo5 - 0.25 : pb.high <= lo5 + 0.25;
      // shrinking counter-aggression vs the prior counter bar
      const pbPrev = minutes[k - 2];
      const shrinking = Math.abs(pbD) < Math.abs(pbPrev.buy - pbPrev.sell);
      if (!held || !shrinking) continue;

      // trigger: current bar closes back through the pullback's high/low
      const m = minutes[k];
      const dir: 1 | -1 = D > 0 ? 1 : -1;
      const trigger = dir > 0 ? closeOf(m) > pb.high : closeOf(m) < pb.low;
      const deltaOk = dir > 0 ? m.buy - m.sell > 0 : m.buy - m.sell < 0;
      if (!trigger || !deltaOk) continue;

      const entry = closeOf(m);
      const stop = dir > 0 ? pb.low - 0.5 : pb.high + 0.5;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk > 25) continue;

      // score 1R
      const target1 = dir > 0 ? entry + risk : entry - risk;
      const end = Math.min(n - 1, k + 60);
      let win1 = false;
      let barsTo = 0;
      let mae = 0;
      let tp10hit = false;
      const tp10 = dir > 0 ? entry + 10 : entry - 10;
      const sl15 = dir > 0 ? entry - 15 : entry + 15;
      for (let j = k + 1; j <= end; j++) {
        const b = minutes[j];
        const fav = dir > 0 ? b.high - entry : entry - b.low;
        const adv = dir > 0 ? entry - b.low : b.high - entry;
        mae = Math.max(mae, adv);
        if (dir > 0 ? b.high >= tp10 : b.low <= tp10) tp10hit = true;
        if (adv >= risk) break;
        if (fav >= risk) { win1 = true; barsTo = j - k; break; }
      }
      // fixed TP10/SL15
      let hit10 = false;
      for (let j = k + 1; j <= end; j++) {
        const b = minutes[j];
        const fav = dir > 0 ? b.high - entry : entry - b.low;
        const adv = dir > 0 ? entry - b.low : b.high - entry;
        if (adv >= 15) break;
        if (fav >= 10) { hit10 = true; break; }
      }

      lastSignal = k;
      const upd = (r: Scored, win: boolean) => {
        r.n++;
        if (win) {
          r.wins++;
          r.exp1r += risk - 0.5;
          r.medBars.push(barsTo);
          r.mae.push(mae);
        } else {
          r.exp1r += -risk - 0.5;
        }
        if (tp10hit) r.hitTp10++;
      };
      upd(r1r, win1);
      f10.n++;
      if (hit10) {
        f10.wins++;
        f10.exp1r += 9.5;
      } else {
        f10.exp1r += -15.5;
      }

      // engine-scored copies for the standard report only — the legacy
      // win/loss model above stays untouched. The engine agrees with the
      // legacy model on stop/target outcomes and scores time exits at the
      // actual midpoint close instead of a full −R loss.
      const sc1r = scoreTrade(minutes, { dir, entry, stop, target: target1, entryIdx: k, risk });
      if (sc1r) engineTrades1r.push({ date, pnl: sc1r.pnl, risk });
      const scF10 = scoreTrade(minutes, { dir, entry, stop: sl15, target: tp10, entryIdx: k, risk: 15 });
      if (scF10) engineTradesF10.push({ date, pnl: scF10.pnl, risk: 15 });
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);
  const fmt = (r: Scored, label: string) => {
    const wr = r.n ? (100 * r.wins) / r.n : 0;
    const exp = r.n ? r.exp1r / r.n : 0;
    const medBars = r.medBars.length ? r.medBars.sort((x, y) => x - y)[Math.floor(r.medBars.length / 2)] : 0;
    const medMae = r.mae.length ? r.mae.sort((x, y) => x - y)[Math.floor(r.mae.length / 2)] : 0;
    console.log(`${label}: n=${r.n} wr=${wr.toFixed(1)}% exp=${exp.toFixed(2)} pts/trade (net) medBars=${medBars} medMAE=${medMae.toFixed(1)}`);
  };
  fmt(r1r, "1R target ");
  fmt(f10, "TP10/SL15 ");

  /* ==== STANDARD REPORT (consolidated engine) ==== */
  console.log("\n=== STANDARD REPORT ===");
  const et1r = coreStats(engineTrades1r);
  console.log(renderT1([{ label: "all (1R target, engine-scored)", stats: et1r }]));
  const etF10 = coreStats(engineTradesF10);
  console.log("\n" + renderT2([
    {
      rule: "1R target",
      n: et1r.n,
      wr: et1r.wr,
      ci: et1r.wrCi,
      pf: et1r.pf,
      expPts: et1r.expPts,
      trainTest: "—",
      compare: `vs TP10/SL15: wr ${etF10.wr.toFixed(1)}% pf ${Number.isFinite(etF10.pf) ? etF10.pf.toFixed(2) : "inf"}`,
    },
    {
      rule: "TP10/SL15",
      n: etF10.n,
      wr: etF10.wr,
      ci: etF10.wrCi,
      pf: etF10.pf,
      expPts: etF10.expPts,
      trainTest: "—",
      compare: `vs 1R target: wr ${et1r.wr.toFixed(1)}% pf ${Number.isFinite(et1r.pf) ? et1r.pf.toFixed(2) : "inf"}`,
    },
  ]));
  const v = propViability(engineTrades1r);
  console.log("\n" + renderT4(v));
  console.log(renderVerdict({
    edge: et1r.netPts > 0 && et1r.expR > 0 ? "real" : "absent",
    significance: "—",
    stability: "—",
    holdout: "n/a (validation pipeline)",
    viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


/* ---------------- failed local flush → buy the close ---------------- */

async function flushHold() {
  const dates = await archiveDates();
  console.log(`failed-local-flush study over ${dates.length} sessions (9:30-10:30)…`);
  const t0 = Date.now();
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));
  const VARIANTS = [
    { name: "fh60", minDelta: 60, minFrac: 0.55 },
    { name: "fh40", minDelta: 40, minFrac: 0.55 },
    { name: "fh80", minDelta: 80, minFrac: 0.55 },
    { name: "fh60f60", minDelta: 60, minFrac: 0.6 },
  ];
  const agg = new Map<string, { n: number; wins: number; exp: number }>();
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 4 >= minutes.length) continue;
    const endK = Math.min(minutes.length - 1, i0 + 60);
    let lastSignal = i0 - 10;
    for (let k = i0 + 2; k <= endK; k++) {
      if (k - lastSignal < 5) continue;
      const h = hourET(minutes[k].t);
      if (h !== 9 && h !== 10) continue;
      const m = minutes[k];
      const vol = m.buy + m.sell;
      if (vol < 200) continue;
      const arr: number[] = [];
      for (let j = Math.max(0, k - 15); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
      const medV = arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] ?? 1;
      if (vol < 1.5 * medV) continue;
      const delta = m.buy - m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      let dir: "long" | "short" | null = null;
      let usedVariant = false;
      for (const v of VARIANTS) {
        dir = delta <= -v.minDelta && frac <= 1 - v.minFrac ? "long" : delta >= v.minDelta && frac >= v.minFrac ? "short" : null;
        if (dir === null) continue;
        let lo5 = Infinity;
        let hi5 = -Infinity;
        for (let j = k - 5; j < k; j++) {
          lo5 = Math.min(lo5, minutes[j].low);
          hi5 = Math.max(hi5, minutes[j].high);
        }
        const held = dir === "long" ? m.low >= lo5 - 0.5 : m.high <= hi5 + 0.5;
        if (!held) continue;
        const entry = closeOf(m);
        const stop = dir === "long" ? m.low - 0.5 : m.high + 0.5;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || risk > 25) continue;
        const target = dir === "long" ? entry + risk : entry - risk;
        let win = false;
        for (let j = k + 1; j <= Math.min(minutes.length - 1, k + 60); j++) {
          const b = minutes[j];
          const fav = dir === "long" ? b.high - entry : entry - b.low;
          const adv = dir === "long" ? entry - b.low : b.high - entry;
          if (adv >= risk) break;
          if (fav >= risk) { win = true; break; }
        }
        const key = `${v.name}|${dir}`;
        const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0 };
        a.n++;
        if (win) { a.wins++; a.exp += risk - 0.5; } else { a.exp += -risk - 0.5; }
        agg.set(key, a);
        usedVariant = true;
      }
      if (usedVariant) lastSignal = k;
    }
  }
  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("variant  | dir   | n   | wr     | exp pts/trade (net)");
  for (const v of VARIANTS) {
    for (const dir of ["long", "short"]) {
      const a = agg.get(`${v.name}|${dir}`);
      if (!a) continue;
      const wr = a.n ? (100 * a.wins) / a.n : 0;
      console.log(`${v.name.padEnd(8)} | ${dir.padEnd(5)} | ${String(a.n).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${(a.exp / a.n).toFixed(2).padStart(8)}`);
    }
  }
}


/* ------- opening-range extreme defense (the 9:31-low defense trade) ------- */

async function rangeDefense() {
  const dates = await archiveDates();
  console.log(`opening-range defense study over ${dates.length} sessions…`);
  const t0 = Date.now();
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));
  const agg = new Map<string, { n: number; wins: number; exp: number }>();
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 8 >= minutes.length) continue;
    // the opening range = first 6 minutes (9:30-9:35)
    let rHi = -Infinity;
    let rLo = Infinity;
    for (let k = i0; k <= Math.min(i0 + 5, minutes.length - 1); k++) {
      rHi = Math.max(rHi, minutes[k].high);
      rLo = Math.min(rLo, minutes[k].low);
    }
    let lastSignal = i0 - 10;
    for (let k = i0 + 6; k <= Math.min(minutes.length - 1, i0 + 30); k++) {
      if (k - lastSignal < 5) continue;
      const h = hourET(minutes[k].t);
      if (h !== 9 && h !== 10) continue;
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const arr: number[] = [];
      for (let j = Math.max(0, k - 15); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
      const medV = arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] ?? 1;
      if (vol < Math.max(300, 1.5 * medV)) continue;
      const delta = m.buy - m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      // flush into the range extreme that HOLDS it
      let dir: "long" | "short" | null = null;
      let held: boolean;
      if (delta < -60 && frac < 0.5) {
        dir = "long";
        held = m.low >= rLo - 1;
      } else if (delta > 60 && frac > 0.5) {
        dir = "short";
        held = m.high <= rHi + 1;
      } else continue;
      if (!held) continue;
      const entry = closeOf(m);
      const stop = dir === "long" ? m.low - 0.5 : m.high + 0.5;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk > 25) continue;
      const target = dir === "long" ? entry + risk : entry - risk;
      let win = false;
      for (let j = k + 1; j <= Math.min(minutes.length - 1, k + 60); j++) {
        const b = minutes[j];
        const fav = dir === "long" ? b.high - entry : entry - b.low;
        const adv = dir === "long" ? entry - b.low : b.high - entry;
        if (adv >= risk) break;
        if (fav >= risk) { win = true; break; }
      }
      const key = dir;
      const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0 };
      a.n++;
      if (win) { a.wins++; a.exp += risk - 0.5; } else { a.exp += -risk - 0.5; }
      agg.set(key, a);
      lastSignal = k;
    }
  }
  console.log(`${(Date.now() - t0) / 1000}s\n`);
  for (const [dir, a] of agg) {
    const wr = a.n ? (100 * a.wins) / a.n : 0;
    console.log(`rangeDefense ${dir}: n=${a.n} wr=${wr.toFixed(1)}% exp=${(a.exp / a.n).toFixed(2)} pts/trade (net)`);
  }
}


/* -------- opening-range-low limit fade (your 9:36:01 fill pattern) -------- */

async function orlFade() {
  const dates = await archiveDates();
  console.log(`ORL limit-fade study over ${dates.length} sessions…`);
  const t0 = Date.now();
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));
  const PLANS: { name: string; entryPad: number; stopPad: number; target: number }[] = [
    { name: "p0s8t25", entryPad: 0, stopPad: 8, target: 25 },
    { name: "p2s8t25", entryPad: 2, stopPad: 8, target: 25 },
    { name: "p5s10t30", entryPad: 5, stopPad: 10, target: 30 },
    { name: "p5s10t45", entryPad: 5, stopPad: 10, target: 45 },
  ];
  const agg = new Map<string, { n: number; wins: number; exp: number }>();
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 8 >= minutes.length) continue;
    // opening range = first 6 minutes
    let rHi = -Infinity;
    let rLo = Infinity;
    for (let k = i0; k <= Math.min(i0 + 5, minutes.length - 1); k++) {
      rHi = Math.max(rHi, minutes[k].high);
      rLo = Math.min(rLo, minutes[k].low);
    }
    // condition: a flush bar (after the range) holds the range low
    let defended = false;
    for (let k = i0 + 6; k <= Math.min(minutes.length - 1, i0 + 15); k++) {
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const arr: number[] = [];
      for (let j = Math.max(0, k - 15); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
      const medV = arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] ?? 1;
      if (vol < Math.max(300, 1.5 * medV)) continue;
      if (m.buy - m.sell < -60 && m.low >= rLo - 1) { defended = true; break; }
    }
    if (!defended) continue;
    for (const plan of PLANS) {
      const entry = rLo + plan.entryPad;
      const stop = rLo - plan.stopPad;
      const target = entry + plan.target;
      // the limit gets filled only if price trades down to it; then score
      let filled = false;
      let fillBar = -1;
      for (let k = i0 + 6; k <= Math.min(minutes.length - 1, i0 + 30); k++) {
        if (minutes[k].low <= entry) { filled = true; fillBar = k; break; }
      }
      if (!filled) continue;
      let win = false;
      let stopOut = false;
      for (let j = fillBar + 1; j <= Math.min(minutes.length - 1, fillBar + 60); j++) {
        const b = minutes[j];
        if (b.low <= stop) { stopOut = true; break; }
        if (b.high >= target) { win = true; break; }
      }
      const key = plan.name;
      const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0 };
      a.n++;
      if (win) { a.wins++; a.exp += plan.target - 0.5; } else if (stopOut) { a.exp += -(entry - stop) - 0.5; } else { a.exp += 0; }
      agg.set(key, a);
    }
  }
  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("plan       | n   | wr     | exp pts/trade (net)");
  for (const plan of PLANS) {
    const a = agg.get(plan.name);
    if (!a) continue;
    const wr = a.n ? (100 * a.wins) / a.n : 0;
    console.log(`${plan.name.padEnd(10)} | ${String(a.n).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${(a.exp / a.n).toFixed(2).padStart(8)}`);
  }
}


/* -------- the sniper: your exact 4-condition reproduction, backtested -------- */

async function sniper() {
  const dates = await archiveDates();
  console.log(`SNIPER study over ${dates.length} sessions…`);
  const t0 = Date.now();
  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));
  const PLANS = [
    { name: "p9s10-FH", pad: 9.5, stop: 10, target: "flushHigh" },
    { name: "p9s10-t45", pad: 9.5, stop: 10, target: "45" },
    { name: "p9s10-2R", pad: 9.5, stop: 10, target: "2R" },
    { name: "p9s12-t45", pad: 9.5, stop: 12, target: "45" },
    { name: "p12s10-t45", pad: 12, stop: 10, target: "45" },
    { name: "p9s10-FH-fp1", pad: 9.5, stop: 10, target: "flushHigh", fp: 1 },
    { name: "p9s10-FH-fp2", pad: 9.5, stop: 10, target: "flushHigh", fp: 2 },
  ];
  const agg = new Map<string, { n: number; wins: number; exp: number; days: Set<string> }>();
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 8 >= minutes.length) continue;
    // opening range = first 6 minutes
    let rHi = -Infinity;
    let rLo = Infinity;
    for (let k = i0; k <= Math.min(i0 + 5, minutes.length - 1); k++) {
      rHi = Math.max(rHi, minutes[k].high);
      rLo = Math.min(rLo, minutes[k].low);
    }
    // find the flush: big, one-sided toward the anchor, holding it
    let flushBar = -1;
    for (let k = i0 + 6; k <= Math.min(minutes.length - 1, i0 + 15); k++) {
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const arr: number[] = [];
      for (let j = Math.max(0, k - 15); j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
      const medV = arr.sort((x, y) => x - y)[Math.floor(arr.length / 2)] ?? 1;
      if (vol < Math.max(300, 1.5 * medV)) continue;
      const delta = m.buy - m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      if (delta > -60 && delta < 60) continue;
      if (delta <= -60 && frac <= 0.45 && m.low >= rLo - 1) { flushBar = k; break; }
      if (delta >= 60 && frac >= 0.55 && m.high <= rHi + 1) { flushBar = k; break; }
    }
    if (flushBar < 0) continue;
    const fm = minutes[flushBar];
    const dir: "long" | "short" = fm.buy < fm.sell ? "long" : "short";
    const anchor = dir === "long" ? rLo : rHi;
    // footprint defense: dominant clusters at the anchor zone during the flush
    let fpCount = 0;
    for (const l of fm.levels) {
      const near = dir === "long" ? l.price <= rLo + 2 : l.price >= rHi - 2;
      if (!near) continue;
      if (dir === "long" && l.buy >= 3 && l.buy >= 2 * l.sell) fpCount++;
      if (dir === "short" && l.sell >= 3 && l.sell >= 2 * l.buy) fpCount++;
    }
    for (const plan of PLANS) {
      if (plan.fp !== undefined && fpCount < plan.fp) continue;
      const entry = dir === "long" ? anchor + plan.pad : anchor - plan.pad;
      const stop = dir === "long" ? anchor - plan.stop : anchor + plan.stop;
      let target: number;
      if (plan.target === "flushHigh") target = dir === "long" ? fm.high : fm.low;
      else if (plan.target === "2R") target = dir === "long" ? entry + 2 * (entry - stop) : entry - 2 * (entry - stop);
      else target = dir === "long" ? entry + Number(plan.target) : entry - Number(plan.target);
      // the limit fills only on a retest
      let fillBar = -1;
      for (let k = flushBar; k <= Math.min(minutes.length - 1, flushBar + 30); k++) {
        if (dir === "long" ? minutes[k].low <= entry : minutes[k].high >= entry) { fillBar = k; break; }
      }
      if (fillBar < 0) continue;
      let win = false;
      let stopped = false;
      for (let j = fillBar; j <= Math.min(minutes.length - 1, fillBar + 60); j++) {
        const b = minutes[j];
        if (dir === "long" ? b.low <= stop : b.high >= stop) { stopped = true; break; }
        if (dir === "long" ? b.high >= target : b.low <= target) { win = true; break; }
      }
      const key = `${plan.name}|${dir}`;
      const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0, days: new Set() };
      a.n++;
      a.days.add(date);
      const risk = Math.abs(entry - stop);
      if (win) { a.wins++; a.exp += Math.abs(target - entry) - 0.5; } else if (stopped) { a.exp += -risk - 0.5; } else { a.exp += 0; }
      agg.set(key, a);
    }
  }
  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("plan           | dir   | n   | wr     | exp pts/trade (net) | days");
  for (const plan of PLANS) {
    for (const dir of ["long", "short"]) {
      const a = agg.get(`${plan.name}|${dir}`);
      if (!a) continue;
      const wr = a.n ? (100 * a.wins) / a.n : 0;
      console.log(`${plan.name.padEnd(14)} | ${dir.padEnd(5)} | ${String(a.n).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${(a.exp / a.n).toFixed(2).padStart(19)} | ${(100 * a.days.size / dates.length).toFixed(0)}%`);
    }
  }
}

if (process.argv.includes("--sniper")) {
  sniper().catch((e) => { console.error(e); process.exit(1); });
} else if (process.argv.includes("--orl")) {
  orlFade().catch((e) => { console.error(e); process.exit(1); });
} else if (process.argv.includes("--range")) {
  rangeDefense().catch((e) => { console.error(e); process.exit(1); });
} else if (process.argv.includes("--flush")) {
  flushHold().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
