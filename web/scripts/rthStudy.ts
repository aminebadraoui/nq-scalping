/* ------------------------------------------------------------------ *
 * RTH strategy study — what works in 9:30-16:00, where every existing
 * product refuses to trade.
 *
 * Candidates, all first-touch scored over 60 bars with 0.5 pt cost:
 *   C1 soft continuation — moderate one-sided bars (55-65%) in RTH
 *      continue 63-67% next-bar (feature study); enter at close, stop
 *      under the bar, 1R.
 *   C2 extreme-bar fade — a bar ≥1.8×ATR closing at its extreme in RTH
 *      is churn; fade it back to the bar's midpoint.
 *   C3 RTH pullback — the validated pullback pattern (trend + shrinking
 *      counter + reclaim) restricted to 10:00-16:00.
 *
 * GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs scripts/rthStudy.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { closeOf, type MomMinute } from "../lib/momentum";

type Scored = { n: number; wins: number; exp: number };

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
  console.log(`RTH study over ${dates.length} sessions…`);
  const t0 = Date.now();

  const agg = new Map<string, Scored>();
  const acctTrades: { date: string; pnlPts: number; riskPts: number }[] = [];

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
    const vwapPos = (m: MomMinute): number => {
      const range = m.high - m.low;
      if (!(range > 0.25)) return 0.5;
      let num = 0;
      let den = 0;
      for (const l of m.levels) {
        const v = l.buy + l.sell;
        num += l.price * v;
        den += v;
      }
      return den > 0 ? (num / den - m.low) / range : 0.5;
    };

    let last = -100;
    for (let k = 20; k < n - 1; k++) {
      if (!inRTH(minutes[k].t)) continue;
      if (k - last < 5) continue;
      const m = minutes[k];
      const vol = m.buy + m.sell;
      const frac = vol > 0 ? m.buy / vol : 0.5;
      const mv = medVol(k);
      const range = m.high - m.low;
      const ar = atr(k);
      const end = Math.min(n - 1, k + 60);

      const score = (key: string, dir: 1 | -1, entry: number, stop: number, target: number) => {
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || risk > 15) return;
        let win = false;
        let stopped = false;
        for (let j = k + 1; j <= end; j++) {
          const b = minutes[j];
          if (dir === 1 ? b.low <= stop : b.high >= stop) { stopped = true; break; }
          if (dir === 1 ? b.high >= target : b.low <= target) { win = true; break; }
        }
        const a = agg.get(key) ?? { n: 0, wins: 0, exp: 0 };
        a.n++;
        if (win) { a.wins++; a.exp += Math.abs(target - entry) - 0.5; } else if (stopped) { a.exp += -risk - 0.5; }
        agg.set(key, a);
        last = k;
        if (key.startsWith("c1-0.6-")) {
          acctTrades.push({ date, pnlPts: win ? Math.abs(target - entry) - 0.5 : stopped ? -risk - 0.5 : 0, riskPts: risk });
        }
      };

      // C1 soft continuation (thresholds 0.55 / 0.60 / 0.65)
      for (const th of [0.55, 0.6, 0.65]) {
        if (vol < 0.5 * mv) continue;
        if (frac >= th) {
          const entry = closeOf(m);
          score(`c1-${th}-L`, 1, entry, m.low - 1, entry + (entry - (m.low - 1)));
        } else if (frac <= 1 - th) {
          const entry = closeOf(m);
          score(`c1-${th}-S`, -1, entry, m.high + 1, entry - ((m.high + 1) - entry));
        }
      }

      // C2 extreme-bar fade (churn at the extreme)
      if (vol >= 0.5 * mv && range >= 1.8 * ar) {
        const vp = vwapPos(m);
        if (vp <= 0.25) {
          const entry = closeOf(m);
          const mid = (m.high + m.low) / 2;
          score("c2-L", 1, entry, m.low - 1, mid + (mid - entry > 0 ? 0 : 0));
          void mid;
        } else if (vp >= 0.75) {
          const entry = closeOf(m);
          const mid = (m.high + m.low) / 2;
          score("c2-S", -1, entry, m.high + 1, mid);
        }
      }

      // C3 RTH pullback (trend + shrinking counter + reclaim)
      if (k >= 35) {
        let D = 0;
        for (let j = k - 15; j < k; j++) D += minutes[j].buy - minutes[j].sell;
        if (D !== 0) {
          const pb = minutes[k - 1];
          const pbD = pb.buy - pb.sell;
          const dir: 1 | -1 = D > 0 ? 1 : -1;
          const against = dir === 1 ? pbD < 0 : pbD > 0;
          if (against) {
            let lo5 = Infinity;
            let hi5 = -Infinity;
            for (let j = k - 6; j <= k - 2; j++) {
              lo5 = Math.min(lo5, minutes[j].low);
              hi5 = Math.max(hi5, minutes[j].high);
            }
            const held = dir === 1 ? pb.low >= lo5 - 0.25 : pb.high <= hi5 + 0.25;
            const prevD = minutes[k - 2].buy - minutes[k - 2].sell;
            if (held && Math.abs(pbD) < Math.abs(prevD)) {
              const trigger = dir === 1 ? closeOf(m) > pb.high : closeOf(m) < pb.low;
              const dOk = dir === 1 ? m.buy - m.sell > 0 : m.buy - m.sell < 0;
              if (trigger && dOk) {
                const entry = closeOf(m);
                const stop = dir === 1 ? pb.low - 0.5 : pb.high + 0.5;
                score(`c3-${dir === 1 ? "L" : "S"}`, dir, entry, stop, dir === 1 ? entry + (entry - stop) : entry - (stop - entry));
              }
            }
          }
        }
      }
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("candidate       | n    | wr     | exp pts/trade (net)");
  for (const [key, a] of [...agg.entries()].sort()) {
    const wr = a.n ? (100 * a.wins) / a.n : 0;
    console.log(`${key.padEnd(15)} | ${String(a.n).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${(a.exp / a.n).toFixed(2).padStart(8)}`);
  }
  // MFF grounding: the best config through the account simulator
  const d9 = dollarize(acctTrades);
  console.log("\nACCOUNT (Rapid EOD 50k · c1-0.6 combined, 9 micros):");
  console.log("  eval  ", accountLine(simulateAccount(d9, "eval")));
  console.log("  funded", accountLine(simulateAccount(d9, "funded")));
  console.log("  net $ (budget-sized):", d9.reduce((a, t) => a + t.pnl, 0).toFixed(0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
