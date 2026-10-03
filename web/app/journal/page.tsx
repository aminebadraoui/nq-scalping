"use client";

import { useEffect, useRef, useState } from "react";
import { familyName } from "@/lib/familyNames";
import { type StreakRow, type DrawdownRow, type HourCell, type HourRow } from "@/lib/journalMetrics";

/* ------------------------------------------------------------------ *
 * Trade journal — the dedicated surface for the self-improving loop:
 * every traded signal, its execution anatomy, the win/loss aggregates,
 * the AI strategy review, and the proposal → gate → live-feed loop.
 * Data: /api/trades (reconciliation + analysis) and /api/insights
 * (mined findings + overrides). Read-only unless you approve a gate.
 * ------------------------------------------------------------------ */

type TradeRow = {
  signal_key: string;
  day: string;
  time_et: string;
  side: "long" | "short";
  contracts: number;
  verdict: string;
  status: "matched" | "unexecuted" | "partial";
  sig_entry: number | null;
  sig_stop: number | null;
  sig_target: number | null;
  fill_entry: number | null;
  exit_avg: number | null;
  gross_usd: number;
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
  manual_gross_usd: number;
  signals_gross_usd: number;
  account_realized: number | null;
  account_net: number | null;
  notes: string;
};

type ScoreRow = {
  family: string;
  signals: number;
  fills: number;
  skips: number;
  days: number;
  wins: number;
  losses: number;
  netUsd: number;
  liveExpR: number | null;
  baselineExpR: number;
  status: "ok" | "watch" | "breach" | "insufficient";
  detail: string;
};

type Insight = {
  id: string;
  run_at: string;
  strategy: string;
  kind: "rule_proposal" | "observation" | "execution" | "narrative";
  severity: "info" | "warn" | "opportunity";
  title: string;
  finding: string;
  evidence: Record<string, unknown>;
  proposedAction: { family: string; gate: string; value: unknown; note: string } | null;
  auto_apply: boolean;
  status: "proposed" | "applied" | "rejected" | "superseded";
  source: string;
};

type Headline = {
  netUsd: number;
  grossUsd: number;
  commissions: number;
  matched: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  expectancy: number | null;
  bestDayNet: number | null;
  worstDayNet: number | null;
};

type DayRow = {
  day: string;
  n: number;
  wins: number;
  losses: number;
  grossUsd: number;
  netUsd: number;
  commissions: number;
};

type EquityPoint = { at: string; net: number; realized: number | null };

type Override = {
  id: string;
  created_at: string;
  family: string;
  gate: string;
  value: unknown;
  active: boolean;
  note: string;
  insight_title: string | null;
};

// the ONE naming scheme — every surface shows the same strategy names
// (lib/familyNames.ts, shared with the AI review and the metric tables)

const HOUR_LABEL: Record<string, string> = {
  globex_early: "18–21",
  globex_core: "21–00",
  globex_late: "00–03",
  globex_dawn: "03–06",
  premkt: "06–09:30",
  rth: "09:30–16",
  close: "16–18",
};

const SEV_STYLE: Record<Insight["severity"], string> = {
  info: "border-info/40 bg-info/10 text-info",
  warn: "border-warn/50 bg-warn/10 text-warn",
  opportunity: "border-long/50 bg-long/10 text-long",
};

const STATUS_STYLE: Record<string, string> = {
  proposed: "border-info/40 bg-info/10 text-info",
  applied: "border-long/50 bg-long/10 text-long",
  rejected: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
  superseded: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
};

const EDGE_STYLE: Record<string, string> = {
  ok: "border-long/50 bg-long/10 text-long",
  watch: "border-warn/50 bg-warn/10 text-warn",
  breach: "border-short/50 bg-short/10 text-short",
  insufficient: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
};

// Edge-monitor verdicts, in trading English. NOTE: these compare LIVE
// expectancy to the replay baseline only — "edge lost" says nothing about
// the MFF account or its guard; the account guard lives in /api/gc health.
const EDGE_LABEL: Record<string, string> = {
  ok: "edge OK",
  watch: "edge weak",
  breach: "edge lost",
  insufficient: "no data",
};

const EDGE_HINT: Record<string, string> = {
  ok: "live expR ≥ half the replay baseline",
  watch: "live expR below half the replay baseline",
  breach: "live expR ≤ 0 — the live sample is losing. Compares live vs replay ONLY; NOT an account breach.",
  insufficient: "fewer than 8 live fills — too early to judge",
};

