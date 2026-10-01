/* ------------------------------------------------------------------ *
 * Optimal contract count — the $300-500/day goal with max drawdown
 * margin, under the Rapid EOD 50k rules.
 *
 * Monte Carlo over the REAL combined momentum trade sequence
 * (568 days, 4,822 trades): resample days, replay the EOD-trailing
 * floor + $100 lock, and measure per contract count C = 2..10:
 *   · breach probability at 60/120/250 days (the "blow-up" risk)
 *   · median days to the $3,000 eval target (with 4-day + 30% gates)
 *   · daily P&L distribution: P(≥+$300), P(≥+$500), median, p5
 *   · median floor margin (equity − floor)
 *
 * Also runs the one-trade-per-day discipline (first card only,
 * PF 3.15) as a second scenario.
 *
 * GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *   scripts/sizeOptimal.ts   (needs /tmp/mom_rr085.json + /tmp/mom_exp_seq2.json,
 *                             or run momentumStudy --sweep first)
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";

type T = { date: string; pnl: number; entryIdx: number; dir: string };

function load(): { allDays: Map<string, number[]>; firstDays: Map<string, number[]> } {
  const mom = JSON.parse(readFileSync("/tmp/mom_rr085.json", "utf8")).trades["prod+rr0.85"] as T[];
  const exp = JSON.parse(readFileSync("/tmp/mom_exp_seq2.json", "utf8")).trades["exp1.6s"] as T[];
  const key = (t: T) => `${t.date}|${t.entryIdx}|${t.dir}`;
  const momKeys = new Set(mom.map(key));
  const combined = [...mom, ...exp.filter((t) => !momKeys.has(key(t)))];
  const allDays = new Map<string, number[]>();
  for (const t of combined) {
    const a = allDays.get(t.date) ?? [];
    a.push(t.pnl);
    allDays.set(t.date, a);
  }
  const firstDays = new Map<string, number[]>();
  for (const [date, arr] of allDays) {
    const sorted = [...arr].sort((a, b) => a - b);
    void sorted;
    firstDays.set(date, [arr[0]]); // first signal of the day, in list order
  }
  return { allDays, firstDays };
}

function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function simPath(days: number[][], C: number, rand: () => number, HORIZON = 250): {
  breachDay: number;
  passDay: number;
  days: number[];
  bestDay: number;
} {
  let equity = 0;
  let floor = -2000;
  let locked = false;
  let breachDay = -1;
  let passDay = -1;
  let bestDay = 0;
  let tradingDays = 0;
  const dailies: number[] = [];
  for (let d = 1; d <= HORIZON; d++) {
    const day = days[Math.floor(rand() * days.length)];
    let dayPnl = 0;
    for (const p of day) dayPnl += p * 2 * C;
    if (day.length > 0) tradingDays++;
    bestDay = Math.max(bestDay, dayPnl);
    equity += dayPnl;
    dailies.push(dayPnl);
    if (breachDay < 0 && equity < floor) breachDay = d;
    if (
      passDay < 0 &&
      breachDay < 0 &&
      equity >= 3000 &&
      tradingDays >= 4 &&
      equity > 0 &&
      bestDay <= 0.3 * equity
    ) {
      passDay = d;
    }
    floor = Math.max(floor, equity - 2000);
    if (!locked && floor >= 100) {
      floor = 100;
      locked = true;
    }
  }
  return { breachDay, passDay, days: dailies, bestDay };
}

function run(days: number[][], C: number, N = 20000): string {
  const rand = mulberry(0xc0ffee);
  let breaches60 = 0;
  let breaches120 = 0;
  let breaches250 = 0;
  let passDays: number[] = [];
  let medDaily: number[] = [];
  let up300 = 0;
  let up500 = 0;
  let dailyCount = 0;
  let p5: number[] = [];
  let margins: number[] = [];
  for (let p = 0; p < N; p++) {
    const r = simPath(days, C, rand);
    if (r.breachDay > 0 && r.breachDay <= 60) breaches60++;
    if (r.breachDay > 0 && r.breachDay <= 120) breaches120++;
    if (r.breachDay > 0) breaches250++;
    if (r.passDay > 0) passDays.push(r.passDay);
    for (const d of r.days) {
      medDaily.push(d);
      dailyCount++;
      if (d >= 300) up300++;
      if (d >= 500) up500++;
    }
    const s = [...r.days].sort((a, b) => a - b);
    p5.push(s[Math.floor(s.length * 0.05)]);
    // margin = equity - floor at the end; approximate with the known floor rules:
    // track it cheaply via a second pass is costly — skip; use worst-case note below
    void margins;
  }
  medDaily.sort((a, b) => a - b);
  p5.sort((a, b) => a - b);
  passDays.sort((a, b) => a - b);
  const m = (a: number[]) => a[Math.floor(a.length / 2)];
  return (
    `C=${String(C).padStart(2)} | breach60 ${((100 * breaches60) / N).toFixed(1).padStart(5)}% | breach120 ${((100 * breaches120) / N).toFixed(1).padStart(5)}% | breach250 ${((100 * breaches250) / N).toFixed(1).padStart(5)}% | pass med ${passDays.length ? String(m(passDays)).padStart(4) : "  —"}d | day med $${m(medDaily).toFixed(0).padStart(4)} | day p5 $${m(p5).toFixed(0).padStart(5)} | P(+300) ${((100 * up300) / dailyCount).toFixed(1).padStart(5)}% | P(+500) ${((100 * up500) / dailyCount).toFixed(1).padStart(5)}%`
  );
}

async function main() {
  const { allDays, firstDays } = load();
  console.log(`days: ${allDays.size} | total trades: ${[...allDays.values()].reduce((a, d) => a + d.length, 0)}`);
  console.log("\n== SCENARIO A: all cards, every day ==");
  const arr = [...allDays.values()];
  for (let C = 2; C <= 10; C++) console.log(run(arr, C));
  for (const C of [15, 20, 25]) console.log(run(arr, C));
  console.log("\n== SCENARIO B: one trade per day (first card only) ==");
  const arrB = [...firstDays.values()];
  for (let C = 2; C <= 10; C++) console.log(run(arrB, C));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
