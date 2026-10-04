"use client";

/* Footer strip — per-source freshness + feed status, borderless.
 * The trust layer: nothing here ever pretends to be live. */

import type { MacroContext } from "@/lib/macroFeed";

function stamp(iso: string | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

export default function MacroFooter({ ctx, error }: { ctx: MacroContext | null; error: string | null }) {
  const watchErrors = ctx?.watch?.errors ?? [];
  const allOk = ctx ? ctx.news.ok && ctx.earnings.ok && ctx.bonds.ok && watchErrors.length === 0 : false;
  return (
    <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800/50 pt-2 font-mono text-[10px] text-zinc-500">
      <span className={`flex items-center gap-1.5 ${allOk ? "text-long" : "text-warn"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${allOk ? "bg-long" : "bg-warn"}`} />
        {ctx ? (allOk ? "feeds ok" : error ?? "feed degraded") : "loading feeds…"}
      </span>
      <span>news {ctx?.news.fetchedAt ? stamp(ctx.news.fetchedAt) : "—"} ET</span>
      <span>earnings {ctx?.earnings.fetchedAt ? stamp(ctx.earnings.fetchedAt) : "—"} ET</span>
      <span>bonds {ctx?.bonds.fetchedAt ? stamp(ctx.bonds.fetchedAt) : "—"} ET</span>
      <span>watch {ctx?.watch?.quotesAt ? stamp(ctx.watch.quotesAt) : "—"} ET (delayed ~20m)</span>
      {watchErrors.length > 0 && <span className="text-warn">{watchErrors.join(" · ")}</span>}
      <span className="ml-auto text-zinc-600">macro context · display-only · never feeds signals</span>
    </footer>
  );
}
