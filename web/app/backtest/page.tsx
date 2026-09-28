"use client";

import { useEffect, useMemo, useState } from "react";

type Stats = {
  trades: number;
  wins: number;
  winRate: number;
  netPts: number;
  profitFactor: number;
  avgPts: number;
};

type ConfigResult = {
  config: { name: string; floor: number; dom: number; posHi: number; posLo: number; localBars: number; pbNear: number };
  sessions: number;
  trainSessions: number;
  testSessions: number;
  all: Stats;
  train: Stats;
  test: Stats;
  bySetup: { reversal: Stats; pullback: Stats };
};

type Payload = {
  ok: boolean;
  status?: string;
  message?: string;
  generatedAt?: string;
  session?: string;
  sessions?: number;
  trainSessions?: number;
  testSessions?: number;
  splitDate?: string;
  costPts?: number;
  holdBars?: number;
  walkForward?: {
    trainBest: string;
    trainNetPts: number;
    testNetPts: number;
    testTrades: number;
    testWinRate: number;
    testProfitFactor: number;
  } | null;
  results?: ConfigResult[];
};

const fmt = (n: number, dp = 1) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—");
const pf = (n: number) => (n === Infinity ? "∞" : Number.isFinite(n) ? n.toFixed(2) : "—");

export default function BacktestPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/backtest", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  const rows = useMemo(() => {
    if (!data?.results) return [];
    return [...data.results].sort((a, b) => b.train.netPts - a.train.netPts);
  }, [data]);

  const best = rows[0];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-200 p-6 md:p-10 font-mono">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-xl font-bold text-zinc-50">Backtest · walk-forward threshold sweep</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Replays the reversal + pullback signal bar-by-bar over the collected footprint sessions and scores each fire
          forward (target vs stop). Round-trip cost {data?.costPts ?? 0.5} pt, max hold {data?.holdBars ?? 60} bars.
          Split: train &lt; {data?.splitDate ?? "2026-01-01"}, test ≥ that date.
        </p>

        {err && <p className="text-red-400 text-xs mt-4">{err}</p>}
        {!data && !err && <p className="text-zinc-500 text-xs mt-4">loading…</p>}
        {data && !data.ok && (
          <p className="text-amber-400 text-xs mt-4">
            {data.message ?? "sweep not run"} — run <code className="text-zinc-300">node --import ../scripts/ts-loader.mjs ./db/backtest.ts</code> from <code className="text-zinc-300">web/</code>.
          </p>
        )}

        {data?.results && (
          <>
            <div className="flex flex-wrap gap-4 mt-4 text-[11px] text-zinc-400">
              <span>session: <b className="text-zinc-200">{data.session}</b></span>
              <span>train: <b className="text-zinc-200">{data.trainSessions}</b> · test: <b className="text-zinc-200">{data.testSessions}</b></span>
              <span>generated: <b className="text-zinc-200">{data.generatedAt}</b></span>
              {data.sessions && data.sessions < 600 && (
                <span className="text-amber-400">partial run — full sweep still finishing</span>
              )}
            </div>

            {data.walkForward && (
              <div className="mt-4 rounded border border-emerald-900/70 bg-emerald-950/20 px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider text-emerald-400">walk-forward (honest out-of-sample)</div>
                <div className="text-base font-bold text-emerald-300">
                  best on train: <span className="text-zinc-100">{data.walkForward.trainBest}</span> ({fmt(data.walkForward.trainNetPts)} pts)
                </div>
                <div className="text-sm text-emerald-200 mt-1">
                  → out-of-sample test: {fmt(data.walkForward.testNetPts)} pts · {data.walkForward.testTrades} trades · {Math.round(data.walkForward.testWinRate * 100)}% win · PF {pf(data.walkForward.testProfitFactor)}
                </div>
              </div>
            )}

            <div className="overflow-x-auto mt-6 rounded border border-zinc-800">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="text-left text-zinc-400 border-b border-zinc-800">
                    <th className="px-2 py-2 font-semibold">config</th>
                    <th className="px-2 py-2 font-semibold">floor</th>
                    <th className="px-2 py-2 font-semibold">dom</th>
                    <th className="px-2 py-2 font-semibold">pos</th>
                    <th className="px-2 py-2 font-semibold">pbNear</th>
                    <th className="px-2 py-2 font-semibold text-right" colSpan={3}>train (2023–25)</th>
                    <th className="px-2 py-2 font-semibold text-right" colSpan={3}>test (2026)</th>
                  </tr>
                  <tr className="text-left text-zinc-500 border-b border-zinc-800">
                    <th className="px-2 py-1" colSpan={5}></th>
                    <th className="px-2 py-1 text-right">trades</th>
                    <th className="px-2 py-1 text-right">win%</th>
                    <th className="px-2 py-1 text-right">net pts</th>
                    <th className="px-2 py-1 text-right">trades</th>
                    <th className="px-2 py-1 text-right">win%</th>
                    <th className="px-2 py-1 text-right">net pts</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.config.name} className={`border-b border-zinc-800/50 ${r === best ? "bg-emerald-950/20" : ""}`}>
                      <td className="px-2 py-1.5 text-zinc-100">{r.config.name}{r === best ? " ★" : ""}</td>
                      <td className="px-2 py-1.5">{r.config.floor}</td>
                      <td className="px-2 py-1.5">{r.config.dom}</td>
                      <td className="px-2 py-1.5">{r.config.posHi}/{r.config.posLo}</td>
                      <td className="px-2 py-1.5">{r.config.pbNear}</td>
                      <td className="px-2 py-1.5 text-right">{r.train.trades}</td>
                      <td className="px-2 py-1.5 text-right">{Math.round(r.train.winRate * 100)}%</td>
                      <td className="px-2 py-1.5 text-right font-semibold text-zinc-100">{fmt(r.train.netPts)}</td>
                      <td className="px-2 py-1.5 text-right">{r.test.trades}</td>
                      <td className="px-2 py-1.5 text-right">{Math.round(r.test.winRate * 100)}%</td>
                      <td className="px-2 py-1.5 text-right text-emerald-300">{fmt(r.test.netPts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] text-zinc-600 mt-4 leading-relaxed">
              Caveats: (1) the location profile is the session's own full-day aggregate, so it sees levels formed later in the
              day — absolute P&L is optimistic; (2) the config is selected on TRAIN only, so the <b>test column is the honest
              number</b> — a config whose test column is green generalizes, a red one overfit the train window.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
