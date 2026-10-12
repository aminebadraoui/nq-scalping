"use client";

/* WEEK AHEAD — the next ~8 US events as a chronological list (warn
 * tint on the big four), with "view all" expanding into the full
 * day-card grid. Every event carries its static guide (what it
 * measures, what a market-friendly vs hostile result means) from
 * lib/macroGuide.ts plus the AI explain + NQ-impact reads from the
 * daily interpretation row. Display-only context. */

import { useEffect, useMemo, useState } from "react";
import type { NewsWeek, NewsItem } from "@/lib/newsCalendar";
import { dayLabel, countdownLabel, etNow, eventEpoch } from "@/lib/macroFmt";
import { newsGuideFor, newsItemId } from "@/lib/macroGuide";
import { BentoCard } from "./BentoCard";

const SOURCE_LABEL: Record<NewsWeek["source"], string> = {
  forexfactory: "forex mirror",
  static: "official schedule · feed offline",
};

const BIG_FOUR = /CPI|FOMC|NFP|PPI|PCE|Employment Situation|Nonfarm/i;

type EventReads = Record<string, { explain?: string; nqImpact?: string }>;

function ImpactBars({ impact }: { impact: NewsItem["impact"] }) {
  const filled = impact === "High" ? 3 : impact === "Medium" ? 2 : 1;
  const color = impact === "High" ? "bg-short" : impact === "Medium" ? "bg-warn" : "bg-zinc-600";
  return (
    <span className="inline-flex items-end gap-[2px]" title={`${impact.toLowerCase()} impact`}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={`w-[3px] rounded-sm ${i <= filled ? color : "bg-zinc-800"}`} style={{ height: `${2 + i * 2}px` }} />
      ))}
    </span>
  );
}

