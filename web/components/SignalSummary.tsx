"use client";

import type { BoxVerdict, Signal } from "@/lib/signals";

const TONE: Record<Signal["tone"], { border: string; text: string; bg: string; label: string }> = {
  long: { border: "border-long/50", text: "text-long", bg: "bg-long/10", label: "LONG" },
  short: { border: "border-short/50", text: "text-short", bg: "bg-short/10", label: "SHORT" },
  forming: { border: "border-warn/50", text: "text-warn", bg: "bg-warn/10", label: "FORMING" },
  neutral: { border: "border-zinc-700", text: "text-zinc-400", bg: "bg-zinc-900/40", label: "NONE" },
};

function BoxChip({ box }: { box: BoxVerdict }) {
  const tag = box.label ?? (box.side === "long" ? "LONG" : box.side === "short" ? "SHORT" : "—");
  const cls =
    box.kind === "context"
      ? box.label === "CHOP"
        ? "border-info/40 bg-info/10 text-info"
        : box.label === "TREND"
          ? "border-short/40 bg-short/10 text-short"
          : "border-zinc-700 text-zinc-400"
      : box.side === "long"
        ? "border-long/40 bg-long/10 text-long"
        : box.side === "short"
          ? "border-short/40 bg-short/10 text-short"
          : "border-zinc-700 text-zinc-400";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`}>
      {box.name} {tag}
    </span>
  );
}

export default function SignalSummary({
  signal,
  gate,
  stale = false,
  source,
}: {
  signal: Signal;
  /** cardGateOpen(signal, mech) — the same gate the live feed uses */
  gate?: { ok: boolean; reason: string } | null;
  stale?: boolean;
  source?: "live" | "collected";
}) {
  const tone = TONE[signal.tone];
  return (
    <section className={`rounded-md border ${tone.border} bg-panel p-3`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Final signal</h2>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone.border} ${tone.bg} ${tone.text}`}>
          {tone.label}
        </span>
      </div>
      <div className={`mb-2 rounded border px-2.5 py-2 ${tone.border} ${tone.bg}`}>
        <p className={`font-mono text-[13px] font-semibold leading-snug ${tone.text}`}>{signal.verdict}</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-400">{signal.headline}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {signal.boxes.map((b) => (
          <BoxChip key={b.id} box={b} />
        ))}
      </div>
      {gate && (
        <p className={`mt-2 font-mono text-[10px] leading-snug ${gate.ok ? "text-long" : "text-zinc-500"}`}>
          push gate →{" "}
          {gate.ok
            ? source === "live"
              ? "open — the live feed would push a card"
              : "open on this data — the feed only pushes while live ticks print"
            : `closed: ${gate.reason}`}
        </p>
      )}
      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        <span className={source === "live" ? "text-long" : "text-warn"}>
          {source === "live" ? "live" : "collected — study the last session, not a call"}
        </span>
        {stale && <span className="text-warn"> · not live</span>}
        {" · "}every box is independent — add or remove one in <span className="text-zinc-400">lib/signals.ts</span> without touching the others
      </p>
    </section>
  );
}
