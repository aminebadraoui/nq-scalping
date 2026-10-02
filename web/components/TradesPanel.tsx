"use client";

import { useEffect, useRef, useState } from "react";

type TradeRow = {
  signal_key: string;
  day: string;
  time_et: string;
  ts: string;
  side: "long" | "short";
  contracts: number;
  verdict: string;
  headline: string;
  status: "matched" | "unexecuted" | "partial";
  fill_entry: number | null;
  exit_avg: number | null;
  sig_entry: number | null;
  gross_pts: number;
  gross_usd: number;
  commissions: number;
  net_usd: number;
  result: "win" | "loss" | "flat" | "";
  family: string;
  hour_bucket: string;
  first_of_day: boolean;
  entry_adverse_pts: number | null;
  held_min: number | null;
  mfe_pts: number | null;
  mae_pts: number | null;
  target_reached: boolean;
  recovered: boolean;
  stop_run: boolean;
  loss_label: string;
};

type StatRow = {
  group: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossUsd: number;
  netUsd: number;
  commissions: number;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  expectancyUsd: number | null;
  stopRuns: number;
  stopRunRate: number | null;
  avgEntryAdversePts: number | null;
  avgMfePts: number | null;
  avgMaePts: number | null;
};

type Analysis = {
  run_at: string;
  trades_n: number;
  summary: { stats: StatRow[] };
};

type RunRow = {
  run_at: string;
  signals_total: number;
  matched: number;
  unexecuted: number;
  manual_fills: number;
  manual_gross_usd: number;
  signals_gross_usd: number;
  account_realized: number | null;
  account_net: number | null;
  notes: string;
};

type TradesResponse = {
  ok: boolean;
  runs: RunRow[];
  trades: TradeRow[];
  analysis: Analysis | null;
};

const SIDE_STYLE: Record<TradeRow["side"], string> = {
  long: "border-long/50 bg-long/10 text-long",
  short: "border-short/50 bg-short/10 text-short",
};

const RESULT_STYLE: Record<string, string> = {
  win: "text-long",
  loss: "text-short",
  flat: "text-zinc-500",
};

const FAMILY_LABEL: Record<string, string> = {
  momentum_flush: "MOM·flush",
  momentum_expansion: "MOM·expansion",
  rth: "RTH",
  open_drive: "OPEN DRIVE",
  open_pullback: "OPEN PULL",
  open_sniper: "SNIPER",
  sweep_reclaim: "SWEEP-RECLAIM",
  other: "OTHER",
};

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = Math.round(n);
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US")}`;
}

function fmtPts(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = n;
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
}

