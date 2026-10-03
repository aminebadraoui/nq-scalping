import { dbEnabled, getDb } from "@/lib/gcdb";
import { familyOf } from "@/lib/tradeStats";
import { edgeStatuses, REPLAY_EXPR_BASELINES } from "@/lib/edgeMonitor";
import { streakTable, drawdownTable, hourMatrix, hourTable } from "@/lib/journalMetrics";

export const dynamic = "force-dynamic";

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
    return Response.json({ ok: false, reason: "no DATABASE_URL" });
  }
  const db = getDb();
  try {
    const runs = await db`select * from reconcile_runs order by run_at desc limit 5`;
    const RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90, all: 0 };
    const rangeParam = new URL(request.url).searchParams.get("range") ?? "30";
    const rangeDays = RANGE_DAYS[rangeParam] ?? 30;
    const w0 = rangeDays > 0 ? Date.now() - rangeDays * 86_400_000 : 0;

    // trade rows for the selected range (was: latest run's window only —
    // the day view and the trades list must agree with the scoreboard)
    const rangeTrades = (await db`select * from trades where ts >= ${w0} order by ts desc limit 1000`) as Array<Record<string, unknown>>;
    const trades = [...rangeTrades].reverse();

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
    for (const t of rangeTrades) {
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

    // ---- account equity curve (one snapshot per reconcile run) ----
    const eqRuns = (await db`
      select run_at, account_net, account_realized, manual_fills, manual_gross_usd from reconcile_runs
      where run_at >= ${new Date(w0).toISOString()}
      order by run_at asc`) as Array<Record<string, unknown>>;
    const equity = eqRuns
      .filter((r) => r.account_net !== null && r.account_net !== undefined)
      .map((r) => ({
        at: String(r.run_at),
        net: Number(r.account_net),
        realized: r.account_realized === null || r.account_realized === undefined ? null : Number(r.account_realized),
      }));

    // ---- balance ledger: account Δ = bot net + manual residual ----
    // netLiq deltas between consecutive snapshots are the TRUE total P&L
    // (bot + manual + anything else). The residual vs the bot's own net
    // is the manual bucket — ground truth, no pairing needed.
    const ledger = eqRuns
      .filter((r) => r.account_net !== null && r.account_net !== undefined)
      .map((r, i, arr) => {
        const at = Date.parse(String(r.run_at));
        const prevAt = i > 0 ? Date.parse(String(arr[i - 1].run_at)) : 0;
        let botNet = 0;
        for (const t of rangeTrades) {
          const ts = Number(t.ts ?? 0);
          if (i === 0 ? ts < at : ts >= prevAt && ts < at) botNet += Number(t.net_usd ?? 0);
        }
        const net = Number(r.account_net);
        const delta = i > 0 ? net - Number(arr[i - 1].account_net) : null;
        const residual = delta !== null ? Math.round((delta - botNet) * 100) / 100 : null;
        return {
          at: String(r.run_at),
          net,
          delta,
          botNet: Math.round(botNet * 100) / 100,
          manualResidual: residual,
          manualFills: Number(r.manual_fills ?? 0),
          manualGrossUsd: r.manual_gross_usd === null || r.manual_gross_usd === undefined ? null : Number(r.manual_gross_usd),
        };
      });

    // ---- dedicated metric tables (pure, unit-tested shapes) ----
    const metricRows = rangeTrades
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

    // ---- manual bucket (Tradovate round trips no signal explains) ----
    const dayFloor = new Date(w0).toISOString().slice(0, 10);
    const manualRows = (await db`
      select * from manual_trades
      where matched_signal is null and day >= ${dayFloor}
      order by entry_at desc, id desc
      limit 500`) as Array<Record<string, unknown>>;
    const manualDays = (await db`
      select day, count(*)::int as n, sum(pnl_usd)::numeric(12,2) as gross
      from manual_trades where matched_signal is null and day >= ${dayFloor}
      group by day order by day desc`) as Array<Record<string, unknown>>;
    const manualTotal = manualDays.length
      ? Math.round(manualDays.reduce((s, d) => s + Number(d.gross ?? 0), 0) * 100) / 100
      : 0;

    const analysis = await db`select * from trade_analysis order by run_at desc limit 1`;
    const a = analysis[0] as (typeof analysis)[number] | undefined;

    // ---- strategy scoreboard: frequency + live vs replay performance ----
    // Accumulates over the selected rolling window (never reset by the
    // reconcile runs — the trades/signals tables are the record).
    let scoreboard: unknown[] = [];
    if (rangeTrades.length) {
      const sigs = await db`select ts, verdict from signals where ts >= ${w0}`;
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
      for (const s of sigs as Array<Record<string, unknown>>) {
        ensure(familyOf(String(s.verdict ?? ""))).signals++;
      }
      // minimal rows for the edge monitor: family, result, contracts,
      // grossUsd, riskPts (from the signal stop distance)
      const enriched: Array<{ family: string; result: string; contracts: number; grossUsd: number; riskPts: number }> = [];
      for (const t of rangeTrades) {
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
      scoreboard = [...buckets.entries()].map(([family, b]) => {
        const st = statusByFamily.get(family);
        const fills = b.fills;
        const liveExpR = st && fills >= 8 ? st.meanExpR : null;
        const baselineExpR = st?.baselineExpR ?? REPLAY_EXPR_BASELINES[family] ?? REPLAY_EXPR_BASELINES.other;
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
      headline,
      days: dayList,
      equity,
      ledger,
      streaks,
      drawdowns,
      matrix,
      hours,
      manual: manualRows,
      manualDays,
      manualTotal,
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
    return Response.json({ ok: false, reason: String(e) });
  }
}
