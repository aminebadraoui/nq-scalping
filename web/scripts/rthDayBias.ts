/* ------------------------------------------------------------------ *
 * Day-bias + double-bar confirmation study (RTH).
 * Angles the four agents are not covering:
 *   bias  — the 9:30-10:00 cumulative delta sets the day's regime; only
 *           trade soft-continuation WITH the bias when |bias| is strong.
 *   dbl   — two consecutive one-sided bars in the same direction, the
 *           second closing beyond the first's high/low → continuation.
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";
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

type T = { date: string; pnlPts: number; riskPts: number; hourET: number };

async function main() {
  const dates = await archiveDates();
  console.log(`day-bias study over ${dates.length} sessions…`);
  const t0 = Date.now();
  const agg = new Map<string, { n: number; wins: number; exp: number }>();
  const trades: Record<string, T[]> = {};

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    const n = minutes.length;

    // day bias = cumulative delta of 9:30-10:00
    let bias = 0;
    for (let k = 0; k < n; k++) {
      if (!inRTH(minutes[k].t)) continue;
      const h = hourET(minutes[k].t);
      if (h === 9 || (h === 10 && mmOf(minutes[k].t) === 0)) bias += minutes[k].buy - minutes[k].sell;
      else break;
    }
    const biasDir: 1 | -1 | 0 = bias >= 500 ? 1 : bias <= -500 ? -1 : 0;

    const medVol = (i: number): number => {
      const arr: number[] = [];
      for (let j = Math.max(0, i - 60); j < i; j++) arr.push(minutes[j].buy + minutes[j].sell);
      return med(arr);
    };

    const score = (key: string, dir: 1 | -1, entry: number, stop: number, k: number) => {
      const risk = Math.abs(entry - stop);
      if (!(risk > 0) || risk > 15) return;
      const target = dir === 1 ? entry + risk : entry - risk;
      let win = false;
      let stopped = false;
      const end = Math.min(n - 1, k + 60);
      for (let j = k + 1; j <= end; j++) {
        const b = minutes[j];
        if (dir === 1 ? b.low <= stop : b.high >= stop) { stopped = true; break; }
        if (dir === 1 ? b.high >= target : b.low <= target) { win = true; break; }
      }
      const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0 };
      a.n++;
      if (win) { a.wins++; a.exp += risk - 0.5; } else if (stopped) { a.exp += -risk - 0.5; }
      agg.set(key, a);
      const tr = trades[key] ?? [];
      tr.push({ date, pnlPts: win ? risk - 0.5 : stopped ? -risk - 0.5 : 0, riskPts: risk, hourET: hourET(minutes[k].t) });
      trades[key] = tr;
    };

    let last = -100;
    for (let k = 20; k < n - 1; k++) {
      if (!inRTH(minutes[k].t)) continue;
      if (k - last < 5) continue;
      const m = minutes[k];
      const vol = m.buy + m.sell;
      if (vol < 0.5 * medVol(k)) continue;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      let dir: 1 | -1 | null = null;
      if (frac >= 0.6) dir = 1;
      else if (frac <= 0.4) dir = -1;
      if (!dir) continue;

      const entry = closeOf(m);
      const stop = dir === 1 ? m.low - 1 : m.high + 1;

      // base
      score("base", dir, entry, stop, k);
      // day-bias filter
      if (biasDir === dir) score("bias", dir, entry, stop, k);
      // double-bar: the prior bar was one-sided the same way and we close beyond its extreme
      const pm = minutes[k - 1];
      const pv = pm.buy + pm.sell;
      const pf = pv > 0 ? pm.buy / pv : 0.5;
      if ((dir === 1 && pf >= 0.55 && closeOf(m) > pm.high) || (dir === -1 && pf <= 0.45 && closeOf(m) < pm.low)) {
        score("dbl", dir, entry, stop, k);
        if (biasDir === dir) score("dblBias", dir, entry, stop, k);
      }
      last = k;
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("variant | n    | wr     | exp pts/trade (net)");
  for (const [key, a] of [...agg.entries()].sort()) {
    const wr = a.n ? (100 * a.wins) / a.n : 0;
    console.log(`${key.padEnd(8)} | ${String(a.n).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${(a.exp / a.n).toFixed(2).padStart(8)}`);
    const tr = trades[key] ?? [];
    const d = dollarize(tr);
    console.log(`          eval: ${accountLine(simulateAccount(d, "eval"))}`);
    console.log(`          funded: ${accountLine(simulateAccount(d, "funded"))}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
