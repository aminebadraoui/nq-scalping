"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReversalReadView, { type SignalRead } from "@/components/ReversalReadView";
import type { LiveReads, DetectorRead, GateRow, ArmedNote } from "@/lib/liveReads";

/* ------------------------------------------------------------------ *
 * LiveSignalBoard — ONE place to see the live signal read of EVERY
 * strategy, not just the reversal composer.
 *
 * Before this board, /api/signal only carried the reversal composer's
 * standing state (computeSignal recomputes every cycle), so the panel
 * could only show "Live signal · reversal read". The direct detectors
 * (momentum flush, expansion, RTH, open drive) are edge detectors —
 * they only produce output on the bar that fires. lib/liveReads.ts now
 * builds each strategy's standing read from the SAME inputs the feed
 * trades (memoized detectors + PROD configs), so this board shows:
 *
 *   · FLUSH / EXP / RTH / OPEN — detector fire state on the just-closed
 *     bar, the ingredient gauges (measured vs threshold), armed states,
 *     and the day's fires with outcomes.
 *   · REV — the full reversal composer read (boxes, votes, checklist,
 *     card gate) that used to be the only read available.
 *   · GATES — news blackout, signal window, trading halt, tape source,
 *     active strategy_overrides — the shared gates every card passes.
 *
 * The armed strip above the tabs surfaces anything that is currently
 * ARMED (e.g. a resting expansion-retrace limit) no matter which tab
 * is open. Polls /api/signal every 15s like the old panel did.
 * ------------------------------------------------------------------ */

type BoardResponse = {
  ok: boolean;
  live: boolean;
  note: string | null;
  feeds: Record<string, boolean> | null;
  signal: SignalRead | null;
  reads: LiveReads | null;
};

type TabId = "flush" | "exp" | "ses" | "open" | "rev" | "gates";

const TABS: { id: TabId; label: string; detectorId?: string }[] = [
  { id: "flush", label: "FLUSH", detectorId: "failed_flush_breakout" },
  { id: "exp", label: "EXP", detectorId: "huge_bar_expansion" },
  { id: "ses", label: "CONT", detectorId: "session_continuation" },
  { id: "open", label: "OPEN", detectorId: "open_drive" },
  { id: "rev", label: "REV" },
  { id: "gates", label: "GATES" },
];

const GAUGE_STYLE: Record<string, string> = {
  pass: "border-long/50 bg-long/10 text-long",
  fail: "border-short/50 bg-short/10 text-short",
  info: "border-info/40 bg-info/10 text-info",
  na: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};

const GAUGE_ICON: Record<string, string> = { pass: "✓", fail: "✗", info: "·", na: "—" };

const GATE_STYLE: Record<string, string> = {
  ok: "border-long/50 bg-long/10 text-long",
  block: "border-short/50 bg-short/10 text-short",
  info: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};

const f2 = (n: number) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

function tabDot(d: DetectorRead | undefined): string {
  if (!d) return "bg-zinc-600";
  if (d.firedNow) return "bg-long animate-pulse";
  if (d.feedOn && d.window.open) return "bg-yellow-400";
  return "bg-zinc-600";
}

function StatusChips({ d }: { d: DetectorRead }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
      <span className={`rounded border px-1.5 py-0.5 font-semibold ${d.feedOn ? "border-long/40 bg-long/10 text-long" : "border-zinc-700 bg-zinc-800/40 text-zinc-400"}`}>
        FEED {d.feedOn ? "ON" : "OFF"}
      </span>
      <span className={`rounded border px-1.5 py-0.5 ${d.window.open ? "border-info/40 bg-info/10 text-info" : "border-zinc-700 bg-zinc-800/40 text-zinc-400"}`}>
        {d.window.note}
      </span>
      <span className={`rounded border px-1.5 py-0.5 ${d.tape.live ? "border-long/40 bg-long/10 text-long" : "border-short/40 bg-short/10 text-short"}`}>
        {d.tape.note}
      </span>
    </div>
  );
}

