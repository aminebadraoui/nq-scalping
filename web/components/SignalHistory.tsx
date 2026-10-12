"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cdtToET } from "@/lib/times";
import { flattenFeatures } from "@/lib/tradeLedger";
import { groupFeatures } from "@/lib/featureGroups";
import { familyName } from "@/lib/familyNames";

type CompactCandidate = {
  side: "bid" | "ask";
  price: number;
  size: number;
  refillSize: number;
  refills: number;
  absorbed: number;
  consistency: number;
  confidence: number;
};

type DomContext = {
  nq: {
    ts: number;
    candidates: CompactCandidate[];
    nearEntry: CompactCandidate[];
    nearStop: CompactCandidate[];
    nearTarget: CompactCandidate[];
  };
  es: { ts: number; candidates: CompactCandidate[] };
};

export type HistoryEntry = {
  /** signals.key — the stable signal id (used to link execution rows) */
  id?: string;
  ts: number;
  timeET: string;
  day: string;
  symbol: string;
  side: "long" | "short" | "none";
  price: number;
  entry: string;
  stop: string;
  target: string;
  size?: string;
  verdict: string;
  headline: string;
  source: string;
  test: boolean;
  sent: boolean;
  reason: string;
  dom?: DomContext | null;
  /** the full feature vector recorded at fire time — signal inputs + study-only context */
  features?: Record<string, unknown> | null;
  /** strategy family id when the feed passes it top-level (otherwise read from features.family) */
  family?: string;
  /** post-fire price-replay score: win | loss | time | open | "" (unscored) */
  outcome?: string;
  exitPrice?: number | null;
  exitTime?: string;
  exitReason?: string;
  mfePts?: number | null;
  maePts?: number | null;
};

type SignalResponse = {
  ok: boolean;
  live: boolean;
  note: string | null;
  lastError: string | null;
  history: HistoryEntry[];
};

/** one executed-signal ledger row (lib/execTracker.ts, via /api/executions) */
type ExecRow = {
  key: string;
  signalId: string;
  ts: number;
  day: string;
  timeET: string;
  label: string;
  side: "long" | "short";
  contracts: number;
  sigEntry: number;
  orderId: string;
  status: "placed" | "filled" | "closed" | "failed";
  fillEntry: number | null;
  exitAvg: number | null;
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: "" | "win" | "loss" | "flat";
};

const SIDE_STYLE: Record<HistoryEntry["side"], string> = {
  long: "border-long/50 bg-long/10 text-long",
  short: "border-short/50 bg-short/10 text-short",
  none: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};

const SIDE_LABEL: Record<HistoryEntry["side"], string> = {
  long: "LONG",
  short: "SHORT",
  none: "—",
};

