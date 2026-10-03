"use client";

import { useDom } from "@/lib/useDom";

const fmt = (p: number) => p.toFixed(2);

function confBar(c: number) {
  const n = Math.min(5, Math.max(1, Math.round(c * 5)));
  return { filled: n, cls: c >= 0.7 ? "text-warn" : c >= 0.5 ? "text-info" : "text-zinc-400" };
}

/** Live DOM_V2 book + iceberg (hidden resting order) candidates — study aid. */
export default function DomIcebergPanel() {
  const dom = useDom();

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-zinc-50">
          DOM — hidden liquidity <span className="ml-1 font-mono text-[10px] font-normal text-zinc-500">refill signatures in the L2 book</span>
        </h2>
        <span className={`font-mono text-[10px] ${dom?.connected ? "text-info" : "text-zinc-500"}`}>
          {dom ? (dom.connected ? "live · wsdom" : "connecting…") : "waiting…"} · study aid — not an entry signal
        </span>
      </div>

      {/* top-of-book ladder (top 5 each side) */}
      {dom && dom.book.bids.length > 0 && (
        <div className="mb-2 grid grid-cols-2 gap-2 font-mono text-[10px]">
          <div>
            <div className="mb-0.5 text-zinc-500">asks</div>
            {[...dom.book.asks].reverse().map((r, i) => (
              <div key={i} className="flex justify-between border-t border-zinc-800/60 px-1 text-short">
                <span>{fmt(r.p)}</span>
                <span>{r.s}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-0.5 text-right text-zinc-500">bids</div>
            {dom.book.bids.map((r, i) => (
              <div key={i} className="flex justify-between border-t border-zinc-800/60 px-1 text-long">
                <span>{r.s}</span>
                <span>{fmt(r.p)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* iceberg candidates */}
      {dom && dom.icebergs.length > 0 ? (
        <div className="space-y-1">
          {dom.icebergs.slice(0, 5).map((c, i) => {
            const bar = confBar(c.confidence);
            return (
              <div key={`${c.side}|${c.price}|${i}`} className="rounded border border-zinc-800/70 px-2 py-1">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span>
                    <span className={c.side === "bid" ? "text-long" : "text-short"}>{c.side === "bid" ? "BID" : "ASK"}</span>{" "}
                    <span className="text-zinc-200">{fmt(c.price)}</span>{" "}
                    <span className="text-zinc-500">shown {c.size} · slice ~{c.refillSize}</span>
                  </span>
                  <span className={bar.cls} title={`confidence ${(c.confidence * 100).toFixed(0)}%`}>
                    {"▮".repeat(bar.filled)}
                    {"▯".repeat(5 - bar.filled)}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-zinc-500">
                  <span>
                    refills <span className="text-zinc-300">{c.refills}</span>
                  </span>
                  <span>
                    absorbed <span className="text-zinc-300">{c.absorbed}</span>
                  </span>
                  <span>
                    consistent <span className="text-zinc-300">{(c.refillConsistency * 100).toFixed(0)}%</span>
                  </span>
                  <span>
                    peak <span className="text-zinc-300">{c.peak}</span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="font-mono text-[10px] leading-relaxed text-zinc-600">
          {dom?.connected
            ? "no refill signatures in the window — size being eaten and coming back at one price is the hidden-order fingerprint (iceberg slice refilling)."
            : "the L2 feed only streams while Globex is open (Sun 18:00 → Fri 17:00 NY)."}
        </p>
      )}

      <details className="mt-2 rounded border border-zinc-800/70 px-2 py-1">
        <summary className="cursor-pointer list-none font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
          ▸ how this works + thresholds
        </summary>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
          an iceberg only shows its top slice, so the hidden order is inferred: a level whose visible size is consumed and then
          replenishes repeatedly (refill) while price cannot trade through is being defended by hidden size. candidate = ≥3 refills
          of ≥2 contracts inside 90s + ≥25 contracts absorbed at one price. confidence = refills × absorbed × refill-size
          consistency. aggregated book only — no order IDs, so this is the ATAS/Bookmap refill heuristic, not order-level truth
          (that needs MBO data).
        </p>
      </details>
    </section>
  );
}
