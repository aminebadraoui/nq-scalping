"use client";

import { useMemo, useState } from "react";
import { buildStory, type BarState, type Story } from "@/lib/story";
import { cdtToET, utcToET } from "@/lib/times";

const GLYPH: Record<BarState, { g: string; cls: string; title: string }> = {
  INITIATIVE_UP: { g: "↑", cls: "text-long", title: "initiative up — aggression with a new high" },
  INITIATIVE_DN: { g: "↓", cls: "text-short", title: "initiative down — aggression with a new low" },
  CLIMAX_UP: { g: "▲", cls: "text-warn", title: "buying climax — big volume/range, closed off the high (exhaustion)" },
  CLIMAX_DN: { g: "▼", cls: "text-warn", title: "selling climax — big volume/range, closed off the low (exhaustion)" },
  TEST: { g: "◦", cls: "text-zinc-300", title: "quiet retest — narrow, low volume, touched the extreme, no extension (no-supply/no-demand test)" },
  VACUUM: { g: "◌", cls: "text-zinc-500", title: "vacuum move — big range on thin volume, prone to retrace" },
  ABSORPTION: { g: "◆", cls: "text-info", title: "absorption — one-sided prints defended, price did not break" },
  ROTATION: { g: "·", cls: "text-zinc-600", title: "rotation — two-way business, nothing directional" },
};

export default function StoryPanel({
  minutes,
  absorption = [],
  timeMode = "cdt",
  date,
}: {
  minutes: { t: string; o?: number; c?: number; high: number; low: number; buy: number; sell: number; delta: number; levels: { price: number; buy: number; sell: number }[]; imb?: { stacked?: { side: "buy" | "sell"; from: number; to: number; len: number } | null } | null }[];
  absorption?: { t: string }[];
  timeMode?: "cdt" | "utc";
  date: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const toET = timeMode === "utc" ? utcToET : cdtToET;
  const story: Story | null = useMemo(() => buildStory(minutes as never[], absorption, toET), [minutes, absorption, timeMode]);
  if (!story) return null;
  const last = story.bars.slice(showAll ? -40 : -12);
  const lastBar = story.bars[story.bars.length - 1];

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-zinc-50">
          Footprint story <span className="ml-1 font-mono text-[10px] font-normal text-zinc-500">relationships across bars, not single candles</span>
        </h2>
        <span className="font-mono text-[10px] text-zinc-500">
          {date} · {toET(lastBar.t)} (New York) · study aid — sequences confirm at bar close, not an entry signal
        </span>
      </div>

      {/* the developing story in words */}
      <p className="mb-2 font-mono text-[11px] leading-relaxed text-zinc-200">{story.narrative}</p>

      {/* three named indicators — the relationship features */}
      <div className="mb-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
        <span
          className={`rounded border px-1.5 py-0.5 ${story.pocTrail === "flat" ? "border-zinc-700 text-zinc-400" : story.pocTrail === "up" ? "border-long/40 bg-long/10 text-long" : "border-short/40 bg-short/10 text-short"}`}
          title="Dalton: 'price moves quickly, value develops slowly'. 3+ same-direction POC steps = value migrating with price; a sticky POC while price extends = value/price divergence."
        >
          POC trail {story.pocTrail === "flat" ? "→ sticky" : story.pocTrail === "up" ? "↑ migrating up" : "↓ migrating down"}
          {story.pocTrail !== "flat" ? ` ×${story.pocTrailLen}` : ""}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 ${story.deltaFlip ? (story.deltaFlip.dir === "up" ? "border-long/40 bg-long/10 text-long" : "border-short/40 bg-short/10 text-short") : "border-zinc-700 text-zinc-400"}`}
          title="Axia 'delta reversal': adjacent bars flip aggressive side with both bars >= 15% of volume — a change in auction personality."
        >
          Δ flip {story.deltaFlip ? `@ ${toET(story.deltaFlip.t)} ${story.deltaFlip.dir === "up" ? "↑" : "↓"}` : "— none"}
        </span>
        <span
          className={`rounded border px-1.5 py-0.5 ${story.effort ? (story.effort.kind === "stall" ? "border-info/40 bg-info/10 text-info" : "border-warn/40 bg-warn/10 text-warn") : "border-zinc-700 text-zinc-400"}`}
          title="VSA effort vs result over 3 bars: high effort + small result = absorption stall; low effort + big result = vacuum move."
        >
          effort/result {story.effort ? (story.effort.kind === "stall" ? `stall @ ${toET(story.effort.t)}` : `vacuum @ ${toET(story.effort.t)}`) : "— balanced"}
        </span>
        {story.sequence && (
          <span
            className={`rounded border px-1.5 py-0.5 ${story.sequence.kind === "exhaustion_reversal" ? "border-warn/40 bg-warn/10 text-warn" : story.sequence.kind === "absorption_hold" ? "border-info/40 bg-info/10 text-info" : "border-zinc-600 text-zinc-300"}`}
          >
            {story.sequence.kind === "exhaustion_reversal" ? "sequence: exhaustion → failed retest" : story.sequence.kind === "absorption_hold" ? "sequence: absorption → initiative" : "sequence: vacuum → fade"}
          </span>
        )}
      </div>

      {/* the last minutes as a state strip */}
      <div className="mb-1 flex flex-wrap gap-0.5">
        {last.map((b) => {
          const g = GLYPH[b.state];
          return (
            <button
              key={b.t}
              title={`${toET(b.t)} NY · ${b.text}`}
              className={`flex min-w-9 flex-col items-center rounded border border-zinc-800/70 px-1 py-0.5 hover:border-zinc-600 ${g.cls}`}
            >
              <span className="font-mono text-[8px] text-zinc-500">{toET(b.t).slice(0, 5)}</span>
              <span className="font-mono text-xs leading-none">{g.g}</span>
            </button>
          );
        })}
        {story.bars.length > 12 && (
          <button onClick={() => setShowAll((v) => !v)} className="ml-1 self-center font-mono text-[9px] text-zinc-500 hover:text-zinc-300">
            {showAll ? "fewer ▴" : `+${story.bars.length - 12} more ▾`}
          </button>
        )}
      </div>

      {/* legend + transition log — collapsible */}
      <details className="rounded border border-zinc-800/70 px-2 py-1">
        <summary className="cursor-pointer list-none font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
          ▸ what the glyphs mean + recent transitions
        </summary>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-zinc-400">
          {Object.entries(GLYPH).map(([k, v]) => (
            <span key={k}>
              <span className={v.cls}>{v.g}</span> {k.toLowerCase().replace("_", " ")}
            </span>
          ))}
        </div>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
          thresholds: initiative |Δ| ≥ 20% + new extreme · climax vol ≥ 2× median & range ≥ 1.5× & closed off the extreme · test vol &lt; prior 2 bars & range ≤ 0.5×
          median · vacuum vol ≤ 0.5× & range ≥ 1.5× · medians from the last 20 bars
        </p>
        <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] text-zinc-500">
          {story.transitions.slice(-10).map((x, i) => (
            <div key={i}>
              {toET(x.t)} · {GLYPH[x.from].g} {x.from.toLowerCase().replace("_", " ")} → {GLYPH[x.to].g} {x.to.toLowerCase().replace("_", " ")}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