const RESULT_STYLE: Record<string, string> = {
  win: "text-long",
  loss: "text-short",
  flat: "text-zinc-500",
};

const fmtUsd = (n: number | null) => {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = Math.round(n);
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US")}`;
};
const fmtPts = (n: number | null) => {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
};
const fmtPx = (n: number | null) => (n === null || !Number.isFinite(n) ? "—" : n.toFixed(2));
/** points + ticks: MNQ tick = 0.25 pt → 4 ticks per point */
const ptsTicks = (pts: number | null) => {
  if (pts === null || !Number.isFinite(pts)) return "—";
  return `${pts.toFixed(1)}p (${Math.round(pts * 4)}t)`;
};
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const pf = (n: number | null) => (n === null ? "—" : n === Infinity ? "∞" : n.toFixed(2));

function renderBold(s: string): React.ReactNode {
  const parts = s.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : p));
}

function Narrative({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-0.5 font-mono text-[12px] leading-relaxed text-zinc-300">
      {lines.map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} className="h-2" />;
        if (t.startsWith("### ")) return <h4 key={i} className="pt-2 text-[13px] font-bold text-zinc-100">{renderBold(t.slice(4))}</h4>;
        if (t.startsWith("## ")) return <h3 key={i} className="pt-3 text-[14px] font-bold text-long">{renderBold(t.slice(3))}</h3>;
        if (t.startsWith("# ")) return <h3 key={i} className="pt-2 text-[15px] font-bold text-zinc-50">{renderBold(t.slice(2))}</h3>;
        if (t.startsWith("- ")) return <div key={i} className="pl-3 text-zinc-400"><span className="text-zinc-600">· </span>{renderBold(t.slice(2))}</div>;
        return <div key={i}>{renderBold(line)}</div>;
      })}
    </div>
  );
}

