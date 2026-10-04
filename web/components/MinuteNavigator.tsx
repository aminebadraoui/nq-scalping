"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FPMinute } from "@/lib/footprint";
import { cdtToET, utcToET } from "@/lib/times";
import { computeDivergences, cumulativeDelta } from "@/lib/divergence";

const compact = (v: number): string => {
  const a = Math.abs(v);
  const s = v >= 0 ? "+" : "";
  if (a >= 1_000_000) return `${s}${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${s}${(v / 1_000).toFixed(1)}k`;
  return `${s}${v}`;
};

/** one minute of the full-session strip (memoized — ~1400 cells, only the
 *  live tail and the selection actually change between renders) */
const StripCell = memo(function StripCell({
  k,
  x,
  cum,
  dv,
  sel,
  selRef,
  toET,
  onTap,
}: {
  k: number;
  x: FPMinute;
  cum: number;
  dv?: "D2" | "D4";
  sel: boolean;
  selRef?: (el: HTMLButtonElement | null) => void;
  toET: (hhmm: string) => string;
  onTap: (k: number) => void;
}) {
  return (
    <button
      ref={selRef}
      onClick={() => onTap(k)}
      title={
        dv
          ? dv === "D2"
            ? `D2 · bullish divergence — lower pivot low with HIGHER cumulative delta (sellers exhausted). Tap to inspect the bar and sync the chart.`
            : `D4 · bearish divergence — higher pivot high with LOWER cumulative delta (buyers exhausted). Tap to inspect the bar and sync the chart.`
          : `${toET(x.t)} NY · Δ ${x.delta >= 0 ? "+" : ""}${x.delta} · cumΔ ${cum >= 0 ? "+" : ""}${cum} — tap to sync the chart`
      }
      className={`w-9 min-w-9 flex-none rounded-b py-1 text-center font-mono ${
        sel
          ? "bg-zinc-900/70 ring-1 ring-amber-400"
          : dv
            ? dv === "D2"
              ? "bg-long/10 hover:bg-long/20"
              : "bg-short/10 hover:bg-short/20"
            : "hover:bg-zinc-900/40"
      }`}
    >
      <p className={`text-[9px] leading-[12px] tabular-nums ${x.delta >= 0 ? "text-long" : "text-short"}`}>{compact(x.delta)}</p>
      <p className={`text-[9px] leading-[12px] tabular-nums ${cum >= 0 ? "text-long" : "text-short"}`}>{compact(cum)}</p>
      <p className={`text-[10px] leading-[12px] ${dv ? (dv === "D2" ? "text-long" : "text-short") : "text-zinc-700"}`}>
        {dv ? (dv === "D2" ? "▲" : "▼") : "·"}
      </p>
    </button>
  );
});

/** one histogram bar of the per-minute strip — the same 36px column as the
 *  stats cell below it, so the two rows scroll as one aligned grid */
const HistBar = memo(function HistBar({
  k,
  x,
  sel,
  maxAbs,
  toET,
  onTap,
}: {
  k: number;
  x: FPMinute;
  sel: boolean;
  maxAbs: number;
  toET: (hhmm: string) => string;
  onTap: (k: number) => void;
}) {
  const h = 15 + (Math.abs(x.delta) / maxAbs) * 85;
  return (
    <button
      onClick={() => onTap(k)}
      title={`${toET(x.t)} NY · Δ ${x.delta >= 0 ? "+" : ""}${x.delta} — tap to sync the chart`}
      className={`w-9 min-w-9 flex-none rounded-[1px] ${sel ? "ring-1 ring-amber-400" : ""}`}
      style={{ height: `${h}%`, background: x.delta >= 0 ? "#34d399" : "#f87171", opacity: 0.8 }}
    />
  );
});

