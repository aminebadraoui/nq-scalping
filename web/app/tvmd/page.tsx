"use client";

import { useEffect, useRef, useState } from "react";
import type { TvmdSnapshot } from "@/lib/tvmd";

/* ---------------------------------------------------------------------------
 * Live Tradovate market-data view — the collected md feed rendered as a
 * footprint: per-price × per-time-bucket bid×ask volume, plus the DOM
 * ladder, the day volume profile, and the recent tick tape. Purely a
 * display of web/data/tradovate-md/*.jsonl (collector: scripts/tradovateMd.ts);
 * it never touches execution code.
 * ------------------------------------------------------------------------- */

function etTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtPrice(p: number | undefined | null): string {
  return p === undefined || p === null ? "—" : p.toFixed(2);
}

function Cell({ cell, colMax }: { cell: { bv: number; av: number } | null; colMax: number }) {
  if (!cell) return <div className="flex items-center justify-center border-r border-zinc-900 text-[9px] text-zinc-800">·</div>;
  const total = cell.bv + cell.av;
  const alpha = total > 0 ? 0.06 + 0.5 * Math.min(1, total / Math.max(1, colMax)) : 0.06;
  const buySide = cell.bv >= cell.av;
  const bg = buySide ? `rgba(52,211,153,${alpha})` : `rgba(248,113,113,${alpha})`;
  const txt = buySide ? "text-long" : "text-short";
  return (
    <div className="flex items-center justify-center gap-0.5 border-r border-zinc-900 px-0.5 text-[9px] leading-4" style={{ background: bg }}>
      <span className={`font-mono ${txt}`}>{cell.bv}</span>
      <span className="font-mono text-zinc-600">×</span>
      <span className={`font-mono ${txt}`}>{cell.av}</span>
    </div>
  );
}

function DomLadder({ snap }: { snap: TvmdSnapshot }) {
  const dom = snap.dom;
  if (!dom) return <div className="p-2 text-xs text-zinc-500">no DOM yet</div>;
  const rows: { label: string; price: number; size: number; side: "bid" | "offer" }[] = [];
  for (const o of dom.offers) rows.push({ label: "", price: o.price, size: o.size, side: "offer" });
  rows.reverse(); // highest ask on top
  rows.push({ label: "spread", price: NaN, size: NaN, side: "offer" });
  for (const b of dom.bids) rows.push({ label: "", price: b.price, size: b.size, side: "bid" });
  return (
    <div className="font-mono text-[10px]">
      {rows.map((r, i) =>
        r.label === "spread" ? (
          <div key={i} className="my-0.5 border-t border-dashed border-zinc-700" />
        ) : (
          <div key={i} className="flex items-center justify-between px-2 py-[1px]">
            <span className={r.side === "bid" ? "text-long" : "text-short"}>{r.price.toFixed(2)}</span>
            <span className="text-zinc-400">{r.size}</span>
          </div>
        ),
      )}
    </div>
  );
}

function Tape({ snap }: { snap: TvmdSnapshot }) {
  return (
    <div className="font-mono text-[10px]">
      {snap.tape.slice(0, 40).map((tk, i) => (
        <div key={i} className="flex items-center justify-between gap-2 px-2 py-[1px]">
          <span className="text-zinc-600">{etTime(tk.t).slice(3)}</span>
          <span className={tk.side === "buy" ? "text-long" : "text-short"}>{tk.price.toFixed(2)}</span>
          <span className="text-zinc-400">{tk.size}</span>
          <span className={`w-3 text-right ${tk.side === "buy" ? "text-long" : "text-short"}`}>{tk.side === "buy" ? "B" : "S"}</span>
        </div>
      ))}
      {snap.tape.length === 0 && <div className="p-2 text-xs text-zinc-500">no trades yet</div>}
    </div>
  );
}

