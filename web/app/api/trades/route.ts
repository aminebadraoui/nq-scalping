import { dbEnabled, getDb } from "@/lib/gcdb";
import { familyOf, hypWrByFamily } from "@/lib/tradeStats";
import { edgeStatuses, REPLAY_EXPR_BASELINES } from "@/lib/edgeMonitor";
import { streakTable, drawdownTable, hourMatrix, hourTable } from "@/lib/journalMetrics";
import { listDaybookDaysRemote, readDaybookDayRemote, type DaybookDaySummary, type DaybookRecord } from "@/lib/daybook";
import {
  auditManualTrips,
  auditSummary,
  type ManualTrip,
  type SignalRef,
  type TripEvidence,
} from "@/lib/manualAudit";
import { resolveAccount, startBalanceFor } from "@/lib/accountAttribution";
import {
  buildEntries,
  accountRollup,
  entryAccounts,
  manualNetUsd,
  type JournalEntry,
} from "@/lib/journalEntries";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ *
 * ONE source of truth for the journal's money and identity:
 *
 *   · every trade carries an explicit account — the fire-time stamp on
 *     the row wins, the known switch timeline fills legacy rows
 *     (lib/accountAttribution.ts);
 *   · every trade carries an explicit origin — bot (a signal card) or
 *     manual (a broker round trip no signal explains)
 *     (lib/journalEntries.ts);
 *   · this route returns BOTH views: the per-account aggregates and the
 *     unified `entries` list the journal renders. `?account=` filters
 *     every aggregate; absent (or "all") keeps the blended view but
 *     still ships the per-account rollup so no surface has to guess.
 * ------------------------------------------------------------------ */

type RawRow = Record<string, unknown>;

/* The account columns on manual_trades were added by the 2026-10-18
 * migration (scripts/backfillAccountAttribution.ts). Ensure them lazily
 * so the unified read path never depends on the migration having run —
 * same pattern as lib/execTracker.ensureTable. Never blocks the route:
 * a DDL failure just means the queries below throw and the daybook
 * fallback serves, exactly as before the columns existed. */
const JOURNAL_COLUMNS_SQL = `
alter table manual_trades add column if not exists account text not null default '';
alter table manual_trades add column if not exists account_source text not null default '';
`;
let journalColumnsReady = false;
async function ensureJournalColumns(db: ReturnType<typeof getDb>): Promise<void> {
  if (journalColumnsReady) return;
  try {
    await db.unsafe(JOURNAL_COLUMNS_SQL);
    journalColumnsReady = true;
  } catch {
    /* best-effort — the daybook fallback covers the failure */
  }
}

/** resolve + stamp the account on a row; returns null when filtered out */
function withAccount(row: RawRow, filter: string): RawRow | null {
  const day = String(row.day ?? "");
  const acct = resolveAccount(row.account, day);
  if (filter && acct.account !== filter) return null;
  return { ...row, account: acct.account, account_source: acct.source };
}

/** DB-less fallback (2026-10-07): when Neon is unreachable the journal is
 *  served from the daybook consolidation summaries (local volume ∪ R2
 *  archive) — per-day headline + trades. The richer analytics (equity
 *  curve, scoreboard, analysis) are DB-only and come back the moment
 *  DATABASE_URL works again. */
