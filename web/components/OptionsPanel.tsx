"use client";

import { dealerBand, type OptionsRead, type WallSetNq, type OptionsRefreshMeta } from "@/lib/options";

const REGIME = {
  chop: { border: "border-info/50", text: "text-info", bg: "bg-info/10", label: "CHOP" },
  trend: { border: "border-short/50", text: "text-short", bg: "bg-short/10", label: "TREND" },
  unknown: { border: "border-zinc-700", text: "text-zinc-400", bg: "bg-zinc-900/40", label: "—" },
} as const;

const fmt = (n: number | null, dp = 2) =>
  n !== null && Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : "—";

function Level({ label, price, spot, tone }: { label: string; price: number | null; spot: number; tone: string }) {
  const dist = price !== null && Number.isFinite(spot) ? price - spot : NaN;
  return (
    <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
      <span className="text-zinc-500">{label}</span>
      <span className={`${tone} font-semibold`}>
        {price !== null ? fmt(price) : "—"}
        {Number.isFinite(dist) && <span className="font-normal text-zinc-500"> · {dist >= 0 ? "+" : ""}{fmt(dist)} pts</span>}
      </span>
    </div>
  );
}

export default function OptionsPanel({
  read,
  meta,
  asOfET,
  stale,
  source,
}: {
  read: OptionsRead | null;
  meta?: OptionsRefreshMeta | null;
  asOfET: string;
  stale: boolean;
  source: "live" | "collected";
}) {
  if (!read || !read.dataOk) {
    return (
      <section className="rounded-md border border-zinc-800 bg-panel p-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Options · gamma</h2>
        <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
          no options data — run <span className="text-zinc-300">gcdata/collect_options.py --symbol QQQ</span> to pull the free CBOE chain
        </p>
      </section>
    );
  }

  const tone = REGIME[read.regime];
  const band = dealerBand(read);
  const bucketRows: [string, WallSetNq | null][] = [
    ["near ≤7d (scalping)", read.near],
    ["monthly 8–45d (OPEX)", read.monthly],
    ["far >45d (LEAPS)", read.far],
  ];
  return (
    <section className={`rounded-md border ${tone.border} bg-panel p-3`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-300">Options · gamma</h2>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone.border} ${tone.bg} ${tone.text}`}>
          {tone.label}
        </span>
      </div>

      <div className={`mb-2 rounded border px-2.5 py-2 ${tone.border} ${tone.bg}`}>
        <p className={`font-mono text-[13px] font-semibold leading-snug ${tone.text}`}>
          {read.regime === "chop" ? "long gamma — dealers dampen moves" : read.regime === "trend" ? "short gamma — dealers amplify moves" : "no regime"}
        </p>
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-400">{read.note}</p>
      </div>

      <div className="space-y-1 rounded border border-zinc-800/70 bg-zinc-950/50 px-2 py-1.5">
        <Level label="gamma flip" price={read.flipNq} spot={read.nqSpot} tone="text-warn" />
        <Level label="call wall ▲" price={read.callWallNq} spot={read.nqSpot} tone="text-short" />
        <Level label="put wall ▼" price={read.putWallNq} spot={read.nqSpot} tone="text-long" />
      </div>

      {band && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between font-mono text-[10px]">
            <span className="text-long">put {fmt(band.put)}</span>
            <span className="text-zinc-500">dealer range · {Math.round(band.pct * 100)}%</span>
            <span className="text-short">call {fmt(band.call)}</span>
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900">
            <div className="absolute inset-y-0 left-0 w-1/2 bg-long/10" />
            <div className="absolute inset-y-0 right-0 w-1/2 bg-short/10" />
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-950 bg-zinc-50 shadow"
              style={{ left: `${band.pct * 100}%` }}
            />
          </div>
          <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
            the put→call band is the options-defined fair-value range — in a chop regime price oscillates between the walls
          </p>
        </div>
      )}

      {(read.near || read.monthly || read.far) && (
        <div className="mt-2 rounded border border-zinc-800/70 px-2 py-1.5 font-mono text-[10px]">
          <div className="mb-1 text-zinc-500">walls by expiry (NQ pts)</div>
          {bucketRows.map(([label, ws]) =>
            ws && (ws.callWall !== null || ws.putWall !== null) ? (
              <div key={label} className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">{label}</span>
                <span>
                  <span className="text-long">P {fmt(ws.putWall)}</span>
                  <span className="mx-1 text-zinc-600">·</span>
                  <span className="text-short">C {fmt(ws.callWall)}</span>
                </span>
              </div>
            ) : null,
          )}
        </div>
      )}

      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        walls are dealer-hedging magnets (pin/repel) · flip = where net gamma changes sign · regime, not a direction — it gates fade vs follow-through
      </p>

      <p className="mt-2 font-mono text-[10px] leading-snug text-zinc-500">
        as of <span className="text-zinc-300">{asOfET} New York</span> ·{" "}
        <span className={source === "live" ? "text-long" : "text-warn"}>{source === "live" ? "live" : "last collected"}</span>
        {stale && <span className="text-warn"> · not live</span>}
      </p>
      {meta && (
        <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
          {meta.lastError ? (
            <span className="text-short">CBOE feed error: {meta.lastError}</span>
          ) : meta.fetched ? (
            <>
              intraday feed · refresh every {Math.round(meta.intervalMs / 1000)}s · as of{" "}
              <span className="text-zinc-300">{meta.asOf}</span>
            </>
          ) : (
            <>fetching first snapshot…</>
          )}
        </p>
      )}
    </section>
  );
}