function FiredBanner({ d }: { d: DetectorRead }) {
  if (!d.firedNow) return null;
  const dirCls = d.firedNow.dir === "long" ? "border-long/60 bg-long/10 text-long" : "border-short/60 bg-short/10 text-short";
  return (
    <div className={`rounded border px-2 py-1.5 font-mono text-[10px] leading-snug ${dirCls}`}>
      <p className="font-bold">
        ⚡ DETECTOR FIRED THIS BAR — {d.firedNow.dir === "long" ? "🟢 LONG" : "🔴 SHORT"}
        {d.firedNow.kind === "expansion" ? " · expansion" : ""}
      </p>
      <p className="mt-0.5 break-words text-zinc-300">
        ENTRY {f2(d.firedNow.entry)} · STOP {f2(d.firedNow.stop)} · TARGET {f2(d.firedNow.target)}
        {d.tail ? ` · ${d.tail.timeET} NY` : ""}
      </p>
      <p className="mt-0.5 text-zinc-500">the feed gates/dedupes this candidate — the actual card lands in history</p>
    </div>
  );
}

function ArmedStrip({ notes }: { notes: ArmedNote[] }) {
  if (!notes.length) return null;
  return (
    <div className="space-y-1">
      {notes.map((n, i) => (
        <div key={i} className="rounded border border-warn/50 bg-warn/10 px-2 py-1.5 font-mono text-[10px] leading-snug text-warn">
          <span className="font-bold">◐ ARMED — </span>
          <span className="break-words">{n.text}</span>
        </div>
      ))}
    </div>
  );
}

