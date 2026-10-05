/* ------------------------------------------------------------------ *
 * Friction report — the two numbers that gate the momentum re-enable
 * (fix-plan Phase 2, docs/research/fix-plan-2026-10-05.md):
 *
 *   1. median adverse ENTRY drift on losing fills  (fill vs signal,
 *      tradeAnalysis `entry_adverse_pts`; positive = filled worse)
 *   2. realized all-in round-trip COST in points   (commissions /
 *      contracts / $2 per point)
 *
 * Reads the enriched `trades` table and writes one row per day into
 * `friction_daily`. Wired into scripts/nightly.sh after tradeAnalysis.
 *
 * Decision readout (the Phase-3 gates):
 *   loser drift ≤ 0.5 pt  → momentum restore eligible (re-run
 *                           gapOnlyValidation with these numbers)
 *   loser drift ≥ 1.0 pt  → momentum stays off
 * ------------------------------------------------------------------ */

import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("frictionReport: DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(DB_URL, { ssl: "require", max: 1 });

const TABLE_SQL = `
create table if not exists friction_daily (
  day date primary key,
  bot_trades int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  loser_drift_med numeric(8,2),
  loser_drift_mean numeric(8,2),
  winner_drift_med numeric(8,2),
  cost_pts_med numeric(8,2),
  updated_at timestamptz not null default now()
);
`;

const med = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

async function main() {
  await sql.unsafe(TABLE_SQL);
  const daysArg = process.argv[2] ? Number(process.argv[2]) : 14;
  const rows = (await sql`
    select day, gross_pts::float8 gross, commissions::float8 comm,
           contracts::int qty, entry_adverse_pts::float8 drift
    from trades where status = 'matched' and family <> ''
    order by ts asc`) as Array<{ day: string; gross: number; comm: number; qty: number; drift: number | null }>;

  if (!rows.length) {
    console.log("frictionReport: no matched bot trades yet — nothing to measure");
    return;
  }

  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = String(r.day).slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r);
  }

  console.log("day         n   W/L   loserDriftMed  loserDriftMean  winDriftMed  costPtsMed  readout");
  console.log("------------------------------------------------------------------------------------------");
  let allLoserDrift: number[] = [];
  let allCosts: number[] = [];
  for (const [day, tt] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-daysArg)) {
    const wins = tt.filter((t) => t.gross > 0);
    const losses = tt.filter((t) => t.gross < 0);
    // entry_adverse_pts is negative-when-worse; the drift gate runs on the
    // ADVERSE fills only (drift < 0 → |drift|) — the fills that actually
    // slipped against us on losing trades
    const ld = losses.map((t) => t.drift).filter((x): x is number => x !== null && x < 0).map((x) => Math.abs(x));
    const wd = wins.map((t) => (t.drift === null ? null : Math.abs(t.drift))).filter((x): x is number => x !== null);
    const costs = tt.map((t) => (t.qty > 0 ? t.comm / (t.qty * 2) : null)).filter((x): x is number => x !== null);
    allLoserDrift.push(...ld);
    allCosts.push(...costs);
    const ldm = med(ld) ?? null;
    const cpm = med(costs) ?? null;
    const readout = ldm !== null && cpm !== null ? (ldm <= 0.5 ? "RESTORE-ELIGIBLE" : ldm >= 1.0 ? "MOMENTUM-OFF" : "marginal") : "no-data";
    console.log(
      `${day} ${String(tt.length).padStart(3)} ${String(wins.length).padStart(3)}/${String(losses.length).padStart(2)}   ${ldm === null ? "—".padStart(12) : ldm.toFixed(2).padStart(12)}  ${mean(ld) === null ? "—".padStart(13) : mean(ld)!.toFixed(2).padStart(13)}  ${med(wd) === null ? "—".padStart(10) : med(wd)!.toFixed(2).padStart(10)}  ${cpm === null ? "—".padStart(10) : cpm.toFixed(2).padStart(10)}  ${readout}`,
    );
    if (ldm !== null || cpm !== null) {
      await sql`
        insert into friction_daily (day, bot_trades, wins, losses, loser_drift_med, loser_drift_mean, winner_drift_med, cost_pts_med)
        values (${day}::date, ${tt.length}, ${wins.length}, ${losses.length}, ${ldm ?? null}, ${mean(ld) ?? null}, ${med(wd) ?? null}, ${cpm ?? null})
        on conflict (day) do update set
          bot_trades = excluded.bot_trades, wins = excluded.wins, losses = excluded.losses,
          loser_drift_med = excluded.loser_drift_med, loser_drift_mean = excluded.loser_drift_mean,
          winner_drift_med = excluded.winner_drift_med, cost_pts_med = excluded.cost_pts_med,
          updated_at = now()`;
    }
  }
  const allLdm = med(allLoserDrift);
  const allCpm = med(allCosts);
  if (allLdm !== null || allCpm !== null) {
    console.log("------------------------------------------------------------------------------------------");
    console.log(
      `ALL-TIME   loserDriftMed ${allLdm === null ? "—" : allLdm.toFixed(2)} pt · costPtsMed ${allCpm === null ? "—" : allCpm.toFixed(2)} pt · ` +
        `all-in losing-trade friction ≈ ${allLdm !== null && allCpm !== null ? (allLdm + allCpm).toFixed(2) : "—"} pt`,
    );    if (allLdm !== null) {
      console.log(
        allLdm <= 0.5
          ? "→ drift gate PASSED (≤0.5): re-run gapOnlyValidation with these numbers before re-enabling momentum"
          : allLdm >= 1.0
            ? "→ drift gate FAILED (≥1.0): momentum stays off"
            : "→ marginal: keep accumulating days",
      );
    }
  }
  await sql.end();
}

main().catch((e) => {
  console.error("frictionReport failed:", e);
  process.exit(1);
});