function Profile({ snap }: { snap: TvmdSnapshot }) {
  const max = Math.max(1, ...snap.profile.map((p) => p.vol));
  return (
    <div className="font-mono text-[10px]">
      {snap.profile.slice(0, 40).map((p, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-[1px]">
          <span className="w-14 shrink-0 text-right text-zinc-500">{p.price.toFixed(2)}</span>
          <div className="h-2.5 flex-1 rounded-sm bg-zinc-800/60">
            <div className="h-full rounded-sm bg-info/60" style={{ width: `${Math.max(2, (p.vol / max) * 100)}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right text-zinc-400">{p.vol}</span>
        </div>
      ))}
      {snap.profile.length === 0 && <div className="p-2 text-xs text-zinc-500">no histogram yet</div>}
    </div>
  );
}

export default function TvmdPage() {
  const [snap, setSnap] = useState<TvmdSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/tvmd", { cache: "no-store" });
        if (!res.ok) throw new Error(`api ${res.status}`);
        const json = (await res.json()) as TvmdSnapshot;
        if (alive) {
          setSnap(json);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(String(e));
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const q = snap?.quote ?? null;
  const entries = q?.entries ?? {};
  const bid = entries.Bid as { price?: number; size?: number } | undefined;
  const offer = entries.Offer as { price?: number; size?: number } | undefined;
  const trade = entries.Trade as { price?: number; size?: number } | undefined;
  const totalVol = entries.TotalTradeVolume as { size?: number } | undefined;
  const openPx = entries.OpeningPrice as { price?: number } | undefined;

  const lastFrameMs = snap?.stats.lastFrame ? Date.parse(snap.stats.lastFrame) : 0;
  const fresh = lastFrameMs > 0 && Date.now() - lastFrameMs < 30_000;

  const colMax = snap ? snap.columns.map((_, ci) => Math.max(1, ...snap.footprint.map((r) => (r.cells[ci] ? r.cells[ci]!.bv + r.cells[ci]!.av : 0)))) : [];

  return (
    <div className="min-h-screen p-3 text-zinc-200">
      {/* header */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-zinc-800 bg-panel px-4 py-2 font-mono text-xs">
        <span className="text-sm font-semibold text-zinc-100">Tradovate MD</span>
        <span className="text-zinc-400">
          MNQZ6{snap?.contractId ? ` · ${snap.contractId}` : ""} · {snap?.file ?? "—"}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${fresh ? "bg-long/15 text-long" : "bg-warn/15 text-warn"}`}>
          {fresh ? "● LIVE" : snap ? "○ STALE" : "○ WAITING"}
        </span>
        <span className="text-zinc-300">
          bid <span className="text-long">{fmtPrice(bid?.price)}</span>
          <span className="text-zinc-500">×{bid?.size ?? "—"}</span>
        </span>
        <span className="text-zinc-300">
          ask <span className="text-short">{fmtPrice(offer?.price)}</span>
          <span className="text-zinc-500">×{offer?.size ?? "—"}</span>
        </span>
        <span className="text-zinc-300">
          last <span className="text-zinc-100">{fmtPrice(trade?.price)}</span>
          <span className="text-zinc-500">×{trade?.size ?? "—"}</span>
        </span>
        <span className="text-zinc-500">
          vol {totalVol?.size ?? "—"} · open {fmtPrice(openPx?.price)}
        </span>
        <span className="ml-auto text-zinc-500">
          {snap ? `frames ${snap.stats.frames} · ticks ${snap.stats.ticks} · ${err ? "api error" : ""}` : "loading…"}
        </span>
      </div>

      {!snap || snap.stats.frames === 0 ? (
        <div className="rounded-lg border border-zinc-800 bg-panel p-8 text-center font-mono text-sm text-zinc-400">
          {err ? (
            <>API error: {err}</>
          ) : (
            <>
              No collected frames yet — start the collector in another terminal (from <span className="text-zinc-200">web/</span>):
              <pre className="mx-auto mt-3 w-fit rounded bg-zinc-900 px-4 py-2 text-xs text-long">
                node --import ../scripts/ts-loader.mjs ./scripts/tradovateMd.ts
              </pre>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-3">
          {/* footprint */}
          <div className="col-span-12 overflow-x-auto rounded-lg border border-zinc-800 bg-panel lg:col-span-8">
            <div className="flex items-center justify-between px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <span>footprint · bid×ask per 15s bucket</span>
              <span>{snap.columns.length} buckets</span>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 220px)" }}>
              <div
                className="grid min-w-max"
                style={{ gridTemplateColumns: `70px repeat(${Math.max(1, snap.columns.length)}, 74px)` }}
              >
                <div className="sticky left-0 z-10 border-b border-zinc-800 bg-panel px-2 py-1 text-[9px] text-zinc-500">price</div>
                {snap.columns.map((c, ci) => (
                  <div key={ci} className="border-b border-zinc-800 px-1 py-1 text-center text-[9px] text-zinc-500">
                    {etTime(c.t0)}
                  </div>
                ))}
                {snap.footprint.map((row) => (
                  <FragmentRow key={row.price} row={row} colMax={colMax} />
                ))}
              </div>
            </div>
          </div>

          {/* right column: DOM + tape */}
          <div className="col-span-12 grid gap-3 lg:col-span-4">
            <div className="rounded-lg border border-zinc-800 bg-panel">
              <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">dom · 10 levels</div>
              <DomLadder snap={snap} />
            </div>
            <div className="rounded-lg border border-zinc-800 bg-panel">
              <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">tape · last trades</div>
              <div className="max-h-72 overflow-y-auto">
                <Tape snap={snap} />
              </div>
            </div>
          </div>

          {/* day profile */}
          <div className="col-span-12 rounded-lg border border-zinc-800 bg-panel lg:col-span-8">
            <div className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">session volume profile</div>
            <Profile snap={snap} />
          </div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ row, colMax }: { row: { price: number; cells: ({ bv: number; av: number } | null)[] }; colMax: number[] }) {
  return (
    <>
      <div className="sticky left-0 z-10 flex items-center border-b border-zinc-900 bg-panel px-2 font-mono text-[10px] text-zinc-300">
        {row.price.toFixed(2)}
      </div>
      {row.cells.map((cell, ci) => (
        <Cell key={ci} cell={cell} colMax={colMax[ci] ?? 1} />
      ))}
    </>
  );
}
