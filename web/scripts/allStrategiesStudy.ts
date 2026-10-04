/* ------------------------------------------------------------------ *
 * ALL-STRATEGIES STUDY — one uniform treatment across every bar-based
 * strategy family in the codebase, so the families are comparable:
 *   own signal stop (entry − 1×risk where the detector has no stored
 *   stop) · 1R target · 60-bar time exit · 0.5pt round trip ·
 *   sequential one-trade-at-a-time per family · 649 sessions.
 *
 * Families:
 *   momentum (failed-flush) · expansion (huge-bar) · mom+exp combined
 *   (the feed's live family pair) · RTH soft-continuation ·
 *   open drive / pullback / sniper (experimental) · sweep-reclaim v2 ·
 *   balance break.
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/allStrategiesStudy.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "../lib/openDrive";
import { detectSweepReclaimV2 } from "../lib/sweepReclaimV2";
import { detectBalanceBreak, BALANCE_BREAK_DEFAULTS } from "../lib/balanceBreak";

const CONCURRENCY = 8;
const COST = 0.5;
const TIME_EXIT = 60;
const TARGET_R = 1;

type Common = { dir: "long" | "short"; entry: number; stop: number | null; risk: number };
type Trade = { date: string; pnl: number; risk: number };

function scoreSig(minutes: MomMinute[], sig: Common, idx: number, date: string): Trade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const stop = sig.stop ?? sig.entry - dir * sig.risk;
  const target = sig.entry + dir * sig.risk * TARGET_R;
  if (!(sig.risk > 0) || (dir > 0 && !(stop < sig.entry && sig.entry < target)) || (dir < 0 && !(target < sig.entry && sig.entry < stop))) return null;
  const start = idx + 1;
  const end = Math.min(minutes.length - 1, idx + TIME_EXIT);
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
  return { date, pnl: (exit - sig.entry) * dir - COST, risk: sig.risk };
}

function sequential(signals: Array<{ sig: Common; idx: number }>, minutes: MomMinute[], date: string): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of signals) {
    if (s.idx <= openUntil) continue;
    const sc = scoreSig(minutes, s.sig, s.idx, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.idx + TIME_EXIT;
  }
  return out;
}

function stats(trades: Trade[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    n: trades.length,
    wr: trades.length ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net,
    expR: trades.length ? net / trades.reduce((a, t) => a + t.risk, 0) : 0,
  };
}

async function main() {
  const dates = await archiveDates();
  const families = [
    { key: "momentum (failed-flush)", trades: [] as Trade[], signals: 0 },
    { key: "expansion (huge-bar)", trades: [] as Trade[], signals: 0 },
    { key: "mom+exp (live pair)", trades: [] as Trade[], signals: 0 },
    { key: "mom+exp (optimizer order)", trades: [] as Trade[], signals: 0 },
    { key: "rth soft-continuation", trades: [] as Trade[], signals: 0 },
    { key: "open drive", trades: [] as Trade[], signals: 0 },
    { key: "open pullback", trades: [] as Trade[], signals: 0 },
    { key: "open sniper", trades: [] as Trade[], signals: 0 },
    { key: "sweep-reclaim v2", trades: [] as Trade[], signals: 0 },
    { key: "balance break", trades: [] as Trade[], signals: 0 },
  ];
  const F = (k: string) => families.find((f) => f.key === k)!;

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const mom = detectMomentum(minutes, MOM_PROD);
      const exp = detectExpansionScalp(minutes, EXP_PROD);
      const runs: Array<{ fam: string; sigs: Array<{ sig: Common; idx: number }> }> = [
        { fam: "momentum (failed-flush)", sigs: mom.map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        { fam: "expansion (huge-bar)", sigs: exp.map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        {
          fam: "mom+exp (live pair)",
          sigs: [...mom, ...exp]
            .map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx }))
            .sort((a, b) => a.idx - b.idx),
        },
        {
          fam: "mom+exp (optimizer order)",
          sigs: [...mom, ...exp].map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })),
        },
        { fam: "rth soft-continuation", sigs: detectSoftMomentum(minutes, SOFT_PROD).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        { fam: "open drive", sigs: detectOpenDrive(minutes, OPEN_PROD).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        { fam: "open pullback", sigs: detectOpenDrive(minutes, PULLBACK_PROD).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        { fam: "open sniper", sigs: detectOpenDrive(minutes, SNIPER_PROD).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: null, risk: s.risk }, idx: s.entryIdx })) },
        {
          fam: "sweep-reclaim v2",
          sigs: detectSweepReclaimV2(minutes).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: s.stop, risk: s.risk }, idx: s.confirmIdx })),
        },
        {
          fam: "balance break",
          sigs: detectBalanceBreak(minutes, BALANCE_BREAK_DEFAULTS).map((s) => ({ sig: { dir: s.dir, entry: s.entry, stop: s.stop, risk: s.risk }, idx: s.failIdx })),
        },
      ];
      for (const run of runs) {
        const f = F(run.fam);
        f.signals += run.sigs.length;
        f.trades.push(...sequential(run.sigs, minutes, date));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${dates.length} sessions\n`);

  console.log("=== ALL STRATEGIES · uniform 1R/60-bar/0.5pt · 649 sessions ===");
  console.log("family".padEnd(24) + " | signals | n | WR | PF | net pts | expR/risk | 2024 WR | 2025 WR | 2026 WR");
  for (const f of families) {
    const st = stats(f.trades);
    const yr = (y: string) => {
      const s = stats(f.trades.filter((t) => t.date.startsWith(y)));
      return s.n ? `${s.wr.toFixed(1)}%` : "—";
    };
    console.log(
      f.key.padEnd(24) +
        ` | ${String(f.signals).padStart(7)} | ${String(st.n).padStart(4)} | ${st.wr.toFixed(1).padStart(5)}% | ${st.pf.toFixed(2).padStart(5)} | ${st.net.toFixed(0).padStart(8)} | ${st.expR.toFixed(2).padStart(9)} | ${yr("2024").padStart(7)} | ${yr("2025").padStart(7)} | ${yr("2026").padStart(7)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
