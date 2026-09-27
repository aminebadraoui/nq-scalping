"use client";

import { useEffect, useRef, useState } from "react";
import type { MechanismRead } from "@/lib/mechanism";

const TONE: Record<MechanismRead["tone"], { border: string; text: string; bg: string; label: string }> = {
  long: { border: "border-long/50", text: "text-long", bg: "bg-long/10", label: "LONG" },
  short: { border: "border-short/50", text: "text-short", bg: "bg-short/10", label: "SHORT" },
  forming: { border: "border-warn/50", text: "text-warn", bg: "bg-warn/10", label: "FORMING" },
  neutral: { border: "border-zinc-700", text: "text-zinc-400", bg: "bg-zinc-900/40", label: "NONE" },
};

const STATE_ICON: Record<string, { icon: string; tone: string }> = {
  yes: { icon: "✓", tone: "text-long" },
  partial: { icon: "◐", tone: "text-warn" },
  no: { icon: "✗", tone: "text-zinc-500" },
};

const ROLE_TAG: Record<string, string> = {
  required: "text-zinc-500",
  support: "text-zinc-600",
  filter: "text-zinc-600",
};

export default function MechanismPanel({
  read,
  asOfET,
  stale,
  source,
}: {
  read: MechanismRead;
  asOfET: string;
  stale: boolean;
  source: "live" | "collected";
}) {
  const tone = TONE[read.tone];

  // pulse the verdict only when the state actually changes (motion = signal)
  const sig = `${read.side ?? "none"}|${read.present}|${read.tone}`;
  const prevSig = useRef(sig);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prevSig.current !== sig) {
      prevSig.current = sig;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 2600);
      return () => clearTimeout(t);
    }
  }, [sig]);

  const criticalMissing = read.missing[0];
  return (
    <section className={`rounded-md border ${tone.border} bg-panel p-3`}>
      {/* verdict — always visible */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Reversal checklist</h2>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone.border} ${tone.bg} ${tone.text}`}>
          {tone.label} · {read.present}/6
        </span>
      </div>
      <div className={`mb-2 rounded border px-2.5 py-2 transition-shadow duration-500 ${tone.border} ${tone.bg} ${flash ? "shadow-[0_0_14px_rgba(251,191,36,0.25)]" : ""}`}>
        <p className={`font-mono text-[13px] font-semibold leading-snug ${tone.text}`}>{read.verdict}</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-400">{read.headline}</p>
        {criticalMissing && (
          <p className="mt-1 font-mono text-[10px] leading-snug">
            <span className="text-zinc-500">next piece needed → </span>
            <span className="text-warn">{criticalMissing}</span>
          </p>
        )}
      </div>

      {/* the six conditions — one line each; why/what inside <details> */}
      <div className="space-y-1">
        {read.ingredients.map((ing) => {
          const st = STATE_ICON[ing.state];
          return (
            <details
              key={ing.key}
              className={`group rounded border px-2 py-1 ${
                ing.state === "yes" ? "border-zinc-700/80 bg-zinc-900/40" : "border-zinc-800/60"
              }`}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
                <span className={`w-4 shrink-0 text-center font-mono text-xs ${st.tone}`}>{st.icon}</span>
                <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{ing.n}</span>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-zinc-200">{ing.name}</span>
                <span className={`shrink-0 font-mono text-[9px] uppercase ${ROLE_TAG[ing.role]}`}>
                  {ing.role === "required" ? "req" : ing.role === "support" ? "sup" : "flt"}
                </span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-zinc-300">{ing.short}</span>
                <span className="shrink-0 font-mono text-[9px] text-zinc-600 transition-transform group-open:rotate-90">▸</span>
              </summary>
              <div className="mt-1 border-t border-zinc-800/60 pt-1">
                <p className="break-words font-mono text-[10px] leading-snug text-zinc-300">{ing.value}</p>
                <p className="mt-0.5 font-mono text-[10px] leading-snug text-zinc-500">{ing.why}</p>
              </div>
            </details>
          );
        })}
      </div>

      {/* the sequence in words — collapsible */}
      <details className="mt-2 rounded border border-zinc-800/70 px-2 py-1">
        <summary className="cursor-pointer list-none font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
          ▸ the story in words
        </summary>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-300">{read.narrative}</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-600">
          a reversal is a sequence, not a prediction: location → mechanism (who absorbs) → fuel (divergence) → trigger (reclaim).
        </p>
      </details>

      {/* action lines — always visible */}
      <div className="mt-2 space-y-1 rounded border border-zinc-800/70 bg-zinc-950/50 px-2 py-1.5 font-mono text-[10px] leading-snug">
        <div>
          <span className="text-zinc-500">trigger → </span>
          <span className="text-zinc-200">{read.trigger}</span>
        </div>
        <div>
          <span className="text-zinc-500">invalidation → </span>
          <span className="text-zinc-200">{read.invalidation}</span>
        </div>
        <div>
          <span className="text-zinc-500">target → </span>
          <span className="text-zinc-200">{read.target}</span>
        </div>
      </div>

      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        as of <span className="text-zinc-300">{asOfET} New York</span> ·{" "}
        <span className={source === "live" ? "text-long" : "text-warn"}>
          {source === "live" ? "live bars · events from the last collected session" : "last collected session"}
        </span>
        {stale && <span className="text-warn"> · not live — study the last session, not a call</span>}
      </p>
    </section>
  );
}