export default function NewsCalendarPanel({
  week,
  stale,
  error,
  reads,
}: {
  week: NewsWeek | null;
  stale: boolean;
  error?: string;
  reads?: EventReads;
}) {
  const [highOnly, setHighOnly] = useState(false);
  const [showAll, setShowAll] = useState(true); // day grid fills the card by default
  const [nowSec, setNowSec] = useState(() => etNow().sec);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setNowSec(etNow().sec), 30_000);
    return () => clearInterval(id);
  }, [reduced]);

  const today = etNow().day;
  const allItems = useMemo(() => {
    const items = (week?.days ?? []).flatMap((d) => d.items).filter((i) => (highOnly ? i.impact === "High" : true));
    return items.sort((a, b) => eventEpoch(a) - eventEpoch(b));
  }, [week, highOnly]);

  const list = allItems.filter((i) => !i.released).slice(0, 8);
  if (list.length < 4 && !showAll) {
    // pad with today's released events (most recent first) when the
    // upcoming window is thin (weekend / fed-blackout weeks)
    const released = allItems.filter((i) => i.released).reverse();
    for (const r of released) {
      if (list.length >= 8) break;
      list.push(r);
    }
  }

  const days = (week?.days ?? [])
    .map((d) => ({ ...d, items: d.items.filter((i) => (highOnly ? i.impact === "High" : true)) }))
    .filter((d) => d.items.length > 0);

  return (
    <BentoCard
      kicker="Calendar"
      title="Week ahead · US"
      tone="short"
      badge={
        <span className="flex items-center gap-1.5">
          {week && <span className={stale ? "text-warn" : "text-zinc-500"}>{SOURCE_LABEL[week.source]}</span>}
          <button
            onClick={() => setHighOnly((v) => !v)}
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
              highOnly ? "border-info/50 bg-info/10 text-info" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
            }`}
            title="toggle medium-impact events"
          >
            high only{highOnly ? " ✓" : ""}
          </button>
        </span>
      }
    >
      {error && <p className="mb-2 font-mono text-[10px] text-warn">feed error: {error}</p>}

      {!week ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-zinc-800/60" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="p-4 font-mono text-xs text-zinc-500">no US events in the feed window</p>
      ) : (
        <>
          {!showAll && (
          <div className="divide-y divide-zinc-800/60">
            {list.map((it, i) => {
              const cd = countdownLabel(it, nowSec);
              const big = BIG_FOUR.test(it.title);
              const read = reads?.[newsItemId(it)];
              return (
                <div key={`${it.day}-${it.title}-${i}`} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
                  <span className="w-[86px] shrink-0 font-mono text-[9px] leading-tight whitespace-nowrap">
                    <span className={it.day === today ? "text-info" : "text-zinc-400"}>{dayLabel(it.day).slice(0, 3)} {it.timeET}</span>
                    {cd && <span className="block text-[8px] text-zinc-500">{cd}</span>}
                  </span>
                  <span className="shrink-0">
                    <ImpactBars impact={it.impact} />
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug">
                    <span
                      className={`block truncate ${big && !it.released ? "text-warn" : it.released ? "text-zinc-500" : "text-zinc-200"}`}
                      title={newsGuideFor(it.title).what}
                    >
                      {it.title}
                    </span>
                    {read?.nqImpact && <span className="block truncate text-[9px] text-info">{read.nqImpact}</span>}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[9px] leading-snug whitespace-nowrap tabular-nums">
                    <span className={it.actual ? "font-semibold text-zinc-50" : "text-zinc-500"}>{it.actual ?? "—"}</span>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-zinc-400">{it.forecast ?? "—"}</span>
                    <span className="text-zinc-600"> / </span>
                    <span className="text-zinc-500">{it.previous ?? "—"}</span>
                  </span>
                </div>
              );
            })}
          </div>
          )}

          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-2 w-full rounded-md border border-zinc-800 py-1 font-mono text-[10px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
          >
            {showAll ? "compact list" : `view all ${days.reduce((n, d) => n + d.items.length, 0)} events`}
          </button>

          {showAll && (
            <div className="grid gap-1.5 lg:grid-cols-2">
              {days.map((d) => (
                <DayCard key={d.day} day={d.day} isToday={d.day === today} items={d.items} nowSec={nowSec} reads={reads} />
              ))}
            </div>
          )}
        </>
      )}

      {week?.source === "forexfactory" && (
        <p className="mt-2 font-mono text-[9px] leading-snug text-zinc-600">
          mirror is forecast/previous-first; the AI judges released results when the actual arrives, else the pre-release beat/miss read applies
        </p>
      )}
    </BentoCard>
  );
}

function DayCard({ day, isToday, items, nowSec, reads }: { day: string; isToday: boolean; items: NewsItem[]; nowSec: number; reads?: EventReads }) {
  return (
    <div className={`rounded-md border bg-zinc-900/30 ${isToday ? "border-info/40" : "border-zinc-800/60"}`}>
      <p className={`px-2 pt-1 font-mono text-[9px] font-semibold uppercase tracking-wider ${isToday ? "text-info" : "text-zinc-500"}`}>
        {dayLabel(day)}
        <span className="ml-1.5 font-normal normal-case text-zinc-600">· {items.length}</span>
      </p>
      <div className="divide-y divide-zinc-800/40">
        {items.map((it, i) => {
          const cd = countdownLabel(it, nowSec);
          const guide = newsGuideFor(it.title);
          const read = reads?.[newsItemId(it)];
          return (
            <div key={i} className={`px-2 py-1 ${it.released ? "opacity-60" : ""}`}>
              <div className="flex items-start gap-1.5">
                <span className="mt-[3px] w-[38px] shrink-0 text-right font-mono text-[9px] leading-tight whitespace-nowrap">
                  <span className="text-zinc-300">{it.timeET || "all-day"}</span>
                  {cd && <span className="block text-[8px] text-zinc-500">{cd}</span>}
                </span>
                <span className="mt-[4px] shrink-0">
                  <ImpactBars impact={it.impact} />
                </span>
                <span className="min-w-0 flex-1 font-mono text-[10px] leading-snug text-zinc-300">{it.title}</span>
                <span className="shrink-0 text-right font-mono text-[9px] leading-snug whitespace-nowrap tabular-nums">
                  <span className={it.actual ? "font-semibold text-zinc-50" : "text-zinc-500"}>{it.actual ?? "—"}</span>
                  <span className="text-zinc-600"> / </span>
                  <span className="text-zinc-400">{it.forecast ?? "—"}</span>
                  <span className="text-zinc-600"> / </span>
                  <span className="text-zinc-500">{it.previous ?? "—"}</span>
                </span>
              </div>
              <div className="mt-1 space-y-0.5 pl-[42px]">
                <p className="font-mono text-[9px] leading-snug text-zinc-500">{guide.what}</p>
                <p className="font-mono text-[9px] leading-snug text-zinc-400">
                  <span className="text-info">NQ — </span>
                  {guide.nqImpact}
                </p>
                <p className="font-mono text-[9px] leading-snug text-zinc-500">
                  <span className="text-long">good </span>
                  {guide.goodForNq}
                </p>
                <p className="font-mono text-[9px] leading-snug text-zinc-500">
                  <span className="text-short">bad </span>
                  {guide.badForNq}
                </p>
                {read?.explain && (
                  <p className="font-mono text-[9px] leading-snug text-info">
                    <span className="text-zinc-500">AI explain — </span>
                    {read.explain}
                  </p>
                )}
                {read?.nqImpact && (
                  <p className="font-mono text-[9px] leading-snug text-info">
                    <span className="text-zinc-500">AI NQ — </span>
                    {read.nqImpact}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