export default function TradesPanel() {
  const [run, setRun] = useState<RunRow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/trades")
        .then((r) => r.json())
        .then((j: TradesResponse) => {
          if (cancelled || !j.ok) return;
          setRun(j.runs?.[0] ?? null);
          setTrades(j.trades ?? []);
          setAnalysis(j.analysis ?? null);
          setLoaded(true);
        })
        .catch(() => {});
    };
    tick();
    timerRef.current = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const overall = analysis?.summary.stats.find((s) => s.group === "overall") ?? null;
  const familyStats = (analysis?.summary.stats ?? []).filter((s) => s.group === "family" && s.n > 0);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Trades — reconciled</h2>
        {run && (
          <span className="font-mono text-[10px] text-zinc-500">
            matched {run.matched}/{run.signals_total} · {run.unexecuted} no-fill · account {fmtUsd(run.account_realized)}
          </span>
        )}
      </div>

      {/* win/loss analysis header */}
      {overall && overall.n > 0 && (
        <div className="mb-2 grid grid-cols-3 gap-1 sm:grid-cols-6">
          {[
            { k: "trades", v: `${overall.wins}W/${overall.losses}L` },
            { k: "win rate", v: overall.winRate === null ? "—" : `${(overall.winRate * 100).toFixed(0)}%` },
            { k: "PF", v: overall.profitFactor === null ? "—" : overall.profitFactor === Infinity ? "∞" : overall.profitFactor.toFixed(2) },
            { k: "expectancy", v: fmtUsd(overall.expectancyUsd) },
            { k: "stop-runs", v: `${overall.stopRuns}/${overall.losses}` },
            { k: "net", v: fmtUsd(overall.netUsd) },
          ].map((c) => (
            <div key={c.k} className="rounded border border-zinc-800/70 px-1.5 py-1 text-center">
              <div className="font-mono text-[8px] uppercase tracking-wider text-zinc-600">{c.k}</div>
              <div className="font-mono text-[11px] font-semibold text-zinc-200">{c.v}</div>
            </div>
          ))}
        </div>
      )}

      {familyStats.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {familyStats.map((f) => (
            <div key={f.label} className="flex items-center justify-between font-mono text-[9px] text-zinc-500">
              <span className="uppercase">{FAMILY_LABEL[f.label] ?? f.label}</span>
              <span>
                {f.wins}W/{f.losses}L ·{" "}
                {f.winRate === null ? "—" : `${(f.winRate * 100).toFixed(0)}%`} · PF{" "}
                {f.profitFactor === null ? "—" : f.profitFactor === Infinity ? "∞" : f.profitFactor.toFixed(2)} ·{" "}
                {fmtUsd(f.netUsd)}
                {f.stopRuns > 0 ? ` · ${f.stopRuns} stop-runs` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="mb-2 font-mono text-[10px] leading-snug text-zinc-500">
        every trade card joined with its CrossTrade fills + execution anatomy (MFE/MAE from minute bars) — most recent first
      </p>

      {run?.notes && <p className="mb-2 font-mono text-[10px] text-warn">{run.notes}</p>}

      {loaded && trades.length === 0 && (
        <p className="font-mono text-xs text-zinc-600">no reconciled trades yet — run scripts/reconcileTrades.ts</p>
      )}

      <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
        {[...trades].reverse().map((t) => (
          <div key={t.signal_key} className="rounded border border-zinc-800/70 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="text-zinc-400">
                {t.day} {t.time_et || "—"} NY · {t.contracts} MNQ · {FAMILY_LABEL[t.family] ?? t.family}
              </span>
              <span className="flex items-center gap-1.5">
                {t.status !== "matched" && (
                  <span className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 text-[9px] text-warn">no fill</span>
                )}
                {t.stop_run && (
                  <span className="rounded border border-short/50 bg-short/10 px-1 py-0.5 text-[9px] text-short">⛔ stop-run</span>
                )}
                {t.target_reached && (
                  <span className="rounded border border-info/40 bg-info/10 px-1 py-0.5 text-[9px] text-info">🎯 target</span>
                )}
                <span className={`rounded border px-1 py-0.5 text-[9px] font-semibold ${SIDE_STYLE[t.side]}`}>
                  {t.side.toUpperCase()}
                </span>
              </span>
            </div>

            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="font-mono text-[13px] font-semibold text-zinc-100">
                {t.status === "matched" && t.fill_entry != null && t.exit_avg != null ? (
                  <>
                    {fmt(t.fill_entry)} → {fmt(t.exit_avg)}
                  </>
                ) : (
                  <>signal {fmt(Number(t.sig_entry))}</>
                )}
              </span>
              <span className={`break-words text-right font-mono text-[10px] leading-snug ${t.result ? RESULT_STYLE[t.result] : "text-zinc-500"}`}>
                {t.result ? `${t.result} ${fmtUsd(Number(t.gross_usd))} gross · ${fmtUsd(Number(t.net_usd))} net` : "not executed"}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 font-mono text-[9px] leading-snug text-zinc-500">
              <span className="break-words">{t.verdict}</span>
              {t.status === "matched" && (
                <span className="whitespace-nowrap">
                  drift {fmtPts(Number(t.entry_adverse_pts))} · MFE {fmtPts(Number(t.mfe_pts))} · MAE {fmtPts(Number(t.mae_pts))}
                  {t.recovered ? " · ↩ recovered" : ""}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
