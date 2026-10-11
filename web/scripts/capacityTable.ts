/* ------------------------------------------------------------------ *
 * Capacity table — the arithmetic cap per family (Medallion-ideas #7:
 * "the cap is arithmetic — each strategy has a max size where impact
 * eats the edge"). Sweeps a contracts multiplier over each family's
 * realized trade sequence through the MFF account model and prints the
 * capacity ceiling: the largest multiplier with no blow and a max
 * drawdown inside the loss limit.
 *
 * The challenge rules come from lib/risk/challengeRules.ts (the single
 * source shared with the live guard) and the EOD-trailing floor from
 * lib/risk/guardCore.ts eodFloorTrail — the SAME formula the live
 * accountGuard commits at the close. No rule numbers are re-stated here.
 *
 * Assumption (stated): scaling is linear — net_usd × (c / observed
 * contracts), commissions included in the observed net.
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/capacityTable.ts
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "../lib/gcdb";
import { familyOf } from "../lib/tradeStats";
import { EVAL_RULES, FUNDED_RULES, type ChallengeRules } from "../lib/risk/challengeRules";
import { eodFloorTrail } from "../lib/risk/guardCore";

type TradeRow = {
  day: string;
  ts: string | number;
  verdict: string;
  contracts: string | number;
  net_usd: string | number;
  features: unknown | null;
};

const MULTIPLIERS = [1, 2, 4, 6, 9, 12, 16, 20, 25, 30];

function familyOfRow(r: TradeRow): string {
  const f = r.features as { family?: unknown } | null;
  if (f && typeof f.family === "string" && f.family) return f.family;
  return familyOf(r.verdict);
}

/** per-day EOD trailing via the live guard's own formula (guardCore.ts). */
function trailFloor(rules: ChallengeRules, floor: number, locked: boolean, equity: number): { floor: number; locked: boolean } {
  if (rules.lockAt === null) return eodFloorTrail(rules.stage, locked, floor, equity, rules.maxLoss, 0);
  return eodFloorTrail(rules.stage, locked, floor, equity, rules.maxLoss, rules.lockAt);
}

/** funded blow check over a scaled, dated net_usd sequence. Breach is
 *  judged at the day close against the trailing floor, and the floor
 *  trails once per day — the live guard's commit granularity. */
function fundedOutcome(seq: { day: string; net: number }[]): { blow: boolean; maxDd: number; final: number; haltTarget: boolean } {
  const r = FUNDED_RULES;
  const days = groupByDay(seq);
  let equity = 0;
  let floor = -r.maxLoss;
  let locked = false;
  let peak = 0;
  let maxDd = 0;
  let haltTarget = false;
  for (const dayNet of days) {
    equity += dayNet;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (equity < floor) return { blow: true, maxDd, final: equity, haltTarget };
    if (equity >= r.profitTarget) haltTarget = true; // the live halt-target (same as accountGuard)
    const trail = trailFloor(r, floor, locked, equity);
    floor = trail.floor;
    locked = trail.locked;
  }
  return { blow: false, maxDd, final: equity, haltTarget };
}

function evalOutcome(seq: { day: string; net: number }[]): { blow: boolean; maxDd: number; final: number; consistencyFail: boolean } {
  const r = EVAL_RULES;
  const cap = r.consistencyCap ?? Infinity;
  const days = groupByDay(seq);
  let equity = 0;
  let floor = -r.maxLoss;
  let locked = false;
  let peak = 0;
  let maxDd = 0;
  let consistencyFail = false;
  for (const dayNet of days) {
    equity += dayNet;
    if (dayNet >= cap && dayNet > 0) consistencyFail = true;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (equity < floor) return { blow: true, maxDd, final: equity, consistencyFail };
    const trail = trailFloor(r, floor, locked, equity);
    floor = trail.floor;
    locked = trail.locked;
  }
  return { blow: false, maxDd, final: equity, consistencyFail };
}

/** collapse a dated sequence into per-day nets, in day order */
function groupByDay(seq: { day: string; net: number }[]): number[] {
  const byDay = new Map<string, number>();
  const order: string[] = [];
  for (const t of seq) {
    if (!byDay.has(t.day)) order.push(t.day);
    byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.net);
  }
  return order.map((d) => byDay.get(d)!);
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
  console.log("Rules: lib/risk/challengeRules.ts (the live guard's source) · assumption: linear scaling —");
  console.log("net_usd × (c / observed contracts), commissions inside the observed net.\n");

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
      const ok = !f.blow && !e.blow && f.maxDd < FUNDED_RULES.maxLoss;
      if (ok) ceiling = m;
      console.log(
        `| ${m} | ${f.blow ? "**BLOW**" : "ok"} | $${Math.round(f.maxDd)} | $${Math.round(f.final)} | ${e.blow ? "**BLOW**" : "ok"} | ${e.consistencyFail ? "FAIL" : "ok"} | ${ok ? "≤" : ""} |`,
      );
    }
    console.log(`\ncapacity ceiling for ${fam}: **${ceiling}×** observed size (largest c with no blow, maxDD < $${FUNDED_RULES.maxLoss})\n`);
  }
  console.log("Caveat: realized-size scaling models impact only linearly — the true cap is where market impact");
  console.log("eats the edge, which this table cannot see. Treat the ceiling as an UPPER bound, not a target.");
}

main().catch((e) => {
  console.error("capacityTable failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
