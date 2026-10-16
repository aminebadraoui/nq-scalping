"use client";

import { useMemo, useState } from "react";
import { derivePipeline, pipelineOverall, type PipelineLevel, type PipelineStage } from "@/lib/pipelineHealth";
import type { ExecHealth } from "@/lib/useExecStatus";

/* ------------------------------------------------------------------ *
 * HealthPipeline — the signal → execution health pipeline strip at
 * the top of the dashboard. One node per production step, each with
 * its live health level (ok / warn / down / off / idle) and the
 * metric behind it. Click a node for the full breakdown.
 * DISPLAY-ONLY: every value comes from /api/gc?action=health.
 * ------------------------------------------------------------------ */

const LEVEL_TEXT: Record<PipelineLevel, string> = {
  ok: "text-long",
  warn: "text-warn",
  down: "text-short",
  idle: "text-info",
  off: "text-zinc-500",
  unknown: "text-zinc-500",
};

const LEVEL_BAR: Record<PipelineLevel, string> = {
  ok: "bg-long",
  warn: "bg-warn",
  down: "bg-short",
  idle: "bg-info",
  off: "bg-zinc-600",
  unknown: "bg-zinc-700",
};

const LEVEL_DOT: Record<PipelineLevel, string> = {
  ok: "bg-long shadow-[0_0_6px_rgba(52,211,153,0.9)]",
  warn: "bg-warn shadow-[0_0_6px_rgba(251,191,36,0.9)] animate-pulse",
  down: "bg-short shadow-[0_0_6px_rgba(248,113,113,0.9)] animate-pulse",
  idle: "bg-info shadow-[0_0_6px_rgba(56,189,248,0.7)]",
  off: "bg-zinc-600",
  unknown: "bg-zinc-700 animate-pulse",
};

const LEVEL_CHIP: Record<PipelineLevel, string> = {
  ok: "border-long/40 bg-long/10 text-long",
  warn: "border-warn/40 bg-warn/10 text-warn",
  down: "border-short/40 bg-short/10 text-short",
  idle: "border-info/40 bg-info/10 text-info",
  off: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
  unknown: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

const LEVEL_LABEL: Record<PipelineLevel, string> = {
  ok: "HEALTHY",
  warn: "DEGRADED",
  down: "DOWN",
  idle: "STANDBY",
  off: "OFF",
  unknown: "NO DATA",
};

/** module-scope (pure) — the strip shows the SERVER's clock, not the
 *  browser's, so stage ages never fight client-side skew */
const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false });

/** the little chevron between two stages — takes the downstream level's color */
function Connector({ level }: { level: PipelineLevel }) {
  return (
    <span aria-hidden className={`flex w-4 shrink-0 items-center justify-center ${LEVEL_TEXT[level]} opacity-50`}>
      <svg viewBox="0 0 6 10" className="h-2.5 w-1.5">
        <path d="M0.5 0.5 L5 5 L0.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Node({
  stage,
  selected,
  onSelect,
}: {
  stage: PipelineStage;
  selected: boolean;
  onSelect: () => void;
}) {
  const tooltip = [stage.headline, ...stage.details.map((d) => `${d.label}: ${d.value}`)].join("\n");
  return (
    <button
      type="button"
      onClick={onSelect}
      title={tooltip}
      aria-pressed={selected}
      className={`group relative min-w-[104px] flex-1 rounded border px-2 pb-1.5 pt-2 text-left transition-colors ${
        selected ? "border-zinc-500 bg-zinc-800/70" : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-600"
      }`}
    >
      {/* level accent bar */}
      <span className={`absolute inset-x-0 top-0 h-[2px] rounded-t ${LEVEL_BAR[stage.level]} ${stage.level === "unknown" ? "" : "opacity-90"}`} />
      <span className="flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[stage.level]}`} />
        <span className="truncate font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-400">
          <span className="mr-0.5 text-zinc-600">{stage.icon}</span>
          {stage.name}
        </span>
      </span>
      <span className={`mt-1 block truncate font-mono text-[10px] font-semibold leading-tight ${LEVEL_TEXT[stage.level]}`}>{stage.metric}</span>
      <span className="mt-0.5 block truncate font-mono text-[9px] leading-tight text-zinc-500">{stage.headline}</span>
    </button>
  );
}

export default function HealthPipeline({ health }: { health: ExecHealth | null }) {
  const [selId, setSelId] = useState<string | null>(null);
  const { stages, asOfET } = useMemo(() => {
    const now = health ? Date.parse(health.now) : 0;
    return {
      stages: derivePipeline(health, now),
      asOfET: health && Number.isFinite(now) ? etFmt.format(new Date(now)) : "…",
    };
  }, [health]);
  const overall = pipelineOverall(stages);
  const sel = stages.find((s) => s.id === selId) ?? null;

  return (
    <section className="mb-4 rounded-md border border-zinc-800 bg-panel px-3 py-2">
      {/* strip header: identity + overall verdict */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">health pipeline · signal → execution</p>
          <span className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${LEVEL_CHIP[overall.level]}`}>
            <span className={`inline-block h-1 w-1 rounded-full ${LEVEL_DOT[overall.level]}`} />
            {overall.label}
          </span>
        </div>
        <p className="font-mono text-[9px] text-zinc-600">
          click a stage for detail · {asOfET} ET
        </p>
      </div>

      {/* the stages */}
      <div className="mt-2 overflow-x-auto pb-0.5">
        <div className="flex min-w-[880px] items-stretch gap-0">
          {stages.map((s, i) => (
            <div key={s.id} className="flex min-w-0 flex-1 items-stretch gap-0">
              {i > 0 && <Connector level={s.level} />}
              <Node stage={s} selected={sel?.id === s.id} onSelect={() => setSelId((cur) => (cur === s.id ? null : s.id))} />
            </div>
          ))}
        </div>
      </div>

      {/* detail drawer for the selected stage */}
      {sel && (
        <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-200">
              <span className="mr-1 text-zinc-500">{sel.icon}</span>
              {sel.name}
            </span>
            <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold ${LEVEL_CHIP[sel.level]}`}>{LEVEL_LABEL[sel.level]}</span>
            <span className="font-mono text-[10px] text-zinc-400">{sel.headline}</span>
          </div>
          <div className="mt-1.5 grid gap-x-6 gap-y-1 sm:grid-cols-2 xl:grid-cols-4">
            {sel.details.map((d) => (
              <div key={d.label} className="flex items-baseline justify-between gap-2 border-b border-zinc-800/60 pb-0.5">
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-500">{d.label}</span>
                <span className={`truncate text-right font-mono text-[10px] ${d.tone ? LEVEL_TEXT[d.tone] : "text-zinc-300"}`}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
