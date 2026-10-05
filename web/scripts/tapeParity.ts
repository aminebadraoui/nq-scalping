/* ------------------------------------------------------------------ *
 * Tape parity — live-written bars vs the archived (vendor) bars.
 *
 * The live feed persists its tick-built minutes into `candles_1m` as
 * bars complete (LIVE_WRITE); the nightly ingest then OVERWRITES those
 * rows with the vendor's collected candles. To know how far the live
 * tape (what the signal engine evaluated) diverged from the archive
 * (what every backtest was computed on), snapshot the live rows BEFORE
 * ingest and diff them AFTER:
 *
 *   snapshot <day>   — copy the day's ETH candles_1m rows into
 *                      `tape_snapshot` (idempotent upsert)
 *   compare <day>    — diff tape_snapshot vs candles_1m (post-ingest)
 *                      and write one summary row into `tape_parity`
 *
 * Wired into scripts/nightly.sh: snapshot before the ingest step,
 * compare after it. Observational only — never read by the engine.
 * ------------------------------------------------------------------ */

import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("tapeParity: DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(DB_URL, { ssl: "require", max: 1 });

const TABLE_SQL = `
create table if not exists tape_snapshot (
  ts   timestamptz primary key,
  date date not null,
  h    numeric(10,2),
  l    numeric(10,2),
  v    bigint,
  buy  bigint,
  sell bigint
);
create index if not exists tape_snapshot_date_idx on tape_snapshot (date);
create table if not exists tape_parity (
  id bigint generated always as identity primary key,
  day date not null,
  compared_at timestamptz not null default now(),
  snap_bars int not null default 0,
  arch_bars int not null default 0,
  frac_diff_gt_010 int not null default 0,
  vol_diff_gt_20pct int not null default 0,
  worst_frac_diff numeric(8,3),
  notes text not null default ''
);
`;

async function snapshot(day: string) {
  await sql.unsafe(TABLE_SQL);
  const res = await sql`
    insert into tape_snapshot (ts, date, h, l, v, buy, sell)
    select ts, date, h, l, v, buy, sell from candles_1m
    where date = ${day}::date and session = 'ETH'
    on conflict (ts) do update set
      date = excluded.date, h = excluded.h, l = excluded.l,
      v = excluded.v, buy = excluded.buy, sell = excluded.sell`;
  console.log(`tapeParity snapshot ${day}: ${res.count} live-written bars`);
}

async function compare(day: string) {
  await sql.unsafe(TABLE_SQL);
  const rows = (await sql`
    select s.ts, s.buy::float8 sbuy, s.sell::float8 ssell, s.v::float8 sv,
           c.buy::float8 cbuy, c.sell::float8 csell, c.v::float8 cv
    from tape_snapshot s
    left join candles_1m c on c.ts = s.ts and c.session = 'ETH'
    where s.date = ${day}::date
    order by s.ts`) as Array<Record<string, number | null>>;

  const archRows = (await sql`
    select count(*)::int n from candles_1m where date = ${day}::date and session = 'ETH'`) as Array<{ n: number }>;

  if (!rows.length) {
    console.log(`tapeParity compare ${day}: no snapshot rows — live write did not run that day`);
    await sql`
      insert into tape_parity (day, snap_bars, arch_bars, notes)
      values (${day}::date, 0, ${archRows[0]?.n ?? 0}, 'no live snapshot rows')`;
    return;
  }

  let fracDiffGt010 = 0;
  let volDiffGt20 = 0;
  let worstFrac = 0;
  let matched = 0;
  for (const r of rows) {
    if (r.cbuy === null || r.csell === null) continue; // live bar never archived
    matched++;
    const sv = (r.sbuy ?? 0) + (r.ssell ?? 0);
    const cv = (r.cbuy ?? 0) + (r.csell ?? 0);
    const sf = sv > 0 ? (r.sbuy ?? 0) / sv : 0.5;
    const cf = cv > 0 ? (r.cbuy ?? 0) / cv : 0.5;
    const fd = Math.abs(sf - cf);
    worstFrac = Math.max(worstFrac, fd);
    if (fd > 0.1) fracDiffGt010++;
    if (cv > 0 && Math.abs(sv - cv) / cv > 0.2) volDiffGt20++;
  }

  const summary = `snap ${rows.length} · arch ${archRows[0]?.n ?? 0} · matched ${matched} · fracDiff>0.10: ${fracDiffGt010} · volDiff>20%: ${volDiffGt20} · worstFrac ${worstFrac.toFixed(3)}`;
  console.log(`tapeParity compare ${day}: ${summary}`);
  await sql`
    insert into tape_parity (day, snap_bars, arch_bars, frac_diff_gt_010, vol_diff_gt_20pct, worst_frac_diff, notes)
    values (${day}::date, ${rows.length}, ${archRows[0]?.n ?? 0}, ${fracDiffGt010}, ${volDiffGt20}, ${+worstFrac.toFixed(3)}, ${summary})`;
}

async function main() {
  const [mode, dayArg] = process.argv.slice(2);
  const day = dayArg ?? new Date().toISOString().slice(0, 10);
  if (mode === "snapshot") await snapshot(day);
  else if (mode === "compare") await compare(day);
  else {
    console.error("usage: tapeParity.ts <snapshot|compare> [day]");
    process.exit(1);
  }
  await sql.end();
}

main().catch((e) => {
  console.error("tapeParity failed:", e);
  process.exit(1);
});
