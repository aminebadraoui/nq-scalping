/* ------------------------------------------------------------------ *
 * DAILY P&L — the implemented profiles (momentum 0.35×/2.25R/60-bar,
 * RTH 0.45×/1.75R/45-bar, both ×1) at the measured 0.95pt round trip.
 * One row per session: trades, net pts, net $ (via the same
 * momentumSize math the feed uses — $170 budget, 30-micro cap), and a
 * running eval equity from $50,000. Also prints the summary.
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/dailyPnl.ts
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import path from "node:path";
import { momentumSize } from "../lib/propRules";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";

const CONCURRENCY = 8;
const COST = 0.95; // measured live round trip (TRADE_REVIEW_2026-10-02)
const BUDGET = 170;

type Family = { key: string; stopMult: number; targetR: number; timeExit: number; detect: (m: MomMinute[]) => MomentumSignal[] };

const FAMILIES: Family[] = [
  {
    key: "momentum",
    stopMult: 0.35,
    targetR: 2.25,
    timeExit: 60,
    detect: (m) => [...detectMomentum(m, MOM_PROD), ...detectExpansionScalp(m, EXP_PROD)].sort((a, b) => a.entryIdx - b.entryIdx),
  },
  { key: "rth", stopMult: 0.45, targetR: 1.75, timeExit: 45, detect: (m) => detectSoftMomentum(m, SOFT_PROD) },
];

type Day = { date: string; trades: number; netPts: number; netUsd: number };

function score(minutes: MomMinute[], sig: MomentumSignal, f: Family): { pnl: number; risk: number } | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * f.stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * f.targetR;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + f.timeExit);
  if (start > end) return null;
  let exit = closeOf(minutes[end]);
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return { pnl: (exit - entry) * dir - COST, risk };
}

async function main() {
  const dates = await archiveDates();
  const days = new Map<string, Day>();
  for (const d of dates) days.set(d, { date: d, trades: 0, netPts: 0, netUsd: 0 });

  const perFam = new Map<string, Day[]>();
  for (const f of FAMILIES) {
    perFam.set(f.key, dates.map((d) => ({ date: d, trades: 0, netPts: 0, netUsd: 0 })));
  }

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      for (const f of FAMILIES) {
        const signals = f.detect(minutes);
        let openUntil = -1;
        for (const sig of signals) {
          if (sig.entryIdx <= openUntil) continue;
          const sc = score(minutes, sig, f);
          if (!sc) continue;
          openUntil = sig.entryIdx + f.timeExit;
          const contracts = momentumSize(sc.risk, BUDGET).contracts;
          const usd = Math.round(sc.pnl * 2 * contracts * 100) / 100;
          const day = perFam.get(f.key)!.find((d) => d.date === date)!;
          day.trades += 1;
          day.netPts = Math.round((day.netPts + sc.pnl) * 100) / 100;
          day.netUsd = Math.round((day.netUsd + usd) * 100) / 100;
        }
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  /* write one CSV per family: date,trades,net_pts,net_usd,equity */
  for (const f of FAMILIES) {
    const rows = perFam.get(f.key)!;
    let eq = 50_000;
    const lines = ["date,trades,net_pts,net_usd,equity"];
    for (const d of rows) {
      eq = Math.round((eq + d.netUsd) * 100) / 100;
      lines.push(`${d.date},${d.trades},${d.netPts.toFixed(2)},${d.netUsd.toFixed(2)},${eq.toFixed(2)}`);
    }
    const out = path.join(process.cwd(), "..", "docs", "data", `daily-pnl-${f.key}-profile-0.95pt.csv`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, lines.join("\n"));
    console.log(`wrote ${out} (${rows.length} sessions)`);
  }

  /* summary per family */
  console.log(`\n=== DAILY P&L SUMMARY (0.95pt, ×1, ${dates.length} sessions) ===`);
  for (const f of FAMILIES) {
    const rows = perFam.get(f.key)!;
    const traded = rows.filter((d) => d.trades > 0);
    const net = rows.reduce((a, d) => a + d.netUsd, 0);
    const wins = traded.filter((d) => d.netUsd > 0).length;
    const best = [...traded].sort((a, b) => b.netUsd - a.netUsd)[0];
    const worst = [...traded].sort((a, b) => a.netUsd - b.netUsd)[0];
    const sorted = [...traded].map((d) => d.netUsd).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `${f.key.padEnd(9)} | days traded ${traded.length}/${rows.length} | win days ${wins}/${traded.length} (${((wins / traded.length) * 100).toFixed(0)}%) | ` +
        `total $${net.toFixed(0)} | median $${median.toFixed(0)} | best ${best.date} $${best.netUsd.toFixed(0)} | worst ${worst.date} $${worst.netUsd.toFixed(0)}`,
    );
    /* monthly totals */
    const byMonth = new Map<string, number>();
    for (const d of rows) {
      const m = d.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + d.netUsd);
    }
    const months = [...byMonth.entries()].map(([m, v]) => `${m} $${v.toFixed(0)}`).join(" · ");
    console.log(`${"".padEnd(9)} | monthly: ${months}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
