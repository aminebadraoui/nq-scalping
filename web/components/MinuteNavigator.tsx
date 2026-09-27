"use client";

import { useEffect, useMemo, useState } from "react";
import type { FPMinute } from "@/lib/footprint";
import { cdtToET, utcToET } from "@/lib/times";

export default function MinuteNavigator({
  minutes,
  date,
  absorption = [],
  timeMode = "cdt",
}: {
  minutes: FPMinute[];
  date: string;
  absorption?: { t: string; price: number; side: "bid" | "ask"; bias: "bull" | "bear"; volume?: number; imbalance?: number }[];
  /** "cdt" = collected feed clock (US Central) · "utc" = live tick clock */
  timeMode?: "cdt" | "utc";
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

  // sparkline context: last 60 bars, delta-colored
  const ctx = useMemo(() => minutes.slice(-60), [minutes]);
  const maxAbs = Math.max(1, ...ctx.map((x) => Math.abs(x.delta)));
  const selInCtx = i - (n - ctx.length);

  const stepBar = (dir: number) => {
    setPinned(false);
    setIdx((v) => Math.min(Math.max(0, v + dir), Math.max(0, n - 1)));
  };
  const goLatest = () => {
    setPinned(true);
    setIdx(Math.max(0, n - 1));
  };

  const pocOf = m.levels.reduce(
    (best, l) => (l.buy + l.sell > (best?.buy ?? 0) + (best?.sell ?? 0) ? l : best),
    m.levels[0],
  );
  const absorbs = absorption.filter((a) => a.t === m.t);

  return (
    <div className="rounded-md border border-zinc-800 bg-panel p-3">
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
          onChange={(e) => {
            setPinned(false);
            setIdx(Number(e.target.value));
          }}
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

      {/* sparkline: last 60 minutes of delta — click to jump */}
      <div className="mb-2 flex h-10 items-end gap-px overflow-hidden rounded border border-zinc-800/70 bg-zinc-950/60 px-1 py-1">
        {ctx.map((x, k) => {
          const h = 25 + (Math.abs(x.delta) / maxAbs) * 70;
          return (
            <button
              key={k}
              title={`${toET(x.t)} NY · Δ ${x.delta >= 0 ? "+" : ""}${x.delta}`}
              onClick={() => {
                setPinned(false);
                setIdx(n - ctx.length + k);
              }}
              className={`min-w-0 flex-1 rounded-[1px] ${k === selInCtx ? "ring-1 ring-amber-400" : ""}`}
              style={{ height: `${h}%`, background: x.delta >= 0 ? "#34d399" : "#f87171", opacity: 0.75 }}
            />
          );
        })}
      </div>

      {/* ladder */}
      <div className="mb-1 flex flex-wrap items-center gap-3 font-mono text-[10px] text-zinc-500">
        <span className="text-zinc-400">bid × ask per tick</span>
        <span className="text-long">▲ buy-side imbalance</span>
        <span className="text-short">▼ sell-side imbalance</span>
        <span>◆ measured against the adjacent tick (diagonal)</span>
        <span>□ zero-side tick — unfinished auction</span>
        <span className="text-zinc-400">stacked = 3+ ticks imbalanced the same way (boxed in the footprint view)</span>
      </div>
      <div className="grid max-h-96 grid-cols-6 gap-x-2 gap-y-0.5 overflow-y-auto pr-2 font-mono text-[11px]">
        <div className="col-span-6 grid grid-cols-6 border-b border-zinc-800 pb-1 text-zinc-500">
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
