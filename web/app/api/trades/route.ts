import { dbEnabled, getDb } from "@/lib/gcdb";
import { familyOf } from "@/lib/tradeStats";
import { edgeStatuses, REPLAY_EXPR_BASELINES } from "@/lib/edgeMonitor";

export const dynamic = "force-dynamic";

/** Reconciled trades (scripts/reconcileTrades.ts output): the latest run's
 *  summary plus its signal↔fill rows — the dashboard's trade review panel.
 *  Also computes the strategy scoreboard: per family, how often it fires
 *  (cards recorded → fills) and how it performs live (expR, net) against
 *  its replay baseline + edge-monitor status. Data-only: no live feed,
 *  no execution state. */
export async function GET() {
  if (!dbEnabled()) {
    return Response.json({ ok: false, reason: "no DATABASE_URL" });
  }
  const db = getDb();
  try {
    const runs = await db`select * from reconcile_runs order by run_at desc limit 5`;
    let trades: unknown = [];
    if (runs.length) {
      const latest = runs[0];
      trades = await db`
        select * from trades
        where ts >= ${Number(latest.window_start)} and ts <= ${Number(latest.window_end)}
        order by ts asc`;
    }
    const analysis = await db`select * from trade_analysis order by run_at desc limit 1`;
    const a = analysis[0] as (typeof analysis)[number] | undefined;

    // ---- strategy scoreboard: frequency + live vs replay performance ----
    let scoreboard: unknown[] = [];
    if (runs.length && Array.isArray(trades) && trades.length) {
      const latest = runs[0];
      const w0 = Number(latest.window_start);
      const w1 = Number(latest.window_end);
      const sigs = await db`select ts, verdict from signals where ts >= ${w0} and ts <= ${w1}`;
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
      for (const t of trades as Array<Record<string, unknown>>) {
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
      const statuses = edgeStatuses(enriched as unknown as Parameters<typeof edgeStatuses>[0]);
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
      scoreboard,
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