const OUTCOME_STYLE: Record<string, string> = {
  win: "border-long/40 bg-long/10 text-long",
  loss: "border-short/40 bg-short/10 text-short",
  time: "border-zinc-600 bg-zinc-800/40 text-zinc-300",
  open: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

const OUTCOME_LABEL: Record<string, string> = {
  win: "✓ win",
  loss: "✗ loss",
  time: "⏱ time",
  open: "● open",
};

function outcomeTitle(e: HistoryEntry): string {
  if (!e.outcome) return "";
  const pnl =
    e.exitPrice !== null && e.exitPrice !== undefined && Number.isFinite(e.exitPrice)
      ? (e.exitPrice - (parseFloat(e.entry) || e.price)) * (e.side === "long" ? 1 : -1)
      : 0;
  const parts = [`exit ${e.exitReason || "—"}`];
  if (e.exitTime) parts.push(`@ ${cdtToET(e.exitTime)} NY`);
  if (Number.isFinite(pnl)) parts.push(`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} pts`);
  if (e.mfePts !== null && e.mfePts !== undefined) parts.push(`MFE ${e.mfePts.toFixed(2)}`);
  if (e.maePts !== null && e.maePts !== undefined) parts.push(`MAE ${e.maePts.toFixed(2)}`);
  return parts.join(" · ");
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const featVal = (v: unknown): string => {
  if (typeof v === "number") return String(Math.round(v * 10000) / 10000);
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
};

export default function SignalHistory({ onInspect }: { onInspect?: (e: HistoryEntry) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [execs, setExecs] = useState<ExecRow[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [featIds, setFeatIds] = useState<Set<string>>(new Set());
  const toggleFeat = (id: string) => {
    setFeatIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const closedCount = entries.filter((e) => e.outcome === "win" || e.outcome === "loss").length;
  const wins = entries.filter((e) => e.outcome === "win").length;
  const openCount = entries.filter((e) => e.outcome === "open").length;
  const timeCount = entries.filter((e) => e.outcome === "time").length;

  /** the execution-row for a signal: by signalId first, then the fuzzy
   *  day/time/side/entry fallback (exec rows link signals best-effort) */
  const execFor = (e: HistoryEntry): ExecRow | null => {
    if (!execs.length) return null;
    if (e.id) {
      const byId = execs.find((x) => x.signalId === e.id);
      if (byId) return byId;
    }
    const entryNum = parseFloat(e.entry);
    const entryRef = Number.isFinite(entryNum) ? entryNum : e.price;
    return (
      execs.find(
        (x) =>
          x.day === e.day &&
          x.timeET === e.timeET &&
          x.side === e.side &&
          Math.abs(x.sigEntry - entryRef) <= 1 &&
          Math.abs(x.ts - e.ts) <= 5 * 60_000,
      ) ?? null
    );
  };

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/signal")
        .then((r) => r.json())
        .then((j: SignalResponse) => {
          if (cancelled || !j.ok) return;
          setEntries(j.history ?? []);
          setLive(j.live);
          setNote(j.lastError ?? j.note ?? null);
          setLoaded(true);
        })
        .catch(() => {});
      fetch("/api/executions", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: { ok: boolean; rows?: ExecRow[] }) => {
          if (cancelled || !j.ok) return;
          setExecs(j.rows ?? []);
        })
        .catch(() => {});
    };
    tick();
    timerRef.current = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Signal history</h2>
        <span className={`font-mono text-[10px] ${live ? "text-long" : "text-zinc-500"}`}>
          {live === null ? "…" : live ? "feed live" : "feed idle"}
        </span>
      </div>

      <p className="mb-2 font-mono text-[10px] leading-snug text-zinc-500">
        every Telegram push from the always-on signal feed — the completed reversal sequence
        (location + mechanism + trigger), most recent first ·{" "}
        {onInspect ? <span className="text-warn">click a signal to visualize its trade on the chart</span> : null}
      </p>

      {note && <p className="mb-2 font-mono text-[10px] text-warn">{note}</p>}

      {loaded && entries.some((e) => e.outcome) && (
        <p className="mb-2 font-mono text-[10px] text-zinc-500">
          {closedCount > 0 ? (
            <>
              last {closedCount} closed: <span className="text-long">{wins}W</span> / <span className="text-short">{closedCount - wins}L</span>
              {timeCount > 0 ? <span className="text-zinc-400"> · {timeCount}⏱</span> : null}
              {openCount > 0 ? <span className="text-amber-300"> · {openCount} open</span> : null}
            </>
          ) : (
            <>
              {timeCount > 0 ? <span className="text-zinc-400">{timeCount}⏱</span> : null}
              {openCount > 0 ? <span className="text-amber-300">{openCount} open so far</span> : null}
            </>
          )}
        </p>
      )}

      {loaded && entries.length === 0 && (
        <p className="font-mono text-xs text-zinc-600">
          no signals pushed yet — a card is sent the moment the sequence completes
        </p>
      )}

      <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
        {entries.map((e) => {
          const id = `${e.ts}|${e.day}|${e.side}|${e.price}`;
          const active = activeId === id;
          const groups = groupFeatures(flattenFeatures(e.features));
          const featOpen = featIds.has(id);
          const exec = execFor(e);
          // the strategy family: featureRegistry.ts records it inside the
          // features vector; the feed may also pass it top-level
          const familyId =
            typeof e.features?.family === "string" ? e.features.family : typeof e.family === "string" ? e.family : "";
          return (
            <div
              key={id}
              role={onInspect ? "button" : undefined}
              tabIndex={onInspect ? 0 : undefined}
              onClick={() => {
                if (!onInspect) return;
                setActiveId(active ? null : id);
                onInspect(e); // the page toggles: clicking the same signal clears the view
              }}
              onKeyDown={(ev) => {
                if (onInspect && (ev.key === "Enter" || ev.key === " ")) {
                  ev.preventDefault();
                  setActiveId(id);
                  onInspect(e);
                }
              }}
              className={`rounded border border-zinc-800/70 px-2 py-1.5 transition-colors ${
                onInspect ? "cursor-pointer hover:border-zinc-600 hover:bg-zinc-900/60" : ""
              } ${active ? "border-amber-400/60 bg-amber-400/5" : ""}`}
            >
            <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="text-zinc-400">
                {e.day} {e.timeET || "—"} NY
              </span>
              <span className="flex items-center gap-1.5">
                {familyId ? (
                  <Link
                    href={`/strategies#strategy-${familyId}`}
                    onClick={(ev) => ev.stopPropagation()}
                    title={`strategy family ${familyId} — open the live strategy card`}
                    className="rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                  >
                    {familyName(familyId)}
                  </Link>
                ) : null}
                {exec ? (
                  <span
                    title={
                      exec.status === "closed"
                        ? `executed on Tradovate · order ${exec.orderId || "—"} · fill ${exec.fillEntry ?? "—"} → exit ${exec.exitAvg ?? "—"} · pts ${exec.pts ?? "—"} · gross ${exec.grossUsd < 0 ? "−" : "+"}$${Math.abs(exec.grossUsd).toFixed(2)} · fees −$${exec.feesUsd.toFixed(2)}`
                        : exec.status === "filled"
                          ? `executed on Tradovate · order ${exec.orderId || "—"} · filled @ ${exec.fillEntry}`
                          : exec.status === "failed"
                            ? "execution failed — see Execution log"
                            : "order dispatched — awaiting fill"
                    }
                    className={`rounded border px-1 py-0.5 text-[9px] font-semibold ${
                      exec.status === "closed"
                        ? exec.result === "win"
                          ? "border-long/40 bg-long/10 text-long"
                          : exec.result === "loss"
                            ? "border-short/40 bg-short/10 text-short"
                            : "border-zinc-600 text-zinc-300"
                        : exec.status === "filled"
                          ? "border-info/40 bg-info/10 text-info"
                          : exec.status === "failed"
                            ? "border-short/40 bg-short/10 text-short"
                            : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    }`}
                  >
                    {exec.status === "closed"
                      ? `${exec.result === "win" ? "✓" : exec.result === "loss" ? "✗" : "="} ${exec.netUsd < 0 ? "−" : "+"}$${Math.abs(exec.netUsd).toFixed(2)}`
                      : exec.status === "filled"
                        ? "● filled"
                        : exec.status === "failed"
                          ? "✗ failed"
                          : "◌ placed"}
                  </span>
                ) : null}
                {e.outcome && OUTCOME_LABEL[e.outcome] ? (
                  <span title={outcomeTitle(e)} className={`rounded border px-1 py-0.5 text-[9px] font-semibold ${OUTCOME_STYLE[e.outcome] ?? "border-zinc-700 text-zinc-500"}`}>
                    {OUTCOME_LABEL[e.outcome]}
                  </span>
                ) : null}
                {e.test && <span className="rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-500">manual</span>}
                <span className={`rounded border px-1 py-0.5 text-[9px] ${e.sent ? "border-info/40 bg-info/10 text-info" : "border-short/40 bg-short/10 text-short"}`}>
                  {e.sent ? "✓ sent" : "✗ failed"}
                </span>
                <span className={`rounded border px-1 py-0.5 text-[9px] font-semibold ${SIDE_STYLE[e.side]}`}>
                  {SIDE_LABEL[e.side]}
                </span>
                {groups.length > 0 && (
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleFeat(id);
                    }}
                    className={`rounded border px-1 py-0.5 text-[9px] transition-colors ${
                      featOpen ? "border-info/60 bg-info/10 text-info" : "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                    }`}
                    title="signal inputs + study context recorded at fire time"
                  >
                    FEATURES ▾
                  </button>
                )}
              </span>
            </div>

            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="font-mono text-[13px] font-semibold text-zinc-100">
                {e.symbol} {fmt(e.price)}
              </span>
              <span className="break-words text-right font-mono text-[10px] leading-snug text-zinc-500">{e.verdict}</span>
            </div>

            <div className="mt-1 grid grid-cols-1 gap-0.5 font-mono text-[10px] leading-snug text-zinc-400">
              <span><span className="text-zinc-600">ENTRY</span> {e.entry || "—"}</span>
              <span><span className="text-zinc-600">STOP</span> {e.stop || "—"}</span>
              <span><span className="text-zinc-600">TARGET</span> {e.target || "—"}</span>
              <span><span className="text-zinc-600">SIZE</span> {e.size || "—"}</span>
            </div>

            {/* the full feature vector, grouped: what made the signal vs what was only observed */}
            {featOpen && groups.length > 0 && (
              <div className="mt-1.5 space-y-1.5 border-t border-zinc-800/60 pt-1 font-mono text-[9px] leading-snug">
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={`font-bold uppercase tracking-wider ${g.role === "signal" ? "text-long" : "text-zinc-500"}`}>
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
                    <div className="grid grid-cols-2 gap-x-4 md:grid-cols-3">
                      {g.entries.map(([k, v]) => (
                        <div key={k} className="flex min-w-0 justify-between gap-2 border-b border-zinc-900 py-0.5">
                          <span className="truncate text-zinc-500" title={k}>{k}</span>
                          <span className="whitespace-nowrap text-zinc-300">{featVal(v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* the DOM picture captured at signal time — observational only */}
            {e.dom && (
              <div className="mt-1 border-t border-zinc-800/60 pt-0.5 font-mono text-[9px] leading-snug text-zinc-500">
                <div className="text-zinc-600">DOM @ signal</div>
                {(
                  [
                    ["entry", e.dom.nq.nearEntry],
                    ["stop", e.dom.nq.nearStop],
                    ["target", e.dom.nq.nearTarget],
                  ] as [string, CompactCandidate[]][]
                ).map(([label, rows]) =>
                  rows.map((c, i) => (
                    <div key={`${label}|${i}`} className="flex justify-between">
                      <span>
                        <span className={c.side === "bid" ? "text-long" : "text-short"}>{c.side === "bid" ? "BID" : "ASK"}</span>{" "}
                        {fmt(c.price)} near {label} · refills {c.refills} · slice {c.refillSize} · abs {c.absorbed}
                      </span>
                      <span title={`confidence ${(c.confidence * 100).toFixed(0)}%`}>
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  )),
                )}
                {e.dom.es.candidates.map((c, i) => (
                  <div key={`es|${i}`} className="flex justify-between">
                    <span>
                      <span className="text-zinc-600">ES</span>{" "}
                      <span className={c.side === "bid" ? "text-long" : "text-short"}>{c.side === "bid" ? "BID" : "ASK"}</span>{" "}
                      {fmt(c.price)} · refills {c.refills} · slice {c.refillSize} · abs {c.absorbed}
                    </span>
                    <span title={`confidence ${(c.confidence * 100).toFixed(0)}%`}>
                      {(c.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
                {e.dom.nq.candidates.length === 0 && e.dom.es.candidates.length === 0 && <div>no refill signatures in the window</div>}
              </div>
            )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
