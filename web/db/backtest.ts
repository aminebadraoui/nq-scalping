/* Offline threshold sweep runner: replays the signal over the collected
 * sessions and writes the aggregate results for the /backtest page.
 *
 *   BT_SESSION=RTH|ETH   session window (default RTH)
 *   BT_MAX=<n>           cap the number of sessions (smoke test)
 *
 * Run:  node --import ../scripts/ts-loader.mjs ./db/backtest.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runSweep, sweepConfigs, walkForwardBest } from "../lib/backtest";

async function main() {
  const configs = sweepConfigs();
  const session = (process.env.BT_SESSION as "RTH" | "ETH") || "RTH";
  const maxSessions = process.env.BT_MAX ? Number(process.env.BT_MAX) : undefined;
  const splitDate = "2026-01-01";

  console.log(`sweeping ${configs.length} configs over ${session}${maxSessions ? ` (capped at ${maxSessions})` : ""}…`);
  const t0 = Date.now();
  const results = await runSweep(configs, { session, maxSessions, splitDate });
  const ms = Date.now() - t0;

  const wf = walkForwardBest(results);
  const outDir = path.join(process.cwd(), "..", "gcdata", "data", "backtest");
  mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    session,
    sessions: results[0]?.sessions ?? 0,
    trainSessions: results[0]?.trainSessions ?? 0,
    testSessions: results[0]?.testSessions ?? 0,
    splitDate,
    costPts: 0.5,
    holdBars: 60,
    walkForward: wf ? { trainBest: wf.trainBest.config.name, trainNetPts: wf.trainBest.train.netPts, testNetPts: wf.testOfBest.netPts, testTrades: wf.testOfBest.trades, testWinRate: wf.testOfBest.winRate, testProfitFactor: wf.testOfBest.profitFactor } : null,
    results,
  };
  const final = path.join(outDir, "results.json");
  const tmp = path.join(outDir, "results.json.tmp");
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  // atomic swap so a concurrent reader never sees a half-written file
  const { renameSync } = await import("node:fs");
  renameSync(tmp, final);

  console.log(`\ndone in ${(ms / 1000).toFixed(1)}s — ${payload.sessions} sessions (train ${payload.trainSessions} / test ${payload.testSessions}), ${results.length} configs`);
  console.log("config | trainTrades | trainWin% | trainNet | testTrades | testWin% | testNet");
  const sorted = [...results].sort((a, b) => b.train.netPts - a.train.netPts);
  for (const r of sorted) {
    console.log(
      `${r.config.name.padEnd(28)} | ${String(r.train.trades).padStart(10)} | ${String(Math.round(r.train.winRate * 100)).padStart(7)}% | ${String(r.train.netPts.toFixed(1)).padStart(8)} | ${String(r.test.trades).padStart(10)} | ${String(Math.round(r.test.winRate * 100)).padStart(7)}% | ${String(r.test.netPts.toFixed(1)).padStart(8)}`,
    );
  }
  if (wf) {
    const pf = Number.isFinite(wf.testOfBest.profitFactor) ? wf.testOfBest.profitFactor.toFixed(2) : "inf";
    console.log(
      `\nWALK-FORWARD: best on train = "${wf.trainBest.config.name}" (${wf.trainBest.train.netPts.toFixed(1)} pts) → out-of-sample test = ${wf.testOfBest.netPts.toFixed(1)} pts, ${wf.testOfBest.trades} trades, ${Math.round(wf.testOfBest.winRate * 100)}% win, PF ${pf}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
