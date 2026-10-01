/* ------------------------------------------------------------------ *
 * Independent verifier for agent-produced RTH trade dumps.
 * Re-computes stats + the MFF account sim from the raw trade list so
 * agent claims are never taken on faith.
 *
 *   node --import ../scripts/ts-loader.mjs scripts/verifyRthDump.ts \
 *     /tmp/rth_gate_trades.json [--min 300]
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";

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
  const wins = trades.filter((t) => t.pnlPts > 0);
  const losses = trades.filter((t) => t.pnlPts <= 0);
  const gw = wins.reduce((a, t) => a + t.pnlPts, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlPts, 0));
  const wr = (100 * wins.length) / n;
  const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : 0;
  const net = trades.reduce((a, t) => a + t.pnlPts, 0);
  console.log(`n=${n} wr=${wr.toFixed(1)}% pf=${Number.isFinite(pf) ? pf.toFixed(2) : "inf"} net=${net.toFixed(0)} pts exp=${(net / n).toFixed(2)} pts/trade`);
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
    const w = tr.filter((t) => t.pnlPts > 0).length;
    console.log(`  ${y}: n=${tr.length} wr=${((100 * w) / tr.length).toFixed(1)}%`);
  }
  if (byHour.size) {
    console.log("by hour:");
    for (const [h, tr] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
      const w = tr.filter((t) => t.pnlPts > 0).length;
      console.log(`  ${h}:00: n=${tr.length} wr=${((100 * w) / tr.length).toFixed(1)}%`);
    }
  }
  console.log("sessions with ≥1 trade:", new Set(trades.map((t) => t.date)).size);

  const d = dollarize(trades);
  console.log("\nACCOUNT (Rapid EOD 50k):");
  console.log("  eval  ", accountLine(simulateAccount(d, "eval")));
  console.log("  funded", accountLine(simulateAccount(d, "funded")));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
