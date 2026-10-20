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

/* GoCharting TRADE feed (lib/live.ts) over /api/tvmd/gc — last print,
 * vendor day snapshot, live minute bar, recent tick ring. This is the
 * socket the signals run on; comparing it against the Tradovate tick
 * stream answers "what would a signal see" at any instant. NQ and MNQ
 * share the same price scale (0.25 tick). */
interface GcTick {
  ms: number;
  ltp: number;
  size: number;
  side: 1 | -1;
}
interface GcLive {
  ok: boolean;
  connected: boolean;
  lastMessage: number;
  lastTradeMs: number;
  lastVolChangeMs: number;
  lastCandleRefreshAt: number;
  ltp: number | null;
  dayVolume: number | null;
  dayDelta: number | null;
  cur: { t: string; du: string | null; c: number; h: number; l: number; vol: number; buy: number; sell: number; source: string | null } | null;
  ticks: GcTick[];
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
  const [gc, setGc] = useState<GcLive | null>(null);
  const [newToken, setNewToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const inFlight = useRef(false);
  const samplesRef = useRef<DeltaSample[]>([]);
  const [samples, setSamples] = useState<DeltaSample[]>([]);

  async function applyToken() {
    const t = newToken.trim();
    if (!t || saving) return;
    setSaving(true);
    setTokenMsg(null);
    try {
      const res = await fetch("/api/tvmd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: t }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (res.ok && j.ok) {
        setNewToken("");
        setTokenMsg("saved — collector hot-restarts with the new session (~10s)");
      } else {
        setTokenMsg(j.error ?? `api ${res.status}`);
      }
    } catch (e) {
      setTokenMsg(String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const [tvRes, gcRes] = await Promise.all([
          fetch("/api/tvmd", { cache: "no-store" }),
          fetch("/api/tvmd/gc", { cache: "no-store" }),
        ]);
        if (!tvRes.ok) throw new Error(`api ${tvRes.status}`);
        const json = (await tvRes.json()) as TvmdSnapshot;
        const gcJson = gcRes.ok ? ((await gcRes.json()) as GcLive) : null;
        if (alive) {
          setSnap(json);
          setGc(gcJson);
          setErr(null);
          // signal-time divergence sample: GC last print vs TV last trade
          if (gcJson && json.stats.lastFrame) {
            const now = Date.now();
            const tvFresh = now - Date.parse(json.stats.lastFrame) < 30_000;
            const gcTick = gcJson.ticks.length ? gcJson.ticks[gcJson.ticks.length - 1] : null;
            const gcFresh = gcTick ? now - gcTick.ms < 30_000 : now - gcJson.lastTradeMs < 30_000;
            const tvTrade = json.quote?.entries.Trade as { price?: number } | undefined;
            const gcPrice = gcTick ? gcTick.ltp : gcJson.ltp;
            if (tvFresh && gcFresh && tvTrade?.price !== undefined && gcPrice !== null && gcPrice !== undefined) {
              const s: DeltaSample = {
                t: now,
                dPrice: gcPrice - tvTrade.price,
                skewMs: (gcTick ? gcTick.ms : gcJson.lastTradeMs) - Date.parse(json.stats.lastFrame),
              };
              samplesRef.current = [...samplesRef.current, s].slice(-300); // 5 min ring
              if (alive) setSamples(samplesRef.current);
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
        <>
          {/* session bar: swap in a fresh token (new demo account / dead chain) */}
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-800 bg-panel px-4 py-2 font-mono text-xs">
            <span className="text-zinc-500">session</span>
            <span className="text-zinc-300">
              {snap.token ? (
                <>
                  <span className="text-long">{snap.token.prefix}</span>
                  {snap.token.renewedAt ? (
                    <span className="text-zinc-500"> · renewed {Math.round((Date.now() - Date.parse(snap.token.renewedAt)) / 60000)}m ago</span>
                  ) : null}
                </>
              ) : (
                <span className="text-warn">no token file</span>
              )}
            </span>
            <input
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void applyToken()}
              placeholder="paste new session token (JWT from the authorize frame)"
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
            />
            <button
              onClick={() => void applyToken()}
              disabled={saving || !newToken.trim()}
              className="rounded bg-long/15 px-3 py-1 text-long disabled:opacity-40"
            >
              {saving ? "saving…" : "Apply"}
            </button>
            {tokenMsg && <span className={tokenMsg.startsWith("saved") ? "text-long" : "text-warn"}>{tokenMsg}</span>}
          </div>

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
        </>
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
  /** GC last print − TV last trade (pts; positive = GC prints higher) */
  dPrice: number;
  /** GC last print ms − TV last frame ms (positive = GC newer) */
  skewMs: number;
}

const TICK = 0.25;

function Sparkline({ samples, color }: { samples: DeltaSample[]; color: string }) {
  if (samples.length < 2) return <div className="h-12 rounded bg-zinc-900/40" />;
  const vals = samples.map((s) => s.dPrice);
  const min = Math.min(...vals, 0);
  const max = Math.max(...vals, 0);
  const span = max - min || 1;
  const w = 320;
  const h = 48;
  const y = (v: number) => h - ((v - min) / span) * h;
  const pts = samples.map((s, i) => `${(i / (samples.length - 1)) * w},${y(s.dPrice)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none">
      <line x1={0} y1={y(0)} x2={w} y2={y(0)} stroke="#3f3f46" strokeDasharray="3 3" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ComparePanel({ snap, gc, samples }: { snap: TvmdSnapshot; gc: GcLive | null; samples: DeltaSample[] }) {
  const tvTrade = snap.quote?.entries.Trade as { price?: number; size?: number } | undefined;
  const tvVol = snap.quote?.entries.TotalTradeVolume as { size?: number } | undefined;
  const tvTicks = snap.tape; // newest first
  const gcTick = gc?.ticks.length ? gc.ticks[gc.ticks.length - 1] : null;
  const gcPrice = gcTick ? gcTick.ltp : gc?.ltp ?? null;
  const gcTs = gcTick ? gcTick.ms : gc?.lastTradeMs ?? 0;
  const tvTs = snap.stats.lastFrame ? Date.parse(snap.stats.lastFrame) : 0;
  const gcFresh = gc ? (gcTick ? Date.now() - gcTick.ms < 60_000 : Date.now() - gc.lastTradeMs < 60_000) : false;
  const tvAgeS = tvTs > 0 ? Math.round((Date.now() - tvTs) / 1000) : null;
  const tvFresh = tvAgeS !== null && tvAgeS < 60;
  const gcAgeS = gc ? Math.round((Date.now() - (gcTick ? gcTick.ms : gc.lastTradeMs)) / 1000) : null;

  const dPrice = tvTrade?.price !== undefined && gcPrice !== null && gcPrice !== undefined ? gcPrice - tvTrade.price : null;
  const skewMs = gcTs && tvTs ? gcTs - tvTs : null;
  // GC reports NQ (full-size) contracts; TV reports MNQ (micro) contracts.
  // Normalize TV to NQ-equivalent (÷10) before comparing volume.
  const tvVolNq = tvVol?.size !== undefined ? tvVol.size / 10 : null;
  const dVol = tvVolNq !== null && gc?.dayVolume != null ? gc.dayVolume - tvVolNq : null;

  const absD = samples.map((s) => Math.abs(s.dPrice));
  const maxAbs = absD.length ? Math.max(...absD) : 0;
  const meanAbs = absD.length ? absD.reduce((a, b) => a + b, 0) / absD.length : 0;
  const maxSample = samples.reduce((a, b) => (Math.abs(b.dPrice) > Math.abs(a.dPrice) ? b : a), samples[0] ?? { t: 0, dPrice: 0, skewMs: 0 });
  const meanSkew = samples.length ? samples.reduce((a, b) => a + b.skewMs, 0) / samples.length : 0;

  const deltaCell = (v: number | null, digits = 2) =>
    v === null ? (
      <span className="text-zinc-700">—</span>
    ) : (
      <span className={Math.abs(v) < 1e-9 ? "text-zinc-500" : v > 0 ? "text-long" : "text-short"}>
        {v > 0 ? "+" : ""}
        {v.toFixed(digits)}
      </span>
    );

  return (
    <div className="rounded-lg border border-zinc-800 bg-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-zinc-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        <span>gocharting vs tradovate — signal-time price check</span>
        <span className={`rounded px-1.5 py-0.5 normal-case ${gcFresh ? "bg-long/15 text-long" : "bg-warn/15 text-warn"}`}>
          GC {gc ? (gcFresh ? `● live` : `○ ${gcAgeS}s`) : "○ no feed"}
        </span>
        <span className={`rounded px-1.5 py-0.5 normal-case ${tvFresh ? "bg-long/15 text-long" : "bg-warn/15 text-warn"}`}>
          TV {tvAgeS !== null ? (tvFresh ? `● live` : `○ ${tvAgeS}s`) : "○ no data"}
        </span>
        <span className="normal-case">GC trade socket (NQZ26) vs Tradovate tick stream (MNQZ6) · tick 0.25 · Δ = GC − TV</span>
      </div>

      {!gc || !tvFresh ? (
        <div className="p-4 text-center font-mono text-xs text-zinc-500">
          {!gc ? "GoCharting trade feed not connected (lib/live singleton — check GOCHARTING_* env and the vendor socket)" : "tradovate feed stale — check the collector"}
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-3 p-3">
          {/* price + rolling divergence */}
          <div className="col-span-12 rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <table className="w-full">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal">metric</th>
                  <th className="text-right font-normal">GoCharting</th>
                  <th className="text-right font-normal">Tradovate</th>
                  <th className="text-right font-normal">Δ</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-zinc-500">last price</td>
                  <td className="text-right">{gcPrice?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">{tvTrade?.price?.toFixed(2) ?? "—"}</td>
                  <td className="text-right">
                    {deltaCell(dPrice)}
                    {dPrice !== null && <span className="ml-1 text-zinc-600">({(dPrice / TICK).toFixed(0)}t)</span>}
                  </td>
                </tr>
                <tr>
                  <td className="text-zinc-500">last print</td>
                  <td className="text-right">{gcTs ? etTime(gcTs) : "—"}</td>
                  <td className="text-right">{tvTs ? etTime(tvTs) : "—"}</td>
                  <td className="text-right">
                    {skewMs === null ? "—" : <span className="text-info">{skewMs >= 0 ? "+" : ""}{Math.round(skewMs)} ms</span>}
                  </td>
                </tr>
                <tr>
                  <td className="text-zinc-500">day volume (NQ-equiv)</td>
                  <td className="text-right">{gc?.dayVolume != null ? gc.dayVolume.toLocaleString() : "—"}</td>
                  <td className="text-right">{tvVolNq !== null ? `${tvVolNq.toLocaleString(undefined, { maximumFractionDigits: 0 })} (raw ${tvVol?.size != null ? tvVol.size.toLocaleString() : "—"} MNQ)` : "—"}</td>
                  <td className="text-right">
                    {deltaCell(dVol, 0)}
                    {dVol !== null && tvVolNq !== null && tvVolNq > 0 && (
                      <span className="ml-1 text-zinc-600">({((dVol / tvVolNq) * 100).toFixed(1)}%)</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="mt-3 border-t border-zinc-800 pt-2">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">rolling window ({samples.length}s)</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <p className="text-[9px] text-zinc-500">current Δprice</p>
                  <p className="text-sm">{deltaCell(dPrice)}</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">mean |Δprice|</p>
                  <p className="text-sm text-zinc-200">{meanAbs.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">max |Δprice|</p>
                  <p className="text-sm text-warn">{maxAbs.toFixed(2)}</p>
                </div>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-center">
                <div>
                  <p className="text-[9px] text-zinc-500">mean skew (GC−TV)</p>
                  <p className="text-xs text-info">{meanSkew >= 0 ? "+" : ""}{Math.round(meanSkew)} ms</p>
                </div>
                <div>
                  <p className="text-[9px] text-zinc-500">peak Δprice</p>
                  <p className="text-xs text-warn">
                    {maxSample.dPrice > 0 ? "+" : ""}
                    {maxSample.dPrice.toFixed(2)} @ {etTime(maxSample.t).slice(3)}
                  </p>
                </div>
              </div>
              <div className="mt-1">
                <p className="text-[9px] text-zinc-500">Δ price (GC − TV), pts</p>
                <Sparkline samples={samples} color="#38bdf8" />
              </div>
            </div>
          </div>

          {/* recent prints side by side */}
          <div className="col-span-12 rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">recent prints</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[9px] text-zinc-600">GoCharting ticks (vendor)</p>
                {gc.ticks.slice(-8).reverse().map((tk, i) => (
                  <div key={i} className="flex justify-between gap-2 py-[1px]">
                    <span className="text-zinc-600">{etTime(tk.ms).slice(3)}</span>
                    <span className={tk.side === 1 ? "text-long" : "text-short"}>{tk.ltp.toFixed(2)}</span>
                    <span className="text-zinc-400">{tk.size}</span>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-[9px] text-zinc-600">Tradovate ticks (collected)</p>
                {tvTicks.slice(0, 8).map((tk, i) => (
                  <div key={i} className="flex justify-between gap-2 py-[1px]">
                    <span className="text-zinc-600">{etTime(tk.t).slice(3)}</span>
                    <span className={tk.side === "buy" ? "text-long" : "text-short"}>{tk.price.toFixed(2)}</span>
                    <span className="text-zinc-400">{tk.size}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 border-t border-zinc-800 pt-2">
              <p className="text-[9px] text-zinc-600">GC live minute bar {gc.cur ? `(${gc.cur.t} UTC, source=${gc.cur.source ?? "?"})` : ""}</p>
              {gc.cur && (
                <div className="grid grid-cols-4 gap-1 text-center">
                  <span className="text-zinc-400">c {gc.cur.c.toFixed(2)}</span>
                  <span className="text-zinc-400">vol {gc.cur.vol}</span>
                  <span className="text-long">buy {gc.cur.buy}</span>
                  <span className="text-short">sell {gc.cur.sell}</span>
                </div>
              )}
            </div>
          </div>

          {/* feed health */}
          <div className="col-span-12 rounded border border-zinc-800 bg-zinc-900/40 p-2 font-mono text-[11px] md:col-span-4">
            <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">feed health</p>
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="text-zinc-500">GC connected</td>
                  <td className="text-right">{gc.connected ? "yes" : "no"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC last trade</td>
                  <td className="text-right">{gc.lastTradeMs ? `${Math.round((Date.now() - gc.lastTradeMs) / 1000)}s ago` : "—"}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC last candle refresh</td>
                  <td className="text-right">
                    {gc.lastCandleRefreshAt ? `${Math.round((Date.now() - gc.lastCandleRefreshAt) / 1000)}s ago` : "never"}
                  </td>
                </tr>
                <tr>
                  <td className="text-zinc-500">GC day delta</td>
                  <td className="text-right">{gc.dayDelta != null ? gc.dayDelta.toLocaleString() : "—"}</td>
                </tr>
                <tr className="border-t border-zinc-800">
                  <td className="text-zinc-500">TV frames</td>
                  <td className="text-right">{snap.stats.frames.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">TV ticks (dedup)</td>
                  <td className="text-right">{snap.stats.ticks.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="text-zinc-500">TV last frame</td>
                  <td className="text-right">{tvTs ? `${Math.round((Date.now() - tvTs) / 1000)}s ago` : "—"}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-[9px] leading-4 text-zinc-600">
              GC = GoCharting TRADE socket (the feed signals run on; NQZ26, full-size contracts). TV = Tradovate md socket (MNQZ6;
              micro contracts — volume normalized ÷10 to NQ-equivalent). Price scales match (0.25 tick), volume units don't. Δ price is
              what a signal would see at that instant; skew is the print-timestamp gap between feeds. A 1–3 tick Δ on latest prints is
              normal tick noise in a moving market — judge by the rolling mean |Δprice|, not any single row.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
