"use client";

/* The backtest page's LIVE companion — the same daily-updated archive
 * the study cards show, here as one table per family + a last-14-day
 * grid: real fills (nightly daybook consolidation, 17:45 ET Mon–Fri)
 * against each family's replay baseline. Fetches /api/live-archive. */

import { useEffect, useState } from "react";
import type { LiveFamily, LiveEdgeStatus } from "@/lib/liveArchive";

type Payload = {
  ok: boolean;
  reason?: string;
  lastDay?: string | null;
  sessions?: number;
  families?: LiveFamily[];
};

const STATUS_TONE: Record<LiveEdgeStatus, string> = {
  ok: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  watch: "border-amber-800 bg-amber-950/40 text-amber-300",
  breach: "border-red-900 bg-red-950/40 text-red-400",
  insufficient: "border-zinc-700 bg-zinc-900/40 text-zinc-500",
};

const STATUS_WORD: Record<LiveEdgeStatus, string> = {
  ok: "edge ok",
  watch: "edge watch",
  breach: "edge breach",
  insufficient: "insufficient",
};

const money = (n: number) =>
  `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

const DAYS_SHOWN = 14;

export default function LiveDailyPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/live-archive", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Payload) => {
        if (cancelled) return;
        setData(j);
        if (!j.ok) setErr(j.reason ?? "live archive unreachable");
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const families = (data?.families ?? []).filter((f) => f.n > 0);
  const daySet = new Set<string>();
  for (const f of families) for (const d of f.byDay) daySet.add(d.day);
  const days = [...daySet].sort().reverse().slice(0, DAYS_SHOWN);

  return (
    <section className="mt-12 border-t border-zinc-800 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-zinc-50">Live · updated daily</h2>
        <span className="text-[11px] text-zinc-500">
          {data?.ok && data.lastDay ? (
            <>
              last session <b className="text-zinc-300">{data.lastDay}</b> · {data.sessions ?? 0} consolidated
            </>
          ) : err ? (
            <span className="text-amber-400">{err}</span>
          ) : (
            "loading…"
          )}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
        Each strategy family&apos;s REAL fills vs its backtest baseline (expR per trade). Written nightly at 17:45 ET
        Mon–Fri by the daybook consolidation from CrossTrade fills — every card on the studies page shows the same
        archive. expR = gross $ ÷ (contracts × risk pts × $2); status thresholds match the edge monitor (n ≥ 8:
        breach ≤ 0 · watch &lt; ½ baseline · ok).
      </p>

      {data?.ok && families.length === 0 && (
        <p className="text-zinc-600 text-xs mt-3">
          no consolidated live sessions in the archive yet — the nightly pipeline writes one per trading day.
        </p>
      )}

      {/* per-family summary */}
      {families.length > 0 && (
        <div className="overflow-x-auto mt-4 rounded border border-zinc-800">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-zinc-800">
                <th className="px-2 py-2 font-semibold">family</th>
                <th className="px-2 py-2 font-semibold text-right">fills</th>
                <th className="px-2 py-2 font-semibold text-right">WR</th>
                <th className="px-2 py-2 font-semibold text-right">PF</th>
                <th className="px-2 py-2 font-semibold text-right">net $</th>
                <th className="px-2 py-2 font-semibold text-right">expR live</th>
                <th className="px-2 py-2 font-semibold text-right">expR backtest</th>
                <th className="px-2 py-2 font-semibold">status</th>
                <th className="px-2 py-2 font-semibold">last session</th>
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <tr key={f.family} className="border-b border-zinc-800/50 hover:bg-zinc-900/40">
                  <td className="px-2 py-1.5 text-zinc-100 uppercase">{f.label}</td>
                  <td className="px-2 py-1.5 text-right">{f.n}</td>
                  <td className="px-2 py-1.5 text-right">{pct(f.wr)}</td>
                  <td className="px-2 py-1.5 text-right">{f.pf === null ? "—" : f.pf.toFixed(2)}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${f.netUsd >= 0 ? "text-emerald-300" : "text-red-400"}`}>
                    {money(f.netUsd)}
                  </td>
                  <td className="px-2 py-1.5 text-right">{f.meanExpR === null ? "—" : f.meanExpR.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{f.baselineExpR.toFixed(2)}</td>
                  <td className="px-2 py-1.5">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS_TONE[f.status]}`}>{STATUS_WORD[f.status]}</span>
                  </td>
                  <td className="px-2 py-1.5 text-zinc-400">{f.lastDay ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* last N sessions × family net grid */}
      {families.length > 0 && days.length > 0 && (
        <div className="overflow-x-auto mt-4 rounded border border-zinc-800">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-zinc-800">
                <th className="px-2 py-1.5 font-semibold">session (net $)</th>
                {families.map((f) => (
                  <th key={f.family} className="px-2 py-1.5 font-semibold text-right uppercase" title={`${f.family} · ${f.n} fills · WR ${pct(f.wr)}`}>
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day} className="border-b border-zinc-800/50">
                  <td className="px-2 py-1.5 text-zinc-400">{day}</td>
                  {families.map((f) => {
                    const d = f.byDay.find((x) => x.day === day);
                    if (!d) return <td key={f.family} className="px-2 py-1.5 text-right text-zinc-700">·</td>;
                    return (
                      <td
                        key={f.family}
                        className={`px-2 py-1.5 text-right font-semibold ${d.netUsd > 0 ? "text-emerald-300" : d.netUsd < 0 ? "text-red-400" : "text-zinc-400"}`}
                        title={`${day} · ${f.label} · ${d.n} fill${d.n === 1 ? "" : "s"} · ${d.wins}W/${d.losses}L${d.flats ? `/${d.flats}F` : ""}`}
                      >
                        {d.netUsd === 0 ? "·" : money(d.netUsd)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-2 py-1.5 text-[9px] text-zinc-600">
            last {days.length} sessions with at least one fill · green win / red loss / grey flat · each cell&apos;s
            tooltip carries the fills and W/L split.
          </p>
        </div>
      )}
    </section>
  );
}
