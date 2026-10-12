"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Execution-latency panel — the execution tab's timing telemetry.
 *
 *   · Current execution time — the five stages of the signal→fill
 *     pipeline (getData → feedCheck → compute → dispatch → CrossTrade
 *     execute) with a stacked bar; live-updating every 5s.
 *   · CrossTrade execution — the last submit→ack→fill leg with the
 *     broker's own fill timestamp.
 *   · History — every cycle the executor has run (persisted in Neon,
 *     read back here) + p50/p95 per stage, so each optimization is
 *     visible against its baseline.
 *
 * DISPLAY-ONLY: polls /api/exec-latency; nothing here can change a
 * trading decision. Writers live in lib/execLatency.ts.
 * ------------------------------------------------------------------ */

type CycleStages = Partial<Record<"getData" | "feedCheck" | "compute" | "dispatch", number>>;

type Cycle = {
  id: string;
  ts: number;
  kind: "cycle";
  totalMs: number;
  stages: CycleStages;
  detail: { detectLagMs?: number; barAgeMs?: number; note?: string; checks?: Array<{ name: string; ms: number }> };
};

type Fill = {
  id: string;
  ts: number;
  kind: "fill";
  totalMs: number;
  detail: { label: string; dir: string; qty: number; submitMs: number; ackMs: number | null; fillMs: number | null; seenMs: number | null };
};

type Live = {
  current: { id: string; startedAt: number; stages: CycleStages; checks: Array<{ name: string; ms: number }> } | null;
  latest: Cycle | null;
  lastFills: Fill[];
  window: Cycle[];
};

type Stat = { p50: number | null; p95: number | null; n: number };
type Agg = Partial<Record<"getData" | "feedCheck" | "compute" | "dispatch", Stat>>;

type Resp = {
  ok: boolean;
  live?: Live;
  rows?: Array<{ ts: number; kind: string; total_ms: number; stages: CycleStages; detail: Record<string, unknown> }>;
  agg?: { h1: Agg; h24: Agg; barAge?: { h1: Stat; h24: Stat } };
  trend?: Array<{ day: number; n: number; avgMs: number; avgBarAge?: number | null }>;
  note?: string;
  error?: string;
};

const STAGES: Array<{ key: keyof CycleStages; label: string; color: string }> = [
  { key: "getData", label: "get data", color: "bg-sky-500/80" },
  { key: "feedCheck", label: "check feed update", color: "bg-amber-400/80" },
  { key: "compute", label: "compute signals", color: "bg-violet-500/80" },
  { key: "dispatch", label: "send to CrossTrade", color: "bg-emerald-500/80" },
];

const fmtMs = (ms: number | undefined | null): string => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
};

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

function StackedBar({ stages, totalMs }: { stages: CycleStages; totalMs: number }) {
  const total = totalMs > 0 ? totalMs : Object.values(stages).reduce<number>((s, v) => s + (v ?? 0), 0);
  if (total <= 0) return <div className="h-1.5 w-full rounded bg-zinc-800" />;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded bg-zinc-800">
      {STAGES.map((s) => {
        const v = stages[s.key] ?? 0;
        if (v <= 0) return null;
        return <div key={s.key} className={`${s.color} h-full`} style={{ width: `${Math.min(100, (v / total) * 100)}%` }} title={`${s.label}: ${fmtMs(v)}`} />;
      })}
    </div>
  );
}

