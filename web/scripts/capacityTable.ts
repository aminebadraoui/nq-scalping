/* ------------------------------------------------------------------ *
 * Capacity table — the arithmetic cap per family (Medallion-ideas #7:
 * "the cap is arithmetic — each strategy has a max size where impact
 * eats the edge"). Sweeps a contracts multiplier over each family's
 * realized trade sequence through the MFF account model and prints the
 * capacity ceiling: the largest multiplier with no funded blow and a
 * max drawdown inside the loss limit.
 *
 * Self-contained MFF sim (eval + funded, Rapid EOD 50k): the guard
 * replay (lib/risk/guardCore.ts) models the day-plan HALTS, but the
 * per-contract capacity sweep only needs the firm's own limits, so the
 * firm rules are re-stated here deliberately (see lib/propRules.ts):
 *   · balance starts at $0 (normalized)
 *   · EOD-trailing max loss $2,000 (trails UP at day closes only)
 *   · funded floor locks at $100 once reached
 *   · eval: +$3,000 target, 30% consistency ($900/day cap)
 *   · funded: +$2,100 first-payout buffer (modeled as target $2,100)
 * Assumption (stated): scaling is linear — net_usd × (c / observed
 * contracts), commissions included in the observed net.
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/capacityTable.ts
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "../lib/gcdb";
import { familyOf } from "../lib/tradeStats";

type TradeRow = {
  day: string;
  ts: string | number;
  verdict: string;
  contracts: string | number;
  net_usd: string | number;
  features: unknown | null;
};

const MAX_LOSS = 2000;
const LOCK_AT = 100;
const CONSISTENCY_CAP = 900;
const MULTIPLIERS = [1, 2, 4, 6, 9, 12, 16, 20, 25, 30];

function familyOfRow(r: TradeRow): string {
  const f = r.features as { family?: unknown } | null;
  if (f && typeof f.family === "string" && f.family) return f.family;
  return familyOf(r.verdict);
}

/** funded blow check over a scaled, dated net_usd sequence (day close trailing). */
function fundedOutcome(seq: { day: string; net: number }[]): { blow: boolean; maxDd: number; final: number; floor: number } {
  let equity = 0;
  let floor = -MAX_LOSS;
  let locked = false;
  let peak = 0;
  let maxDd = 0;
  for (const t of seq) {
    equity += t.net;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (equity > peak) peak = equity;
    // EOD trailing at each day boundary (simplification: trail per trade at the
    // day close — same as guardReplay's per-day commit)
    if (locked) continue;
    const candidate = equity - MAX_LOSS;
    if (candidate >= LOCK_AT) {
      floor = LOCK_AT;
      locked = true;
    } else if (candidate > floor) {
      floor = candidate;
    }
    if (equity < floor) return { blow: true, maxDd, final: equity, floor };
  }
  return { blow: false, maxDd, final: equity, floor };
}

function evalOutcome(seq: { day: string; net: number }[]): { blow: boolean; maxDd: number; final: number; consistencyFail: boolean } {
  let equity = 0;
  let floor = -MAX_LOSS;
  let peak = 0;
  let maxDd = 0;
  let dayPnl = 0;
  let curDay = "";
  let consistencyFail = false;
  for (const t of seq) {
    if (t.day !== curDay) {
      if (dayPnl >= CONSISTENCY_CAP && dayPnl > 0) consistencyFail = true;
      curDay = t.day;
      dayPnl = 0;
      const candidate = equity - MAX_LOSS;
      if (candidate > floor) floor = candidate;
    }
    equity += t.net;
    dayPnl += t.net;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (equity > peak) peak = equity;
    if (equity < floor) return { blow: true, maxDd, final: equity, consistencyFail };
  }
  if (dayPnl >= CONSISTENCY_CAP && dayPnl > 0) consistencyFail = true;
  return { blow: false, maxDd, final: equity, consistencyFail };
}

export async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.log("db disabled — the capacity table reads realized trades from Neon; run it where DATABASE_URL is set.");
    return;
  }
  const rows = (await getDb()`
    select day, ts, verdict, contracts, net_usd, features from trades
    where result = 'win' or result = 'loss'
    order by ts asc`) as TradeRow[];

  const byFamily = new Map<string, TradeRow[]>();
  for (const r of rows) {
    const fam = familyOfRow(r);
    const e = byFamily.get(fam) ?? [];
    e.push(r);
    byFamily.set(fam, e);
  }

  console.log("# Capacity table — contracts multiplier sweep through the MFF account model\n");
  console.log("Assumption: linear scaling — net_usd × (c / observed contracts), commissions inside the observed net.\n");

  for (const [fam, trades] of [...byFamily.entries()].sort((a, b) => b.length - a.length)) {
    const seq = trades.map((t) => ({ day: String(t.day), net: Number(t.net_usd), contracts: Number(t.contracts) || 1 }));
    console.log(`## ${fam} (n=${seq.length} realized trades)\n`);
    console.log("| multiplier c | funded blow | funded maxDD | funded final | eval blow | eval consistency | ceiling |");
    console.log("|---|---|---|---|---|---|---|");
    let ceiling = 0;
    for (const m of MULTIPLIERS) {
      const scaled = seq.map((t) => ({ day: t.day, net: t.net * m }));
      const f = fundedOutcome(scaled);
      const e = evalOutcome(scaled);
      const ok = !f.blow && !e.blow && f.maxDd < MAX_LOSS;
      if (ok) ceiling = m;
      console.log(
        `| ${m} | ${f.blow ? "**BLOW**" : "ok"} | $${Math.round(f.maxDd)} | $${Math.round(f.final)} | ${e.blow ? "**BLOW**" : "ok"} | ${e.consistencyFail ? "FAIL" : "ok"} | ${ok ? "≤" : ""} |`,
      );
    }
    console.log(`\ncapacity ceiling for ${fam}: **${ceiling}×** observed size (largest c with no blow, maxDD < $${MAX_LOSS})\n`);
  }
  console.log("Caveat: realized-size scaling models impact only linearly — the true cap is where market impact");
  console.log("eats the edge, which this table cannot see. Treat the ceiling as an UPPER bound, not a target.");
}

main().catch((e) => {
  console.error("capacityTable failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
