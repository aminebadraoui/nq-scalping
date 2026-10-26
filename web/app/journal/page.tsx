"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { familyName } from "@/lib/familyNames";
import { adminFetch } from "@/lib/adminFetch";
import { type StreakRow, type DrawdownRow, type HourCell, type HourRow } from "@/lib/journalMetrics";
import { flattenFeatures, ledgerCsv, type LedgerRow as DeepTradeRow, type LedgerVariable } from "@/lib/tradeLedger";
import { groupFeatures } from "@/lib/featureGroups";
import PatternExplorer from "@/components/PatternExplorer";
import ExecLogPanel from "@/components/ExecLogPanel";
import { AccountLine, useAccount } from "@/components/AccountStrip";

/* ------------------------------------------------------------------ *
 * Trade journal — ONE source of truth for every trade.
 *
 * The unified record: /api/trades returns `entries` — one row per trade,
 * bot AND manual, each with an explicit `origin` and an explicit
 * `account` (fire-time stamp wins, known switch timeline fills legacy
 * rows — lib/accountAttribution.ts). Live intraday rows (execution
 * ledger + manual detector) sit on top for today and are deduped
 * against the nightly record by signal identity.
 *
 * Everything money-related on this page is account-scoped: the account
 * chips filter /api/trades server-side, so the headline, per-day P&L,
 * equity, ledger and scoreboard never blend accounts.
 * ------------------------------------------------------------------ */

/** one unified journal row (lib/journalEntries.ts, via /api/trades) */
type JournalEntry = {
  key: string;
  origin: "bot" | "manual";
  day: string;
  timeET: string;
  ts: number;
  account: string;
  accountSource: "fire-time" | "timeline" | "";
  side: "long" | "short";
  contracts: number;
  family: string;
  symbol: string;
  status: "matched" | "unexecuted" | "partial";
  result: "" | "win" | "loss" | "flat";
  fillEntry: number | null;
  exitAvg: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  audit: { label: string; reason: string; nearestSignal: string | null } | null;
};

type JournalEntryLive = JournalEntry & { live: true };

type AccountRollupRow = {
  account: string;
  botN: number;
  manualN: number;
  botNet: number;
  manualNet: number;
  net: number;
  firstDay: string;
  lastDay: string;
};

type TradeRow = {
  signal_key: string;
  day: string;
  time_et: string;
  side: "long" | "short";
  contracts: number;
  verdict: string;
  status: "matched" | "unexecuted" | "partial";
  result: "win" | "loss" | "flat" | "";
  gross_usd: number;
  net_usd: number;
};

/** one live execution-ledger row (lib/execTracker.ts, via /api/executions) */
type LiveExecRow = {
  key: string;
  signalId: string;
  ts: number;
  day: string;
  timeET: string;
  label: string;
  family: string;
  side: "long" | "short";
  contracts: number;
  sigEntry: number;
  sigStop: number;
  sigTarget: number;
  orderId: string;
  status: "placed" | "filled" | "closed" | "failed";
  fillEntry: number | null;
  fillEntryAt: number | null;
  exitAvg: number | null;
  exitFills: Array<{ ts: number; action: string; qty: number; price: number }>;
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: "" | "win" | "loss" | "flat";
};

