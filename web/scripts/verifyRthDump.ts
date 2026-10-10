/* ------------------------------------------------------------------ *
 * Independent verifier for agent-produced RTH trade dumps.
 * Re-computes stats + the MFF account sim from the raw trade list so
 * agent claims are never taken on faith.
 *
 *   node --import scripts/ts-loader.mjs scripts/verifyRthDump.ts \
 *     /tmp/rth_gate_trades.json [--min 300]
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
// consolidated engine: standard T1/T2/T4 + verdict
import { coreStats, propViability, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

type T = { date: string; pnlPts: number; riskPts: number };

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: verifyRthDump.ts <dump.json> [--min N]");
    process.exit(1);
  }
  const min = process.argv.includes("--min") ? Number(process.argv[process.argv.indexOf("--min") + 1]) : 300;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const trades: T[] = Array.isArray(raw) ? raw : raw.trades ?? [];
  const n = trades.length;
  if (!n) {
    console.error("no trades in dump");
    process.exit(1);
  }
  // legacy headline fed from the engine's canonical T1 stats — identical
  // formulas (wins = pnl > 0, pf = grossWin/grossLoss, net = Σpnl,
  // exp = net/n).
  const engineTrades: EngineTrade[] = trades.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const cs = coreStats(engineTrades);
  const wr = cs.wr;
  const pf = cs.pf;
  const net = cs.netPts;
  console.log(`n=${n} wr=${wr.toFixed(1)}% pf=${Number.isFinite(pf) ? pf.toFixed(2) : "inf"} net=${net.toFixed(0)} pts exp=${cs.expPts.toFixed(2)} pts/trade`);
  console.log(`target met: ${wr >= 75 && n >= min ? "YES (≥75% and n≥" + min + ")" : "no"}`);

  const byYear = new Map<string, T[]>();
  const byHour = new Map<number, T[]>();
  for (const t of trades) {
    const y = t.date.slice(0, 4);
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(t);
    const h = Number((t as unknown as { hourET?: number }).hourET);
    if (Number.isFinite(h)) (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(t);
  }
  console.log("by year:");
  for (const [y, tr] of [...byYear.entries()].sort()) {
    const ycs = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
    console.log(`  ${y}: n=${ycs.n} wr=${ycs.wr.toFixed(1)}%`);
  }
  if (byHour.size) {
    console.log("by hour:");
    for (const [h, tr] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
      const hcs = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
      console.log(`  ${h}:00: n=${hcs.n} wr=${hcs.wr.toFixed(1)}%`);
    }
  }
  console.log("sessions with ≥1 trade:", new Set(trades.map((t) => t.date)).size);

  const d = dollarize(trades);
  console.log("\nACCOUNT (Rapid EOD 50k):");
  console.log("  eval  ", accountLine(simulateAccount(d, "eval")));
  console.log("  funded", accountLine(simulateAccount(d, "funded")));

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Dump verifier — no train/test split, so T1 prints the "all" row only;
   * T2 renders the by-year segments; T4 + verdict follow. ---- */
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "dump (all)", stats: cs }]));
  console.log("\n" + renderT2(
    [...byYear.entries()].sort().map(([y, tr]) => {
      const ycs = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts })));
      return {
        rule: `year ${y}`,
        n: ycs.n,
        wr: ycs.wr,
        ci: ycs.wrCi,
        pf: ycs.pf,
        expPts: ycs.expPts,
      };
    }),
  ));
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: cs.netPts > 0 && cs.expR > 0 ? "real" : "absent",
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