async function daybookPayload() {
  const days = await Promise.all(
    (await listDaybookDaysRemote()).map(async (d) => {
      const rows = await readDaybookDayRemote(d);
      const summaries = rows
        .filter((r): r is Extract<DaybookRecord, { t: "dayend" }> => r.t === "dayend")
        .map((r) => r.summary as unknown as DaybookDaySummary);
      return { day: d, rows, summaries };
    }),
  );
  const sum = (f: (s: DaybookDaySummary) => number) => days.reduce((acc, d) => acc + d.summaries.reduce((a, s) => a + f(s), 0), 0);

  const allTrades = days.flatMap((d) => d.summaries.flatMap((s) => s.trades ?? []));
  const matched = sum((s) => s.tradesN);
  const wins = sum((s) => s.wins);
  const losses = sum((s) => s.losses);
  const flats = sum((s) => s.flats);
  const grossUsd = Math.round(sum((s) => s.grossUsd) * 100) / 100;
  const netUsd = Math.round(sum((s) => s.netUsd) * 100) / 100;
  const commissions = Math.round(sum((s) => s.commissions) * 100) / 100;
  const dayList = days
    .map((d) => ({
      day: d.day,
      n: d.summaries.reduce((a, s) => a + s.tradesN, 0),
      wins: d.summaries.reduce((a, s) => a + s.wins, 0),
      losses: d.summaries.reduce((a, s) => a + s.losses, 0),
      grossUsd: Math.round(d.summaries.reduce((a, s) => a + s.grossUsd, 0) * 100) / 100,
      netUsd: Math.round(d.summaries.reduce((a, s) => a + s.netUsd, 0) * 100) / 100,
      commissions: Math.round(d.summaries.reduce((a, s) => a + s.commissions, 0) * 100) / 100,
    }))
    .filter((d) => d.n > 0)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  const nets = dayList.map((d) => d.netUsd);
  const trades = allTrades.map((t) => ({
    signal_key: `${t.day}|${t.timeET}|${t.side}`,
    day: t.day,
    time_et: t.timeET,
    side: t.side,
    contracts: t.contracts,
    verdict: t.verdict,
    family: familyOf(t.verdict),
    gross_usd: t.grossUsd,
    net_usd: t.netUsd,
    commissions: t.commissions,
    result: t.result,
    status: "matched",
    source: "daybook",
    account: resolveAccount(null, t.day).account,
    account_source: "timeline",
  }));
  // the unified list in DB-less mode: bot entries only (the daybook
  // summaries never carry broker round trips)
  const entries = buildEntries(trades as RawRow[], []);
  return {
    ok: true,
    source: "daybook",
    runs: [],
    trades,
    entries,
    accounts: accountRollup(entries),
    accountList: entryAccounts(entries),
    accountFilter: "all",
    headline: {
      netUsd,
      grossUsd,
      commissions,
      matched,
      wins,
      losses,
      flats,
      winRate: matched > 0 ? wins / matched : null,
      expectancy: matched > 0 ? netUsd / matched : null,
      bestDayNet: nets.length ? Math.max(...nets) : null,
      worstDayNet: nets.length ? Math.min(...nets) : null,
    },
    days: dayList,
    equity: [],
    ledger: [],
    account: null,
    streaks: [],
    drawdowns: [],
    matrix: [],
    hours: [],
    manual: [],
    manualDays: [],
    manualTotal: null,
    manualSummary: null,
    scoreboard: [],
    scoreRange: "daybook",
    analysis: null,
  };
}

/** Reconciled trades (scripts/reconcileTrades.ts output): the latest run's
 *  summary plus its signal↔fill rows — the dashboard's trade review panel.
 *  Also computes the strategy scoreboard: per family, how often it fires
 *  (cards recorded → fills) and how it performs live (expR, net) against
 *  its replay baseline + edge-monitor status. The scoreboard accumulates
 *  over a rolling window (?range=7|30|90|all, default 30d) — trades and
 *  signal cards persist forever, so the same table covers day → week →
 *  month → all-time. Data-only: no live feed, no execution state. */
