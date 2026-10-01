/* ------------------------------------------------------------------ *
 * Footprint × candle-impact interaction study (RTH).
 * The directive: compare footprint microstructure inside a bar against
 * the bar's forward impact. Builds the interaction table, then 1R
 * strategy variants from the top cells.
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { writeFileSync } from "node:fs";
import { closeOf } from "../lib/momentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
const inRTH = (t: string): boolean => {
  const h = hourET(t);
  const mm = mmOf(t);
  return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  const dates = await archiveDates();
  console.log(`footprint × candle-impact study over ${dates.length} sessions…`);
  const t0 = Date.now();

  // interaction: cell key → {n, up}
  const cells = new Map<string, { n: number; up: number }>();
  // strategy variants
  const strat = new Map<string, { n: number; wins: number; exp: number; trades: { date: string; pnlPts: number; riskPts: number }[] }>();

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    const n = minutes.length;

    const medVol = (i: number): number => {
      const arr: number[] = [];
      for (let j = Math.max(0, i - 60); j < i; j++) arr.push(minutes[j].buy + minutes[j].sell);
      return med(arr);
    };
    const atr = (i: number): number => {
      const arr: number[] = [];
      for (let j = Math.max(0, i - 14); j < i; j++) arr.push(minutes[j].high - minutes[j].low);
      return med(arr);
    };

    // day bias = 9:30-10:00 cumulative delta
    let bias = 0;
    for (let k = 0; k < n; k++) {
      if (!inRTH(minutes[k].t)) continue;
      const h = hourET(minutes[k].t);
      if (h === 9 || (h === 10 && mmOf(minutes[k].t) === 0)) bias += minutes[k].buy - minutes[k].sell;
      else break;
    }
    const biasDir: 1 | -1 | 0 = bias >= 500 ? 1 : bias <= -500 ? -1 : 0;

    let last = -100;
    for (let k = 20; k < n - 1; k++) {
      if (!inRTH(minutes[k].t)) continue;
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      const range = m.high - m.low;
      const rr = range / Math.max(0.25, atr(k));
      let buyC = 0;
      let sellC = 0;
      for (const l of m.levels) {
        if (l.buy >= 3 && l.buy >= 2 * l.sell) buyC++;
        if (l.sell >= 3 && l.sell >= 2 * l.buy) sellC++;
      }
      const cluster = buyC > sellC ? `B${Math.min(buyC, 5)}` : sellC > buyC ? `S${Math.min(sellC, 5)}` : "N";
      const nextUp = closeOf(minutes[k + 1]) > closeOf(m) ? 1 : 0;
      const cellKey = `${cluster}|${frac >= 0.65 ? "h" : frac >= 0.55 ? "m" : "l"}|${rr >= 1.2 ? "big" : rr >= 0.8 ? "mid" : "small"}`;
      const c = cells.get(cellKey) ?? { n: 0, up: 0 };
      c.n++;
      c.up += nextUp;
      cells.set(cellKey, c);

      // strategy variants from top-cell hypotheses
      if (k - last < 5) continue;
      const entry = closeOf(m);
      let cumD15 = 0;
      for (let j = k - 15; j < k; j++) cumD15 += minutes[j].buy - minutes[j].sell;
      const scoreStrat = (key: string, dir: 1 | -1, opts: { stopPad?: number; tR?: number } = {}) => {
        const stopPad = opts.stopPad ?? 1;
        const tR = opts.tR ?? 1;
        const stop = dir === 1 ? m.low - stopPad : m.high + stopPad;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || risk > 15) return;
        const target = dir === 1 ? entry + tR * risk : entry - tR * risk;
        let win = false;
        let stopped = false;
        for (let j = k + 1; j <= Math.min(n - 1, k + 60); j++) {
          const b = minutes[j];
          if (dir === 1 ? b.low <= stop : b.high >= stop) { stopped = true; break; }
          if (dir === 1 ? b.high >= target : b.low <= target) { win = true; break; }
        }
        const a = strat.get(key) ?? { n: 0, wins: 0, exp: 0, trades: [] };
        a.n++;
        if (win) { a.wins++; a.exp += tR * risk - 0.5; a.trades.push({ date, pnlPts: tR * risk - 0.5, riskPts: risk }); }
        else if (stopped) { a.exp += -risk - 0.5; a.trades.push({ date, pnlPts: -risk - 0.5, riskPts: risk }); }
        strat.set(key, a);
        last = k;
      };
      const cond = (dir: 1 | -1) =>
        vol >= 0.5 * medVol(k) &&
        (dir === 1 ? buyC >= 3 && frac >= 0.6 && rr >= 1.0 : sellC >= 3 && frac <= 0.4 && rr >= 1.0);
      if (cond(1)) scoreStrat("fp3-60-big", 1);
      if (cond(-1)) scoreStrat("fp3-60-big", -1);
      if (cond(1) && biasDir === 1) scoreStrat("fp3+bias", 1);
      if (cond(-1) && biasDir === -1) scoreStrat("fp3+bias", -1);
      if (cond(1) && cumD15 > 0) scoreStrat("fp3+trend", 1);
      if (cond(-1) && cumD15 < 0) scoreStrat("fp3+trend", -1);
      if (cond(1) && biasDir === 1 && cumD15 > 0) scoreStrat("fp3+bias+trend", 1);
      if (cond(-1) && biasDir === -1 && cumD15 < 0) scoreStrat("fp3+bias+trend", -1);
      if (cond(1)) scoreStrat("fp3-stop0.5", 1, { stopPad: 0.5 });
      if (cond(-1)) scoreStrat("fp3-stop0.5", -1, { stopPad: 0.5 });
      if (cond(1)) scoreStrat("fp3-t0.75", 1, { tR: 0.75 });
      if (cond(-1)) scoreStrat("fp3-t0.75", -1, { tR: 0.75 });
      if (cond(1) && biasDir === 1) scoreStrat("fp3+bias+stop0.5", 1, { stopPad: 0.5 });
      if (cond(-1) && biasDir === -1) scoreStrat("fp3+bias+stop0.5", -1, { stopPad: 0.5 });
      if (vol >= 0.5 * medVol(k) && (buyC >= 3 && frac >= 0.65 && rr >= 0.8)) scoreStrat("fp3-65-mid", 1);
      if (vol >= 0.5 * medVol(k) && (sellC >= 3 && frac <= 0.35 && rr >= 0.8)) scoreStrat("fp3-65-mid", -1);
      // the top interaction cells: >=5 dominant clusters + >=65% one-sided + big candle
      if (vol >= 0.5 * medVol(k) && (buyC >= 5 && frac >= 0.65 && rr >= 1.2)) scoreStrat("fp5-65-big", 1);
      if (vol >= 0.5 * medVol(k) && (sellC >= 5 && frac <= 0.35 && rr >= 1.2)) scoreStrat("fp5-65-big", -1);
      if (vol >= 0.5 * medVol(k) && (buyC >= 5 && frac >= 0.7 && rr >= 1.2)) scoreStrat("fp5-70-big", 1);
      if (vol >= 0.5 * medVol(k) && (sellC >= 5 && frac <= 0.3 && rr >= 1.2)) scoreStrat("fp5-70-big", -1);
      if (vol >= 1.0 * medVol(k) && (buyC >= 5 && frac >= 0.65 && rr >= 1.2)) scoreStrat("fp5-65-bigV2", 1);
      if (vol >= 1.0 * medVol(k) && (sellC >= 5 && frac <= 0.35 && rr >= 1.2)) scoreStrat("fp5-65-bigV2", -1);
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("== interaction: cluster × delta × size → % next bar up ==");
  const order = ["B1", "B2", "B3", "B4", "B5", "N", "S1", "S2", "S3", "S4", "S5"];
  for (const key of [...cells.keys()].sort((a, b) => {
    const [ca] = a.split("|");
    const [cb] = b.split("|");
    return order.indexOf(ca) - order.indexOf(cb) || a.localeCompare(b);
  })) {
    const c = cells.get(key)!;
    if (c.n < 100) continue;
    console.log(`  ${key.padEnd(18)} n=${String(c.n).padStart(6)} up=${((100 * c.up) / c.n).toFixed(1).padStart(5)}%`);
  }

  const w = strat.get("fp3-t0.75");
  if (w) writeFileSync("/tmp/rth_winner.json", JSON.stringify(w.trades));
  console.log("\n== strategy variants (1R, stop under bar, RTH) ==");
  for (const [key, a] of [...strat.entries()].sort()) {
    const wr = a.n ? (100 * a.wins) / a.n : 0;
    console.log(`${key.padEnd(12)} | n=${String(a.n).padStart(4)} wr=${wr.toFixed(1).padStart(5)}% exp=${(a.exp / a.n).toFixed(2).padStart(6)} pts/trade`);
    const d = dollarize(a.trades);
    console.log(`               eval: ${accountLine(simulateAccount(d, "eval"))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