/** one live manual-action row (lib/manualDetect.ts, via /api/manual) */
type LiveManualRow = {
  key: string;
  kind: string;
  at: number;
  day: string;
  timeET: string;
  side: "long" | "short" | "";
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  orderId: string;
  fills: Array<{ ts: number; action: string; qty: number; price: number }>;
  closed: boolean;
  note: string;
  updatedAt: number;
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
  /** hypothetical first-touch win rate over ALL recorded cards (replay) */
  hypWr: number | null;
  hypN: number;
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

type LedgerRow = {
  at: string;
  account: string;
  net: number;
  delta: number | null;
  botNet: number;
  manualResidual: number | null;
  manualFills: number;
  manualGrossUsd: number | null;
};

type AccountHead = {
  net: number;
  realized: number | null;
  at: string;
  account: string;
  startBalance: number;
  pnl: number;
  pct: number;
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
const fmtUsdSigned = (n: number | null) => {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = Math.round(n * 100) / 100;
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const fmtPts = (n: number | null) => {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
};
const fmtPx = (n: number | null) => (n === null || !Number.isFinite(n) ? "—" : n.toFixed(2));
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);
const pf = (n: number | null) => (n === null ? "—" : n === Infinity ? "∞" : n.toFixed(2));
const shortAcct = (a: string) => (a ? `…${a.slice(-4)}` : "—");

const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

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

/** live execution-ledger row → unified journal entry (origin bot, live) */
function liveExecToEntry(e: LiveExecRow, acct: string): JournalEntryLive {
  return {
    key: e.signalId || e.key,
    origin: "bot",
    day: e.day,
    timeET: e.timeET,
    ts: e.ts,
    account: acct,
    accountSource: "fire-time",
    side: e.side,
    contracts: e.contracts,
    family: e.family,
    symbol: "",
    status: e.status === "closed" ? "matched" : "partial",
    result: e.status === "closed" ? e.result : "",
    fillEntry: e.fillEntry,
    exitAvg: e.exitAvg,
    grossUsd: e.grossUsd,
    feesUsd: e.feesUsd,
    netUsd: e.status === "closed" ? e.netUsd : 0,
    audit: null,
    live: true,
  };
}

/** live manual-action row → unified journal entry (origin manual, live) */
function liveManualToEntry(m: LiveManualRow, acct: string): JournalEntryLive {
  const pnl = m.pnlUsd ?? 0;
  return {
    key: m.key,
    origin: "manual",
    day: m.day,
    timeET: m.timeET,
    ts: m.at,
    account: acct,
    accountSource: "fire-time",
    side: m.side === "short" ? "short" : "long",
    contracts: m.qty,
    family: "",
    symbol: "MNQ",
    status: "matched",
    result: m.closed ? (pnl > 0.5 ? "win" : pnl < -0.5 ? "loss" : "flat") : "",
    fillEntry: m.entryPrice,
    exitAvg: m.exitPrice,
    grossUsd: pnl,
    feesUsd: 0,
    netUsd: pnl,
    audit: m.closed ? null : { label: "manual", reason: "live detector — position still open", nearestSignal: null },
    live: true,
  };
}

export default function JournalPage() {
  const liveAccount = useAccount();
  const [run, setRun] = useState<RunRow | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [accounts, setAccounts] = useState<AccountRollupRow[]>([]);
  const [accountList, setAccountList] = useState<string[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreRow[]>([]);
  const [scoreSort, setScoreSort] = useState<"net" | "expR" | "freq">("net");
  const [scoreRange, setScoreRange] = useState<"7" | "30" | "90" | "all">("30");
  const [headline, setHeadline] = useState<Headline | null>(null);
  const [dayRows, setDayRows] = useState<DayRow[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [manualTotal, setManualTotal] = useState<number | null>(null);
  const [account, setAccount] = useState<AccountHead | null>(null);
  const [streaks, setStreaks] = useState<StreakRow[]>([]);
  const [drawdowns, setDrawdowns] = useState<DrawdownRow[]>([]);
  const [matrix, setMatrix] = useState<HourCell[]>([]);
  const [hours, setHours] = useState<HourRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [deepTrades, setDeepTrades] = useState<DeepTradeRow[]>([]);
  const [deepVars, setDeepVars] = useState<LedgerVariable[]>([]);
  const [deepSource, setDeepSource] = useState<string>("");
  const [liveExecs, setLiveExecs] = useState<LiveExecRow[]>([]);
  const [liveManualRows, setLiveManualRows] = useState<LiveManualRow[]>([]);
  const [showAllVars, setShowAllVars] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [acctFilter, setAcctFilter] = useState<string>("all");
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    Promise.all([
      fetch(`/api/trades?range=${scoreRange}&account=${acctFilter}`).then((r) => r.json()),
      fetch("/api/insights").then((r) => r.json()),
      fetch("/api/trades/table").then((r) => r.json()),
      fetch("/api/executions", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/manual", { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([t, i, l, e, m]) => {
        setRun(t.runs?.[0] ?? null);
        setAnalysis(t.analysis ?? null);
        setTrades(t.trades ?? []);
        setEntries(t.entries ?? []);
        setAccounts(t.accounts ?? []);
        setAccountList(t.accountList ?? []);
        setScoreboard(t.scoreboard ?? []);
        setHeadline(t.headline ?? null);
        setDayRows(t.days ?? []);
        setEquity(t.equity ?? []);
        setLedger(t.ledger ?? []);
        setManualTotal(typeof t.manualTotal === "number" ? t.manualTotal : null);
        setAccount(t.account ?? null);
        setStreaks(t.streaks ?? []);
        setDrawdowns(t.drawdowns ?? []);
        setMatrix(t.matrix ?? []);
        setHours(t.hours ?? []);
        setInsights(i.insights ?? []);
        setOverrides(i.overrides ?? []);
        setDeepTrades(l.rows ?? []);
        setDeepVars(l.variables ?? []);
        setDeepSource(l.source ?? "");
        setLiveExecs(Array.isArray(e.rows) ? e.rows : []);
        setLiveManualRows(Array.isArray(m.rows) ? m.rows.filter((r: { kind: string }) => r.kind === "manual_trade") : []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoreRange, acctFilter]);

  const post = (body: Record<string, unknown>) => {
    adminFetch("/api/insights", {
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

  /* ---- the unified journal: ONE list, bot + manual ----
   * today's live rows (execution ledger + manual detector) sit on top of
   * the nightly reconcile rows; identity rules dedupe the overlap:
   *   · a live bot row whose signal already has a nightly row is dropped
   *     EXCEPT for today, where the live row wins and the nightly row is
   *     suppressed (the reconcile only runs at night);
   *   · live manual rows for today suppress today's nightly manual rows.
   */
  const today = etToday();
  const liveAcctName = liveAccount?.account?.name ?? "";
  const liveBotEntries: JournalEntryLive[] = liveExecs
    .filter((e) => {
      const id = e.signalId || e.key;
      const nightlyHas = entries.some((n) => n.origin === "bot" && n.key === id);
      return !(e.day < today && nightlyHas);
    })
    .map((e) => liveExecToEntry(e, liveAcctName));
  const liveBotIds = new Set(liveBotEntries.map((e) => e.key));
  const liveManualEntries: JournalEntryLive[] = liveManualRows
    .filter((m) => m.day === today)
    .map((m) => liveManualToEntry(m, liveAcctName));
  const nightly = entries.filter((e) => {
    if (e.origin === "bot" && e.day === today && liveBotIds.has(e.key)) return false;
    if (e.origin === "manual" && e.day === today && liveManualEntries.length > 0) return false;
    return true;
  });
  const journalRows: (JournalEntry | JournalEntryLive)[] = [...liveBotEntries, ...liveManualEntries, ...nightly].sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key));
  const nBotRows = journalRows.filter((r) => r.origin === "bot").length;
  const nManualRows = journalRows.filter((r) => r.origin === "manual").length;
  const nLiveRows = journalRows.filter((r) => "live" in r).length;
  const liveTodayNet = Math.round(
    liveBotEntries.filter((r) => r.status === "matched").reduce((s, r) => s + r.netUsd, 0) * 100,
  ) / 100;

  /* ---- all-variables bot study table ---- */
  const deepFiltered = deepTrades.filter((r) => acctFilter === "all" || r.account === acctFilter);
  const varCell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(Math.round(v * 10000) / 10000);
    if (typeof v === "boolean") return v ? "1" : "0";
    return String(v);
  };
  const downloadCsv = () => {
    const csv = ledgerCsv(deepFiltered, deepVars.map((v) => v.key));
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `trades-${deepFiltered[0]?.day ?? "all"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main className="mx-auto w-full max-w-[1800px] px-4 py-6">
      {/* header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-bold tracking-widest text-zinc-100">TRADE JOURNAL</h1>
          <p className="font-mono text-[11px] text-zinc-500">
            one record per trade — explicit origin (bot · manual) · explicit account · signals → fills → anatomy → insights → gates
          </p>
        </div>
        <div className="flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
          <span className="rounded border border-zinc-800 px-2 py-1">dataset {analysis?.trades_n ?? "—"} trades</span>
          <span className="rounded border border-zinc-800 px-2 py-1">
            reconcile: {fmtUsd(run?.account_realized ?? null)} realized (history)
          </span>
          <span className="rounded border border-zinc-800 px-2 py-1">{activeOverrides.length} active gates</span>
        </div>
      </div>

      {/* range + ACCOUNT scope — every money number below respects both */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">range</span>
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
        <span className="mx-2 h-4 w-px bg-zinc-800" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">account</span>
        <button
          onClick={() => setAcctFilter("all")}
          title="every account, blended — the per-account strip below breaks it out"
          className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
            acctFilter === "all"
              ? "border-info/60 bg-info/10 text-info"
              : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
          }`}
        >
          ALL
        </button>
        {accountList.map((a) => {
          const roll = accounts.find((x) => x.account === a);
          return (
            <button
              key={a}
              onClick={() => setAcctFilter(a === acctFilter ? "all" : a)}
              title={`${a} · bot ${fmtUsd(roll?.botNet ?? null)} · manual ${fmtUsd(roll?.manualNet ?? null)} · all-time`}
              className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                acctFilter === a
                  ? "border-info/60 bg-info/10 text-info"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-200"
              }`}
            >
              {shortAcct(a)} {roll && <span className={roll.net >= 0 ? "text-long" : "text-short"}>{fmtUsd(roll.net)}</span>}
            </button>
          );
        })}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {scoreRange === "all" ? "all time" : `rolling ${scoreRange} days`} ·{" "}
          {acctFilter === "all" ? "every account" : `account ${shortAcct(acctFilter)} only`}
        </span>
      </div>

      {/* LIVE account — the number every tab shares (/api/account, the
          CrossTrade snapshot). This is the account's true current state;
          the reconcile block below is history. */}
      <div className="mb-5 rounded-md border border-info/30 bg-panel px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">LIVE account · CrossTrade → Tradovate</p>
            <p className="font-mono text-3xl font-bold text-zinc-50">
              {liveAccount?.account?.netLiq !== null && liveAccount?.account?.netLiq !== undefined
                ? `$${liveAccount.account.netLiq.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "…"}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">day P&L (guard)</p>
            <p className={`font-mono text-2xl font-bold ${(liveAccount?.guard?.dayPnl ?? 0) >= 0 ? "text-long" : "text-short"}`}>
              {fmtUsd(liveAccount?.guard?.dayPnl ?? null)}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">open P&L</p>
            <p className={`font-mono text-2xl font-bold ${(liveAccount?.account?.openPnl ?? 0) >= 0 ? "text-long" : "text-short"}`}>
              {fmtUsd(liveAccount?.account?.openPnl ?? null)}
            </p>
          </div>
          <div className="text-right font-mono text-[10px] text-zinc-400">
            {liveAccount?.position
              ? `position ${liveAccount.position.dir.toUpperCase()} ${liveAccount.position.qty} MNQ`
              : "flat"}
            <br />
            <AccountLine payload={liveAccount} />
          </div>
        </div>
      </div>

      {/* the reconcile snapshot — HISTORY (written by the nightly jobs
          container; the live numbers above are the ones every tab shares).
          Scoped to the selected account — a switch can never pollute it. */}
      {account && (
        <div className="mb-5 rounded-md border border-zinc-800 bg-panel px-4 py-3 opacity-80">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                Last reconcile snapshot · netLiq · {acctFilter === "all" ? account.account : shortAcct(account.account)}
              </p>
              <p className="font-mono text-3xl font-bold text-zinc-50">
                ${account.net.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">net profit / loss (vs {account.startBalance.toLocaleString("en-US")} start)</p>
              <p className={`font-mono text-2xl font-bold ${account.pnl >= 0 ? "text-long" : "text-short"}`}>
                {fmtUsd(account.pnl)}{" "}
                <span className="text-base">({account.pct >= 0 ? "+" : ""}{account.pct.toFixed(2)}%)</span>
              </p>
            </div>
            <div className="text-right font-mono text-[10px] text-zinc-500">
              {acctFilter !== "all" && <>{account.account}<br /></>}
              snapshot {account.at.slice(0, 16).replace("T", " ")}Z
            </div>
          </div>
        </div>
      )}

      {/* per-account strip — the all-time money per account, from the
          unified record; the headline cards below are the selected range */}
      {accounts.length > 1 && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {accounts.map((a) => (
            <button
              key={a.account}
              onClick={() => setAcctFilter(a.account === acctFilter ? "all" : a.account)}
              className={`rounded-md border bg-panel px-3 py-2 text-left ${acctFilter === a.account ? "border-info/60" : "border-zinc-800 hover:border-zinc-600"}`}
            >
              <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{a.account}</p>
              <p className={`font-mono text-lg font-bold ${a.net >= 0 ? "text-long" : "text-short"}`}>{fmtUsdSigned(a.net)}</p>
              <p className="font-mono text-[9px] text-zinc-600">
                bot {fmtUsd(a.botNet)} · manual {fmtUsd(a.manualNet)} · {a.firstDay.slice(5)} → {a.lastDay.slice(5)}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* headline — the glance layer (selected range × account) */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <GlanceCard
          label={`BOT NET${acctFilter !== "all" ? ` · ${shortAcct(acctFilter)}` : ""}`}
          value={fmtUsd(headline?.netUsd ?? null)}
          tone={(headline?.netUsd ?? 0) >= 0 ? "long" : "short"}
          sub={`gross ${fmtUsd(headline?.grossUsd ?? null)} · fees ${fmtUsd(headline ? -headline.commissions : null)} · ${headline?.matched ?? 0} matched`}
        />
        {liveBotEntries.length > 0 && (
          <GlanceCard
            label="TODAY · BOT LIVE ⚡"
            value={fmtUsd(liveTodayNet)}
            tone={liveTodayNet >= 0 ? "long" : "short"}
            sub={`${liveBotEntries.filter((r) => r.status === "matched").length} closed · live execution ledger`}
          />
        )}
        <GlanceCard
          label={`MANUAL NET${acctFilter !== "all" ? ` · ${shortAcct(acctFilter)}` : ""}`}
          value={manualTotal === null ? "—" : fmtUsd(manualTotal)}
          tone={(manualTotal ?? 0) >= 0 ? "long" : "short"}
          sub="broker round trips no signal explains · net"
        />
        <GlanceCard
          label="BOT + MANUAL"
          value={headline && manualTotal !== null ? fmtUsd(headline.netUsd + manualTotal) : "—"}
          tone={(headline?.netUsd ?? 0) + (manualTotal ?? 0) >= 0 ? "long" : "short"}
          sub="this range × account · net"
        />
        <GlanceCard
          label="WIN RATE"
          value={headline?.winRate != null ? `${(headline.winRate * 100).toFixed(0)}%` : "—"}
          tone={headline?.winRate != null && headline.winRate >= 0.5 ? "long" : "none"}
          sub={`${headline?.wins ?? 0}W / ${headline?.losses ?? 0}L / ${headline?.flats ?? 0}F · bot only`}
        />
        <GlanceCard
          label="EXPECTANCY"
          value={headline?.expectancy != null ? fmtUsd(headline.expectancy) : "—"}
          tone={(headline?.expectancy ?? 0) >= 0 ? "long" : "short"}
          sub="net per bot trade"
        />
      </div>
      <p className="mb-5 -mt-3 font-mono text-[10px] text-zinc-500">
        bot and manual nets are scoped to the selected range and account — the per-account strip above is the all-time rollup from the same unified record.
      </p>

      {/* equity curve + per-day breakdown (account-scoped) */}
      <div className="mb-5 grid grid-cols-1 gap-5 xl:grid-cols-5">
        <section className="rounded-md border border-zinc-800 bg-panel p-4 xl:col-span-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Account equity</h2>
            <span className="font-mono text-[10px] text-zinc-600">
              {equity.length
                ? `${equity[0].at.slice(0, 10)} → ${equity[equity.length - 1].at.slice(0, 10)} · netLiq snapshot per reconcile run · ${
                    acctFilter === "all" ? "ALL" : shortAcct(acctFilter)
                  }`
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
          {ledger.length > 1 && (
            <>
              <h3 className="mb-1 mt-3 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Balance reconciliation</h3>
              <div className="max-h-[220px] overflow-y-auto">
                <table className="w-full border-collapse font-mono text-[10px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr className="text-left text-zinc-500">
                      <th className="border-b border-zinc-800 py-1 pr-2 font-normal">snapshot</th>
                      <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">netLiq</th>
                      <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="account change since the previous snapshot (ground truth)">Δ acct</th>
                      <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="matched bot trades in this window (net)">bot net</th>
                      <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="Δ acct − bot net: manual trading, non-bot fees, deposits">manual</th>
                      <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="fills not attributable to any signal">fills</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.slice(1).map((l) => (
                      <tr key={l.at} className="text-zinc-400">
                        <td className="py-1 pr-2 whitespace-nowrap text-zinc-500">
                          {l.at.slice(0, 16).replace("T", " ")}Z{acctFilter === "all" && l.account ? ` ${shortAcct(l.account)}` : ""}
                        </td>
                        <td className="px-2 py-1 text-right">{fmtUsd(l.net)}</td>
                        <td className={`px-2 py-1 text-right ${(l.delta ?? 0) >= 0 ? "text-long" : "text-short"}`}>{l.delta === null ? "—" : fmtUsd(l.delta)}</td>
                        <td className={`px-2 py-1 text-right ${l.botNet >= 0 ? "text-long" : "text-short"}`}>{fmtUsd(l.botNet)}</td>
                        <td className={`px-2 py-1 text-right ${(l.manualResidual ?? 0) >= 0 ? "text-long" : "text-short"}`}>
                          {l.manualResidual === null ? "—" : fmtUsd(l.manualResidual)}
                        </td>
                        <td className="px-2 py-1 text-right text-zinc-500">{l.manualFills}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 font-mono text-[9px] leading-snug text-zinc-600">
                Δ acct = bot net + manual residual — the residual is the true manual bucket (manual trades, non-bot fees, deposits); it comes from the
                account snapshot, not from fill pairing. Snapshots are scoped to {acctFilter === "all" ? "each account" : shortAcct(acctFilter)} so a
                switch never pollutes the deltas.
              </p>
            </>
          )}
        </section>
        <section className="rounded-md border border-zinc-800 bg-panel p-4 xl:col-span-2">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Per-day P&L · bot</h2>
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
                        left: d.netUsd >= 0 ? "50%" : `${50 - Math.min(50, (Math.abs(d.netUsd) / Math.max(1, Math.max(...dayRows.map((x) => Math.abs(x.netUsd))))) * 50)}%`,
                        width: `${Math.min(50, (Math.abs(d.netUsd) / Math.max(1, Math.max(...dayRows.map((x) => Math.abs(x.netUsd))))) * 50)}%`,
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center font-mono text-xs text-zinc-600">no matched bot trades in this range</p>
          )}
        </section>
      </div>

      {/* execution log — the executor's own records (order attempts,
          watcher decisions); display-only, polled from /api/exec-log */}
      <section className="mb-5">
        <ExecLogPanel />
      </section>

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

        {/* right column: scoreboard + stats + the unified journal */}
        <div className="space-y-5 xl:col-span-3">
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Strategy scoreboard</h2>
              <span className="flex items-center gap-2">
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
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="hypothetical first-touch win rate over EVERY recorded card (replay outcomes, unfilled included) — the signal-quality view; compare with live fills to judge the gates">hyp WR</th>
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
                        <td className="px-2 py-1 text-right" title={s.hypN ? `all signals replayed: ${s.hypN} decided (win/loss)` : "no replay outcomes yet"}>
                          {s.hypWr === null ? (
                            <span className="text-zinc-600">—</span>
                          ) : (
                            <span className={s.hypWr >= 0.6 ? "text-info" : s.hypWr <= 0.4 ? "text-warn" : "text-zinc-400"}>
                              {pct(s.hypWr)}
                              <span className="text-zinc-600"> (n={s.hypN})</span>
                            </span>
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
              scoped to {acctFilter === "all" ? "every account" : `account ${shortAcct(acctFilter)}`} ·
              sort: net $ = account contribution · expR = mean gross R/trade (replay baseline until a family has ≥8 fills) · frequency = fills, then cards ·
              hyp WR = hypothetical first-touch win rate over EVERY recorded card (unfilled included) — signal quality, not money; a gap vs live expR measures what the gates + fills filter ·
              live n is small — treat ranks as provisional · skips = cards recorded but not filled (gates, retrace expiries, refusals) ·
              edge compares LIVE expR to the 648-session replay baseline only (edge OK &gt;= half · edge weak &lt; half · edge lost &lt;= 0) — it is a strategy-quality flag,
              never an account/guard metric (the MFF account guard is reported in /api/gc?action=health → execution.protections)
            </p>
          </section>

          {/* ---- winner/loser pattern explorer (same engine as the CLI) ---- */}
          <PatternExplorer />

          {/* ---- dedicated metric tables (one question each) ---- */}
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-zinc-400">Strategy performance</h2>
            <StatsTable rows={familyStats} />
            <p className="mt-1 font-mono text-[9px] text-zinc-600">study view from the nightly analysis — all accounts blended (bot trades only)</p>
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

          {/* ---- THE unified journal: every trade, one list ----
               origin is explicit on every row; accounts are explicit;
               today's live rows are merged in and deduped by identity. */}
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                Journal — every trade{" "}
                <span className="font-mono text-[10px] font-normal text-zinc-500">
                  {journalRows.length} rows · {nBotRows} bot · {nManualRows} manual{nLiveRows > 0 ? ` · ${nLiveRows} live today ⚡` : ""}
                </span>
              </h2>
              <span className="flex items-center gap-2 font-mono text-[9px] text-zinc-600">
                <span className="rounded border border-info/40 px-1 py-0.5 text-info" title="a trade backed by a signal card (nightly reconcile row or live execution ledger)">BOT</span>
                <span className="rounded border border-zinc-700 px-1 py-0.5 text-zinc-400" title="a broker round trip no signal explains (MFF/Tradovate import or the live manual detector) — hover for audit evidence">MANUAL</span>
                <span className="rounded border border-warn/50 px-1 py-0.5 text-warn" title="today's intraday row — the nightly reconcile has not run yet">⚡ live</span>
              </span>
            </div>
            {run?.notes && <p className="mb-2 font-mono text-[10px] text-warn">{run.notes}</p>}
            <div className="max-h-[640px] overflow-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">day · time</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">origin</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal" title="fire-time stamp from the fill record · ∂ = timeline fallback">acct</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">strategy / symbol</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">dir</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">fill → exit</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="gross / net after fees">gross / net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">result</th>
                  </tr>
                </thead>
                <tbody>
                  {journalRows.map((r) => {
                    const isLive = "live" in r;
                    const manualTip = r.origin === "manual" && r.audit
                      ? `${r.audit.reason}${r.audit.nearestSignal ? ` · signal ${r.audit.nearestSignal}` : ""}`
                      : "";
                    return (
                      <tr key={`${r.origin}|${r.key}|${isLive ? "live" : "nightly"}`} className={`align-top text-zinc-400 ${isLive ? "bg-zinc-900/40" : "hover:bg-zinc-900/50"}`}>
                        <td className="py-1 pr-2 whitespace-nowrap">
                          {r.day.slice(5)} {r.timeET || "—"}
                          {isLive && <span className="ml-1 text-warn" title="today's intraday row — the nightly reconcile has not run yet">⚡</span>}
                        </td>
                        <td className="px-2 py-1">
                          {r.origin === "bot" ? (
                            <span
                              className="rounded border border-info/40 bg-info/10 px-1 py-0.5 text-[8px] uppercase text-info"
                              title={`signal-backed${r.family ? ` · ${familyName(r.family)}` : ""}`}
                            >
                              bot
                            </span>
                          ) : (
                            <span
                              className="rounded border border-zinc-700 bg-zinc-800/40 px-1 py-0.5 text-[8px] uppercase text-zinc-400"
                              title={manualTip || "a broker round trip no signal explains — hover for audit evidence when labeled"}
                            >
                              manual
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap text-zinc-500" title={r.account}>
                          {shortAcct(r.account)}
                          {r.accountSource === "timeline" ? "·∂" : ""}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.origin === "bot" ? familyName(r.family) : r.symbol.replace("MNQ", "NQ")}
                        </td>
                        <td className={`px-2 py-1 font-semibold ${r.side === "long" ? "text-long" : "text-short"}`}>
                          {r.side.toUpperCase().slice(0, 1)}
                        </td>
                        <td className="px-2 py-1 text-right">{r.contracts || "—"}</td>
                        <td className="px-2 py-1 text-right whitespace-nowrap">
                          {r.status === "unexecuted" || (r.fillEntry === null && r.exitAvg === null && !isLive) ? (
                            <span className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 text-[8px] text-warn">NO FILL</span>
                          ) : (
                            `${fmtPx(r.fillEntry)} → ${fmtPx(r.exitAvg)}`
                          )}
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap" title={`fees ${fmtUsd(r.feesUsd)}`}>
                          {r.status === "matched" || isLive ? (
                            <>
                              {fmtUsd(r.grossUsd)} / <span className={(r.netUsd ?? 0) >= 0 ? "text-long" : "text-short"}>{fmtUsd(r.netUsd)}</span>
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.status === "unexecuted" ? (
                            <span className="text-zinc-600">unexecuted</span>
                          ) : isLive && r.result === "" ? (
                            <span className="text-warn" title="live — still open or not yet closed">open ⚡</span>
                          ) : (
                            <span className={`font-semibold ${RESULT_STYLE[r.result] ?? ""}`}>{r.result?.toUpperCase() || "—"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {loaded && journalRows.length === 0 && <p className="py-2 font-mono text-xs text-zinc-600">no trades in the unified record yet</p>}
            </div>
            <p className="mt-2 font-mono text-[9px] leading-snug text-zinc-600">
              one list for the whole journal: bot rows are signal-backed (nightly reconcile + today's live execution ledger); manual rows are broker
              round trips no signal explains (MFF/Tradovate import + today's live detector) — hover a manual row for the audit evidence · ∂ = account
              inferred from the switch timeline (no fire-time stamp) · ⚡ = today's intraday row (the reconcile only runs at night) · money is NET
              (fees included) everywhere on this page
            </p>
          </section>

          {/* ---- all-variables BOT study table (the training-dataset view) ---- */}
          <section className="rounded-md border border-zinc-800 bg-panel p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
                All bot trades · every variable
              </h2>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-500">
                  {deepFiltered.length} rows · source {deepSource || "—"} · {deepVars.length} variables · bot only
                </span>
                <button
                  onClick={() => setShowAllVars(!showAllVars)}
                  className={`rounded border px-1.5 py-0.5 ${showAllVars ? "border-info/60 bg-info/10 text-info" : "border-zinc-800 text-zinc-500 hover:text-zinc-200"}`}
                >
                  {showAllVars ? "VARS ON" : "VARS OFF"}
                </button>
                <button
                  onClick={downloadCsv}
                  className="rounded border border-long/40 px-1.5 py-0.5 text-long hover:bg-long/10"
                >
                  ↓ CSV
                </button>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-collapse font-mono text-[10px]">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr className="text-left text-zinc-500">
                    <th className="border-b border-zinc-800 py-1 pr-2 font-normal">day · time</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">acct</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">dir</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">n</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">strategy</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">signal</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">fill → exit</th>
                    <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">gross / net</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">result</th>
                    <th className="border-b border-zinc-800 px-2 py-1 font-normal">variation</th>
                    {showAllVars &&
                      deepVars.map((v) => (
                        <th key={v.key} title={`${v.key} · present on ${v.count} rows`} className="max-w-[130px] truncate border-b border-zinc-800 px-2 py-1 text-right font-normal">
                          {v.key}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {deepFiltered.map((r) => {
                    const flat = flattenFeatures(r.features);
                    const open = expandedKey === r.key;
                    return (
                      <Fragment key={r.key}>
                        <tr
                          onClick={() => setExpandedKey(open ? null : r.key)}
                          className={`cursor-pointer align-top text-zinc-400 ${open ? "bg-zinc-900" : "hover:bg-zinc-900/50"}`}
                        >
                          <td className="py-1 pr-2 whitespace-nowrap">
                            {r.day.slice(5)} {r.timeET || "—"}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-zinc-500" title={r.account}>
                            {shortAcct(r.account)}
                            {r.accountSource === "timeline" ? "·∂" : ""}
                          </td>
                          <td className={`px-2 py-1 font-semibold ${r.side === "long" ? "text-long" : "text-short"}`}>
                            {r.side.toUpperCase().slice(0, 1)}
                          </td>
                          <td className="px-2 py-1 text-right">{r.contracts || "—"}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{familyName(r.family)}</td>
                          <td className="px-2 py-1 text-right">{fmtPx(r.sigEntry)}</td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            {r.status === "no-fill" || r.status === "unexecuted" ? (
                              <span className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 text-[8px] text-warn">NO FILL</span>
                            ) : (
                              `${fmtPx(r.fillEntry)} → ${fmtPx(r.exitAvg)}`
                            )}
                          </td>
                          <td className="px-2 py-1 text-right whitespace-nowrap">
                            {fmtUsd(r.grossUsd)} / <span className={(r.netUsd ?? 0) >= 0 ? "text-long" : "text-short"}>{fmtUsd(r.netUsd)}</span>
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            {r.status === "matched" ? (
                              <span className="flex items-center gap-1">
                                <span className="font-semibold">{r.result.toUpperCase() || "—"}</span>
                                {r.stopRun && <span title="stop-run">⛔</span>}
                                {r.targetReached && <span title="target was in range">🎯</span>}
                                {r.recovered && <span title="price recovered after exit">↩</span>}
                              </span>
                            ) : (
                              <span className="text-zinc-600">{r.reason || "vetoed"}</span>
                            )}
                          </td>
                          <td className="px-2 py-1 whitespace-nowrap text-zinc-500" title={r.variationId ?? ""}>
                            {r.variationId ? r.variationId.slice(0, 8) : "—"}
                          </td>
                          {showAllVars &&
                            deepVars.map((v) => (
                              <td key={v.key} className="max-w-[130px] truncate px-2 py-1 text-right text-zinc-500">
                                {varCell(flat[v.key])}
                              </td>
                            ))}
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={10 + (showAllVars ? deepVars.length : 0)} className="border-b border-zinc-800 bg-zinc-950/60 px-2 py-2">
                              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                                <div>
                                  <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">card</p>
                                  <p className="text-[10px] leading-relaxed text-zinc-400">{r.verdict || "—"}</p>
                                  <p className="text-[10px] text-zinc-500">{r.headline}</p>
                                  <p className="mt-1 text-[10px] text-zinc-600">
                                    {r.size} · {r.source} · sent {r.sent ? "✓" : "✗"}
                                    {r.reason ? ` · ${r.reason}` : ""}
                                  </p>
                                </div>
                                <div>
                                  <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">levels & anatomy</p>
                                  <p className="text-[10px] text-zinc-400">
                                    sig {fmtPx(r.sigEntry)} · stop {fmtPx(r.sigStop)} · target {fmtPx(r.sigTarget)}
                                  </p>
                                  <p className="text-[10px] text-zinc-400">
                                    fill {fmtPx(r.fillEntry)} → exit {fmtPx(r.exitAvg)} · drift {fmtPts(r.drift)} · MFE {fmtPts(r.mfe)} · MAE{" "}
                                    {fmtPts(r.mae)} · held {r.heldMin === null ? "—" : `${Math.round(r.heldMin)}m`}
                                  </p>
                                  <p className="text-[10px] text-zinc-600">{r.lossLabel ? `loss class: ${r.lossLabel}` : ""}</p>
                                </div>
                                <div>
                                  <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                                    variation {r.variationId ? r.variationId.slice(0, 8) : "—"}
                                    {r.buildSha ? ` · ${r.buildSha.slice(0, 7)}` : ""}
                                  </p>
                                  {r.settings ? (
                                    <div className="max-h-40 overflow-y-auto">
                                      <table className="w-full font-mono text-[9px] text-zinc-500">
                                        <tbody>
                                          {Object.entries(r.settings)
                                            .sort(([a], [b]) => a.localeCompare(b))
                                            .map(([k, v]) => (
                                              <tr key={k}>
                                                <td className="pr-2 whitespace-nowrap">{k}</td>
                                                <td className="break-all text-zinc-400">{v || "—"}</td>
                                              </tr>
                                            ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-zinc-600">no boot record for this day</p>
                                  )}
                                </div>
                                <div className="md:col-span-2 xl:col-span-3">
                                  <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
                                    variables at signal time ({Object.keys(flat).length})
                                  </p>
                                  {Object.keys(flat).length ? (
                                    <div className="space-y-2">
                                      {groupFeatures(flat).map((g) => (
                                        <div key={g.key}>
                                          <div className="mb-0.5 flex items-baseline justify-between gap-2">
                                            <span className={`text-[9px] font-bold uppercase tracking-wider ${g.role === "signal" ? "text-long" : "text-zinc-500"}`}>
                                              {g.label}
                                            </span>
                                            <span
                                              className={`rounded border px-1 py-px text-[8px] uppercase ${
                                                g.role === "signal" ? "border-long/40 bg-long/10 text-long" : "border-zinc-700 bg-zinc-800/40 text-zinc-500"
                                              }`}
                                            >
                                              {g.role === "signal" ? "drives signal" : "study only"}
                                            </span>
                                          </div>
                                          <p className="mb-1 text-[8px] text-zinc-600">{g.note}</p>
                                          <div className="grid grid-cols-2 gap-x-4 md:grid-cols-4 xl:grid-cols-6">
                                            {g.entries.map(([k, v]) => (
                                              <div key={k} className="flex min-w-0 justify-between gap-2 border-b border-zinc-900 py-0.5">
                                                <span className="truncate text-zinc-500" title={k}>
                                                  {k}
                                                </span>
                                                <span className="whitespace-nowrap text-zinc-300">{varCell(v)}</span>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-zinc-600">
                                      no feature vector recorded (trades from before feature capture)
                                    </p>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {loaded && deepTrades.length === 0 && (
                <p className="py-2 font-mono text-xs text-zinc-600">no trades in the ledger yet</p>
              )}
            </div>
            <p className="mt-2 font-mono text-[9px] text-zinc-600">
              bot study view — click a row for the full variable dump · VARS ON appends every distinct signal-time variable as a column · ↓ CSV exports the
              flat training table (core + all variables) · ∂ = account inferred from the switch timeline · variables include
              context that does not participate in the signal (dom, walls, ES/seasonal/round-number context, kelly, gates)
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