export async function GET(request: Request) {
  if (!dbEnabled()) {
    return Response.json(await daybookPayload());
  }
  const db = getDb();
  try {
    await ensureJournalColumns(db);
    const runs = await db`select * from reconcile_runs order by run_at desc limit 50`;
    const RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90, all: 0 };
    const url = new URL(request.url);
    const rangeParam = url.searchParams.get("range") ?? "30";
    const rangeDays = RANGE_DAYS[rangeParam] ?? 30;
    const w0 = rangeDays > 0 ? Date.now() - rangeDays * 86_400_000 : 0;
    const accountFilter = (url.searchParams.get("account") ?? "").trim();

    // trade rows for the selected range (was: latest run's window only —
    // the day view and the trades list must agree with the scoreboard)
    const rangeTradesAll = (await db`select * from trades where ts >= ${w0} order by ts desc limit 1000`) as RawRow[];
    const filtered = rangeTradesAll
      .map((t) => withAccount(t, accountFilter))
      .filter((t): t is RawRow => t !== null);
    const trades = [...filtered].reverse();

    // ---- headline + per-day aggregation (matched trades only) ----
    type DayAgg = { day: string; n: number; wins: number; losses: number; grossUsd: number; netUsd: number; commissions: number };
    const byDay = new Map<string, DayAgg>();
    let headline = {
      netUsd: 0,
      grossUsd: 0,
      commissions: 0,
      matched: 0,
      wins: 0,
      losses: 0,
      flats: 0,
      winRate: null as number | null,
      expectancy: null as number | null,
      bestDayNet: null as number | null,
      worstDayNet: null as number | null,
    };
    for (const t of filtered) {
      if (String(t.status ?? "") !== "matched") continue;
      headline.matched++;
      const r = String(t.result ?? "");
      if (r === "win") headline.wins++;
      else if (r === "loss") headline.losses++;
      else if (r === "flat") headline.flats++;
      headline.grossUsd += Number(t.gross_usd ?? 0);
      headline.commissions += Number(t.commissions ?? 0);
      headline.netUsd += Number(t.net_usd ?? 0);
      const d = t.day ? String(t.day) : "—";
      const agg = byDay.get(d) ?? { day: d, n: 0, wins: 0, losses: 0, grossUsd: 0, netUsd: 0, commissions: 0 };
      agg.n++;
      if (r === "win") agg.wins++;
      if (r === "loss") agg.losses++;
      agg.grossUsd += Number(t.gross_usd ?? 0);
      agg.netUsd += Number(t.net_usd ?? 0);
      agg.commissions += Number(t.commissions ?? 0);
      byDay.set(d, agg);
    }
    if (headline.matched > 0) {
      headline.winRate = headline.wins / headline.matched;
      headline.expectancy = headline.netUsd / headline.matched;
    }
    const dayList = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    if (dayList.length) {
      const nets = dayList.map((d) => d.netUsd);
      headline.bestDayNet = Math.max(...nets);
      headline.worstDayNet = Math.min(...nets);
    }

    // ---- account equity curve (one snapshot per reconcile run, scoped
    //      to the selected account so the curve never crosses a switch) ----
    const eqRunsAll = (await db`
      select run_at, window_start, account_net, account_realized, manual_fills, manual_gross_usd, account from reconcile_runs
      where run_at >= ${new Date(w0).toISOString()}
      order by run_at asc`) as RawRow[];
    const eqRuns = eqRunsAll
      .map((r) => withAccount({ ...r, day: String(r.window_start ?? r.run_at ?? "").slice(0, 10) }, accountFilter))
      .filter((r): r is RawRow => r !== null);
    const equity = eqRuns
      .filter((r) => r.account_net !== null && r.account_net !== undefined)
      .map((r) => ({
        at: String(r.run_at),
        net: Number(r.account_net),
        realized: r.account_realized === null || r.account_realized === undefined ? null : Number(r.account_realized),
      }));

    // ---- balance ledger: account Δ = bot net + manual residual ----
    // netLiq deltas between consecutive snapshots of the SAME account are
    // the true total P&L (bot + manual + anything else). The residual vs
    // the bot's own net is the manual bucket — ground truth, no pairing.
    // Deltas NEVER cross accounts: each snapshot compares against the
    // previous snapshot of ITS OWN account, even in the ALL view.
    const prevByAcct = new Map<string, RawRow>();
    const ledger = eqRuns
      .filter((r) => r.account_net !== null && r.account_net !== undefined)
      .map((r) => {
        const at = Date.parse(String(r.run_at));
        const acct = String(r.account ?? "");
        const prev = prevByAcct.get(acct) ?? null;
        let botNet = 0;
        for (const t of filtered) {
          const ts = Number(t.ts ?? 0);
          if (prev === null ? ts < at : ts >= Date.parse(String(prev.run_at)) && ts < at) {
            botNet += Number(t.net_usd ?? 0);
          }
        }
        const net = Number(r.account_net);
        const delta = prev !== null ? net - Number(prev.account_net) : null;
        const residual = delta !== null ? Math.round((delta - botNet) * 100) / 100 : null;
        prevByAcct.set(acct, r);
        return {
          at: String(r.run_at),
          account: acct,
          net,
          delta,
          botNet: Math.round(botNet * 100) / 100,
          manualResidual: residual,
          manualFills: Number(r.manual_fills ?? 0),
          manualGrossUsd: r.manual_gross_usd === null || r.manual_gross_usd === undefined ? null : Number(r.manual_gross_usd),
        };
      });

    // ---- dedicated metric tables (pure, unit-tested shapes) ----
    const metricRows = filtered
      .filter((t) => String(t.status ?? "") === "matched")
      .map((t) => ({
        ts: Number(t.ts ?? 0),
        day: String(t.day ?? ""),
        family: familyOf(String(t.verdict ?? "")),
        hourBucket: String(t.hour_bucket ?? ""),
        result: String(t.result ?? ""),
        netUsd: Number(t.net_usd ?? 0),
      }));
    const streaks = streakTable(metricRows);
    const drawdowns = drawdownTable(metricRows);
    const matrix = hourMatrix(metricRows);
    const hours = hourTable(metricRows);

    // ---- account headline: the FINAL number (netLiq vs start balance)
    //      for the SELECTED account (MFF eval accounts start at $50k;
    //      ACCOUNT_START_BALANCE overrides when the tier changes) ----
    const lastEq = equity.length ? equity[equity.length - 1] : null;
    const account = lastEq
      ? (() => {
          const acct = accountFilter || "all";
          const startBalance = accountFilter ? startBalanceFor(accountFilter) : Number(process.env.ACCOUNT_START_BALANCE ?? "50000");
          return {
            net: lastEq.net,
            realized: lastEq.realized,
            at: lastEq.at,
            account: acct,
            startBalance,
            pnl: Math.round((lastEq.net - startBalance) * 100) / 100,
            pct: Math.round(((lastEq.net - startBalance) / startBalance) * 10000) / 100,
          };
        })()
      : null;

    // ---- manual bucket (broker round trips no signal explains) ----
    // every trip is cross-referenced with ALL recorded signals and
    // labeled (bot / bot-suspect / ambiguous / manual) with evidence —
    // lib/manualAudit.ts, the same engine as scripts/manualTradeAudit.ts.
    // The label is AUDIT context (hover detail) — the entry's identity
    // is origin=manual, full stop.
    const dayFloor = new Date(w0).toISOString().slice(0, 10);
    const manualRowsAll = (await db`
      select * from manual_trades
      where matched_signal is null and day >= ${dayFloor}
      order by entry_at desc, id desc
      limit 500`) as RawRow[];
    const manualFiltered = manualRowsAll
      .map((r) => withAccount(r, accountFilter))
      .filter((r): r is RawRow => r !== null);
    // per-day manual totals computed from the ACCOUNT-FILTERED rows
    // (manual_trades rows may predate the account stamp — attribution is
    // resolved here, not in SQL)
    const mdMap = new Map<string, { day: string; n: number; net: number; gross: number }>();
    for (const r of manualFiltered) {
      const day = String(r.day ?? "");
      const agg = mdMap.get(day) ?? { day, n: 0, net: 0, gross: 0 };
      agg.n++;
      agg.net += manualNetUsd(r);
      agg.gross += Number(r.pnl_usd ?? 0);
      mdMap.set(day, agg);
    }
    const manualDays = [...mdMap.values()]
      .map((d) => ({
        day: d.day,
        n: d.n,
        net: Math.round(d.net * 100) / 100,
        gross: Math.round(d.gross * 100) / 100,
      }))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    const manualTotal = manualDays.length
      ? Math.round(manualDays.reduce((s, d) => s + d.net, 0) * 100) / 100
      : 0;

    // ---- manual-trade audit labels (cross-reference with signals) ----
    const sigRefs = (await db`
      select key, ts, day, side, size, entry from signals
      where day >= ${dayFloor}`) as RawRow[];
    const signalList: SignalRef[] = sigRefs.map((s) => ({
      key: String(s.key),
      day: String(s.day),
      ts: Number(s.ts),
      side: String(s.side) === "long" ? "long" : "short",
      contracts: Number(String(s.size ?? "").match(/^(\d+)\s*MNQ/)?.[1] ?? 0),
      entry: Number(s.entry) || null,
    }));
    const trips: ManualTrip[] = manualFiltered.map((r) => ({
      key: String(r.key),
      day: String(r.day),
      direction: String(r.direction) === "long" ? "long" : "short",
      qty: Number(r.qty ?? 0),
      entryPrice: Number(r.entry_price ?? 0),
      exitPrice: Number(r.exit_price ?? 0),
      entryAtMs: Date.parse(String(r.entry_at)),
      matchedSignal: null,
    }));
    const audit = auditManualTrips(trips, signalList);
    const manualLabeled: RawRow[] = manualFiltered.map((r, i) => ({
      ...r,
      label: audit[i]?.evidence.label ?? "manual",
      evidence: audit[i]?.evidence ?? null,
    }));
    const manualSummary = auditSummary(audit);

    const analysis = await db`select * from trade_analysis order by run_at desc limit 1`;
    const a = analysis[0] as (typeof analysis)[number] | undefined;

    // ---- unified entries (ONE list: bot + manual, explicit origin) ----
    const entries: JournalEntry[] = buildEntries(filtered, manualFiltered);
    const auditByKey = new Map(manualLabeled.map((m) => [String(m.key), m]));
    for (const e of entries) {
      if (e.origin !== "manual") continue;
      const audited = auditByKey.get(e.key);
      const ev = audited?.evidence as TripEvidence | null | undefined;
      if (ev) {
        e.audit = {
          label: String(ev.label),
          reason: String(ev.reason),
          nearestSignal: ev.nearestSignal ? String(ev.nearestSignal) : null,
        };
      }
    }

    // ---- per-account rollup over ALL time (stable filter chips; the
    //      headline cards above describe the selected range) ----
    const allTrades = (await db`select signal_key, day, account, status, net_usd, gross_usd, commissions, result from trades`) as RawRow[];
    const allManual = (await db`
      select key, day, account, pnl_usd, pnl_net_usd, fees_usd from manual_trades
      where matched_signal is null`) as RawRow[];
    const allEntries = buildEntries(allTrades, allManual);
    const accounts = accountRollup(allEntries);
    const accountList = entryAccounts(allEntries);

    // ---- strategy scoreboard: frequency + live vs replay performance ----
    // Accumulates over the selected rolling window (never reset by the
    // reconcile runs — the trades/signals tables are the record).
    let scoreboard: unknown[] = [];
    if (filtered.length) {
      const sigs = await db`select ts, key, verdict, outcome from signals where ts >= ${w0}`;
      // when an account filter is active, only cards that produced a
      // trade on that account count toward its scoreboard
      const tradeKeys = new Set(filtered.map((t) => String(t.signal_key ?? "")));
      const scopedSigs = (sigs as RawRow[]).filter(
        (s) => !accountFilter || tradeKeys.has(String(s.key ?? "")),
      );
      type Bucket = {
        signals: number;
        fills: number;
        wins: number;
        losses: number;
        netUsd: number;
        days: Set<string>;
      };
      const buckets = new Map<string, Bucket>();
      const ensure = (f: string): Bucket => {
        let b = buckets.get(f);
        if (!b) {
          b = { signals: 0, fills: 0, wins: 0, losses: 0, netUsd: 0, days: new Set() };
          buckets.set(f, b);
        }
        return b;
      };
      for (const s of scopedSigs) {
        ensure(familyOf(String(s.verdict ?? ""))).signals++;
      }
      // minimal rows for the edge monitor: family, result, contracts,
      // grossUsd, riskPts (from the signal stop distance)
      const enriched: Array<{ family: string; result: string; contracts: number; grossUsd: number; riskPts: number }> = [];
      for (const t of filtered) {
        const family = familyOf(String(t.verdict ?? ""));
        const b = ensure(family);
        if (String(t.status ?? "") !== "matched") continue;
        b.fills++;
        const result = String(t.result ?? "");
        if (result === "win") b.wins++;
        else if (result === "loss") b.losses++;
        b.netUsd += Number(t.net_usd ?? 0);
        if (t.day) b.days.add(String(t.day));
        enriched.push({
          family,
          result,
          contracts: Number(t.contracts ?? 0),
          grossUsd: Number(t.gross_usd ?? 0),
          riskPts: Math.abs(Number(t.sig_entry ?? 0) - Number(t.sig_stop ?? 0)),
        });
      }
      // edge over the WHOLE selected range (window ≈ unbounded), not just
      // the last 30 trades — the expR column and the edge chip describe
      // the same set of trades the table aggregates
      const statuses = edgeStatuses(enriched as unknown as Parameters<typeof edgeStatuses>[0], { window: 10_000_000 });
      const statusByFamily = new Map(statuses.map((s) => [s.family, s]));
      // the all-signals hypothetical win rate per family (replay outcomes
      // of every recorded card — the signal-quality complement to fills)
      const hypByFamily = hypWrByFamily(
        scopedSigs as unknown as Array<{ verdict: string; outcome: string }>,
      );
      scoreboard = [...buckets.entries()].map(([family, b]) => {
        const st = statusByFamily.get(family);
        const fills = b.fills;
        const liveExpR = st && fills >= 8 ? st.meanExpR : null;
        const baselineExpR = st?.baselineExpR ?? REPLAY_EXPR_BASELINES[family] ?? REPLAY_EXPR_BASELINES.other;
        const hyp = hypByFamily.get(family);
        return {
          family,
          signals: b.signals,
          fills,
          skips: Math.max(0, b.signals - b.fills),
          days: b.days.size,
          wins: b.wins,
          losses: b.losses,
          netUsd: Math.round(b.netUsd * 100) / 100,
          liveExpR: st?.meanExpR ?? null,
          baselineExpR,
          hypWr: hyp ? hyp.wr : null,
          hypN: hyp ? hyp.n : 0,
          status: st?.status ?? "insufficient",
          detail: st?.detail ?? "",
        };
      });
      // families with no recorded data still appear (zero-filled) so the
      // whole strategy catalog is visible — a family that never fires in
      // the range is itself a finding
      for (const fam of Object.keys(REPLAY_EXPR_BASELINES)) {
        if (fam === "other" || buckets.has(fam)) continue;
        scoreboard.push({
          family: fam,
          signals: 0,
          fills: 0,
          skips: 0,
          days: 0,
          wins: 0,
          losses: 0,
          netUsd: 0,
          liveExpR: null,
          baselineExpR: REPLAY_EXPR_BASELINES[fam],
          hypWr: null,
          hypN: 0,
          status: "insufficient",
          detail: "no cards recorded in this range",
        });
      }
      // default order: net account contribution; the client re-sorts by
      // expR or frequency on demand
      scoreboard.sort(
        (x, y) =>
          (y as { netUsd: number }).netUsd - (x as { netUsd: number }).netUsd ||
          (y as { fills: number }).fills - (x as { fills: number }).fills,
      );
    }

    return Response.json({
      ok: true,
      runs,
      trades,
      entries,
      accounts,
      accountList,
      accountFilter: accountFilter || "all",
      headline,
      days: dayList,
      equity,
      ledger,
      account,
      streaks,
      drawdowns,
      matrix,
      hours,
      manual: manualLabeled,
      manualDays,
      manualTotal,
      manualSummary,
      scoreboard,
      scoreRange: rangeDays > 0 ? `${rangeDays}d` : "all",
      analysis: a
        ? {
            ...a,
            summary: typeof a.summary === "string" ? JSON.parse(a.summary) : a.summary,
          }
        : null,
    });
  } catch (e) {
    // DB configured but unreachable (Neon quota etc.) — serve the daybook
    // journal instead of an error page
    try {
      return Response.json(await daybookPayload());
    } catch {
      return Response.json({ ok: false, reason: String(e) });
    }
  }
}
