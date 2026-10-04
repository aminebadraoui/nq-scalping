"use client";

/* CROSS-ASSET BOARD — the hero tile of the macro band: the 15-key
 * quote grid (5×3) with the day's biggest mover as the hero, signed
 * deltas with arrows, and 5-day sparklines when the feed is available.
 * Pointer-tracked glow (skipped under prefers-reduced-motion).
 * Display-only context. */

import { useRef, useState } from "react";
import type { WatchData, WatchQuote } from "@/lib/macroWatch";
import { BentoCard, CardGroupLabel } from "./BentoCard";

function pct(v: number | null, dp = 2): string {
  return v == null ? "—" : v.toFixed(dp);
}

function signed(v: number | null, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v.toFixed(dp);
  return v > 0 ? `+${s}` : s;
}

function deltaTone(v: number | null): string {
  if (v == null) return "text-zinc-500";
  if (v > 0) return "text-long";
  if (v < 0) return "text-short";
  return "text-zinc-400";
}

function Spark({ pts, up }: { pts: number[] | undefined; up: boolean }) {
  if (!pts || pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 40;
  const h = 16;
  const xy = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)]);
  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const stroke = up ? "#34d399" : "#f87171";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-4 w-10" aria-hidden="true">
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="1.5" fill={stroke} />
    </svg>
  );
}

function Tile({ q, nqPct, spark }: { q: WatchQuote; nqPct: number | null; spark: number[] | undefined }) {
  const rel = q.symbol === ".NDX" && nqPct != null && q.changePct != null ? Math.round((q.changePct - nqPct) * 100) / 100 : null;
  const up = (q.change ?? 0) >= 0;
  return (
    <div
      className="rounded-lg border border-white/5 bg-white/[0.03] p-2 transition-colors hover:bg-white/[0.06]"
      title={q.asOf ? `as of ${q.asOf}` : undefined}
    >
      <p className="truncate font-mono text-[11px] font-semibold tracking-[0.04em] text-zinc-400">{q.label}</p>
      <p className="mt-0.5 font-mono text-[15px] leading-none text-zinc-100 tabular-nums">{pct(q.value)}</p>
      <p className={`mt-1 flex items-center gap-1 font-mono text-[11px] leading-none tabular-nums ${deltaTone(q.change)}`}>
        {up ? "↑" : "↓"}
        {signed(q.change)}
        {rel != null ? <span className="text-zinc-500">vsNQ {signed(rel)}</span> : <span className="text-zinc-600">· {signed(q.changePct)}%</span>}
      </p>
      <div className="mt-1.5">
        <Spark pts={spark} up={up} />
      </div>
    </div>
  );
}

const GROUPS: { key: WatchQuote["group"]; label: string }[] = [
  { key: "risk", label: "Risk" },
  { key: "rates", label: "Rates" },
  { key: "fx-equities", label: "FX & Equities" },
  { key: "commodities", label: "Commodities" },
  { key: "crypto", label: "Crypto" },
];

export default function CrossAssetCard({ watch, nqPct }: { watch: WatchData | null; nqPct: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const quotes = watch?.quotes ?? [];
  const sparks = watch?.sparks ?? {};
  const hero = [...quotes].sort((a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0))[0];
  const rest = quotes.filter((q) => q.symbol !== hero?.symbol);
  const heroSpark = hero ? sparks[hero.symbol] : undefined;
  const heroUp = (hero?.change ?? 0) >= 0;

  return (
    <BentoCard
      kicker="Market"
      title="Cross-asset board"
      tone="muted"
      hero
      badge={
        <span title="CNBC quotes are exchange-delayed ~20m; BTC is Coinbase real-time when available">
          {watch?.quotes.find((q) => q.symbol === "BTC.CB=")?.asOf?.startsWith("coinbase") ? "btc live · rest delayed ~20m" : "delayed ~20m"}
        </span>
      }
      className="overflow-hidden"
    >
      <div
        ref={ref}
        onMouseMove={(e) => {
          if (reduced || !ref.current) return;
          const r = ref.current.getBoundingClientRect();
          setGlow({ x: e.clientX - r.left, y: e.clientY - r.top });
        }}
        onMouseLeave={() => setGlow(null)}
        className="relative"
      >
        {/* pointer glow */}
        {glow && (
          <div
            className="pointer-events-none absolute inset-0 z-0"
            style={{ background: `radial-gradient(220px at ${glow.x}px ${glow.y}px, rgba(52,211,153,0.08), transparent)` }}
          />
        )}

        {/* hero — biggest mover of the day */}
        {hero && (
          <div className="relative z-10 mb-3 flex items-end justify-between rounded-lg border border-white/5 bg-white/[0.03] p-3">
            <div>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.04em] text-zinc-400">{hero.label} · biggest mover</p>
              <p className="mt-1 font-mono text-[28px] leading-none tracking-[-0.02em] text-zinc-50 tabular-nums">{pct(hero.value)}</p>
              <p className={`mt-1.5 font-mono text-[11px] tabular-nums ${deltaTone(hero.change)}`}>
                {heroUp ? "↑" : "↓"} {signed(hero.change)} · {signed(hero.changePct)}%
              </p>
            </div>
            {heroSpark && (
              <svg viewBox="0 0 120 36" className="h-9 w-28" aria-hidden="true">
                <path
                  d={(() => {
                    const min = Math.min(...heroSpark);
                    const span = Math.max(...heroSpark) - min || 1;
                    return heroSpark
                      .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (heroSpark.length - 1)) * 120).toFixed(1)},${(34 - ((v - min) / span) * 30).toFixed(1)}`)
                      .join(" ");
                  })()}
                  fill="none"
                  stroke={heroUp ? "#34d399" : "#f87171"}
                  strokeWidth="2.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        )}

        {/* grouped tiles */}
        <div className="relative z-10">
          {GROUPS.map(({ key, label }) => {
            const tiles = rest.filter((q) => q.group === key);
            if (tiles.length === 0) return null;
            return (
              <div key={key}>
                <CardGroupLabel>{label}</CardGroupLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {tiles.map((t) => (
                    <Tile key={t.symbol} q={t} nqPct={nqPct} spark={sparks[t.symbol]} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {quotes.length === 0 && <p className="p-2 font-mono text-[10px] text-zinc-600">quote feed unavailable</p>}
      </div>
    </BentoCard>
  );
}
