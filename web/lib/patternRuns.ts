/* ------------------------------------------------------------------ *
 * Pattern runs — reproducible snapshots of winner/loser explorations.
 *
 * Every analysis run (panel "RUN NOW" or the CLI --record) is stored
 * with its filters, dataset size, build sha, family baselines and the
 * full per-variable result set, so any exploration can be revisited
 * and compared later: "the pattern I saw on Tuesday" is a row, not a
 * memory. The panel loads stored runs read-only; writing is
 * analysis-only (never touches signals, orders or env).
 * ------------------------------------------------------------------ */

import type postgres from "postgres";
import type { VarPattern } from "./patternMining";

/** a stored pattern: the mined variable + optional registry annotations
 *  (the panel annotates on load when they're absent) */
export type StoredPattern = VarPattern & { group?: string; registered?: boolean; doc?: string | null };

export type PatternRunRow = {
  id: number;
  runAt: string;
  sha: string;
  since: string;
  family: string;
  account: string;
  minN: number;
  nTrades: number;
  wins: number;
  losses: number;
  baselineWr: number;
  familyBaselines: Array<{ family: string; n: number; wins: number; wr: number }>;
  patterns: StoredPattern[];
};

export const PATTERN_RUNS_DDL = `
create table if not exists pattern_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  sha text not null default '',
  since text not null default '',
  family text not null default '',
  account text not null default 'all',
  min_n int not null default 5,
  n_trades int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  baseline_wr numeric(10,6) not null default 0,
  family_baselines jsonb not null default '[]',
  patterns jsonb not null default '[]'
);
create index if not exists pattern_runs_at_idx on pattern_runs (run_at desc);
`;

export async function ensurePatternRunsTable(db: postgres.Sql): Promise<void> {
  await db.unsafe(PATTERN_RUNS_DDL);
}

export type RunInput = Omit<PatternRunRow, "id" | "runAt">;

export async function recordPatternRun(db: postgres.Sql, run: RunInput): Promise<number> {
  await ensurePatternRunsTable(db);
  const rows = (await db`
    insert into pattern_runs
      (sha, since, family, account, min_n, n_trades, wins, losses, baseline_wr, family_baselines, patterns)
    values
      (${run.sha}, ${run.since}, ${run.family}, ${run.account}, ${run.minN}, ${run.nTrades}, ${run.wins}, ${run.losses},
       ${run.baselineWr}, ${JSON.stringify(run.familyBaselines)}, ${JSON.stringify(run.patterns)})
    returning id`) as Array<{ id: number }>;
  return rows[0]?.id ?? 0;
}

export type PatternRunSummary = {
  id: number;
  runAt: string;
  sha: string;
  since: string;
  family: string;
  account: string;
  minN: number;
  nTrades: number;
  wins: number;
  losses: number;
  baselineWr: number;
  significant: number;
  stable: number;
  exploratory: number;
};

/** the recent runs for the panel's selector (no patterns payload) */
export async function listPatternRuns(db: postgres.Sql, limit = 25): Promise<PatternRunSummary[]> {
  await ensurePatternRunsTable(db);
  const rows = (await db`
    select id, run_at, sha, since, family, account, min_n, n_trades, wins, losses, baseline_wr, patterns
    from pattern_runs
    order by run_at desc
    limit ${limit}`) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let patterns: Array<{ verdict?: string }> = [];
    try {
      patterns = typeof r.patterns === "string" ? JSON.parse(r.patterns) : ((r.patterns as Array<{ verdict?: string }>) ?? []);
    } catch {
      patterns = [];
    }
    const count = (v: string) => patterns.filter((p) => p.verdict === v).length;
    return {
      id: Number(r.id),
      runAt: new Date(String(r.run_at)).toISOString(),
      sha: String(r.sha),
      since: String(r.since),
      family: String(r.family),
      account: String(r.account),
      minN: Number(r.min_n),
      nTrades: Number(r.n_trades),
      wins: Number(r.wins),
      losses: Number(r.losses),
      baselineWr: Number(r.baseline_wr),
      significant: count("significant"),
      stable: count("stable"),
      exploratory: count("exploratory"),
    };
  });
}

export async function getPatternRun(db: postgres.Sql, id: number): Promise<PatternRunRow | null> {
  await ensurePatternRunsTable(db);
  const rows = (await db`
    select id, run_at, sha, since, family, account, min_n, n_trades, wins, losses, baseline_wr, family_baselines, patterns
    from pattern_runs
    where id = ${id}`) as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const parse = (v: unknown): [] => {
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return [];
      }
    }
    return (v as []) ?? [];
  };
  return {
    id: Number(r.id),
    runAt: new Date(String(r.run_at)).toISOString(),
    sha: String(r.sha),
    since: String(r.since),
    family: String(r.family),
    account: String(r.account),
    minN: Number(r.min_n),
    nTrades: Number(r.n_trades),
    wins: Number(r.wins),
    losses: Number(r.losses),
    baselineWr: Number(r.baseline_wr),
    familyBaselines: parse(r.family_baselines) as PatternRunRow["familyBaselines"],
    patterns: parse(r.patterns) as PatternRunRow["patterns"],
  };
}

/** the deploy sha (Coolify SOURCE_COMMIT → BUILD_SHA), same source as the daybook boot record */
export function buildSha(): string {
  return (process.env.BUILD_SHA ?? "").trim().slice(0, 12);
}