export default function MinuteNavigator({
  minutes,
  date,
  absorption = [],
  timeMode = "cdt",
  onSelect,
}: {
  minutes: FPMinute[];
  date: string;
  absorption?: { t: string; price: number; side: "bid" | "ask"; bias: "bull" | "bear"; volume?: number; imbalance?: number }[];
  /** "cdt" = collected feed clock (US Central) · "utc" = live tick clock */
  timeMode?: "cdt" | "utc";
  /** fired whenever the user taps/selects a bar — the page syncs the chart to it */
  onSelect?: (t: string, d?: string) => void;
}) {
  const toET = timeMode === "utc" ? utcToET : cdtToET;
  const n = minutes.length;
  const [idx, setIdx] = useState<number>(Math.max(0, n - 1));
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    if (pinned) setIdx(Math.max(0, n - 1));
  }, [n, pinned]);

  const i = Math.min(Math.max(0, idx), Math.max(0, n - 1));
  const m = minutes[i];

  // per-bar stats: session cumulative delta + the shared divergence def
  const cvd = useMemo(() => cumulativeDelta(minutes), [minutes]);
  const divergences = useMemo(() => computeDivergences(minutes), [minutes]);
  const divAt = useMemo(() => {
    const map = new Map<number, "D2" | "D4">();
    for (const d of divergences) map.set(d.index, d.kind);
    return map;
  }, [divergences]);

  // histogram scale across the WHOLE session (the strip shows every minute,
  // so the reference is the session's biggest |Δ|, with a visible floor)
  const maxAbs = Math.max(1, ...minutes.map((x) => Math.abs(x.delta)));

  /** select bar k and tell the page (which syncs the chart to that minute) */
  const jumpTo = (k: number) => {
    const kk = Math.min(Math.max(0, k), Math.max(0, n - 1));
    setPinned(false);
    setIdx(kk);
    const mm = minutes[kk];
    if (mm) onSelect?.(mm.t, mm.d);
  };
  const stepBar = (dir: number) => {
    jumpTo(idx + dir);
  };
  const goLatest = () => {
    setPinned(true);
    setIdx(Math.max(0, n - 1));
    const mm = minutes[Math.max(0, n - 1)];
    if (mm) onSelect?.(mm.t, mm.d);
  };

  // full-session strip scrolling: follow the live edge while pinned, centre
  // the tapped bar while exploring. Cells call jumpTo through a ref so the
  // memoized strip survives the per-tick minutes identity change.
  const stripRef = useRef<HTMLDivElement>(null);
  const selCellRef = useRef<HTMLButtonElement | null>(null);
  const setSelCell = useCallback((el: HTMLButtonElement | null) => {
    selCellRef.current = el;
  }, []);
  const jumpToRef = useRef<(k: number) => void>(() => {});
  useEffect(() => {
    jumpToRef.current = jumpTo;
  });
  const tapCell = useCallback((k: number) => jumpToRef.current(k), []);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    if (pinned) {
      el.scrollTo({ left: el.scrollWidth, behavior: "auto" });
    } else {
      selCellRef.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }, [i, pinned, n]);

  const pocOf = m.levels.reduce(
    (best, l) => (l.buy + l.sell > (best?.buy ?? 0) + (best?.sell ?? 0) ? l : best),
    m.levels[0],
  );
  const absorbs = absorption.filter((a) => a.t === m.t);
  const divHere = divAt.get(i) ?? null;
  const divDetail = divergences.find((d) => d.index === i) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-md border border-zinc-800 bg-panel p-3">
      {/* navigation */}
      <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-xs">
        <button onClick={() => stepBar(-1)} disabled={i <= 0} className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30">
          ◀ prev
        </button>
        <button onClick={() => stepBar(1)} disabled={i >= n - 1} className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30">
          next ▶
        </button>
        <button
          onClick={goLatest}
          className={`rounded border px-2 py-1 ${pinned ? "border-info/50 bg-info/10 text-info" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
        >
          ⏵ latest {pinned ? "(pinned)" : ""}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, n - 1)}
          value={i}
          onChange={(e) => jumpTo(Number(e.target.value))}
          className="min-w-40 flex-1 accent-amber-400"
        />
        <span className="whitespace-nowrap text-zinc-400">
          bar <span className="text-zinc-200">{i + 1}</span> / {n} · <span className="text-zinc-200">{toET(m.t)}</span> (New York) ·{" "}
          <span className="text-zinc-200">{date}</span>
        </span>
      </div>

      {/* minute summary */}
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px] text-zinc-400">
        {m.o ? (
          <span>
            O <span className="text-zinc-200">{m.o.toFixed(2)}</span> C <span className={(m.c ?? 0) >= m.o ? "text-long" : "text-short"}>{(m.c ?? 0).toFixed(2)}</span>
          </span>
        ) : null}
        <span>H <span className="text-zinc-200">{m.high.toFixed(2)}</span></span>
        <span>L <span className="text-zinc-200">{m.low.toFixed(2)}</span></span>
        <span>
          buy <span className="text-long">{m.buy.toLocaleString()}</span> · sell <span className="text-short">{m.sell.toLocaleString()}</span>
        </span>
        <span>
          Δ <span className={m.delta >= 0 ? "text-long" : "text-short"}>{m.delta >= 0 ? "+" : ""}{m.delta.toLocaleString()}</span>
          {m.buy + m.sell > 0 && (
            <span className="text-zinc-500"> ({((m.delta / (m.buy + m.sell)) * 100).toFixed(0)}%)</span>
          )}
        </span>
        <span>
          bar POC <span className="text-warn">{pocOf ? pocOf.price.toFixed(2) : "—"}</span>
        </span>
        {m.vwap ? (
          <span>
            bar VWAP <span className="text-zinc-200">{m.vwap.toFixed(2)}</span>
          </span>
        ) : null}
        {m.imb ? (
          <span title="footprint imbalance: bid x ask pressure per tick (>=3:1 and >=10 ct)">
            imbalance{" "}
            <span className="text-long">{m.imb.buy}▲</span> / <span className="text-short">{m.imb.sell}▼</span>
            <span className="text-zinc-500"> (diag {m.imb.dBuy}/{m.imb.dSell})</span>
            {m.imb.stacked ? (
              <span className={m.imb.stacked.side === "buy" ? "text-long" : "text-short"}>
                {" "}
                · stacked {m.imb.stacked.side === "buy" ? "▲" : "▼"}×{m.imb.stacked.len} {m.imb.stacked.from.toFixed(2)}–{m.imb.stacked.to.toFixed(2)}
              </span>
            ) : null}
            {m.imb.biased ? (
              <span className={m.imb.biased === "buy" ? "text-long" : "text-short"}>
                {" "}
                · {m.imb.biased === "buy" ? "buy" : "sell"}-biased bar
              </span>
            ) : null}
          </span>
        ) : null}
        {absorbs.length > 0 && (
          <span className="text-info">
            ⬦ absorption here ({absorbs.map((a) => `${a.bias === "bull" ? "buyers" : "sellers"}@${a.price.toFixed(2)}`).join(", ")})
          </span>
        )}
      </div>

      {/* divergence explainer — appears when the selected bar carries a D2/D4 */}
      {divHere && (
        <div
          className={`mb-2 rounded border px-2 py-1.5 font-mono text-[11px] leading-snug ${
            divHere === "D2" ? "border-long/40 bg-long/10" : "border-short/40 bg-short/10"
          }`}
        >
          <span className={`font-bold ${divHere === "D2" ? "text-long" : "text-short"}`}>
            {divHere === "D2" ? "▲ D2 · bullish divergence" : "▼ D4 · bearish divergence"}
          </span>
          {divDetail ? <span className="text-zinc-400"> — pivot at {divDetail.price.toFixed(2)}</span> : null}
          <span className="block text-zinc-300">
            {divHere === "D2"
              ? "price made a LOWER pivot low than the previous pivot low, but cumulative delta (buy−sell) is HIGHER — the new low was pushed with less aggressive selling. Sellers are exhausting / buyers are absorbing. It's a symptom, not a trigger: wait for a reclaim (buyers stepping back in) before acting."
              : "price made a HIGHER pivot high than the previous pivot high, but cumulative delta (buy−sell) is LOWER — the new high was pushed with less aggressive buying. Buyers are exhausting / sellers are absorbing. It's a symptom, not a trigger: wait for a rejection or a sweep-and-reclaim before acting."}
          </span>
        </div>
      )}

      {/* divergence index — every D2/D4 of the session in one place; tapping a
          chip selects that bar, shows its explainer and syncs the chart */}
      {divergences.length > 0 && (
        <div className="mb-2 flex max-h-20 flex-wrap items-center gap-1 overflow-y-auto rounded border border-zinc-800/70 bg-zinc-950/60 px-1.5 py-1">
          <span className="mr-1 font-mono text-[9px] uppercase tracking-wider text-zinc-500">divergences · {divergences.length}</span>
          {divergences.map((dv) => {
            const active = dv.index === i;
            const bull = dv.kind === "D2";
            return (
              <button
                key={dv.index}
                onClick={() => jumpTo(dv.index)}
                title={
                  bull
                    ? `D2 · bullish divergence at ${toET(minutes[dv.index].t)} NY — lower pivot low with HIGHER cumulative delta (sellers exhausted). Tap to inspect the bar and sync the chart.`
                    : `D4 · bearish divergence at ${toET(minutes[dv.index].t)} NY — higher pivot high with LOWER cumulative delta (buyers exhausted). Tap to inspect the bar and sync the chart.`
                }
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${
                  active
                    ? bull
                      ? "border-long bg-long/25 text-long"
                      : "border-short bg-short/25 text-short"
                    : bull
                      ? "border-long/40 bg-long/5 text-long/90 hover:bg-long/15"
                      : "border-short/40 bg-short/5 text-short/90 hover:bg-short/15"
                }`}
              >
                {bull ? "▲" : "▼"} {toET(minutes[dv.index].t)} @ {dv.price.toFixed(2)}
              </button>
            );
          })}
        </div>
      )}

      {/* per-minute strip: histogram (Δ) + stats (Δ · cumΔ · divergence), the
          WHOLE session, one shared scroll — every histogram bar sits in the
          same 36px column as its stats cell, so rows stay aligned */}
      <div ref={stripRef} className="mb-2 overflow-x-auto rounded border border-zinc-800/70 bg-zinc-950/60 px-1 pb-0.5 pt-1">
        <div className="flex w-max flex-col gap-1">
          <div className="flex items-end gap-1" style={{ height: "2.5rem" }}>
            {minutes.map((x, k) => (
              <HistBar key={k} k={k} x={x} sel={k === i} maxAbs={maxAbs} toET={toET} onTap={tapCell} />
            ))}
          </div>
          <div className="flex gap-1">
            {minutes.map((x, k) => (
              <StripCell
                key={k}
                k={k}
                x={x}
                cum={cvd[k] ?? 0}
                dv={divAt.get(k)}
                sel={k === i}
                selRef={k === i ? setSelCell : undefined}
                toET={toET}
                onTap={tapCell}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ladder */}
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px] leading-tight text-zinc-600">
        <span className="text-zinc-500">bid × ask per tick</span>
        <span className="text-long">▲ buy imb</span>
        <span className="text-short">▼ sell imb</span>
        <span>◆ diagonal</span>
        <span>□ zero-side</span>
        <span>histogram (Δ) · Δ · cumΔ · divergence per minute — full session, scroll ↔ · tinted cells = divergence</span>
        <span className="text-warn">tapping a bar (or ◀/▶/slider) syncs the chart to that minute</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-6 gap-x-2 gap-y-0 overflow-y-auto pr-2 font-mono text-[10px] leading-4">
        <div className="col-span-6 grid grid-cols-6 border-b border-zinc-800 pb-0.5 text-zinc-500">
          <span>price</span>
          <span className="text-right">bid</span>
          <span className="text-right">ask</span>
          <span className="text-right">Δ</span>
          <span className="text-right">total</span>
          <span className="text-right">imb</span>
        </div>
        {m.levels.map((l, idx) => {
          const isPoc = pocOf && l.price === pocOf.price;
          const buyImb = l.dBuy ?? l.hBuy ?? false;
          const sellImb = l.dSell ?? l.hSell ?? false;
          const diag = !!(l.dBuy || l.dSell);
          // a diagonal against a tick that never traded its opposite side is a
          // one-sided print: the ratio is infinite, so say so instead of
          // dividing by the 1-contract floor used internally
          const belowSell = idx < m.levels.length - 1 ? m.levels[idx + 1].sell : 0;
          const aboveBuy = idx > 0 ? m.levels[idx - 1].buy : 0;
          const inf = (l.dBuy && belowSell === 0) || (l.dSell && aboveBuy === 0);
          const ratio = diag
            ? Math.max(l.dBuy ? (l.dBuyRatio ?? 0) : 0, l.dSell ? (l.dSellRatio ?? 0) : 0)
            : (l.ratio ?? Math.max(l.buy, l.sell) / Math.max(1, Math.min(l.buy, l.sell)));
          const zeroSide = Math.min(l.buy, l.sell) === 0;
          const rowTone = buyImb ? "bg-long/10" : sellImb ? "bg-short/10" : isPoc ? "bg-warn/10" : "";
          return (
            <div key={l.price} className={`col-span-6 grid grid-cols-6 rounded ${rowTone}`}>
              <span className={`${isPoc ? "text-warn" : "text-zinc-300"}`}>{l.price.toFixed(2)}{isPoc ? " ◂POC" : ""}</span>
              <span className="text-right text-short">{l.sell || "–"}</span>
              <span className="text-right text-long">{l.buy || "–"}</span>
              <span className={`text-right ${l.buy >= l.sell ? "text-long" : "text-short"}`}>{l.buy - l.sell}</span>
              <span className="text-right text-zinc-400">{(l.buy + l.sell).toLocaleString()}</span>
              <span className="text-right">
                {buyImb || sellImb ? (
                  <span className={buyImb ? "text-long" : "text-short"} title={inf ? "one-sided print: the neighbouring tick's opposite side never traded" : `${ratio.toFixed(1)}:1${diag ? " diagonal" : " horizontal"}`}>
                    {buyImb ? "▲" : "▼"}
                    {diag ? "◆" : ""} {inf ? "∞" : ratio.toFixed(1)}×
                  </span>
                ) : zeroSide ? (
                  <span className="text-zinc-500" title="one side never traded here — unfinished auction">
                    □
                  </span>
                ) : (
                  <span className="text-zinc-700">·</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

    </div>
  );
}
