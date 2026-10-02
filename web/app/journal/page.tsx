"use client";

import { useEffect, useRef, useState } from "react";

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

const FAMILY_LABEL: Record<string, string> = {
  momentum_flush: "MOM·flush",
  momentum_expansion: "MOM·expansion",
  rth: "RTH",
  open_drive: "OPEN DRIVE",
  open_pullback: "OPEN PULL",
  open_sniper: "SNIPER",
  sweep_reclaim: "SWEEP-RECLAIM",
  reversal: "REVERSAL",
  other: "OTHER",
};

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

const EDGE_LABEL: Record<string, string> = {
  ok: "OK",
  watch: "WATCH",
  breach: "BREACH",
  insufficient: "collecting",
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

export default function JournalPage() {
  const [run, setRun] = useState<RunRow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [scoreSort, setScoreSort] = useState<"net" | "expR" | "freq">("net");
  const [scoreRange, setScoreRange] = useState<"7" | "30" | "90" | "all">("30");
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
  const narrative = insights.find((i) => i.kind === "narrative" && i.source === "llm") ??
    insights.find((i) => i.kind === "narrative") ?? null;
  const nonNarrative = insights.filter((i) => i.kind !== "narrative");
  const activeOverrides = overrides.filter((o) => o.active);
  const newestFirst = [...trades].reverse();

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
                      {o.family}.{o.gate} = {JSON.stringify(o.value)} · {o.note}
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
                        → {i.proposedAction.family}.{i.proposedAction.gate}: {i.proposedAction.note}
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
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">W/L</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="live expectancy per R (mean gross R/trade)">live expR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="replay baseline from the 648-session archive">replay expR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">edge</th>
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
                    return sorted.map((s, i) => (
                      <tr key={s.family} className={i === 0 ? "font-bold text-zinc-100" : "text-zinc-400"}>
                        <td className="py-1 pr-2 text-zinc-600">{i + 1}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{FAMILY_LABEL[s.family] ?? s.family}</td>
                        <td className="px-2 py-1 text-right">{s.signals}</td>
                        <td className="px-2 py-1 text-right">{s.fills}</td>
                        <td className="px-2 py-1 text-right">{s.days > 0 ? (s.fills / s.days).toFixed(1) : "—"}</td>
                        <td className="px-2 py-1 text-right text-zinc-500">{s.skips > 0 ? s.skips : "—"}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">{s.wins}/{s.losses}</td>
                        <td className={`px-2 py-1 text-right ${s.netUsd >= 0 ? "text-long" : "text-short"}`}>{fmtUsd(s.netUsd)}</td>
                        <td className="px-2 py-1 text-right">
                          {s.liveExpR === null ? (
                            <span className="text-zinc-600">—</span>
                          ) : (
                            <span className={s.liveExpR >= 0 ? "text-long" : "text-short"}>{s.liveExpR >= 0 ? "+" : ""}{s.liveExpR.toFixed(2)}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right text-zinc-500">{s.baselineExpR.toFixed(2)}</td>
                        <td className="px-2 py-1">
                          <span className={`inline-block rounded border px-1 py-0.5 text-[8px] uppercase ${EDGE_STYLE[s.status] ?? EDGE_STYLE.insufficient}`} title={s.detail}>
                            {EDGE_LABEL[s.status] ?? EDGE_LABEL.insufficient}
                          </span>
                        </td>
                      </tr>
                    ));
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
              live n is small — treat ranks as provisional · skips = cards recorded but not filled (gates, retrace expiries, refusals) · edge = range expR vs the 648-session replay baseline
            </p>
          </section>

          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Win / loss analysis</h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">group</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">W/L</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">WR</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">PF</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">gross</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">avg W/L</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">exp</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">stop-runs</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">drift</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">MFE/MAE</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.filter((s) => s.n > 0).map((s) => (
                    <tr key={`${s.group}|${s.label}`} className={s.group === "overall" ? "font-bold text-zinc-100" : "text-zinc-400"}>
                      <td className="py-1 pr-2">
                        {s.group === "overall" ? "ALL" : `${s.group}: ${s.label}`}
                      </td>
                      <td className="px-2 py-1 text-right">{s.n}</td>
                      <td className="px-2 py-1 text-right">{s.wins}/{s.losses}</td>
                      <td className={`px-2 py-1 text-right ${s.winRate !== null && s.winRate >= 0.6 ? "text-long" : s.winRate !== null && s.winRate <= 0.35 ? "text-short" : ""}`}>{pct(s.winRate)}</td>
                      <td className="px-2 py-1 text-right">{pf(s.profitFactor)}</td>
                      <td className="px-2 py-1 text-right">{fmtUsd(s.grossUsd)}</td>
                      <td className={`px-2 py-1 text-right ${s.netUsd >= 0 ? "text-long" : "text-short"}`}>{fmtUsd(s.netUsd)}</td>
                      <td className="px-2 py-1 text-right">{fmtUsd(s.avgWinUsd)} / {fmtUsd(s.avgLossUsd)}</td>
                      <td className="px-2 py-1 text-right">{fmtUsd(s.expectancyUsd)}</td>
                      <td className="px-2 py-1 text-right">
                        {s.stopRuns}{s.stopRunRate !== null && s.losses > 0 ? ` (${pct(s.stopRunRate)})` : ""}
                      </td>
                      <td className="px-2 py-1 text-right">{fmtPts(s.avgEntryAdversePts)}</td>
                      <td className="px-2 py-1 text-right">{fmtPts(s.avgMfePts)}/{fmtPts(s.avgMaePts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {overall && (
              <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
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
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">family</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">signal</th>
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
                      <td className="px-2 py-1 whitespace-nowrap">{FAMILY_LABEL[t.family] ?? t.family}</td>
                      <td className="px-2 py-1 text-right">{fmtPx(Number(t.sig_entry))}</td>
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
