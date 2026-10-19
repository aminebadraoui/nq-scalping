/* ------------------------------------------------------------------ *
 * Decay watch — the rolling control chart over the recorded signal
 * stream (Medallion-ideas #7: "if you don't keep getting better, you're
 * going to do worse"). Compares each family's trailing-100-trade window
 * against its archive baseline and flags WATCH when the latest window's
 * WR sits more than 2× the Wilson standard error below the baseline.
 *
 * Baselines are the playbook numbers (PLAYBOOK.md, Oct 2026) — hardcoded
 * here WITH the doc reference; expR baselines come from
 * lib/edgeMonitor.ts REPLAY_EXPR_BASELINES (the same source the journal
 * edge badges use).
 *
 * Journal-only alert text — this script never changes a live feed.
 *
 * Usage: cd web && node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/decayWatch.ts
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "../lib/gcdb";
import { familyOf } from "../lib/tradeStats";
import { REPLAY_EXPR_BASELINES } from "../lib/edgeMonitor";
import { canonicalFamily } from "../lib/strategies/aliases";

type SigRow = { ts: string | number; day: string; verdict: string; outcome: string; gross_pts: string | number | null; risk_pts: string | number | null; features: unknown | null };

/** playbook baselines — WR per family (PLAYBOOK.md Oct 2026). RTH quotes
 *  the LIVE bracket numbers (37.7% / PF 1.49, resting-limit 2.5R), which
 *  is what the live cards actually trade. */
const WR_BASELINES: Record<string, number> = {
  failed_flush_breakout: 77.5,
  huge_bar_expansion: 78.4,
  session_continuation: 37.7,
  open_drive: 93.0, // hit rate at TP15/SL35, not WR
  open_pullback: 69.8,
  open_sniper: 55.8,
  sweep_reclaim: 67.0,
  other: 50.0,
};

function familyOfRow(r: SigRow): string {
  const f = r.features as { family?: unknown } | null;
  // canonicalize: rows written before the 2026-10-19 rename keep legacy slugs
  if (f && typeof f.family === "string" && f.family) return canonicalFamily(f.family);
  return canonicalFamily(familyOf(r.verdict));
}

const WINDOW = 100;
const STEP = 20;

export async function main(): Promise<void> {
  if (!dbEnabled()) {
    console.log("db disabled — the decay watch reads the recorded signal stream from Neon; run it where DATABASE_URL is set.");
    return;
  }
  const rows = (await getDb()`
    select ts, day, verdict, outcome, gross_pts, risk_pts, features from signals
    where outcome in ('win','loss') order by ts asc`) as SigRow[];

  const byFamily = new Map<string, { win: number; expR: number }[]>();
  for (const r of rows) {
    const fam = familyOfRow(r);
    const e = byFamily.get(fam) ?? [];
    const gp = Number(r.gross_pts);
    const rp = Number(r.risk_pts);
    const expR = Number.isFinite(gp) && Number.isFinite(rp) && rp > 0 ? gp / rp : Number.NaN;
    e.push({ win: r.outcome === "win" ? 1 : 0, expR });
    byFamily.set(fam, e);
  }

  console.log("# Decay watch — trailing-100-trade windows per family vs the archive baseline\n");

  const alerts: string[] = [];

  for (const [fam, seq] of [...byFamily.entries()].sort((a, b) => b.length - a.length)) {
    const n = seq.length;
    if (n < WINDOW / 2) continue;
    const baseline = WR_BASELINES[fam] ?? 50;
    console.log(`## ${fam} (baseline WR ${baseline}% · expR baseline ${REPLAY_EXPR_BASELINES[fam] ?? "—"})\n`);
    console.log("| window (last trade idx) | n | WR | expR | vs baseline |");
    console.log("|---|---|---|---|---|");
    let latest: { wr: number; se: number } | null = null;
    for (let end = n; end >= WINDOW; end -= STEP) {
      const win = seq.slice(end - WINDOW, end);
      const w = win.filter((s) => s.win === 1).length;
      const wr = (w / win.length) * 100;
      const expRs = win.map((s) => s.expR).filter((x) => Number.isFinite(x));
      const expR = expRs.length ? expRs.reduce((a, b) => a + b, 0) / expRs.length : Number.NaN;
      const se = Math.sqrt((wr / 100) * (1 - wr / 100) / win.length) * 100;
      if (!latest) latest = { wr, se };
      const flag = wr < baseline - 2 * se ? " ⚠ WATCH" : "";
      console.log(
        `| ${end} | ${win.length} | ${wr.toFixed(1)}% | ${Number.isFinite(expR) ? expR.toFixed(2) : "—"} | ` +
          `${(wr - baseline).toFixed(1)} pts${flag} |`,
      );
    }
    if (latest && latest.wr < baseline - 2 * latest.se) {
      alerts.push(`${fam}: latest ${WINDOW}-trade WR ${latest.wr.toFixed(1)}% is ${((baseline - latest.wr) / latest.se).toFixed(1)}σ below the ${baseline}% baseline`);
    }
    console.log("");
  }

  if (alerts.length > 0) {
    console.log("## Suggested journal-only Telegram heads-up (never a live gate by itself)\n");
    for (const a of alerts) console.log(`- ${a}`);
  } else {
    console.log("No family is currently >2σ below its baseline in the latest window.");
  }
  console.log("\nThresholds are pre-registered per the playbook; a heads-up is research input, not a feed change.");
}

main().catch((e) => {
  console.error("decayWatch failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
