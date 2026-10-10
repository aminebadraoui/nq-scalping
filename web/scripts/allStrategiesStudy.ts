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
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "../lib/openDrive";
import { detectSweepReclaimV2 } from "../lib/sweepReclaimV2";
import { detectBalanceBreak, BALANCE_BREAK_DEFAULTS } from "../lib/balanceBreak";
import {
  coreStats,
  scoreTrade,
  scoreSequential,
  wilson95,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  type CoreStats,
  type ScoreSpec,
} from "../lib/backtestEngine";

const CONCURRENCY = 8;
const TIME_EXIT = 60;
const TARGET_R = 1;

type Common = { dir: "long" | "short"; entry: number; stop: number | null; risk: number };
type Trade = { date: string; pnl: number; risk: number; heldBars?: number };

const specOf = (sig: Common, idx: number): ScoreSpec => {
  const dir = sig.dir === "long" ? 1 : -1;
  const stop = sig.stop ?? sig.entry - dir * sig.risk;
  return { dir, entry: sig.entry, stop, target: sig.entry + dir * sig.risk * TARGET_R, entryIdx: idx, risk: sig.risk };
};

function scoreSig(minutes: MomMinute[], sig: Common, idx: number, date: string): Trade | null {
  const sc = scoreTrade(minutes, specOf(sig, idx));
  return sc ? { date, pnl: sc.pnl, risk: sig.risk, heldBars: sc.heldBars } : null;
}

function sequential(signals: Array<{ sig: Common; idx: number }>, minutes: MomMinute[], date: string): Trade[] {
  // one-trade-at-a-time over the FULL 60-bar window (the local convention)
  return scoreSequential(signals.map((s) => ({ entryIdx: s.idx, sig: s.sig })), (w) => scoreSig(minutes, w.sig, w.entryIdx, date), {
    occupy: "full",
    window: TIME_EXIT,
  });
}

/** legacy expR = net ÷ Σrisk (a different formula from the engine's mean
 *  pnl/risk expR — kept because the legacy table prints this one) */
const legacyExpR = (trades: Trade[]): number => {
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const risk = trades.reduce((a, t) => a + t.risk, 0);
  return risk > 0 ? net / risk : 0;
};

const stats = (trades: Trade[]): CoreStats => coreStats(trades);

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
        ` | ${String(f.signals).padStart(7)} | ${String(st.n).padStart(4)} | ${st.wr.toFixed(1).padStart(5)}% | ${st.pf.toFixed(2).padStart(5)} | ${st.netPts.toFixed(0).padStart(8)} | ${legacyExpR(f.trades).toFixed(2).padStart(9)} | ${yr("2024").padStart(7)} | ${yr("2025").padStart(7)} | ${yr("2026").padStart(7)}`,
    );
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * primary cohort = the live pair (mom+exp); T1 core quality, T2 family
   * ranking, T4 prop viability, five-slot verdict. ---- */
  const primary = F("mom+exp (live pair)").trades;
  const engineTrades = primary.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "all", stats: coreStats(engineTrades) }]));
  const baseline = coreStats(engineTrades);
  console.log(
    "\n" +
      renderT2(
        families.map((f) => {
          const st = coreStats(f.trades);
          return {
            rule: f.key,
            n: st.n,
            wr: st.wr,
            ci: wilson95(st.wins, st.n),
            pf: st.pf,
            expPts: st.expPts,
            compare: f.key === "mom+exp (live pair)" ? undefined : `live-pair WR ${baseline.wr.toFixed(0)}%`,
          };
        }),
      ),
  );
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: baseline.netPts > 0 && baseline.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: "—",
        holdout: "n/a (validation pipeline)",
        viability:
          viability.pPass === null
            ? "n/a"
            : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
