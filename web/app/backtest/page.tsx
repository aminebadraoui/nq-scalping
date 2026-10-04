"use client";

import { useEffect, useMemo, useState } from "react";

type Stats = {
  trades: number;
  wins: number;
  winRate: number;
  netPts: number;
  profitFactor: number;
  avgPts: number;
  /** divergence-fuel split (present when the sweep was run with the div store) */
  withDiv?: FuelSplit;
  withoutDiv?: FuelSplit;
};

type FuelSplit = { trades: number; wins: number; winRate: number; netPts: number; profitFactor: number };

type ConfigResult = {
  config: { name: string; floor: number; dom: number; posHi: number; posLo: number; localBars: number; pbNear: number };
  sessions: number;
  trainSessions: number;
  testSessions: number;
  all: Stats;
  train: Stats;
  test: Stats;
  bySetup: { reversal: Stats; pullback: Stats };
  byYear: { year: string; stats: Stats }[];
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

type VReport = {
  family: string;
  sweep: string;
  costPts: number;
  nConfigs: number;
  nSessions: number;
  nEffectiveTrials: number;
  pick: {
    id: string;
    params: { s: number; t: number; x: number };
    totals: { n: number; wins: number; wr: number; netPts: number; netUsd: number; riskPts: number; riskUsd: number };
    perYear: Record<string, { netUsd: number; netPts: number; trades: number; wins: number; sessions: number; wr: number | null }>;
    concentration: { top10SessionShare: number; sessionsForHalfNet: number | null; nPositiveSessions: number };
  };
  statistics: {
    observedSharpe: number;
    trialSharpeMean: number;
    trialSharpeMax: number;
    varSharpe: number;
    nTrialsRaw: number;
    nTrialsEffective: number;
    deflatedBenchmark: number;
    dsr: number;
    psr: number;
    minTrackRecordSessions: number;
    minBacktestYears: number;
    skew: number;
    kurtosis: number;
    pbo: { pbo: number; slope: number; nCombos: number; nSplits: number };
  };
  verdict: string[];
  nSessionsFull: number;
  holdout: {
    sessions: number;
    from: string;
    to: string;
    pickId: string;
    n: number;
    wins: number;
    wr: number | null;
    netUsd: number;
    netPts: number;
    riskUsd: number;
    sharpe: number;
  } | null;
  digest: {
    heatmap: { x: number; stops: number[]; targets: number[]; values: (number | null)[][] };
    topConfigs: ({ id: string; params: { s: number; t: number; x: number }; sharpe: number; n: number; wins: number; wr: number; netUsd: number })[];
    pickSeries: { date: string; netUsd: number; riskUsd: number }[];
  };
};

type VPayload = {
  ok: boolean;
  message?: string;
  reports?: VReport[];
  ledger?: { entries: { family: string; generatedAt: string; file: string; nConfigs: number; nSessions: number; costPts: number; validation?: { pick: string; dsr: number; pbo: number; slope: number; observedSharpe: number; nEffectiveTrials: number; verdict: string[] } }[] };
};

export default function BacktestPage() {
  const [session, setSession] = useState<"rth" | "eth">("rth");
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [validation, setValidation] = useState<VPayload | null>(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    fetch(`/api/backtest?session=${session}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, [session]);

  useEffect(() => {
    fetch("/api/backtest/validation", { cache: "no-store" })
      .then((r) => r.json())
      .then(setValidation)
      .catch(() => setValidation({ ok: false, message: "validation endpoint unreachable" }));
  }, []);

  const rows = useMemo(() => {
    if (!data?.results) return [];
    return [...data.results].sort((a, b) => b.train.netPts - a.train.netPts);
  }, [data]);

  const best = rows[0];

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-200 p-6 md:p-10 font-mono">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-zinc-50">Backtest · walk-forward threshold sweep</h1>
          <div className="flex gap-1 text-xs">
            {(["rth", "eth"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSession(s)}
                className={`px-3 py-1 rounded border ${session === s ? "border-emerald-700 bg-emerald-950/40 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:text-zinc-200"}`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-zinc-500 mt-1">
          Replays the reversal + pullback signal bar-by-bar over the collected footprint sessions and scores each fire
          forward (target vs stop). Round-trip cost {data?.costPts ?? 0.5} pt, max hold {data?.holdBars ?? 60} bars.
          Split: train &lt; {data?.splitDate ?? "2026-01-01"}, test ≥ that date. Click a row for the per-year breakdown.
        </p>

        {err && <p className="text-red-400 text-xs mt-4">{err}</p>}
        {!data && !err && <p className="text-zinc-500 text-xs mt-4">loading…</p>}
        {data && !data.ok && (
          <p className="text-amber-400 text-xs mt-4">
            {data.message ?? "sweep not run"} — run <code className="text-zinc-300">BT_SESSION={session} node --import ../scripts/ts-loader.mjs ./db/backtest.ts</code> from <code className="text-zinc-300">web/</code>.
          </p>
        )}

        {data?.results && (
          <>
            <div className="flex flex-wrap gap-4 mt-4 text-[11px] text-zinc-400">
              <span>session: <b className="text-zinc-200">{data.session ?? session}</b></span>
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
                    <th className="px-2 py-2 font-semibold text-right" colSpan={3}>train</th>
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
                    <Row key={r.config.name} r={r} best={r === best} expanded={expanded === r.config.name} onToggle={() => setExpanded(expanded === r.config.name ? null : r.config.name)} />
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] text-zinc-600 mt-4 leading-relaxed">
              Caveats: (1) the location profile is the session's own full-day aggregate, so it sees levels formed later in the
              day — absolute P&L is optimistic; (2) the config is selected on TRAIN only, so the <b>test column is the honest
              number</b> — green generalizes, red overfit. The per-year row shows whether the winner is stable across regimes.
            </p>
          </>
        )}

        <section className="mt-12 border-t border-zinc-800 pt-6">
          <h2 className="text-lg font-bold text-zinc-50">Overfitting audit · DSR / PBO / CPCV</h2>
          <p className="text-xs text-zinc-500 mt-1">
            gcdata/validate_sweep.py over web/scripts/exportSweep.ts grids (all 649 sessions, measured cost).
            DSR = deflated Sharpe (multiple-testing corrected) · PBO = probability the in-sample best underperforms the OOS
            median · slope only matters when PBO is high (stable selection makes it mechanical). Sweep explorer:
            <code className="text-zinc-300"> ./.venv/bin/optuna-dashboard sqlite:///gcdata/data/optuna/&lt;family&gt;.db</code>
          </p>
          {validation && !validation.ok && (
            <p className="text-amber-400 text-xs mt-3">
              {validation.message ?? "no reports"} — run <code className="text-zinc-300">exportSweep.ts</code> then{" "}
              <code className="text-zinc-300">validate_sweep.py</code> from gcdata/.
            </p>
          )}
          {!validation && <p className="text-zinc-500 text-xs mt-3">loading…</p>}
          {validation?.reports?.map((r) => (
            <ReportCard key={`${r.family}-${r.sweep}`} r={r} />
          ))}
          {validation?.ledger && <LedgerTable ledger={validation.ledger} />}
        </section>
      </div>
    </main>
  );
}

function Row({ r, best, expanded, onToggle }: { r: ConfigResult; best: boolean; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className={`border-b border-zinc-800/50 cursor-pointer hover:bg-zinc-900/40 ${best ? "bg-emerald-950/20" : ""}`}>
        <td className="px-2 py-1.5 text-zinc-100">{r.config.name}{best ? " ★" : ""}{expanded ? " ▾" : " ▸"}</td>
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
      {expanded && (
        <tr className="border-b border-zinc-800/50 bg-zinc-900/30">
          <td colSpan={11} className="px-3 py-2">
            <div className="flex flex-wrap gap-3 text-[11px] text-zinc-400">
              <span className="text-zinc-500">per-year net pts:</span>
              {(r.byYear ?? []).map((y) => (
                <span key={y.year} className={y.stats.netPts >= 0 ? "text-zinc-300" : "text-red-400"}>
                  <b>{y.year}</b>: {fmt(y.stats.netPts)} ({y.stats.trades}t, {Math.round(y.stats.winRate * 100)}%)
                </span>
              ))}
            </div>
            {r.train.withDiv && r.test.withDiv && (
              <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-zinc-400">
                <span className="text-zinc-500">divergence fuel (matching D2/D4 ≤10 bars before entry):</span>
                <Fuel label="train with" s={r.train.withDiv} against={r.train.withoutDiv} />
                <Fuel label="train without" s={r.train.withoutDiv} against={r.train.withDiv} />
                <Fuel label="test with" s={r.test.withDiv} against={r.test.withoutDiv} />
                <Fuel label="test without" s={r.test.withoutDiv} against={r.test.withDiv} />
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* ---------------- overfitting-audit section ---------------- */

/** one divergence-fuel cohort, colored by whether it beats its counterpart */
function Fuel({ label, s, against }: { label: string; s?: FuelSplit; against?: FuelSplit }) {
  if (!s || !against) return null;
  const better = s.winRate > against.winRate + 0.001;
  const worse = s.winRate < against.winRate - 0.001;
  const tone = better ? "text-emerald-300" : worse ? "text-red-300" : "text-zinc-300";
  return (
    <span className={tone} title={`net ${fmt(s.netPts)} pts · PF ${pf(s.profitFactor)}`}>
      {label}: <b>{Math.round(s.winRate * 100)}%</b> ({s.trades}t · net {fmt(s.netPts)})
    </span>
  );
}

function verdictTone(flag: string): string {
  const f = flag.toLowerCase();
  if (/weak|short|unstable|<= 0/.test(f)) return "border-red-900/70 bg-red-950/30 text-red-300";
  if (/moderate|high/.test(f)) return "border-amber-900/70 bg-amber-950/30 text-amber-300";
  return "border-emerald-900/70 bg-emerald-950/30 text-emerald-300";
}

function ReportCard({ r }: { r: VReport }) {
  const s = r.statistics;
  const hm = r.digest.heatmap;
  const maxAbs = Math.max(...hm.values.flat().map((v) => Math.abs(v ?? 0)), 1e-9);
  const series = r.digest.pickSeries;
  const cum: number[] = [];
  let acc = 0;
  for (const p of series) {
    acc += p.netUsd;
    cum.push(acc);
  }
  const eqMax = Math.max(...cum.map(Math.abs), 1e-9);
  const poly = cum.map((v, i) => `${(i / (cum.length - 1)) * 640},${48 - (v / eqMax) * 44}`).join(" ");
  const holdoutIdx = r.holdout ? series.findIndex((p) => p.date >= r.holdout!.from) : -1;
  const holdoutX = holdoutIdx > 0 ? (holdoutIdx / (cum.length - 1)) * 640 : null;

  return (
    <div className="mt-6 rounded border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="text-base font-bold text-zinc-100 uppercase">{r.family}</h3>
          <span className="text-[11px] text-zinc-500">{r.sweep}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {r.verdict.map((f) => (
            <span key={f} className={`px-2 py-0.5 rounded border text-[10px] ${verdictTone(f)}`}>{f}</span>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3 mt-4 text-[11px]">
        <StatBox label="pick" value={r.pick.id} sub={`s${r.pick.params.s} · t${r.pick.params.t} · x${r.pick.params.x}`} />
        <StatBox label="DSR" value={s.dsr.toFixed(3)} sub={`deflated bench ${s.deflatedBenchmark.toFixed(3)} vs observed ${s.observedSharpe.toFixed(3)}`} tone={s.dsr >= 0.95 ? "good" : s.dsr >= 0.8 ? "warn" : "bad"} />
        <StatBox label="PBO" value={s.pbo.pbo.toFixed(3)} sub={`${s.pbo.nCombos.toLocaleString()} CSCV combos · slope ${s.pbo.slope >= 0 ? "+" : ""}${s.pbo.slope.toFixed(2)}`} tone={s.pbo.pbo <= 0.2 ? "good" : s.pbo.pbo <= 0.4 ? "warn" : "bad"} />
        <StatBox
          label="PSR / MinTRL"
          value={`${s.psr.toFixed(3)} / ${Math.round(s.minTrackRecordSessions)}`}
          sub={`need ${Math.round(s.minTrackRecordSessions)} sessions, have ${r.nSessions}${r.holdout ? " (pre-holdout)" : ""} · MinBTL ${s.minBacktestYears.toFixed(1)}y @SR1`}
          tone={s.psr >= 0.95 ? "good" : "warn"}
        />
        <StatBox label="trials" value={`${s.nTrialsEffective} / ${s.nTrialsRaw}`} sub="effective independent / raw configs" />
        <StatBox label="trials Sharpe" value={`${s.trialSharpeMean.toFixed(3)} mean · ${s.trialSharpeMax.toFixed(3)} max`} sub={`var ${s.varSharpe.toFixed(4)} · per-session return-on-risk`} />
        <StatBox
          label="concentration"
          value={`${(r.pick.concentration.top10SessionShare * 100).toFixed(1)}%`}
          sub={`top-10 sessions of net · ${r.pick.concentration.sessionsForHalfNet ?? "—"} sessions hold 50%`}
          tone={r.pick.concentration.top10SessionShare <= 0.15 ? "good" : r.pick.concentration.top10SessionShare <= 0.3 ? "warn" : "bad"}
        />
        <StatBox label="trades / WR" value={`${r.pick.totals.n.toLocaleString()} / ${(r.pick.totals.wr * 100).toFixed(1)}%`} sub={`net ${r.pick.totals.netUsd.toLocaleString()}$ at 1 MNQ · pre-holdout · cost ${r.costPts}pt`} />
        {r.holdout && (
          <StatBox
            label="frozen holdout"
            value={`${r.holdout.netUsd >= 0 ? "+" : ""}${r.holdout.netUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}$ · WR ${r.holdout.wr === null ? "—" : `${(r.holdout.wr * 100).toFixed(0)}%`}`}
            sub={`${r.holdout.sessions} sessions ${r.holdout.from}→${r.holdout.to} · ${r.holdout.n} trades · Sharpe ${r.holdout.sharpe.toFixed(2)}`}
            tone={r.holdout.netUsd >= 0 ? "good" : "bad"}
          />
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Sharpe heatmap · stop × target @ x{hm.x}</div>
          <div className="inline-block">
            <div className="flex">
              <div className="w-10" />
              {hm.targets.map((t) => (
                <div key={t} className="w-14 text-center text-[9px] text-zinc-500">t{t}</div>
              ))}
            </div>
            {hm.stops.map((st, i) => (
              <div key={st} className="flex">
                <div className="w-10 text-right pr-1 text-[9px] text-zinc-500 leading-8">s{st}</div>
                {hm.targets.map((t, j) => {
                  const v = hm.values[i][j];
                  const a = v === null ? 0.04 : 0.12 + 0.85 * (Math.abs(v!) / maxAbs);
                  const color = v === null ? "rgb(63 63 70)" : v! >= 0 ? `rgba(16,185,129,${a.toFixed(2)})` : `rgba(239,68,68,${a.toFixed(2)})`;
                  return (
                    <div
                      key={t}
                      title={`s${st} t${t}: ${v === null ? "—" : v.toFixed(3)}`}
                      className="w-14 h-8 border border-zinc-900 text-center text-[9px] leading-8 text-zinc-200/90"
                      style={{ backgroundColor: color }}
                    >
                      {v === null ? "" : v.toFixed(2)}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="text-[9px] text-zinc-600 mt-1">per-session return-on-risk Sharpe; a spiky peak = fitted noise, a flat plateau = robust.</p>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">pick equity (1 MNQ, per-session net $)</div>
          <svg viewBox="0 0 640 96" className="w-full h-28 border border-zinc-800 rounded bg-zinc-950/60">
            <line x1={0} y1={48} x2={640} y2={48} stroke="rgb(63 63 70)" strokeWidth={1} />
            {holdoutX !== null && (
              <>
                <rect x={holdoutX} y={0} width={640 - holdoutX} height={96} fill="rgba(250,204,21,0.07)" />
                <line x1={holdoutX} y1={0} x2={holdoutX} y2={96} stroke="rgb(250 204 21)" strokeWidth={1} strokeDasharray="3 2" />
              </>
            )}
            <polyline points={poly} fill="none" stroke="rgb(16 185 129)" strokeWidth={1.5} />
          </svg>
          <p className="text-[9px] text-zinc-600 mt-1">
            {series[0]?.date} → {series[series.length - 1]?.date} · cumulative ${acc.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            {holdoutX !== null && <span className="text-amber-400/80"> · yellow = frozen holdout (never used for selection)</span>}
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-zinc-800">
                <th className="px-2 py-1.5">year</th>
                <th className="px-2 py-1.5 text-right">net $</th>
                <th className="px-2 py-1.5 text-right">trades</th>
                <th className="px-2 py-1.5 text-right">WR</th>
                <th className="px-2 py-1.5 text-right">sessions</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(r.pick.perYear).map(([y, b]) => (
                <tr key={y} className="border-b border-zinc-800/50">
                  <td className="px-2 py-1 text-zinc-100">{y}</td>
                  <td className={`px-2 py-1 text-right ${b.netUsd >= 0 ? "text-emerald-300" : "text-red-400"}`}>{fmt(b.netUsd, 0)}</td>
                  <td className="px-2 py-1 text-right">{b.trades}</td>
                  <td className="px-2 py-1 text-right">{b.wr === null ? "—" : `${(b.wr * 100).toFixed(1)}%`}</td>
                  <td className="px-2 py-1 text-right">{b.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded border border-zinc-800">
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="text-left text-zinc-400 border-b border-zinc-800">
                <th className="px-2 py-1.5">top configs by Sharpe</th>
                <th className="px-2 py-1.5 text-right">sharpe</th>
                <th className="px-2 py-1.5 text-right">n</th>
                <th className="px-2 py-1.5 text-right">WR</th>
                <th className="px-2 py-1.5 text-right">net $</th>
              </tr>
            </thead>
            <tbody>
              {r.digest.topConfigs.slice(0, 10).map((c) => (
                <tr key={c.id} className={`border-b border-zinc-800/50 ${c.id === r.pick.id ? "bg-emerald-950/20" : ""}`}>
                  <td className="px-2 py-1 text-zinc-100">{c.id}{c.id === r.pick.id ? " ★" : ""}</td>
                  <td className="px-2 py-1 text-right">{c.sharpe.toFixed(3)}</td>
                  <td className="px-2 py-1 text-right">{c.n}</td>
                  <td className="px-2 py-1 text-right">{(c.wr * 100).toFixed(1)}%</td>
                  <td className="px-2 py-1 text-right">{fmt(c.netUsd, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "good" | "warn" | "bad" }) {
  const toneCls = tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-sm font-bold ${toneCls}`}>{value}</div>
      <div className="text-[9px] text-zinc-500">{sub}</div>
    </div>
  );
}

function LedgerTable({ ledger }: { ledger: NonNullable<VPayload["ledger"]> }) {
  const entries = [...(ledger.entries ?? [])].reverse();
  return (
    <div className="mt-6">
      <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Trial ledger · every config ever tried</h4>
      <div className="overflow-x-auto mt-2 rounded border border-zinc-800">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="text-left text-zinc-400 border-b border-zinc-800">
              <th className="px-2 py-1.5">family</th>
              <th className="px-2 py-1.5">file</th>
              <th className="px-2 py-1.5 text-right">configs</th>
              <th className="px-2 py-1.5 text-right">sessions</th>
              <th className="px-2 py-1.5 text-right">cost</th>
              <th className="px-2 py-1.5">validation</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.file} className="border-b border-zinc-800/50">
                <td className="px-2 py-1 text-zinc-100 uppercase">{e.family}</td>
                <td className="px-2 py-1 text-zinc-400">{e.file}</td>
                <td className="px-2 py-1 text-right">{e.nConfigs}</td>
                <td className="px-2 py-1 text-right">{e.nSessions}</td>
                <td className="px-2 py-1 text-right">{e.costPts}</td>
                <td className="px-2 py-1">
                  {e.validation ? (
                    <span className="text-zinc-300">
                      {e.validation.pick} · DSR {e.validation.dsr.toFixed(3)} · PBO {e.validation.pbo.toFixed(3)}
                    </span>
                  ) : (
                    <span className="text-zinc-600">not validated</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
