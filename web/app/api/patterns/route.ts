/* ------------------------------------------------------------------ *
 * Pattern explorer API — winner/loser patterns over the full journal
 * variable dump, computed with lib/patternMining.ts (the same engine
 * as scripts/winnerLoserPatterns.ts, so the CLI and this panel always
 * agree).
 *
 * GET  /api/patterns?since=YYYY-MM-DD&family=rth&minN=5&account=all
 *      live analysis + the recent stored runs (selector)
 * GET  /api/patterns?run=<id>
 *      a stored run snapshot (reproducible view)
 * POST /api/patterns        { since, family, account, minN }
 *      run the analysis, store it in pattern_runs, return the run
 *
 * Every pattern carries registry metadata (registered / doc) and the
 * response lists unregistered keys — the feature-drift signal.
 * Read-only except the pattern_runs insert (analysis records only).
 * ------------------------------------------------------------------ */

import type { NextRequest } from "next/server";
import { dbEnabled, getDb } from "@/lib/gcdb";
import { isRecentAccount, resolveAccount } from "@/lib/accountAttribution";
import { familyOf } from "@/lib/tradeStats";
import { canonicalFamily } from "@/lib/strategies/aliases";
import {
  minePatterns,
  winLossRowsFromDb,
  signalsToWinLossRows,
  POST_HOC_KEYS,
  type VarPattern,
  type WinLossRow,
} from "@/lib/patternMining";
import { groupKeyOf, GROUP_ORDER } from "@/lib/featureGroups";
import { lookupFeature, driftKeys } from "@/lib/featureRegistry";
import {
  ensurePatternRunsTable,
  recordPatternRun,
  listPatternRuns,
  getPatternRun,
  buildSha,
  type RunInput,
} from "@/lib/patternRuns";

export const dynamic = "force-dynamic";

const GROUP_LABEL = new Map(GROUP_ORDER.map((g) => [g.key, g.label]));
const groupLabelOf = (key: string): string => GROUP_LABEL.get(groupKeyOf(key)) ?? "OTHER";

type Annotated = VarPattern & { group: string; registered: boolean; doc: string | null };

function annotate(p: VarPattern): Annotated {
  const hit = lookupFeature(p.key);
  return {
    ...p,
    group: p.kind === "post-hoc" ? "ANATOMY (post-hoc)" : groupLabelOf(p.key),
    registered: hit.registered,
    doc: hit.entry?.doc ?? null,
  };
}

