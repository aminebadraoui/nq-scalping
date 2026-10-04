"use client";

import { useEffect, useMemo, useState } from "react";
import FlowChart, { fmt } from "@/components/FlowChart";
import MinuteNavigator from "@/components/MinuteNavigator";
import SweepReclaimPanel from "@/components/SweepReclaimPanel";
import PriceActionPanel from "@/components/PriceActionPanel";
import SignalHistory from "@/components/SignalHistory";
import DomIcebergPanel from "@/components/DomIcebergPanel";
import TickMomentumPanel from "@/components/TickMomentumPanel";
import MacroPulseCard from "@/components/MacroPulseCard";
import CrossAssetCard from "@/components/CrossAssetCard";
import TreasuriesCard from "@/components/TreasuriesCard";
import NewsCalendarPanel from "@/components/NewsCalendarPanel";
import EarningsPanel from "@/components/EarningsPanel";
import MacroFooter from "@/components/MacroFooter";
import { useMacro } from "@/lib/useMacro";
import { blendLiveMinutes, type FPMinute } from "@/lib/footprint";
import { useLive, type LiveMinute } from "@/lib/useLive";
import { imbalanceFor, summarizeImb } from "@/lib/imbalance";
import { readPriceAction } from "@/lib/priceaction";
import { realizedDailyBandPct } from "@/lib/macroFmt";

type FootMinute = { t: string; d?: string; o?: number; c?: number; vwap?: number; high: number; low: number; buy: number; sell: number; delta: number };

