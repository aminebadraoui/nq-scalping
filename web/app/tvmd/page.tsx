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

/* GoCharting DomState over /api/dom SSE (lib/dom.ts) — top-10 book per
 * symbol, throttled ~1/s. NQ and MNQ share the same price scale (0.25
 * tick), so books are directly comparable. */
interface GcLevel {
  p: number;
  s: number;
}
interface GcState {
  connected: boolean;
  lastMessage: number;
  frames: number;
  silentConnects: number;
  lastReconnectAt: number;
  nq: { symbol: string; book: { bids: GcLevel[]; asks: GcLevel[] } };
}

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
  const [gc, setGc] = useState<GcState | null>(null);
  const inFlight = useRef(false);
  const gcRef = useRef<GcState | null>(null);
  const samplesRef = useRef<DeltaSample[]>([]);
  const [samples, setSamples] = useState<DeltaSample[]>([]);

  // GoCharting DOM book over SSE (~1/s)
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/dom");
      es.onmessage = (ev) => {
        try {
          const g = JSON.parse(ev.data) as GcState;
          gcRef.current = g;
          setGc(g);
        } catch {
          /* keep last */
        }
      };
    } catch {
      /* no SSE — panel will report no feed */
    }
    return () => es?.close();
  }, []);

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
          // divergence sample: TV quote vs GC book, only when both fresh
          const g = gcRef.current;
          if (g && g.connected && json.stats.lastFrame && g.lastMessage) {
            const now = Date.now();
            const tvFresh = now - Date.parse(json.stats.lastFrame) < 30_000;
            const gcFresh = now - g.lastMessage < 30_000;
            if (tvFresh && gcFresh) {
              const tvBid = json.quote?.entries.Bid as { price?: number } | undefined;
              const tvAsk = json.quote?.entries.Offer as { price?: number } | undefined;
              const gb = g.nq.book.bids[0];
              const ga = g.nq.book.asks[0];
              if (tvBid?.price !== undefined && tvAsk?.price !== undefined && gb && ga) {
                const s: DeltaSample = {
                  t: now,
                  dMid: (tvBid.price + tvAsk.price) / 2 - (gb.p + ga.p) / 2,
                  dBid: tvBid.price - gb.p,
                  dAsk: tvAsk.price - ga.p,
                };
                samplesRef.current = [...samplesRef.current, s].slice(-300); // 5 min ring
                if (alive) setSamples(samplesRef.current);
              }
            }
          }
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

      {snap && snap.stats.frames > 0 && (
        <div className="mt-3">
          <ComparePanel snap={snap} gc={gc} samples={samples} />
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

/* ------------------- GoCharting vs Tradovate ------------------- */

interface DeltaSample {
  t: number;
  dMid: number;
  dBid: number;
  dAsk: number;
}

const TICK = 0.25;

function Sparkline({ samples, field, color }: { samples: DeltaSample[]; field: "dMid" | "dBid" | "dAsk"; color: string }) {
  if (samples.length < 2) return <div className="h-12 rounded bg-zinc-900/40" />;
  const vals = samples.map((s) => s[field]);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const span = max - min || 1;
  const w = 320;
  const h = 48;
  const y = (v: number) => h - ((v - min) / span) * h;
  const pts = samples.map((s, i) => `${(i / (samples.length - 1)) * w},${y(s[field])}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <line x1={0} y1={y(0)} x2={w} y2={y(0)} stroke="#3f3f46" strokeDasharray="3 3" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ComparePanel({ snap, gc, samples }: { snap: TvmdSnapshot; gc: GcState | null; samples: DeltaSample[] }) {
  const tvBid = snap.quote?.entries.Bid as { price?: number; size?: number } | undefined;
  const tvAsk = snap.quote?.entries.Offer as { price?: number; size?: number } | undefined;
  const tvMid = tvBid?.price !== undefined && tvAsk?.price !== undefined ? (tvBid.price + tvAsk.price) / 2 : null;
  const gcBid = gc?.nq.book.bids[0] ?? null;
  const gcAsk = gc?.nq.book.asks[0] ?? null;
  const gcMid = gcBid && gcAsk ? (gcBid.p + gcAsk.p) / 2 : null;
  const gcFresh = gc ? Date.now() - gc.lastMessage < 30_000 : false;
  const tvFresh = snap.stats.lastFrame ? Date.now() - Date.parse(snap.stats.lastFrame) < 30_000 : false;

  const dMid = tvMid !== null && gcMid !== null ? tvMid - gcMid : null;
  const dBid = tvBid?.price !== undefined && gcBid ? tvBid.price - gcBid.p : null;
  const dAsk = tvAsk?.price !== undefined && gcAsk ? tvAsk.price - gcAsk.p : null;

  const absMids = samples.map((s) => Math.abs(s.dMid));
  const maxAbs = absMids.length ? Math.max(...absMids) : 0;
  const meanAbs = absMids.length ? absMids.reduce((a, b) => a + b, 0) / absMids.length : 0;
  const maxSample = samples.reduce((a, b) => (Math.abs(b.dMid) > Math.abs(a.dMid) ? b : a), samples[0] ?? { t: 0, dMid: 0, dBid: 0, dAsk: 0 });

  const tvBids = snap.dom?.bids.slice(0, 10) ?? [];
  const tvAsks = snap.dom?.offers.slice(0, 10) ?? [];
  const gcBids = gc?.nq.book.bids ?? [];
  const gcAsks = gc?.nq.book.asks ?? [];
  const cumTvBid = tvBids.reduce((a, l) => a + l.size, 0);
  const cumTvAsk = tvAsks.reduce((a, l) => a + l.size, 0);
  const cumGcBid = gcBids.reduce((a, l) => a + l.s, 0);
  const cumGcAsk = gcAsks.reduce((a, l) => a + l.s, 0);

  const deltaCell = (v: number | null) =>
    v === null ? (
      <span className="text-zinc-700">—</span>
    ) : (
      <span className={Math.abs(v) < 1e-9 ? "text-zinc-500" : v > 0 ? "text-long" : "text-short"}>
        {v > 0 ? "+" : ""}
        {v.toFixed(2)}
      </span>
    );

  return (
    <div className="rounded-lg border border-zinc-800 bg-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-zinc-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        <span>gocharting vs tradovate — live divergence</span>
        <span className={`rounded px-1.5 py-0.5 normal-case ${gcFresh ? "bg-long/15 text-long" : "bg-warn/15 text-warn"}`}>
          GC {gc ? (gcFresh ? "● live" : "○ stale") : "○ no feed"}
        </span>
        <span className={`rounded px-1.5 py-0.5 normal-case ${tvFresh ? "bg-long/15 text-long" : "bg-warn/15 text-warn"}`}>
          TV {tvFresh ? "● live" : "○ stale"}
        </span>
        <span className="normal-case">NQ (GC) ≈ MNQ (TV) · tick 0.25 both · Δ = TV − GC</span>
      </div>

      {!gc || (!gcFresh && !tvFresh) ? (
        <div className="p-4 text-center font-mono text-xs text-zinc-500">
          {!gc ? "GoCharting DOM feed not connected (lib/dom has no frames — check GOCHARTING_* env and the vendor socket)" : "both feeds stale — check the collectors"}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-3 p-3">
          {/* prices */}
          <div className="col-span-12 rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <table className="w-full">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal">level</th>
                  <th className="text-right font-normal">GoCharting</th>
                  <th className="text-right font-normal">Tradovate</th>
                  <th className="text-right font-normal">Δ pts</th>
                  <th className="text-right font-normal">Δ ticks</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-zinc-500">bid</td>
                  <td className="text-right">{gcBid ? gcBid.p.toFixed(2) : "—"}</td>
                  <td className="text-right">{tvBid?.price?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">{deltaCell(dBid)}</td>
                  <td className="text-right">{dBid === null ? "—" : (dBid / TICK).toFixed(0)}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">ask</td>
                  <td className="text-right">{gcAsk ? gcAsk.p.toFixed(2) : "—"}</td>
                  <td className="text-right">{tvAsk?.price?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">{deltaCell(dAsk)}</td>
                  <td className="text-right">{dAsk === null ? "—" : (dAsk / TICK).toFixed(0)}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">mid</td>
                  <td className="text-right">{gcMid?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">{tvMid?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">{deltaCell(dMid)}</td>
                  <td className="text-right">{dMid === null ? "—" : (dMid / TICK).toFixed(0)}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">spread</td>
                  <td className="text-right">{gcBid && gcAsk ? (gcAsk.p - gcBid.p).toFixed(2) : "—"}</td>
                  <td className="text-right">
                    {tvBid?.price !== undefined && tvAsk?.price !== undefined ? (tvAsk.price - tvBid.price).toFixed(2) : "—"}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>

            <div className="mt-3 border-t border-zinc-800 pt-2">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">rolling window ({(samples.length)}s)</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[9px] text-zinc-500">current Δmid</p>
                  <p className="text-sm">{deltaCell(dMid)}</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">mean |Δmid|</p>
                  <p className="text-sm text-zinc-200">{meanAbs.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">max |Δmid|</p>
                  <p className="text-sm text-warn">{maxAbs.toFixed(2)}</p>
                </div>
              </div>
              <p className="mt-1 text-center text-[9px] text-zinc-600">
                peak divergence {maxSample.dMid > 0 ? "+" : ""}
                {maxSample.dMid.toFixed(2)} pts at {etTime(maxSample.t)}
              </p>
              <div className="mt-1 space-y-1">
                <div>
                  <p className="text-[9px] text-zinc-500">Δ mid</p>
                  <Sparkline samples={samples} field="dMid" color="#38bdf8" />
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">Δ bid (solid) · Δ ask (dashed)</p>
                  <Sparkline samples={samples} field="dBid" color="#34d399" />
                </div>
              </div>
            </div>
          </div>

          {/* depth */}
          <div className="col-span-12 overflow-x-auto rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <table className="w-full">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal">lv</th>
                  <th className="text-right font-normal">GC bid</th>
                  <th className="text-right font-normal">TV bid</th>
                  <th className="text-right font-normal">Δbid</th>
                  <th className="text-right font-normal">GC ask</th>
                  <th className="text-right font-normal">TV ask</th>
                  <th className="text-right font-normal">Δask</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 10 }, (_, i) => {
                  const tb = tvBids[i];
                  const ta = tvAsks[i];
                  const gb = gcBids[i];
                  const ga = gcAsks[i];
                  return (
                    <tr key={i} className={i === 0 ? "text-zinc-100" : "text-zinc-400"}>
                      <td className="text-zinc-600">{i + 1}</td>
                      <td className="text-right">{gb?.s ?? "—"}</td>
                      <td className="text-right">{tb?.size ?? "—"}</td>
                      <td className="text-right">{gb && tb ? deltaCell(tb.size - gb.s) : "—"}</td>
                      <td className="text-right">{ga?.s ?? "—"}</td>
                      <td className="text-right">{ta?.size ?? "—"}</td>
                      <td className="text-right">{ga && ta ? deltaCell(ta.size - ga.s) : "—"}</td>
                    </tr>
                  );
                })}
                <tr className="border-t border-zinc-700 font-semibold text-zinc-200">
                  <td className="text-zinc-500">Σ10</td>
                  <td className="text-right">{cumGcBid}</td>
                  <td className="text-right">{cumTvBid}</td>
                  <td className="text-right">{deltaCell(cumTvBid - cumGcBid)}</td>
                  <td className="text-right">{cumGcAsk}</td>
                  <td className="text-right">{cumTvAsk}</td>
                  <td className="text-right">{deltaCell(cumTvAsk - cumGcAsk)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* feed health */}
          <div className="col-span-12 rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">feed health</p>
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="text-zinc-500">GC connected</td>
                  <td className="text-right">{gc?.connected ? "yes" : "no"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC DOM frames</td>
                  <td className="text-right">{gc?.frames ?? "—"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC silent connects</td>
                  <td className="text-right">{gc?.silentConnects ?? "—"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC last message</td>
                  <td className="text-right">{gc ? `${Math.round((Date.now() - gc.lastMessage) / 1000)}s ago` : "—"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC symbol</td>
                  <td className="text-right">{gc?.nq.symbol ?? "—"}</td>
                </tr>
                <tr className="border-t border-zinc-800">
                  <td className="text-zinc-500">TV frames</td>
                  <td className="text-right">{snap.stats.frames}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">TV ticks (dedup)</td>
                  <td className="text-right">{snap.stats.ticks}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">TV last frame</td>
                  <td className="text-right">
                    {snap.stats.lastFrame ? `${Math.round((Date.now() - Date.parse(snap.stats.lastFrame)) / 1000)}s ago` : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[9px] leading-4 text-zinc-600">
              GC = GoCharting DOM_V2 (NQ, top 10 levels, lib/dom). TV = Tradovate md socket (MNQ, quote/DOM/ticks). Per-trade timestamp
              lag needs GC's trade socket — not currently exposed; this panel compares book, depth, and feed health only.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
