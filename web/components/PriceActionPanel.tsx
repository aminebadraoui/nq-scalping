"use client";

import { OTE_LONG, OTE_SHORT, type PriceActionRead, type TFRead } from "@/lib/priceaction";

const TONE: Record<PriceActionRead["tone"], { border: string; text: string; bg: string; label: string }> = {
  long: { border: "border-long/50", text: "text-long", bg: "bg-long/10", label: "LONG" },
  short: { border: "border-short/50", text: "text-short", bg: "bg-short/10", label: "SHORT" },
  neutral: { border: "border-zinc-700", text: "text-zinc-400", bg: "bg-zinc-900/40", label: "MIXED" },
};

const fmt = (n: number, dp = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";

/* one timeframe as a left/right gauge: green = discount (buy), red =
 * premium (sell), shaded bands = OTE, the dot = where price sits. When
 * every dot lands on the same side, the location is aligned. */
function Gauge({ row }: { row: TFRead }) {
  const pct = Math.round(row.pct * 1000) / 10;
  const zoneCls = row.zone === "discount" ? "text-long" : row.zone === "premium" ? "text-short" : "text-zinc-400";
  const zoneLabel = row.zone === "discount" ? "discount" : row.zone === "premium" ? "premium" : "mid";
  return (
    <div
      className="flex items-center gap-2"
      title={
        row.enough
          ? `${row.label}: ${fmt(row.low)} – ${fmt(row.high)} · equilibrium ${fmt(row.eq)} · ${zoneLabel} ${fmt(pct)}%`
          : `${row.label}: not enough bars yet`
      }
    >
      <span className="w-9 shrink-0 text-right font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
        {row.label}
      </span>
      <div className="relative h-2.5 flex-1 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-long/10" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-short/10" />
        <div className="absolute inset-y-0 bg-long/25" style={{ left: `${OTE_LONG[0] * 100}%`, width: `${(OTE_LONG[1] - OTE_LONG[0]) * 100}%` }} />
        <div className="absolute inset-y-0 bg-short/25" style={{ left: `${OTE_SHORT[0] * 100}%`, width: `${(OTE_SHORT[1] - OTE_SHORT[0]) * 100}%` }} />
        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500" />
        {row.enough && (
          <div
            className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-950 bg-zinc-50 shadow"
            style={{ left: `${row.pct * 100}%` }}
          />
        )}
      </div>
      <span className={`w-16 shrink-0 text-left font-mono text-[10px] ${zoneCls}`}>
        {zoneLabel} {fmt(pct)}%
      </span>
    </div>
  );
}

export default function PriceActionPanel({
  read,
  asOfET,
  stale,
  source,
}: {
  read: PriceActionRead;
  asOfET: string;
  stale: boolean;
  source: "live" | "collected";
}) {
  const tone = TONE[read.tone];
  const score = read.side ? (read.side === "long" ? read.longScore : read.shortScore) : 0;
  return (
    <section className={`rounded-md border ${tone.border} bg-panel p-3`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Price action · discount / premium</h2>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone.border} ${tone.bg} ${tone.text}`}>
          {tone.label} · {read.side ? `${score}/${read.maxScore}` : "—"}
        </span>
      </div>

      <div className={`mb-2 rounded border px-2.5 py-2 ${tone.border} ${tone.bg}`}>
        <p className={`font-mono text-[13px] font-semibold leading-snug ${tone.text}`}>{read.verdict}</p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-400">{read.headline}</p>
      </div>

      <div className="space-y-1">
        {read.rows.map((r) => (
          <Gauge key={r.tf} row={r} />
        ))}
      </div>

      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        buy in the green (discount) · sell in the red (premium) · shaded bands = OTE retracement (
        {Math.round(OTE_LONG[0] * 100)}–{Math.round(OTE_LONG[1] * 100)}% / {Math.round(OTE_SHORT[0] * 100)}–
        {Math.round(OTE_SHORT[1] * 100)}%)
      </p>

      <details className="mt-1 rounded border border-zinc-800/70 px-2 py-1">
        <summary className="cursor-pointer list-none font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
          ▸ the location in words
        </summary>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-300">{read.narrative}</p>
      </details>

      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        as of <span className="text-zinc-300">{asOfET} New York</span> ·{" "}
        <span className={source === "live" ? "text-long" : "text-warn"}>
          {source === "live" ? "live location" : "last collected session"}
        </span>
        {stale && <span className="text-warn"> · not live</span>}
      </p>
    </section>
  );
}