export default function DashboardPage() {
  const live = useLive();
  const macro = useMacro();
  const [hist, setHist] = useState<LiveMinute[]>([]);
  const [fp, setFp] = useState<{ minutes: FPMinute[]; minPrice: number; maxPrice: number } | null>(null);
  const [dataDate, setDataDate] = useState("");
  const [chartMax, setChartMax] = useState(false);

  const snap = live?.snapshot ?? null;
  const today = snap?.date ?? new Date().toISOString().slice(0, 10);

  // bootstrap: latest collected date + its footprint (feeds the chart + ladder)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d = today;
      try {
        const j = await fetch("/api/gc?action=datasets").then((r) => r.json());
        const ds: { date: string }[] = j.datasets ?? [];
        if (ds[0]?.date) d = ds[0].date;
      } catch {
        /* keep today */
      }
      if (cancelled) return;
      setDataDate(d);

      fetch(`/api/gc?action=footprint&date=${d}&session=ETH&start=&end=`)
        .then((r) => r.json())
        .then((j) => {
          if (!j.minutes) return;
          setHist(
            j.minutes.map((m: FootMinute) => ({
              t: m.t,
              d: m.d,
              o: m.o ?? 0,
              h: m.high,
              l: m.low,
              c: m.c ?? 0,
              vol: m.buy + m.sell,
              buy: m.buy,
              sell: m.sell,
              live: false,
            })),
          );
          setFp({ minutes: j.minutes, minPrice: j.minPrice, maxPrice: j.maxPrice });
        })
        .catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [today]);

  // collected full day, continued by live ticks
  const blended = useMemo<LiveMinute[]>(() => {
    const liveMins = live ? (live.cur ? [...live.minutes, live.cur] : live.minutes) : [];
    return blendLiveMinutes(hist, liveMins as LiveMinute[]);
  }, [hist, live]);
  const liveTail = blended.slice(hist.length);

  // the appended live minutes as footprint rows (for the ladder)
  const liveFpTail = useMemo<FPMinute[]>(
    () =>
      liveTail
        .filter((m) => m.levels && Object.keys(m.levels).length > 0)
        .map((m) => {
          const levels = imbalanceFor(
            Object.entries(m.levels!)
              .map(([p, v]) => ({ price: Number(p), buy: (v as [number, number])[0], sell: (v as [number, number])[1], bTrades: 0, sTrades: 0 }))
              .sort((a, b) => b.price - a.price),
          );
          let num = 0;
          let den = 0;
          for (const l of levels) {
            const v = l.buy + l.sell;
            num += l.price * v;
            den += v;
          }
          return {
            t: m.t,
            o: m.o,
            c: m.c,
            vwap: den > 0 ? num / den : (m.h + m.l) / 2,
            high: m.h,
            low: m.l,
            buy: m.buy,
            sell: m.sell,
            delta: m.buy - m.sell,
            levels,
            imb: summarizeImb(levels),
          };
        }),
    [liveTail],
  );
  const ladderMinutes: FPMinute[] = fp ? [...fp.minutes, ...liveFpTail] : liveFpTail;
  const ladderDate = dataDate || today;
  const chartMinutes: LiveMinute[] = blended;

  const lastMin = chartMinutes[chartMinutes.length - 1];
  const lastPrice = lastMin ? lastMin.c || lastMin.h : snap?.ltp ?? 0;
  const chg = snap ? snap.ltp - snap.prev_close : 0;

  // premium / discount location across all six timeframes, live
  const pa = useMemo(
    () =>
      readPriceAction({
        minutes: chartMinutes.map((m) => ({ high: m.h, low: m.l, t: m.t, d: m.d })),
        lastPrice,
        sessionHigh: snap?.high,
        sessionLow: snap?.low,
      }),
    [chartMinutes, lastPrice, snap?.high, snap?.low],
  );
  // live realized 1σ band from the blended 1-min closes — the
  // real-time twin of the (delayed) VIX-based band
  const realizedBandPct = useMemo(
    () => realizedDailyBandPct(chartMinutes.map((m) => ({ c: m.c })), 30),
    [chartMinutes],
  );

  const asOfET = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
  });

  return (
    <main className="mx-auto min-h-screen max-w-[1600px] px-4 py-6 text-zinc-100">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.25em] text-long">NQ scalping · sweep-reclaim</p>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Sweep-Reclaim</h1>
        </div>
        <span className={`flex items-center gap-2 font-mono text-xs ${live?.connected ? "text-long" : "text-short"}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${live?.connected ? "bg-long shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-short"}`} />
          {live?.connected ? "connected" : "reconnecting…"}
        </span>
      </div>

      {/* live strip */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">NQ {snap?.date ?? ""}</p>
          <p className="font-mono text-lg font-bold text-zinc-50">{fmt(snap?.ltp)}</p>
          <p className={`font-mono text-[11px] ${chg >= 0 ? "text-long" : "text-short"}`}>{chg >= 0 ? "+" : ""}{fmt(chg)}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">cum delta</p>
          <p className={`font-mono text-lg font-semibold ${(snap?.delta ?? 0) >= 0 ? "text-long" : "text-short"}`}>
            {(snap?.delta ?? 0) >= 0 ? "+" : ""}
            {(snap?.delta ?? 0).toLocaleString()}
          </p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">volume</p>
          <p className="font-mono text-lg font-semibold text-zinc-200">{(snap?.volume ?? 0).toLocaleString()}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">range</p>
          <p className="font-mono text-[11px] text-zinc-300">
            {fmt(snap?.high)} / {fmt(snap?.low)}
          </p>
        </div>
      </div>

      {/* BENTO BAND 1 · market context first: pulse 3 / cross-asset 6 / rates 3 */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 md:col-span-6 xl:col-span-3">
          <MacroPulseCard
            watch={macro.ctx?.watch ?? null}
            news={macro.ctx?.news.data ?? null}
            earnings={macro.ctx?.earnings.data ?? null}
            nqPrice={lastPrice}
            realizedBandPct={realizedBandPct}
          />
        </div>
        <div className="col-span-12 md:col-span-6 xl:col-span-6">
          <CrossAssetCard
            watch={macro.ctx?.watch ?? null}
            nqPct={snap && snap.prev_close > 0 ? Math.round(((snap.ltp - snap.prev_close) / snap.prev_close) * 10000) / 100 : null}
          />
        </div>
        <div className="col-span-12 md:col-span-12 xl:col-span-3">
          <TreasuriesCard
            data={macro.ctx?.bonds.data ?? null}
            intraday={macro.ctx?.bonds.intraday ?? null}
            stale={macro.ctx ? !macro.ctx.bonds.ok : false}
            watch={macro.ctx?.watch ?? null}
          />
        </div>
      </div>

      {/* BENTO BAND 2 · the trading workspace (sacred: chart + rail) */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,360px)]">
        {/* left: chart + footprint ladder (the ladder grows to fill the column) */}
        <div className="flex min-w-0 flex-col gap-4">
          <section className={`flex flex-col rounded-md border border-zinc-800 bg-panel p-3 ${chartMax ? "fixed inset-0 z-40 rounded-none bg-zinc-950" : ""}`}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-lg font-bold text-zinc-50">1-min candles — delta tinted</h2>
              <button
                onClick={() => setChartMax((v) => !v)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${chartMax ? "border-info/50 bg-info/10 text-info" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                title={chartMax ? "restore" : "maximize"}
              >
                {chartMax ? "restore ▣" : "maximize ⛶"}
              </button>
            </div>
            <div className={`min-h-[380px] ${chartMax ? "min-h-0 flex-1" : "h-[560px] xl:h-[calc(100vh-220px)]"}`}>
              {chartMinutes.length > 0 ? (
                <FlowChart
                  minutes={chartMinutes}
                  levels={[]}
                  markers={[]}
                  dataDate={dataDate || today}
                  colorBy="delta"
                  height={560}
                  autoHeight
                />
              ) : (
                <p className="p-8 font-mono text-sm text-zinc-600">waiting for data…</p>
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-md border border-zinc-800 bg-panel p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-zinc-50">Footprint — minute ladder</h2>
              <p className="font-mono text-[10px] text-zinc-500">bid×ask per tick · ▲▼ = imbalance · full day 18:00 → 16:59 NY</p>
            </div>
            {ladderMinutes.length > 0 ? (
              <MinuteNavigator minutes={ladderMinutes} date={ladderDate} timeMode="cdt" />
            ) : (
              <p className="p-8 font-mono text-sm text-zinc-600">no footprint data — collect with gcdata</p>
            )}
          </section>
        </div>

        {/* right: the strategy */}
        <aside className="space-y-4">
          <PriceActionPanel
            read={pa}
            asOfET={asOfET}
            stale={!live?.connected}
            source={live?.connected ? "live" : "collected"}
          />
          <SweepReclaimPanel minutes={chartMinutes} cur={live?.cur} lastPrice={lastPrice} />
          <TickMomentumPanel />
          <DomIcebergPanel />
          <SignalHistory />
        </aside>
      </div>

      {/* BENTO BAND 3 · detail layer: earnings 8 / week ahead 4 */}
      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-8">
          <EarningsPanel data={macro.ctx?.earnings.data ?? null} stale={macro.ctx ? !macro.ctx.earnings.ok : false} error={macro.ctx?.earnings.error} />
        </div>
        <div className="col-span-12 xl:col-span-4">
          <NewsCalendarPanel week={macro.ctx?.news.data ?? null} stale={macro.ctx ? !macro.ctx.news.ok : false} error={macro.ctx?.news.error} />
        </div>
      </div>

      <MacroFooter ctx={macro.ctx} error={macro.error} />
    </main>
  );
}
