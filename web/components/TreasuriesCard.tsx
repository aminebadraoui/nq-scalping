"use client";

/* TREASURIES card — the rates glance: spread chips, curve sparkline,
 * tenor rows with day change, delayed intraday. Display-only. */

import type { BondsData, IntradayCurve } from "@/lib/bonds";
import type { WatchData } from "@/lib/macroWatch";
import { bpDiff, spread210, spread103m, breakeven10y, real10y } from "@/lib/bonds";
import { signed, impliedFfr } from "@/lib/macroFmt";
import { BentoCard } from "./BentoCard";

const TENORS: { label: string; key: "m1" | "m3" | "m6" | "y1" | "y2" | "y5" | "y10" | "y30" }[] = [
  { label: "1M", key: "m1" },
  { label: "3M", key: "m3" },
  { label: "6M", key: "m6" },
  { label: "1Y", key: "y1" },
  { label: "2Y", key: "y2" },
  { label: "5Y", key: "y5" },
  { label: "10Y", key: "y10" },
  { label: "30Y", key: "y30" },
];

function Spark({ latest, prev }: { latest: NonNullable<BondsData["latest"]>; prev?: BondsData["curve"][number] | null }) {
  const pts = TENORS.map((t) => latest[t.key]).filter((v): v is number => v != null);
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 220;
  const h = 40;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 8)]);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full" aria-hidden="true">
      <path d={line} fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeLinejoin="round" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.5" fill="#38bdf8" />
      ))}
    </svg>
  );
}

export default function TreasuriesCard({
  data,
  intraday,
  stale,
  watch,
}: {
  data: BondsData | null;
  intraday: IntradayCurve | null;
  stale: boolean;
  watch: WatchData | null;
}) {
  const latest = data?.latest ?? null;
  const prev = data?.curve?.[1] ?? null;
  const s210 = latest ? spread210(latest) : null;
  const s103m = latest ? spread103m(latest) : null;
  const real10 = latest && data ? real10y({ date: latest.date, y10: latest.y10 }, data.real) : null;
  const be10 = latest && data ? breakeven10y({ date: latest.date, y10: latest.y10 }, data.real) : null;
  const ffPrice = watch?.quotes.find((q) => q.symbol === "@FF.1")?.value ?? null;
  const ffr = impliedFfr(ffPrice);
  const effr = data?.effr?.rate ?? null;

  return (
    <BentoCard
      kicker="Rates"
      title="Treasuries"
      tone="info"
      badge={latest ? `as of ${latest.date}${stale ? " · stale" : ""}` : undefined}
    >
      {!latest ? (
        <p className="p-2 font-mono text-[10px] text-zinc-600">curve feed unavailable</p>
      ) : (
        <>
          <div className="mb-1.5 grid grid-cols-2 gap-1.5">
            {[
              { label: "2s10s", value: s210 == null ? "—" : `${s210 > 0 ? "+" : ""}${s210} bp`, tone: s210 == null ? "text-zinc-400" : s210 < 0 ? "text-short" : "text-long" },
              { label: "10y−3m", value: s103m == null ? "—" : `${s103m > 0 ? "+" : ""}${s103m} bp`, tone: s103m == null ? "text-zinc-400" : s103m < 0 ? "text-short" : "text-long" },
              { label: "10y real", value: real10 == null ? "—" : `${real10.toFixed(2)}%`, tone: "text-zinc-300" },
              { label: "breakeven", value: be10 == null ? "—" : `${be10.toFixed(2)}%`, tone: "text-zinc-300" },
              { label: "FFR imp", value: ffr != null ? `${ffr.toFixed(2)}%` : "—", tone: "text-zinc-300" },
              { label: "EFFR", value: effr != null ? `${effr.toFixed(2)}%` : "—", tone: "text-zinc-300" },
            ].map((c) => (
              <div key={c.label} className="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-1.5 py-1">
                <p className="font-mono text-[8px] uppercase tracking-wider text-zinc-500">{c.label}</p>
                <p className={`font-mono text-[12px] tabular-nums ${c.tone}`}>{c.value}</p>
              </div>
            ))}
          </div>

          <div className="mb-1.5 rounded-md border border-zinc-800/60 bg-zinc-900/30 p-1.5">
            <Spark latest={latest} prev={prev} />
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {TENORS.map((t) => {
              const v = latest[t.key];
              const d = bpDiff(v, prev ? prev[t.key] : null);
              const strong = t.key === "y2" || t.key === "y10";
              return (
                <div key={t.key} className="flex items-baseline justify-between font-mono text-[10px]">
                  <span className={`${strong ? "text-zinc-200" : "text-zinc-500"}`}>{t.label}</span>
                  <span className={`tabular-nums ${strong ? "text-zinc-100" : "text-zinc-400"}`}>{v == null ? "—" : v.toFixed(2)}%</span>
                  <span className={`w-9 text-right tabular-nums ${d == null ? "text-zinc-600" : d > 0 ? "text-long" : d < 0 ? "text-short" : "text-zinc-500"}`}>
                    {d == null ? "" : signed(d, 0)}
                  </span>
                </div>
              );
            })}
          </div>

          {intraday && (
            <p className="mt-auto border-t border-zinc-800/60 pt-1.5 font-mono text-[9px] leading-snug text-zinc-500">
              delayed: 3M {intraday.m3?.toFixed(2) ?? "—"} · 2Y {intraday.y2?.toFixed(2) ?? "—"} · 10Y {intraday.y10?.toFixed(2) ?? "—"} · 30Y {intraday.y30?.toFixed(2) ?? "—"}
            </p>
          )}
        </>
      )}
    </BentoCard>
  );
}
