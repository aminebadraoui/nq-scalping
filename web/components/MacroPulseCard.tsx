"use client";

/* MACRO PULSE — "what's next and what regime are we in": next news
 * event + next earnings (hero lines), the calendar beyond news, and
 * the regime chips. Display-only. Span 3 in the macro band. */

import { useEffect, useMemo, useState } from "react";
import type { WatchData } from "@/lib/macroWatch";
import type { NewsWeek } from "@/lib/newsCalendar";
import type { QuarterData } from "@/lib/earnings";
import { impliedFfr, shortDate, dayLabel, countdownLabel, minutesUntil, daysAway, nextUpcoming, etNow, realizedDailyBandPct } from "@/lib/macroFmt";
import { BentoCard, CardGroupLabel, TintChip } from "./BentoCard";

function pct(v: number | null, dp = 2): string {
  return v == null ? "—" : v.toFixed(dp);
}

export default function MacroPulseCard({
  watch,
  news,
  earnings,
  nqPrice,
  realizedBandPct,
}: {
  watch: WatchData | null;
  news: NewsWeek | null;
  earnings: QuarterData | null;
  nqPrice: number;
  /** live realized daily 1σ (%) from the NQ 1-min feed — real-time twin of the delayed VIX band */
  realizedBandPct: number | null;
}) {
  const [nowSec, setNowSec] = useState(0);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    setNowSec(etNow().sec);
    if (reduced) return;
    const id = setInterval(() => setNowSec(etNow().sec), 30_000);
    return () => clearInterval(id);
  }, [reduced]);

  const nextEvent = useMemo(() => nextUpcoming(news), [news]);
  const mins = nextEvent ? minutesUntil(nextEvent, nowSec) : Infinity;
  const nowDay = etNow().day;
  const nextEarn = earnings?.upcoming.filter(
    (r): r is (typeof r) & { nextDate: string } => r.nextDate != null && daysAway(r.nextDate, nowDay) >= 0,
  )[0];

  const quotesAtMs = watch?.quotesAt ? Date.parse(watch.quotesAt) : 0;
  const ageMin = quotesAtMs ? Math.floor((Date.now() - quotesAtMs) / 60_000) : Infinity;
  const live = quotesAtMs > 0 && ageMin < 5 ? "text-long" : "text-warn";
  const liveLabel = quotesAtMs > 0 ? (ageMin < 5 ? "live" : `lag ${ageMin}m`) : "loading";

  const vix = watch?.vix;
  const bandPts = vix?.rangePct != null && nqPrice > 0 ? Math.round(((vix.rangePct / 100) * nqPrice) * 10) / 10 : null;
  const realBandPts = realizedBandPct != null && nqPrice > 0 ? Math.round(((realizedBandPct / 100) * nqPrice) * 10) / 10 : null;
  const ffPrice = watch?.quotes.find((q) => q.symbol === "@FF.1")?.value ?? null;
  const ffr = impliedFfr(ffPrice);
  const gex = watch?.gex;
  const flipDist = gex && gex.flip != null && gex.spot ? Math.round((gex.flip - gex.spot) * 10) / 10 : null;
  const walcl = watch?.fred?.walcl;
  const rrp = watch?.fred?.rrp;
  const hy = watch?.fred?.hyOas;
  const cot = watch?.cot;
  const cal = watch?.calendar;

  return (
    <BentoCard
      kicker="Macro pulse"
      title="What's next"
      tone="warn"
      badge={<span className={`flex items-center gap-1.5 font-mono text-[10px] ${live}`}>● {liveLabel}</span>}
    >
      {/* next news event — the pulse hero line */}
      {nextEvent ? (
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-2">
          <p className={`font-mono text-[13px] leading-snug ${mins <= 15 ? "text-warn" : "text-zinc-100"}`}>
            {nextEvent.title}
          </p>
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-zinc-400">
            {dayLabel(nextEvent.day)} {nextEvent.timeET || "all-day"} ET · {countdownLabel(nextEvent, nowSec) ?? "today"}
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-2 font-mono text-[10px] text-zinc-500">
          no upcoming US releases
        </p>
      )}

      {nextEarn && (
        <p className="mt-1.5 px-0.5 font-mono text-[10px] leading-snug text-zinc-400">
          next earnings: <span className="text-zinc-200">{nextEarn.symbol}</span> · {shortDate(nextEarn.nextDate)} ·{" "}
          {daysAway(nextEarn.nextDate, nowDay) === 0 ? "today" : `in ${daysAway(nextEarn.nextDate, nowDay)}d`}
        </p>
      )}

      {/* calendar beyond news */}
      <CardGroupLabel tone="warn">Calendar</CardGroupLabel>
      <div className="flex flex-wrap gap-1">
        {cal?.opex && (
          <TintChip label="OPEX" value={`${shortDate(cal.opex.day)}${cal.opex.quad ? " quad" : ""} · ${cal.opex.days}d`} tone="muted" urgent={cal.opex.days <= 1} />
        )}
        {cal?.auctions.slice(0, 2).map((a) => (
          <TintChip key={a.day} label={`${a.label}`} value={`${shortDate(a.day)} · ${a.days}d`} tone="muted" urgent={a.days <= 1} />
        ))}
        {cal?.fomcMinutes && (
          <TintChip label="FOMC mins" value={`${cal.fomcMinutes.approx ? "~" : ""}${shortDate(cal.fomcMinutes.day)}`} tone="muted" urgent={cal.fomcMinutes.days <= 1} />
        )}
      </div>

      {/* regime */}
      <CardGroupLabel tone="info">Regime</CardGroupLabel>
      <div className="grid grid-cols-2 gap-1">
        <TintChip
          label="GEX"
          tone={gex?.regime === "chop" ? "info" : gex?.regime === "trend" ? "warn" : "muted"}
          value={gex ? `${gex.regime === "chop" ? "CHOP" : gex.regime === "trend" ? "TREND" : "—"}${flipDist != null ? ` ${flipDist > 0 ? "+" : ""}${flipDist}` : ""}` : "—"}
        />
        <TintChip label="VIX" value={`${pct(vix?.level ?? null)} ${vix?.pct1y != null ? `${vix.pct1y}th` : ""}`} tone="muted" />
        <TintChip label="VIX 1σ" value={bandPts != null ? `±${bandPts}` : "—"} tone="muted" />
        <TintChip label="NQ σ live" value={realBandPts != null ? `±${realBandPts}` : "—"} tone="info" />
        <TintChip
          label="D structure"
          value={watch?.htf.daily ?? "—"}
          tone={watch?.htf.daily === "HH/HL" ? "long" : watch?.htf.daily === "LH/LL" ? "short" : "muted"}
        />
        <TintChip
          label="W structure"
          value={watch?.htf.weekly ?? "—"}
          tone={watch?.htf.weekly === "HH/HL" ? "long" : watch?.htf.weekly === "LH/LL" ? "short" : "muted"}
        />
        <TintChip
          label="Fed B/S"
          value={walcl?.value != null ? `${(walcl.value / 1e12).toFixed(2)}T${walcl.delta == null ? "" : walcl.delta < 0 ? " QT" : walcl.delta > 0 ? " QE" : ""}` : "—"}
          tone={walcl?.delta == null ? "muted" : walcl.delta < 0 ? "warn" : "long"}
        />
        <TintChip label="RRP" value={rrp?.value != null ? `${(rrp.value / 1e9).toFixed(0)}B` : "—"} tone="muted" />
        <TintChip label="HY OAS" value={hy?.value != null ? `${pct(hy.value)}%` : "—"} tone="muted" />
        <TintChip label="COT" value={cot?.netPctOi != null ? `${cot.netPctOi > 0 ? "+" : ""}${cot.netPctOi}%` : "—"} tone="muted" />
      </div>
    </BentoCard>
  );
}
