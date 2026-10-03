/* ------------------------------------------------------------------ *
 * Deep risk-management research.
 *
 * For each live strategy (momentum combined, RTH, open drive) re-score
 * every signal under a grid of stop multiples k × target multiples t:
 *   k ∈ {1, 1.25, 1.5, 2} × risk₀   t ∈ {0.75, 1, 1.25, 1.5, 2} × risk₀
 * (risk₀ = the strategy's structural stop distance). First-touch over
 * 60 bars, stop first, 0.5 pt cost. Report win rate, median holding
 * bars (exposure), expected pts — then at contract counts 2..9 the
 * dollar math: P(win ≥ $200), P(day ≥ $500 / ≥ $900), breach risk via
 * the MFF account simulator on daily sequences.
 *
 * GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *   scripts/riskMgmt.ts [--dump out.json]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, closeOf, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import { simulateAccount, accountLine } from "../lib/propAccount";

const KS = [1, 1.25, 1.5, 2];
const TS = [0.75, 1, 1.25, 1.5, 2];

type Sig = { entry: number; risk0: number; dir: "long" | "short"; t: string };
type ComboAgg = {
  n: number;
  wins: number;
  exp: number;
  bars: number[];
  days: Map<string, number[]>;
  bigWin: number; // trades with gross win >= 100 pts (>= $200 at 1 contract)
};

async function main() {
  const dates = await archiveDates();
  console.log(`risk-mgmt study over ${dates.length} sessions…`);
  const t0 = Date.now();

  const agg = new Map<string, ComboAgg>(); // key = strategy|k|t
  const comboOf = (st: string, k: number, t: number) => `${st}|${k}|${t}`;
  const get = (key: string): ComboAgg => agg.get(key) ?? { n: 0, wins: 0, exp: 0, bars: [], days: new Map(), bigWin: 0 };

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    const n = minutes.length;

    const momS = detectMomentum(minutes, MOM_PROD);
    const expS = detectExpansionScalp(minutes, EXP_PROD);
    const mk = new Set(momS.map((x) => `${x.entryIdx}|${x.dir}`));
    const combined = [...momS, ...expS.filter((x) => !mk.has(`${x.entryIdx}|${x.dir}`))];
    const rthS = detectSoftMomentum(minutes, SOFT_PROD);
    const drvS = detectOpenDrive(minutes, OPEN_PROD);

    const signals: { st: string; s: Sig; idx: number }[] = [];
    const conv = (s: MomentumSignal, st: string) =>
      signals.push({ st, idx: s.breakIdx, s: { entry: s.entry, risk0: s.risk, dir: s.dir, t: s.t } });
    for (const s of combined) conv(s, "mom");
    for (const s of rthS) conv(s, "rth");
    for (const s of drvS) conv(s, "drive");

    for (const { st, s, idx } of signals) {
      const k0 = idx;
      const end = Math.min(n - 1, k0 + 60);
      for (const k of KS) {
        const risk = s.risk0 * k;
        if (!(risk > 0) || risk > 60) continue;
        const stop = s.dir === "long" ? s.entry - risk : s.entry + risk;
        for (const t of TS) {
          const target = s.dir === "long" ? s.entry + t * risk : s.entry - t * risk;
          let win = false;
          let stopHit = false;
          let barsTo = 0;
          for (let j = k0 + 1; j <= end; j++) {
            const b = minutes[j];
            const stp = s.dir === "long" ? b.low <= stop : b.high >= stop;
            const tgt = s.dir === "long" ? b.high >= target : b.low <= target;
            if (stp) { stopHit = true; barsTo = j - k0; break; }
            if (tgt) { win = true; barsTo = j - k0; break; }
          }
          if (!win && !stopHit) continue; // unresolved — skip
          const key = comboOf(st, k, t);
          const a = get(key);
          a.n++;
          a.bars.push(barsTo);
          const gross = t * risk - 0.5;
          if (win) {
            a.wins++;
            a.exp += gross;
            if (gross >= 100) a.bigWin++;
          } else {
            a.exp += -risk - 0.5;
          }
          const day = a.days.get(date) ?? [];
          day.push(win ? gross : -risk - 0.5);
          a.days.set(date, day);
          agg.set(key, a);
        }
      }
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);

  const med = (a: number[]) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

  console.log("strategy | k(stop×) | t(target×) | n     | wr     | medBars | expPts | P(win≥\$200)@1ct");
  for (const st of ["mom", "rth", "drive"]) {
    for (const k of KS) {
      for (const t of TS) {
        const a = agg.get(comboOf(st, k, t));
        if (!a || a.n < 100) continue;
        const wr = (100 * a.wins) / a.n;
        console.log(
          `${st.padEnd(8)} | ${k.toFixed(2).padStart(6)} | ${t.toFixed(2).padStart(9)} | ${String(a.n).padStart(5)} | ${wr.toFixed(1).padStart(5)}% | ${String(med(a.bars)).padStart(7)} | ${(a.exp / a.n).toFixed(2).padStart(6)} | ${((100 * a.bigWin) / a.n).toFixed(1).padStart(6)}%`,
        );
      }
    }
    console.log("");
  }

  // daily-goal Monte Carlo for the interesting combos
  console.log("== daily goals (C = contracts) ==");
  const interest: { st: string; k: number; t: number; label: string }[] = [
    { st: "mom", k: 1, t: 1, label: "mom 1R" },
    { st: "mom", k: 1.25, t: 1, label: "mom 1.25R stop" },
    { st: "mom", k: 1.5, t: 1.25, label: "mom 1.5 stop / 1.25 tgt" },
    { st: "rth", k: 1, t: 0.75, label: "rth 0.75R" },
    { st: "rth", k: 1.25, t: 1, label: "rth 1.25 stop / 1R" },
    { st: "drive", k: 1, t: 1, label: "drive (fixed 15/35)" },
  ];
  for (const it of interest) {
    const a = agg.get(comboOf(it.st, it.k, it.t));
    if (!a || a.n < 100) continue;
    const days = [...a.days.values()];
    const wr = (100 * a.wins) / a.n;
    let line = `${it.label.padEnd(26)} | wr=${wr.toFixed(1).padStart(5)}% exp=${(a.exp / a.n).toFixed(2).padStart(6)}`;
    for (const C of [2, 4, 6, 9]) {
      // resample days, sum daily P&L, count days >= 500 / >= 900, breach via account sim
      let up500 = 0;
      let up900 = 0;
      let nDays = 0;
      const allTrades: { date: string; pnl: number }[] = [];
      for (let p = 0; p < 2000; p++) {
        const day = days[Math.floor(Math.random() * days.length)];
        let sum = 0;
        for (const x of day) sum += x * 2 * C;
        if (sum >= 500) up500++;
        if (sum >= 900) up900++;
        nDays++;
      }
      // account sim on the real chronological sequence at C
      const trades = [...a.days.entries()]
        .sort((x, y) => x[0].localeCompare(y[0]))
        .flatMap(([date, arr]) => arr.map((pnl) => ({ date, pnl: pnl * 2 * C })));
      const sim = simulateAccount(trades, "funded");
      line += ` | C${C}: P500=${((100 * up500) / nDays).toFixed(0).padStart(3)}% P900=${((100 * up900) / nDays).toFixed(0).padStart(3)}% ${sim.breachDay ? "BREACH" : "ok"}`;
    }
    console.log(line);
  }

  if (process.argv.includes("--dump")) {
    const out: Record<string, unknown> = {};
    for (const [key, a] of agg) {
      out[key] = { n: a.n, wins: a.wins, exp: a.exp, medBars: med(a.bars) };
    }
    require("node:fs").writeFileSync("/tmp/riskmgmt.json", JSON.stringify(out));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