function Gauges({ d }: { d: DetectorRead }) {
  return (
    <div className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-1.5 font-mono text-[10px]">
        <span className="font-bold uppercase tracking-wider text-zinc-200">live read — the just-closed bar</span>
        <span className="text-zinc-500">{d.tail ? `${d.tail.day} ${d.tail.timeET} NY · ${f2(d.tail.price)}` : "no bar"}</span>
      </div>
      <div className="mt-1.5 space-y-1">
        {d.gauges.map((g) => (
          <div key={g.key} className="border-t border-zinc-800/60 pt-1 font-mono text-[10px] leading-snug">
            <div className="flex items-start justify-between gap-2">
              <span className="shrink-0 text-zinc-400">{g.label}</span>
              <span className={`rounded border px-1 py-px text-[9px] font-bold ${GAUGE_STYLE[g.state]}`}>
                {GAUGE_ICON[g.state]}
              </span>
            </div>
            <p className="mt-0.5 break-words text-zinc-300">{g.value}</p>
            <p className="break-words text-zinc-500">need {g.need}</p>
            {g.note && <p className="break-words text-zinc-600">{g.note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayLine({ d }: { d: DetectorRead }) {
  const last = d.lastFire;
  return (
    <div className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5 font-mono text-[10px]">
      <span className="text-zinc-400">
        today: <span className="font-bold text-zinc-200">{d.todayCount}</span> fire{d.todayCount === 1 ? "" : "s"}
        {d.gapBars !== null && <span className="text-zinc-500"> · {d.gapBars} bar{d.gapBars === 1 ? "" : "s"} since the last</span>}
      </span>
      {last && (
        <span className="text-zinc-500">
          last {last.timeET} NY ·{" "}
          <span className={last.outcome === "win" ? "text-long" : last.outcome === "loss" ? "text-short" : "text-zinc-400"}>
            {last.outcome || "open"}
          </span>
        </span>
      )}
    </div>
  );
}

function DetectorTab({ d }: { d: DetectorRead }) {
  return (
    <div className="space-y-2">
      <StatusChips d={d} />
      <FiredBanner d={d} />
      <ArmedStrip notes={d.armed} />
      <DayLine d={d} />
      <Gauges d={d} />
      <p className="font-mono text-[9px] leading-snug text-zinc-600">
        thresholds rendered live from the strategy registry (lib/strategies/registry.ts) — the same config objects the feed trades.{" "}
        <Link href={`/strategies#strategy-${d.id}`} className="text-zinc-400 underline hover:text-zinc-200">
          full conditions →
        </Link>
      </p>
    </div>
  );
}

function GatesTab({ gates, feeds }: { gates: GateRow[]; feeds: Record<string, boolean> | null }) {
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {gates.map((g) => (
          <div key={g.label} className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
            <div className="flex items-start justify-between gap-2 font-mono text-[10px] leading-snug">
              <span className="shrink-0 font-semibold uppercase tracking-wider text-zinc-300">{g.label}</span>
              <span className={`rounded border px-1 py-px text-[9px] font-bold ${GATE_STYLE[g.state]}`}>
                {g.state === "ok" ? "OPEN" : g.state === "block" ? "BLOCKED" : "INFO"}
              </span>
            </div>
            <p className="mt-0.5 break-words font-mono text-[10px] leading-snug text-zinc-500">{g.text}</p>
          </div>
        ))}
      </div>
      {feeds && (
        <div className="rounded border border-zinc-800/70 bg-zinc-900/40 px-2 py-1.5">
          <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-300">feed switches</p>
          <div className="flex flex-wrap gap-1">
            {Object.entries(feeds).map(([k, v]) => (
              <span
                key={k}
                title={k}
                className={`rounded border px-1 py-px font-mono text-[9px] ${v ? "border-long/40 bg-long/10 text-long" : "border-zinc-700 bg-zinc-800/40 text-zinc-500"}`}
              >
                {k} {v ? "ON" : "OFF"}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="font-mono text-[9px] leading-snug text-zinc-600">
        every card passes these gates before anything is sent — the full pipeline lives on the{" "}
        <Link href="/strategies" className="text-zinc-400 underline hover:text-zinc-200">
          strategies page
        </Link>
        .
      </p>
    </div>
  );
}

export default function LiveSignalBoard() {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [tab, setTab] = useState<TabId>("flush");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/signal", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: BoardResponse) => {
          if (!cancelled && j.ok) setData(j);
        })
        .catch(() => {});
    };
    tick();
    timerRef.current = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const reads = data?.reads ?? null;
  const detectors = reads?.detectors ?? [];
  const byId = (id: string) => detectors.find((d) => d.id === id) ?? undefined;

  return (
    <section id="live-board" className="scroll-mt-14 rounded-md border border-zinc-800 bg-panel p-3">
      {/* ---- header ---- */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Live signal board · all strategies</h2>
        <span className={`font-mono text-[10px] ${data?.live ? "text-long" : "text-zinc-500"}`}>
          {data === null ? "…" : data.live ? "feed live" : "feed idle"}
          {reads?.asOf?.live && reads.asOf.day ? ` · ${reads.asOf.day} ${reads.asOf.timeET}` : ""}
        </span>
      </div>

      {/* ---- armed strip: whatever is armed right now, no matter the tab ---- */}
      <ArmedStrip notes={reads?.hotArmed ?? []} />

      {/* ---- tabs ---- */}
      <div className="mb-2 flex flex-wrap gap-1">
        {TABS.map((t) => {
          const d = t.detectorId ? byId(t.detectorId) : undefined;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors ${
                active
                  ? "border-info/60 bg-info/10 text-info"
                  : "border-zinc-700 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${t.detectorId ? tabDot(d) : "bg-zinc-600"}`} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ---- tab content ---- */}
      {tab === "rev" && (
        <ReversalReadView feeds={data?.feeds ?? null} signal={data?.signal ?? null} />
      )}
      {tab === "gates" && <GatesTab gates={reads?.gates ?? []} feeds={data?.feeds ?? null} />}
      {tab !== "rev" && tab !== "gates" && (
        <>
          {(() => {
            const t = TABS.find((x) => x.id === tab);
            const d = t?.detectorId ? byId(t.detectorId) : undefined;
            if (!d) {
              return (
                <p className="font-mono text-[10px] leading-snug text-zinc-500">
                  no live read yet — the read computes from the live tape every poll (market closed or feed warming up)
                </p>
              );
            }
            return <DetectorTab d={d} />;
          })()}
        </>
      )}
    </section>
  );
}
