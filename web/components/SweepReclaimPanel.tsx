"use client";

import { useMemo } from "react";
import { detectOneSidedReclaim, swingLevels } from "@/lib/reclaimSetup";

const f = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

type Bar = { t: string; d?: string; h: number; l: number; c: number; buy: number; sell: number };

/**
 * The sweep-reclaim + one-sided scalp setup, rendered live so the trader can
 * watch it form: the two swing levels, the reclaim bar's one-sidedness as it
 * prints, and the trade ticket (ENTRY / STOP / TARGET) the moment the setup
 * completes. Mirrors detectOneSidedReclaim() — the 67%-win @ 1R filter.
 */
export default function SweepReclaimPanel({
  minutes,
  cur,
  lastPrice,
}: {
  minutes: Bar[];
  cur?: { buy: number; sell: number } | null;
  lastPrice: number;
}) {
  const rc = useMemo(
    () => minutes.map((m) => ({ t: m.t, d: m.d, high: m.h, low: m.l, buy: m.buy, sell: m.sell, c: m.c })),
    [minutes],
  );
  const setup = useMemo(() => detectOneSidedReclaim(rc), [rc]);
  const sw = useMemo(() => swingLevels(rc), [rc]);

  const curBuy = cur?.buy ?? 0;
  const curSell = cur?.sell ?? 0;
  const curTotal = curBuy + curSell;
  const curBuyPct = curTotal > 0 ? curBuy / curTotal : 0;
  const curSellPct = 1 - curBuyPct;

  const nearLow = lastPrice - sw.low;
  const nearHigh = sw.high - lastPrice;

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Sweep-Reclaim</h2>
        <span className="font-mono text-[10px] text-zinc-600">67% win @ 1R · forward-test</span>
      </div>

      {/* the two levels to watch */}
      <div className="mb-3 grid grid-cols-2 gap-2 font-mono text-[11px]">
        <div className={`rounded border px-2 py-1 ${nearLow <= 2.5 ? "border-info/60 bg-info/10 text-info" : "border-zinc-700 text-zinc-300"}`}>
          <div className="text-zinc-500">SWING LOW</div>
          <div className="text-sm font-bold">{f(sw.low)}</div>
          <div className="text-[9px] text-zinc-500">{f(nearLow, 1)}pt away</div>
        </div>
        <div className={`rounded border px-2 py-1 ${nearHigh <= 2.5 ? "border-info/60 bg-info/10 text-info" : "border-zinc-700 text-zinc-300"}`}>
          <div className="text-zinc-500">SWING HIGH</div>
          <div className="text-sm font-bold">{f(sw.high)}</div>
          <div className="text-[9px] text-zinc-500">{f(nearHigh, 1)}pt away</div>
        </div>
      </div>

      {/* the trade ticket when a setup completes */}
      {setup ? (
        <div className={`rounded border p-2 ${setup.dir === "long" ? "border-long/60 bg-long/10" : "border-short/60 bg-short/10"}`}>
          <div className={`mb-2 font-mono text-sm font-bold ${setup.dir === "long" ? "text-long" : "text-short"}`}>
            {setup.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} — reclaim bar {f(setup.buyPct * 100, 0)}% {setup.dir === "long" ? "buy" : "sell"}
          </div>
          <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <div className="text-zinc-500">ENTRY</div>
              <div className="text-sm font-bold text-zinc-100">{f(setup.entry)}</div>
            </div>
            <div>
              <div className="text-zinc-500">STOP</div>
              <div className="text-sm font-bold text-short">{f(setup.stop)}</div>
            </div>
            <div>
              <div className="text-zinc-500">TARGET</div>
              <div className="text-sm font-bold text-long">{f(setup.target)}</div>
            </div>
          </div>
          <div className="mt-1 font-mono text-[9px] text-zinc-500">
            1R = {f(setup.risk)}pt · swept {setup.dir === "long" ? "low" : "high"} {f(setup.extreme)} · {setup.timeET} NY
          </div>
        </div>
      ) : (
        <div className="rounded border border-zinc-800 p-2 font-mono text-[10px] text-zinc-500">
          waiting for a sweep of {f(sw.low)} / {f(sw.high)} to reclaim one-sided…
        </div>
      )}

      {/* live aggression gauge of the forming bar */}
      <div className="mt-3">
        <div className="mb-1 flex justify-between font-mono text-[9px] text-zinc-500">
          <span>current bar</span>
          <span>
            buy {f(curBuyPct * 100, 0)}% · sell {f(curSellPct * 100, 0)}%
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-800">
          <div className="bg-long" style={{ width: `${curBuyPct * 100}%` }} />
          <div className="bg-short" style={{ width: `${curSellPct * 100}%` }} />
        </div>
        <div className="mt-1 font-mono text-[9px] text-zinc-600">≥65% one-sided + ≥ median volume = the confirmation</div>
      </div>
    </section>
  );
}