function StatsTable({ rows, compact = false }: { rows: StatRow[]; compact?: boolean }) {
  const show = rows.filter((s) => s.n > 0);
  if (!show.length) return <p className="py-2 font-mono text-xs text-zinc-600">no data in this range</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="border-b border-zinc-800 py-1 pr-2 font-normal">{compact ? "group" : "strategy"}</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">W/L</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">WR</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">PF</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">gross</th>
            <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net</th>
            {!compact && (
              <>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">exp</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">stop-runs</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">drift</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">MFE/MAE</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {show.map((s) => (
            <tr key={`${s.group}|${s.label}`} className={s.group === "overall" ? "font-bold text-zinc-100" : "text-zinc-400"}>
              <td className="py-1 pr-2 whitespace-nowrap">
                {s.group === "overall" ? "ALL" : s.group === "family" ? familyName(s.label) : s.label}
              </td>
              <td className="px-2 py-1 text-right">{s.n}</td>
              <td className="px-2 py-1 text-right whitespace-nowrap">
                <span className="text-long">{s.wins}</span>/<span className="text-short">{s.losses}</span>
              </td>
              <td className={`px-2 py-1 text-right ${s.winRate !== null && s.winRate >= 0.6 ? "text-long" : s.winRate !== null && s.winRate <= 0.35 ? "text-short" : ""}`}>{pct(s.winRate)}</td>
              <td className="px-2 py-1 text-right">{pf(s.profitFactor)}</td>
              <td className="px-2 py-1 text-right">{fmtUsd(s.grossUsd)}</td>
              <td className={`px-2 py-1 text-right ${s.netUsd >= 0 ? "text-long" : "text-short"}`}>{fmtUsd(s.netUsd)}</td>
              {!compact && (
                <>
                  <td className="px-2 py-1 text-right">{fmtUsd(s.expectancyUsd)}</td>
                  <td className="px-2 py-1 text-right">
                    {s.stopRuns}{s.stopRunRate !== null && s.losses > 0 ? ` (${pct(s.stopRunRate)})` : ""}
                  </td>
                  <td className="px-2 py-1 text-right">{fmtPts(s.avgEntryAdversePts)}</td>
                  <td className="px-2 py-1 text-right">{fmtPts(s.avgMfePts)}/{fmtPts(s.avgMaePts)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GlanceCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: "long" | "short" | "none" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-zinc-50";
  return (
    <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2.5">
      <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`font-mono text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="font-mono text-[9px] text-zinc-600">{sub}</p>}
    </div>
  );
}

function EquityCurve({ points }: { points: EquityPoint[] }) {
  const W = 600;
  const H = 150;
  const PAD = 6;
  const vals = points.map((p) => p.net);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const step = (W - PAD * 2) / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => {
    const x = PAD + i * step;
    const y = H - PAD - ((p.net - lo) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = points[0].net;
  const last = points[points.length - 1].net;
  const delta = last - first;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[150px] w-full" preserveAspectRatio="none">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-zinc-800" strokeWidth="1" />
        <polyline points={xy.join(" ")} fill="none" strokeWidth="1.5" className={delta >= 0 ? "stroke-long" : "stroke-short"} />
        {points.map((p, i) => (
          <circle key={p.at} cx={PAD + i * step} cy={H - PAD - ((p.net - lo) / span) * (H - PAD * 2)} r="1.6" className={p.net >= 0 ? "fill-long" : "fill-short"} />
        ))}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-500">
        <span>start {fmtUsd(first)}</span>
        <span className={delta >= 0 ? "text-long" : "text-short"}>
          {delta >= 0 ? "+" : ""}
          {fmtUsd(delta)}
        </span>
        <span>now {fmtUsd(last)}</span>
      </div>
    </div>
  );
}

export default function JournalPage() {
  const [run, setRun] = useState<RunRow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [scoreSort, setScoreSort] = useState<"net" | "expR" | "freq">("net");
  const [scoreRange, setScoreRange] = useState<"7" | "30" | "90" | "all">("30");
  const [headline, setHeadline] = useState<Headline | null>(null);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [streaks, setStreaks] = useState<StreakRow[]>([]);
  const [drawdowns, setDrawdowns] = useState<DrawdownRow[]>([]);
  const [matrix, setMatrix] = useState<HourCell[]>([]);
  const [hours, setHours] = useState<HourRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    Promise.all([
      fetch(`/api/trades?range=${scoreRange}`).then((r) => r.json()),
      fetch("/api/insights").then((r) => r.json()),
    ])
      .then(([t, i]) => {
        setRun(t.runs?.[0] ?? null);
        setAnalysis(t.analysis ?? null);
        setTrades(t.trades ?? []);
        setScoreboard(t.scoreboard ?? []);
        setHeadline(t.headline ?? null);
        setDayRows(t.days ?? []);
        setEquity(t.equity ?? []);
        setStreaks(t.streaks ?? []);
        setDrawdowns(t.drawdowns ?? []);
        setMatrix(t.matrix ?? []);
        setHours(t.hours ?? []);
        setInsights(i.insights ?? []);
        setOverrides(i.overrides ?? []);
        setLoaded(true);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [scoreRange]);

  const post = (body: Record<string, unknown>) => {
    fetch("/api/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then(() => load())
      .catch(() => {});
  };

  const stats = analysis?.summary.stats ?? [];
  const overall = stats.find((s) => s.group === "overall") ?? null;
  const familyStats = stats.filter((s) => s.group === "family");
  const sideStats = stats.filter((s) => s.group === "side");
  const firstStats = stats.filter((s) => s.group === "first");
  const lossStats = stats.filter((s) => s.group === "lossclass");
  const matrixFams = [...new Set(matrix.map((c) => c.family))].sort((a, b) => familyName(a).localeCompare(familyName(b)));
  const extraHours = [...new Set(matrix.map((c) => c.hour))].filter((h) => !(h in HOUR_LABEL));
  const HOUR_KEYS = [...Object.keys(HOUR_LABEL), ...extraHours];
  const narrative = insights.find((i) => i.kind === "narrative" && i.source === "llm") ??
    insights.find((i) => i.kind === "narrative") ?? null;
  const nonNarrative = insights.filter((i) => i.kind !== "narrative");
  const activeOverrides = overrides.filter((o) => o.active);
  const newestFirst = [...trades].reverse();
  const maxAbsDay = Math.max(1, ...dayRows.map((d) => Math.abs(d.netUsd)));

  return (
    <main className="mx-auto w-full max-w-[1800px] px-4 py-6">
      {/* header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-bold tracking-widest text-zinc-100">TRADE JOURNAL</h1>
          <p className="font-mono text-[11px] text-zinc-500">
            signals → fills → anatomy → insights → gates · the self-improving loop
          </p>
        </div>
        <div className="flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
          <span className="rounded border border-zinc-800 px-2 py-1">dataset {analysis?.trades_n ?? "—"} trades</span>
          <span className="rounded border border-zinc-800 px-2 py-1">
            account {fmtUsd(run?.account_realized ?? null)} realized
          </span>
          <span className="rounded border border-zinc-800 px-2 py-1">{activeOverrides.length} active gates</span>
        </div>
      </div>

      {/* headline — the glance layer */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(["7", "30", "90", "all"] as const).map((r) => (
          <button
            key={r}
            onClick={() => setScoreRange(r)}
            className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
              scoreRange === r
                ? "border-info/60 bg-info/10 text-info"
                : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {r === "all" ? "ALL" : `${r}D`}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {scoreRange === "all" ? "all time" : `rolling ${scoreRange} days`} · bot strategies only
        </span>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <GlanceCard
          label="NET P&L"
          value={fmtUsd(headline?.netUsd ?? null)}
          tone={(headline?.netUsd ?? 0) >= 0 ? "long" : "short"}
          sub={`gross ${fmtUsd(headline?.grossUsd ?? null)}`}
        />
        <GlanceCard
          label="WIN RATE"
          value={headline?.winRate != null ? `${(headline.winRate * 100).toFixed(0)}%` : "—"}
          tone={headline?.winRate != null && headline.winRate >= 0.5 ? "long" : "none"}
          sub={`${headline?.wins ?? 0}W / ${headline?.losses ?? 0}L / ${headline?.flats ?? 0}F`}
        />
        <GlanceCard
          label="EXPECTANCY"
          value={headline?.expectancy != null ? fmtUsd(headline.expectancy) : "—"}
          tone={(headline?.expectancy ?? 0) >= 0 ? "long" : "short"}
          sub="net per trade"
        />
        <GlanceCard
          label="TRADES"
          value={String(headline?.matched ?? 0)}
          tone="none"
          sub={`fees ${fmtUsd(headline ? -headline.commissions : null)}`}
        />
        <GlanceCard label="BEST DAY" value={fmtUsd(headline?.bestDayNet ?? null)} tone="long" sub="bot net" />
        <GlanceCard label="WORST DAY" value={fmtUsd(headline?.worstDayNet ?? null)} tone="short" sub="bot net" />
      </div>

      {/* equity curve + per-day breakdown */}
      <div className="mb-5 grid grid-cols-1 gap-5 xl:grid-cols-5">
        <section className="rounded-md border border-zinc-800 bg-panel p-4 xl:col-span-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Account equity</h2>
            <span className="font-mono text-[10px] text-zinc-600">
              {equity.length
                ? `${equity[0].at.slice(0, 10)} → ${equity[equity.length - 1].at.slice(0, 10)} · netLiq snapshot per reconcile run`
                : "no snapshots yet — reconcile runs nightly"}
            </span>
          </div>
          {equity.length >= 2 ? (
            <EquityCurve points={equity} />
          ) : (
            <p className="py-10 text-center font-mono text-xs text-zinc-600">
              {equity.length === 1 ? "one snapshot — the curve starts with the next reconcile" : "no equity data in this range"}
            </p>
          )}
        </section>
        <section className="rounded-md border border-zinc-800 bg-panel p-4 xl:col-span-2">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Per-day P&L</h2>
          {dayRows.length ? (
            <div className="max-h-[260px] space-y-1 overflow-y-auto pr-1">
              {dayRows.map((d) => (
                <div key={d.day} className="flex items-center gap-2 rounded border border-zinc-800/70 px-2 py-1 font-mono text-[10px]">
                  <span className="w-[76px] shrink-0 text-zinc-400">{d.day.slice(5)}</span>
                  <span className="w-[74px] shrink-0 text-zinc-500">
                    {d.n} t · {d.wins}W/{d.losses}L
                  </span>
                  <span className={`w-[64px] shrink-0 text-right ${d.netUsd >= 0 ? "text-long" : "text-short"}`}>
                    {fmtUsd(d.netUsd)}
                  </span>
                  <span className="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
                    <span
                      className={`absolute inset-y-0 ${d.netUsd >= 0 ? "bg-long/50" : "bg-short/50"}`}
                      style={{
                        left: d.netUsd >= 0 ? "50%" : `${50 - Math.min(50, (Math.abs(d.netUsd) / maxAbsDay) * 50)}%`,
                        width: `${Math.min(50, (Math.abs(d.netUsd) / maxAbsDay) * 50)}%`,
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center font-mono text-xs text-zinc-600">no matched trades in this range</p>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
        {/* left column: narrative + insights */}
        <div className="space-y-5 xl:col-span-2">
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">AI strategy review</h2>
              <span className="flex items-center gap-1.5">
                {narrative && run && narrative.run_at < run.run_at && (
                  <span className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 font-mono text-[9px] text-warn">
                    older than trades — run strategyInsights.ts
                  </span>
                )}
                {narrative && (
                  <span className="font-mono text-[9px] text-zinc-600">
                    {narrative.source === "llm" ? "DeepSeek" : "deterministic"} · {narrative.run_at?.slice(0, 16).replace("T", " ") ?? ""}Z
                  </span>
                )}
              </span>
            </div>
            {(() => {
              const byDay = new Map<string, { n: number; w: number; l: number; gross: number; net: number }>();
              for (const t of trades) {
                if (t.status !== "matched") continue;
                const d = byDay.get(t.day) ?? { n: 0, w: 0, l: 0, gross: 0, net: 0 };
                d.n++;
                if (t.result === "win") d.w++;
                if (t.result === "loss") d.l++;
                d.gross += Number(t.gross_usd);
                d.net += Number(t.net_usd);
                byDay.set(t.day, d);
              }
              const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
              return (
                <div className="mb-2 space-y-0.5">
                  {days.slice(0, 3).map(([day, d]) => (
                    <div key={day} className="flex items-center justify-between rounded border border-zinc-800/70 px-1.5 py-0.5 font-mono text-[9px] text-zinc-500">
                      <span>{day === days[0]?.[0] ? "TODAY" : day}</span>
                      <span>
                        {d.n} trades · {d.w}W/{d.l}L · gross {fmtUsd(d.gross)} · net {fmtUsd(d.net)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {narrative && (
              <p className="mb-2 font-mono text-[10px] text-zinc-500">
                AI dataset: rolling 30 days ({String((narrative.evidence as Record<string, unknown>).windowStart ?? "—").slice(0, 10)} → now) ·{" "}
                {String((narrative.evidence as Record<string, unknown>).trades ?? "—")} trades
              </p>
            )}
            {narrative ? (
              <Narrative text={narrative.finding} />
            ) : (
              <p className="font-mono text-xs text-zinc-600">no review yet — run scripts/strategyInsights.ts</p>
            )}
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Insights & gates</h2>
            <p className="mb-3 font-mono text-[10px] leading-snug text-zinc-500">
              the nightly miner proposes gate changes with evidence — approve here and the live feed applies them within minutes
            </p>

            {activeOverrides.length > 0 && (
              <div className="mb-3 space-y-1">
                {activeOverrides.map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-2 rounded border border-long/40 bg-long/5 px-2 py-1.5">
                    <span className="break-all font-mono text-[10px] text-long">
                      {familyName(o.family)}.{o.gate} = {JSON.stringify(o.value)} · {o.note}
                    </span>
                    <button
                      onClick={() => post({ action: "disable", overrideId: Number(o.id) })}
                      className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-short hover:text-short"
                    >
                      disable
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="max-h-[600px] space-y-1.5 overflow-y-auto pr-1">
              {nonNarrative.map((i) => (
                <div key={i.id} className="rounded border border-zinc-800/70 px-2 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="break-words font-mono text-[11px] font-semibold text-zinc-100">{i.title}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${SEV_STYLE[i.severity]}`}>{i.severity}</span>
                      <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${STATUS_STYLE[i.status] ?? STATUS_STYLE.proposed}`}>{i.status}</span>
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[9px] text-zinc-600">
                    {i.strategy} · {i.kind} · {Object.entries(i.evidence).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`).join(" ")}
                  </div>
                  <p className="mt-1 break-words font-mono text-[10px] leading-snug text-zinc-400">{i.finding}</p>
                  {i.status === "proposed" && i.proposedAction && (
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="break-words font-mono text-[9px] text-info">
                        → {familyName(i.proposedAction.family)}.{i.proposedAction.gate}: {i.proposedAction.note}
                        {i.auto_apply ? " (auto when SELF_IMPROVE=1)" : ""}
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <button
                          onClick={() => post({ action: "apply", id: Number(i.id) })}
                          className="rounded border border-long/50 bg-long/10 px-1.5 py-0.5 font-mono text-[9px] text-long hover:bg-long/20"
                        >
                          apply
                        </button>
                        <button
                          onClick={() => post({ action: "reject", id: Number(i.id) })}
                          className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-short hover:text-short"
                        >
                          reject
                        </button>
                      </span>
                    </div>
                  )}
                </div>
              ))}
              {loaded && nonNarrative.length === 0 && (
                <p className="font-mono text-xs text-zinc-600">no findings yet — accumulating</p>
              )}
            </div>
          </section>
        </div>

        {/* right column: scoreboard + stats + trades */}
        <div className="space-y-5 xl:col-span-3">
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Strategy scoreboard</h2>
              <span className="flex items-center gap-2">
                <span className="flex gap-1">
                  {(["7", "30", "90", "all"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setScoreRange(r)}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                        scoreRange === r
                          ? "border-long/50 bg-long/10 text-long"
                          : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                      }`}
                    >
                      {r === "all" ? "ALL" : `${r}D`}
                    </button>
                  ))}
                </span>
                <span className="flex gap-1">
                  {([
                    ["net", "net $"],
                    ["expR", "expR"],
                    ["freq", "frequency"],
                  ] as const).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setScoreSort(k)}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                        scoreSort === k
                          ? "border-info/50 bg-info/10 text-info"
                          : "border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">#</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">strategy</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="cards recorded in the window">cards</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="signals that filled">fills</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="fills per trading day">/day</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="recorded but not filled">skips</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal text-long" title="wins">W</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal text-short" title="losses">L</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="live expectancy per R (mean gross R/trade)">live expR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="replay baseline from the 648-session archive">replay expR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal" title="live expectancy vs the 648-session replay baseline — a strategy-quality flag, NOT an account metric">edge</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const expRKey = (s: ScoreRow) => s.liveExpR ?? s.baselineExpR;
                    const sorted = [...scoreboard].sort((a, b) =>
                      scoreSort === "freq"
                        ? b.fills - a.fills || b.signals - a.signals
                        : scoreSort === "expR"
                          ? expRKey(b) - expRKey(a)
                          : b.netUsd - a.netUsd,
                    );
                    return sorted.map((s, i) => {
                      const idle = s.fills === 0;
                      return (
                      <tr key={s.family} className={i === 0 ? "font-bold text-zinc-100" : idle ? "text-zinc-600" : "text-zinc-400"}>
                        <td className="py-1 pr-2 text-zinc-600">{i + 1}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{familyName(s.family)}</td>
                        <td className="px-2 py-1 text-right">{s.signals}</td>
                        <td className="px-2 py-1 text-right">{s.fills}</td>
                        <td className="px-2 py-1 text-right">{s.days > 0 ? (s.fills / s.days).toFixed(1) : "—"}</td>
                        <td className="px-2 py-1 text-right text-zinc-500">{s.skips > 0 ? s.skips : "—"}</td>
                        <td className="px-2 py-1 text-right text-long">{s.fills > 0 ? s.wins : "—"}</td>
                        <td className="px-2 py-1 text-right text-short">{s.fills > 0 ? s.losses : "—"}</td>
                        <td className={`px-2 py-1 text-right ${s.fills === 0 ? "text-zinc-700" : s.netUsd >= 0 ? "text-long" : "text-short"}`}>
                          {s.fills > 0 ? fmtUsd(s.netUsd) : "—"}
                        </td>
                        <td className="px-2 py-1 text-right">
                          {s.liveExpR === null ? (
                            <span className="text-zinc-600">—</span>
                          ) : (
                            <span className={s.liveExpR >= 0 ? "text-long" : "text-short"}>{s.liveExpR >= 0 ? "+" : ""}{s.liveExpR.toFixed(2)}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right text-zinc-500">{s.baselineExpR.toFixed(2)}</td>
                        <td className="px-2 py-1">
                          <span
                            className={`inline-block rounded border px-1 py-0.5 text-[8px] uppercase ${EDGE_STYLE[s.status] ?? EDGE_STYLE.insufficient}`}
                            title={`${EDGE_HINT[s.status] ?? ""} · live ${s.liveExpR === null ? "n/a" : `${s.liveExpR >= 0 ? "+" : ""}${s.liveExpR.toFixed(2)}R`} vs replay ${s.baselineExpR.toFixed(2)}R${s.detail ? ` · ${s.detail}` : ""}`}
                          >
                            {EDGE_LABEL[s.status] ?? EDGE_LABEL.insufficient}
                          </span>
                        </td>
                      </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
              {loaded && scoreboard.length === 0 && (
                <p className="py-2 font-mono text-xs text-zinc-600">no reconciled trades yet — the scoreboard fills with the next reconcile run</p>
              )}
            </div>
            <p className="mt-2 font-mono text-[9px] leading-snug text-zinc-600">
              accumulates over the selected range (7D / 30D / 90D / ALL — never resets; trades and cards persist forever) ·
              sort: net $ = account contribution · expR = mean gross R/trade (replay baseline until a family has ≥8 fills) · frequency = fills, then cards ·
              live n is small — treat ranks as provisional · skips = cards recorded but not filled (gates, retrace expiries, refusals) ·
              edge compares LIVE expR to the 648-session replay baseline only (edge OK &gt;= half · edge weak &lt; half · edge lost &lt;= 0) — it is a strategy-quality flag,
              never an account/guard metric (the MFF account guard is reported in /api/gc?action=health → execution.protections)
            </p>
          </section>

          {/* ---- dedicated metric tables (one question each) ---- */}
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Strategy performance</h2>
            <StatsTable rows={familyStats} />
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Risk, streaks &amp; drawdown</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">strategy</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal text-long" title="longest consecutive wins">max W run</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal text-short" title="longest consecutive losses">max L run</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="current streak (W/L)">now</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="worst peak-to-trough of the running net">max DD</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="max DD as % of the peak it fell from">DD %</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">worst day</th>
                  </tr>
                </thead>
                <tbody>
                  {drawdowns.map((d) => {
                    const s = streaks.find((x) => x.family === d.family);
                    return (
                      <tr key={d.family} className="text-zinc-400">
                        <td className="py-1 pr-2 whitespace-nowrap">{d.label}</td>
                        <td className="px-2 py-1 text-right">{s?.n ?? "—"}</td>
                        <td className="px-2 py-1 text-right text-long">{s?.maxWin ?? "—"}</td>
                        <td className="px-2 py-1 text-right text-short">{s?.maxLoss ?? "—"}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          {s ? `${s.curWin > 0 ? `+${s.curWin}W` : s.curLoss > 0 ? `−${s.curLoss}L` : "flat"}` : "—"}
                        </td>
                        <td className={`px-2 py-1 text-right ${d.maxDdUsd < 0 ? "text-short" : "text-zinc-400"}`}>{fmtUsd(d.maxDdUsd)}</td>
                        <td className="px-2 py-1 text-right text-zinc-500">{d.ddPct === null ? "—" : `${d.ddPct.toFixed(0)}%`}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap text-zinc-500">
                          {d.worstDay ? `${d.worstDay.slice(5)} ${fmtUsd(d.worstDayUsd)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {drawdowns.length === 0 && <p className="py-2 font-mono text-xs text-zinc-600">no matched trades in this range</p>}
            </div>
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Strategy × hour</h2>
            {matrix.length ? (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse font-mono text-[10px]">
                  <thead>
                    <tr className="text-left text-zinc-500">
                      <th className="border-b border-zinc-800 py-1 pr-2 font-normal">strategy</th>
                      {HOUR_KEYS.map((h) => (
                        <th key={h} className="border-b border-zinc-800 px-2 py-1 text-right font-normal">{HOUR_LABEL[h] ?? h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrixFams.map((f) => (
                      <tr key={f} className="text-zinc-400">
                        <td className="py-1 pr-2 whitespace-nowrap">{familyName(f)}</td>
                        {HOUR_KEYS.map((h) => {
                          const c = matrix.find((x) => x.family === f && x.hour === h);
                          if (!c) return <td key={h} className="px-2 py-1 text-right text-zinc-700">—</td>;
                          return (
                            <td key={h} className={`px-2 py-1 text-right ${c.netUsd >= 0 ? "text-long" : "text-short"}`} title={`${c.wins}W/${c.losses}L · ${c.wr?.toFixed(0) ?? "—"}% WR`}>
                              {c.n}·{fmtUsd(c.netUsd)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-2 font-mono text-xs text-zinc-600">no trades in this range</p>
            )}
            <p className="mt-1 font-mono text-[9px] text-zinc-600">cell = trades · net (hover: W/L and win rate) — which strategy pays at which hour block</p>
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Hour performance</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">hour block</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">W/L</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">WR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">exp / trade</th>
                  </tr>
                </thead>
                <tbody>
                  {hours.map((h) => (
                    <tr key={h.hour} className="text-zinc-400">
                      <td className="py-1 pr-2 whitespace-nowrap">{h.label}</td>
                      <td className="px-2 py-1 text-right">{h.n}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        <span className="text-long">{h.wins}</span>/<span className="text-short">{h.losses}</span>
                      </td>
                      <td className={`px-2 py-1 text-right ${h.wr !== null && h.wr >= 60 ? "text-long" : h.wr !== null && h.wr <= 35 ? "text-short" : ""}`}>{h.wr === null ? "—" : `${h.wr.toFixed(0)}%`}</td>
                      <td className={`px-2 py-1 text-right ${h.netUsd >= 0 ? "text-long" : "text-short"}`}>{fmtUsd(h.netUsd)}</td>
                      <td className={`px-2 py-1 text-right ${h.expUsd !== null && h.expUsd >= 0 ? "text-long" : "text-short"}`}>{h.expUsd === null ? "—" : fmtUsd(h.expUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hours.length === 0 && <p className="py-2 font-mono text-xs text-zinc-600">no trades in this range</p>}
            </div>
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Execution lenses</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <h3 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Side</h3>
                <StatsTable rows={sideStats} compact />
              </div>
              <div>
                <h3 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">First of day</h3>
                <StatsTable rows={firstStats} compact />
              </div>
              <div>
                <h3 className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Loss classes</h3>
                <StatsTable rows={lossStats} compact />
              </div>
            </div>
            {overall && (
              <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4">
                {[
                  { k: "expectancy / trade", v: fmtUsd(overall.expectancyUsd) },
                  { k: "stop-runs", v: `${overall.stopRuns} of ${overall.losses} losses` },
                  { k: "commissions", v: fmtUsd(overall.commissions) },
                  { k: "avg adverse drift", v: fmtPts(overall.avgEntryAdversePts) },
                ].map((c) => (
                  <div key={c.k} className="rounded border border-zinc-800/70 px-2 py-1">
                    <div className="font-mono text-[8px] uppercase tracking-wider text-zinc-600">{c.k}</div>
                    <div className="font-mono text-[12px] font-semibold text-zinc-200">{c.v}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Trades</h2>
            {run?.notes && <p className="mb-2 font-mono text-[10px] text-warn">{run.notes}</p>}
            <div className="max-h-[640px] overflow-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead className="sticky top-0 bg-panel">
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">time</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">dir</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">strategy</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">signal</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="stop distance from the signal (points / ticks, 1 pt = 4 ticks)">risk</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="target distance from the signal (points / ticks)">target</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">fill → exit</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">drift</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">MFE/MAE</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">held</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">gross / net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">result</th>
                  </tr>
                </thead>
                <tbody>
                  {newestFirst.map((t) => (
                    <tr key={t.signal_key} className="align-top text-zinc-400">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {t.day.slice(5)} {t.time_et || "—"}
                        {t.first_of_day ? " ★" : ""}
                      </td>
                      <td className={`px-2 py-1 font-semibold ${t.side === "long" ? "text-long" : "text-short"}`}>
                        {t.side.toUpperCase().slice(0, 1)}
                      </td>
                      <td className="px-2 py-1 text-right">{t.contracts}</td>
                      <td className="px-2 py-1 whitespace-nowrap">{familyName(t.family)}</td>
                      <td className="px-2 py-1 text-right">{fmtPx(Number(t.sig_entry))}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {t.sig_entry !== null && t.sig_stop !== null ? ptsTicks(Math.abs(Number(t.sig_entry) - Number(t.sig_stop))) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {t.sig_entry !== null && t.sig_target !== null ? ptsTicks(Math.abs(Number(t.sig_target) - Number(t.sig_entry))) : "—"}
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {t.status === "matched" ? `${fmtPx(Number(t.fill_entry))} → ${fmtPx(Number(t.exit_avg))}` : "—"}
                      </td>
                      <td className="px-2 py-1 text-right">{fmtPts(Number(t.entry_adverse_pts))}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">{fmtPts(Number(t.mfe_pts))}/{fmtPts(Number(t.mae_pts))}</td>
                      <td className="px-2 py-1 text-right">{t.held_min !== null ? `${Math.round(Number(t.held_min))}m` : "—"}</td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {t.status === "matched" ? `${fmtUsd(Number(t.gross_usd))} / ${fmtUsd(Number(t.net_usd))}` : "—"}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {t.status !== "matched" ? (
                          <span className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 text-[8px] text-warn">NO FILL</span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <span className={`font-semibold ${RESULT_STYLE[t.result] ?? ""}`}>{t.result?.toUpperCase()}</span>
                            {t.stop_run && <span title="stop-run">⛔</span>}
                            {t.target_reached && <span title="target was in range">🎯</span>}
                            {t.recovered && <span title="price recovered after exit">↩</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {loaded && trades.length === 0 && <p className="py-2 font-mono text-xs text-zinc-600">no reconciled trades yet</p>}
            </div>
            <p className="mt-2 font-mono text-[9px] text-zinc-600">
              ★ first of day · ⛔ stop-run · 🎯 target in range before exit · ↩ price crossed back through entry ≤15 min after exit · drift positive = filled worse than signal
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