async function runAnalysis(sp: URLSearchParams): Promise<RunInput & { runAt: string; drift: string[] }> {
  const db = getDb();
  await ensurePatternRunsTable(db);
  const since = (sp.get("since") ?? "").replace(/[^0-9-]/g, "");
  // 2026-10-19 rename bridge: legacy ?family= slugs keep working
  const family = canonicalFamily((sp.get("family") ?? "").replace(/[^a-z_]/g, ""));
  const minN = Number(sp.get("minN") ?? "5") || 5;
  const account = sp.get("account") ?? "all";
  const universe = (sp.get("universe") ?? "filled") === "signals" ? ("signals" as const) : ("filled" as const);

  let rows: WinLossRow[];
  if (universe === "signals") {
    // the all-signals universe: every recorded card's HYPOTHETICAL
    // first-touch replay outcome (win/loss) — signal-quality view,
    // not money (no fills, no slippage, no commissions)
    const rawSigs = (await db`
      select key, day, time_et, side, size, verdict, outcome, features
      from signals
      where outcome in ('win','loss')
        ${since ? db`and day >= ${since}` : db``}
      order by ts asc`) as Array<Record<string, unknown>>;
    const sigs = family ? rawSigs.filter((s) => familyOf(String(s.verdict ?? "")) === family) : rawSigs;
    rows = signalsToWinLossRows(sigs);
  } else {
    const raw = (await db`
      select t.day, t.time_et, t.side, t.contracts, t.family, t.verdict,
             t.result, t.hour_bucket, t.first_of_day,
             t.entry_adverse_pts, t.held_min, t.mfe_pts, t.mae_pts,
             t.target_reached, t.recovered, t.stop_run, t.loss_label,
             t.account, t.features
      from trades t
      where t.result in ('win','loss')
        ${since ? db`and t.day >= ${since}` : db``}
        ${family ? db`and t.family = ${family}` : db``}
      order by t.ts asc`) as Array<Record<string, unknown>>;
    const filtered =
      account === "all"
        ? raw
        : raw.filter((r) => {
            const a = resolveAccount(r.account, String(r.day)).account;
            return account === "new" ? isRecentAccount(a) : !isRecentAccount(a);
          });
    rows = winLossRowsFromDb(filtered);
  }
  const wins = rows.filter((r) => r.result === "win").length;

  const famStats = new Map<string, { n: number; wins: number }>();
  for (const r of rows) {
    const f = String(r.anatomy.family ?? "other");
    const s = famStats.get(f) ?? { n: 0, wins: 0 };
    s.n++;
    if (r.result === "win") s.wins++;
    famStats.set(f, s);
  }

  const patterns = minePatterns(rows, { minN, anatomyKeys: Object.keys(POST_HOC_KEYS) }).map(annotate);
  const keys = patterns.map((p) => p.key);

  return {
    runAt: new Date().toISOString(),
    sha: buildSha(),
    since,
    family,
    account,
    minN,
    universe,
    nTrades: rows.length,
    wins,
    losses: rows.length - wins,
    baselineWr: rows.length > 0 ? wins / rows.length : 0,
    familyBaselines: [...famStats.entries()]
      .map(([family, s]) => ({ family, n: s.n, wins: s.wins, wr: s.n > 0 ? s.wins / s.n : 0 }))
      .sort((a, b) => b.n - a.n),
    patterns,
    drift: driftKeys(keys),
  };
}

export async function GET(req: NextRequest) {
  if (!dbEnabled()) {
    return Response.json({ ok: false, reason: "no database configured" });
  }
  try {
    const db = getDb();
    const runId = Number(req.nextUrl.searchParams.get("run") ?? "") || 0;
    if (runId > 0) {
      const run = await getPatternRun(db, runId);
      if (!run) return Response.json({ ok: false, reason: "run not found" });
      const patterns = run.patterns.map((p) =>
        annotate(p as VarPattern),
      );
      return Response.json({ ok: true, source: "run", runId, runAt: run.runAt, sha: run.sha, since: run.since, family: run.family, account: run.account, minN: run.minN, universe: run.universe, n: run.nTrades, wins: run.wins, losses: run.losses, baselineWr: run.baselineWr, familyBaselines: run.familyBaselines, patterns, drift: driftKeys(patterns.map((p) => p.key)), runs: await listPatternRuns(db) });
    }
    const a = await runAnalysis(req.nextUrl.searchParams);
    return Response.json({
      ok: true,
      source: "live",
      runId: null,
      runAt: a.runAt,
      sha: a.sha,
      since: a.since,
      family: a.family,
      account: a.account,
      minN: a.minN,
      universe: a.universe,
      n: a.nTrades,
      wins: a.wins,
      losses: a.losses,
      baselineWr: a.baselineWr,
      familyBaselines: a.familyBaselines,
      patterns: a.patterns,
      drift: a.drift,
      runs: await listPatternRuns(db),
    });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}

export async function POST(req: NextRequest) {
  if (!dbEnabled()) {
    return Response.json({ ok: false, reason: "no database configured" });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sp = new URLSearchParams();
    for (const k of ["since", "family", "account", "minN", "universe"] as const) {
      if (typeof body[k] === "string" || typeof body[k] === "number") sp.set(k, String(body[k]));
    }
    const a = await runAnalysis(sp);
    const db = getDb();
    const id = await recordPatternRun(db, {
      sha: a.sha,
      since: a.since,
      family: a.family,
      account: a.account,
      minN: a.minN,
      universe: a.universe,
      nTrades: a.nTrades,
      wins: a.wins,
      losses: a.losses,
      baselineWr: a.baselineWr,
      familyBaselines: a.familyBaselines,
      patterns: a.patterns,
    });
    return Response.json({ ok: true, runId: id, runs: await listPatternRuns(db) });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e) });
  }
}
