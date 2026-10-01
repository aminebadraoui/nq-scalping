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
 * GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *   scripts/pullbackEntry.ts [--open]  (--open = 9:30-10:30 window only)
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";

type Scored = { n: number; wins: number; exp1r: number; hitTp10: number; medBars: number[]; mae: number[] };

async function main() {
  const onlyOpen = process.argv.includes("--open");
  const dates = await archiveDates();
  console.log(`pullback-entry study over ${dates.length} sessions${onlyOpen ? " (9:30-10:30 only)" : ""}…`);
  const t0 = Date.now();

  const r1r: Scored = { n: 0, wins: 0, exp1r: 0, hitTp10: 0, medBars: [], mae: [] };
  const f10: Scored = { n: 0, wins: 0, exp1r: 0, hitTp10: 0, medBars: [], mae: [] };
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