function Sparkline({ totals }: { totals: number[] }) {
  if (totals.length < 2) return <span className="font-mono text-[10px] text-zinc-600">waiting for cycles…</span>;
  const max = Math.max(...totals, 1);
  const w = 320;
  const h = 40;
  const pts = totals
    .map((v, i) => `${((i / (totals.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke="#34d399" strokeWidth="1" />
      <text x={0} y={h + 10} className="fill-zinc-600 font-mono text-[8px]">{max >= 1000 ? `${(max / 1000).toFixed(1)}s` : `${Math.round(max)}ms`} max</text>
    </svg>
  );
}

export default function ExecLatencyPanel() {
  const [live, setLive] = useState<Live | null>(null);
  const [rows, setRows] = useState<Resp["rows"]>([]);
  const [agg, setAgg] = useState<Resp["agg"]>({ h1: {}, h24: {} });
  const [trend, setTrend] = useState<Resp["trend"]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([]);

  useEffect(() => {
    let cancelled = false;
    const lite = () => {
      fetch("/api/exec-latency?lite=1")
        .then((r) => r.json())
        .then((j: Resp) => {
          if (cancelled || !j.ok || !j.live) return;
          setLive(j.live);
        })
        .catch(() => {});
    };
    const full = () => {
      fetch("/api/exec-latency")
        .then((r) => r.json())
        .then((j: Resp) => {
          if (cancelled) return;
          if (!j.ok) {
            setError(j.error ?? "failed to load history");
            return;
          }
          setRows(j.rows ?? []);
          setAgg(j.agg ?? { h1: {}, h24: {} });
          setTrend(j.trend ?? []);
          setNote(j.note ?? null);
          setError(null);
        })
        .catch(() => {});
    };
    lite();
    full();
    timers.current = [setInterval(lite, 5_000), setInterval(full, 60_000)];
    return () => {
      cancelled = true;
      for (const t of timers.current) clearInterval(t);
    };
  }, []);

  const cur = live?.current ?? null;
  const last = live?.latest ?? null;
  const view: { stages: CycleStages; totalMs: number; inFlight: boolean } = cur
    ? { stages: cur.stages, totalMs: Math.max(0, Date.now() - cur.startedAt), inFlight: true }
    : last
      ? { stages: last.stages, totalMs: last.totalMs, inFlight: false }
      : { stages: {}, totalMs: 0, inFlight: false };
  const lastFill = live?.lastFills?.[0] ?? null;
  const historyCycles = (rows ?? []).filter((r) => r.kind === "cycle").slice(0, 100);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Execution time — signal → CrossTrade → fill
        </h2>
        <span className="font-mono text-[10px] text-zinc-500">
          {cur ? "cycle in flight" : last ? `last cycle ${fmtTime(last.ts)} NY` : "no cycles yet"} · cycle every 15s
        </span>
      </div>

      {/* ---- current execution time ---- */}
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              current execution time {view.inFlight && <span className="text-amber-400">● running</span>}
            </span>
            <span className="font-mono text-xs text-zinc-200">
              total <span className="font-bold">{fmtMs(view.totalMs)}</span>
            </span>
          </div>
          <StackedBar stages={view.stages} totalMs={view.totalMs} />
          <div className="mt-2 space-y-1">
            {STAGES.map((s) => (
              <div key={s.key} className="flex items-center justify-between font-mono text-[10px]">
                <span className="flex items-center gap-1.5 text-zinc-400">
                  <span className={`inline-block h-1.5 w-1.5 rounded-sm ${s.color}`} />
                  {s.label}
                </span>
                <span className="text-zinc-200">{fmtMs(view.stages[s.key])}</span>
              </div>
            ))}
            <div className="flex items-center justify-between font-mono text-[10px]">
              <span className="flex items-center gap-1.5 text-zinc-400">
                <span className="inline-block h-1.5 w-1.5 rounded-sm bg-zinc-500" />
                cross trade execute (submit→fill)
              </span>
              <span className={lastFill?.detail.fillMs != null ? "text-zinc-200" : "text-zinc-600"}>
                {lastFill?.detail.fillMs != null ? fmtMs(lastFill.detail.fillMs) : "awaiting fill"}
              </span>
            </div>
            {last?.detail.detectLagMs !== undefined && (
              <div className="flex items-center justify-between border-t border-zinc-800 pt-1 font-mono text-[10px]">
                <span className="text-zinc-500">detection lag (bar close → dispatch)</span>
                <span className={last.detail.detectLagMs > 10_000 ? "text-amber-400" : "text-long"}>{fmtMs(last.detail.detectLagMs)}</span>
              </div>
            )}
            {last?.detail.barAgeMs !== undefined && (
              <div className="flex items-center justify-between border-t border-zinc-800 pt-1 font-mono text-[10px]">
                <span className="text-zinc-500">bar age (bar close → this tick, every cycle)</span>
                <span className={last.detail.barAgeMs > 10_000 ? "text-amber-400" : "text-long"}>{fmtMs(last.detail.barAgeMs)}</span>
              </div>
            )}
          </div>
        </div>

        {/* ---- last CrossTrade leg ---- */}
        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">last CrossTrade execution</div>
          {lastFill ? (
            <div className="space-y-1 font-mono text-[10px]">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">{lastFill.detail.label}</span>
                <span className={lastFill.detail.dir === "long" ? "text-long" : "text-short"}>
                  {lastFill.detail.dir} {lastFill.detail.qty}
                </span>
              </div>
              <div className="flex items-center justify-between"><span className="text-zinc-500">submit → placement ack</span><span className="text-zinc-200">{fmtMs(lastFill.detail.submitMs)}</span></div>
              <div className="flex items-center justify-between"><span className="text-zinc-500">ack → broker fill</span><span className="text-zinc-200">{fmtMs(lastFill.detail.fillMs)}</span></div>
              <div className="flex items-center justify-between"><span className="text-zinc-500">fill → watcher saw it</span><span className="text-zinc-200">{fmtMs(lastFill.detail.seenMs)}</span></div>
              {lastFill.detail.fillMs === null && <div className="text-zinc-600">no fill matched yet (watcher checks at 90s)</div>}
            </div>
          ) : (
            <p className="font-mono text-[10px] text-zinc-600">no live CrossTrade placements recorded — fills appear here once a card trades</p>
          )}

          {/* p50/p95 per stage */}
          <div className="mt-3 border-t border-zinc-800 pt-2">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">stage latency — 1h / 24h (p50 · p95)</div>
            <div className="space-y-0.5">
              {STAGES.map((s) => {
                const a = agg?.h24?.[s.key];
                const b = agg?.h1?.[s.key];
                return (
                  <div key={s.key} className="flex items-center justify-between font-mono text-[10px]">
                    <span className="text-zinc-400">{s.label}</span>
                    <span className="text-zinc-300">
                      {a?.n ? `${fmtMs(a.p50)} · ${fmtMs(a.p95)}` : "—"}
                      {b?.n ? <span className="text-zinc-500"> · now {fmtMs(b.p50)}</span> : null}
                    </span>
                  </div>
                );
              })}
              {agg?.barAge && (
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="text-zinc-400">bar age (poll lag)</span>
                  <span className="text-zinc-300">
                    {agg.barAge.h24?.n ? `${fmtMs(agg.barAge.h24.p50)} · ${fmtMs(agg.barAge.h24.p95)}` : "—"}
                    {agg.barAge.h1?.n ? <span className="text-zinc-500"> · now {fmtMs(agg.barAge.h1.p50)}</span> : null}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ---- history ---- */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500">history — every cycle (latest 100)</h3>
        {trend && trend.length > 1 && (
          <span className="font-mono text-[10px] text-zinc-500">
            daily avg: {trend.map((t) => `${new Date(t.day).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" })} ${fmtMs(t.avgMs)}${t.avgBarAge !== null && t.avgBarAge !== undefined ? `/${fmtMs(t.avgBarAge)}` : ""}`).slice(-7).join(" · ")}
          </span>
        )}
      </div>
      {error ? (
        <p className="font-mono text-xs text-short">{error}</p>
      ) : note ? (
        <p className="font-mono text-xs text-zinc-500">{note}</p>
      ) : historyCycles.length === 0 ? (
        <p className="font-mono text-xs text-zinc-600">no cycles recorded yet — the signal feed writes one per tick</p>
      ) : (
        <>
          <div className="mb-2"><Sparkline totals={historyCycles.map((c) => c.total_ms).reverse()} /></div>
          <div className="max-h-[320px] overflow-y-auto rounded border border-zinc-800">
            <table className="w-full border-collapse font-mono text-[10px]">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className="text-left text-zinc-500">
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">time (NY)</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">src</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">total</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">get data</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">feed check</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">compute</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">dispatch</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal text-right">bar age</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">note</th>
                </tr>
              </thead>
              <tbody>
                {historyCycles.map((c, i) => (
                  <tr key={`${c.ts}|${i}`} className="text-zinc-400">
                    <td className="px-2 py-0.5 whitespace-nowrap text-zinc-500">{fmtTime(c.ts)}</td>
                    <td className={`px-2 py-0.5 whitespace-nowrap ${c.detail?.source === "event" ? "text-long" : c.detail?.source === "poll" ? "text-amber-400" : "text-zinc-500"}`}>
                      {typeof c.detail?.source === "string" ? c.detail.source : "—"}
                    </td>
                    <td className="px-2 py-0.5 text-right whitespace-nowrap text-zinc-200">{fmtMs(c.total_ms)}</td>
                    <td className="px-2 py-0.5 text-right whitespace-nowrap">{fmtMs(c.stages?.getData)}</td>
                    <td className="px-2 py-0.5 text-right whitespace-nowrap">{fmtMs(c.stages?.feedCheck)}</td>
                    <td className="px-2 py-0.5 text-right whitespace-nowrap">{fmtMs(c.stages?.compute)}</td>
                    <td className="px-2 py-0.5 text-right whitespace-nowrap">{fmtMs(c.stages?.dispatch)}</td>
                    <td className={`px-2 py-0.5 text-right whitespace-nowrap ${typeof c.detail?.barAgeMs === "number" && c.detail.barAgeMs > 10_000 ? "text-amber-400" : "text-zinc-400"}`}>
                      {fmtMs(c.detail?.barAgeMs as number | undefined)}
                    </td>
                    <td className="px-2 py-0.5 max-w-[220px] truncate text-zinc-600">{typeof c.detail?.note === "string" ? c.detail.note : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
