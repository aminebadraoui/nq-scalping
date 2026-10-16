"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FlowChart, { fmt } from "@/components/FlowChart";
import MinuteNavigator from "@/components/MinuteNavigator";
import SweepReclaimPanel from "@/components/SweepReclaimPanel";
import PriceActionPanel from "@/components/PriceActionPanel";
import SignalHistory, { type HistoryEntry as SignalEntry } from "@/components/SignalHistory";
import LiveSignalPanel from "@/components/LiveSignalPanel";
import DomIcebergPanel from "@/components/DomIcebergPanel";
import TickMomentumPanel from "@/components/TickMomentumPanel";
import ExecStatusBar from "@/components/ExecStatusBar";
import HealthPipeline from "@/components/HealthPipeline";
import SessionPicker, { type DatasetInfo } from "@/components/SessionPicker";
import { blendLiveMinutes, type FPMinute } from "@/lib/footprint";
import { useLive, type LiveMinute } from "@/lib/useLive";
import { useExecStatus } from "@/lib/useExecStatus";
import { imbalanceFor, summarizeImb } from "@/lib/imbalance";
import { etToFeed } from "@/lib/times";
import { readPriceAction } from "@/lib/priceaction";

type FootMinute = { t: string; d?: string; o?: number; c?: number; vwap?: number; high: number; low: number; buy: number; sell: number; delta: number };

export default function DashboardPage() {
  const live = useLive();
  /** the executor health snapshot — ONE 20s poll shared by the pipeline
   *  strip and the exec status bar (both are display-only mirrors) */
  const execHealth = useExecStatus();
  const [hist, setHist] = useState<LiveMinute[]>([]);
  const [fp, setFp] = useState<{ minutes: FPMinute[]; minPrice: number; maxPrice: number } | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  /** the session being viewed — null until the first dataset list arrives */
  const [sel, setSel] = useState<{ date: string; session: "ETH" | "RTH" } | null>(null);
  const [chartMax, setChartMax] = useState(false);
  /** the minute the footprint ladder selected — the chart scrolls to it */
  const [focusT, setFocusT] = useState<{ t: string; d?: string } | null>(null);
  /** the signal whose trade is visualized on the chart (entry/stop/target) */
  const [tradeView, setTradeView] = useState<{ id: string; side: "long" | "short"; entry: number; stop: number; target: number; timeET: string } | null>(null);

  const snap = live?.snapshot ?? null;
  const today = snap?.date ?? new Date().toISOString().slice(0, 10);

  // bootstrap: list the collected sessions (newest first), then default to
  // the latest date's ETH window (the live one — ticks keep streaming in)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/gc?action=datasets")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const ds: DatasetInfo[] = j.datasets ?? [];
        setDatasets(ds);
        if (ds[0]?.date) {
          setSel((cur) =>
            cur ??
            ({
              date: ds[0].date,
              session: (ds[0].sessions.includes("ETH") ? "ETH" : ds[0].sessions[0]) as "ETH" | "RTH",
            } as const),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [today]);

  // load the selected session's footprint (feeds the chart + ladder)
  // `shown` tracks the session whose data is actually DISPLAYED, so the
  // "loading" transition is derived from state instead of an effect reset
  const [shown, setShown] = useState<{ date: string; session: "ETH" | "RTH" } | null>(null);
  const loadingSession = sel !== null && (shown?.date !== sel.date || shown?.session !== sel.session);
  useEffect(() => {
    if (!sel) return;
    let cancelled = false;
    fetch(`/api/gc?action=footprint&date=${sel.date}&session=${sel.session}&start=&end=`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled || !j.minutes) return;
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
        setShown(sel);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sel]);

  // live ticks blend into the session ONLY when viewing the newest collected
  // ETH window (the "current session" continuation). A historical date — or
  // any RTH window, which is only ever collected after it closes — must not
  // be polluted with today's live bars.
  const latestDate = datasets[0]?.date ?? "";
  const viewingLive = sel ? (sel.date === latestDate || latestDate === "") && sel.session === "ETH" : true;
  const dataDate = sel?.date ?? latestDate ?? today;

  // bring the chart into view when a signal/ladder interaction synced to it —
  // but only when it is NOT already on screen (side-by-side xl layout and
  // mid-page positions never scroll)
  const chartSectionRef = useRef<HTMLElement | null>(null);
  const revealChart = () => {
    if (chartMax) return;
    const el = chartSectionRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const inView = r.top >= 0 && r.top < vh - 120 && r.bottom > 120;
    if (inView) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // click a signal in the history card → visualize its trade on the chart:
  // switch to the signal's session (overnight bars may live in the previous
  // day's file, so fall back one calendar day), focus the entry minute and
  // draw entry/stop/target lines. Clicking the same signal again clears it.
  const inspectSignal = (e: SignalEntry) => {
    const id = `${e.ts}|${e.day}|${e.side}|${e.price}`;
    if (tradeView?.id === id) {
      setTradeView(null);
      return;
    }
    let target = datasets.find((d) => d.date === e.day);
    if (!target) {
      const prev = new Date(`${e.day}T12:00:00Z`);
      prev.setUTCDate(prev.getUTCDate() - 1);
      const prevStr = prev.toISOString().slice(0, 10);
      target = datasets.find((d) => d.date === prevStr);
    }
    if (target) {
      setSel((cur) => (cur?.date === target!.date ? cur : { date: target!.date, session: "ETH" }));
    }
    const t = etToFeed(e.timeET);
    setFocusT({ t, d: target?.date });
    const entry = parseFloat(e.entry);
    const stop = parseFloat(e.stop);
    const tgt = parseFloat(e.target);
    if (e.side !== "none" && [entry, stop, tgt].every((v) => Number.isFinite(v))) {
      setTradeView({ id, side: e.side as "long" | "short", entry, stop, target: tgt, timeET: e.timeET });
    } else {
      // reversal-style text levels — focus the entry minute, no lines
      setTradeView(null);
    }
    revealChart();
  };

  // collected full day, continued by live ticks (latest session only)
  const blended = useMemo<LiveMinute[]>(() => {
    if (!viewingLive) return hist;
    const liveMins = live ? (live.cur ? [...live.minutes, live.cur] : live.minutes) : [];
    return blendLiveMinutes(hist, liveMins as LiveMinute[]);
  }, [hist, live, viewingLive]);
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
            d: m.d,
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
  const ladderMinutes: FPMinute[] = fp ? (viewingLive ? [...fp.minutes, ...liveFpTail] : fp.minutes) : viewingLive ? liveFpTail : [];
  const ladderDate = dataDate;
  const chartMinutes: LiveMinute[] = blended;

  const lastMin = chartMinutes[chartMinutes.length - 1];
  const lastPrice = lastMin ? lastMin.c || lastMin.h : snap?.ltp ?? 0;
  const chg = snap ? snap.ltp - snap.prev_close : 0;

  // the session high/low of the session being VIEWED: the live snapshot for
  // the latest (live) session, the bars themselves for a historical one
  const sessHigh = viewingLive ? snap?.high : chartMinutes.length ? Math.max(...chartMinutes.map((m) => m.h)) : undefined;
  const sessLow = viewingLive ? snap?.low : chartMinutes.length ? Math.min(...chartMinutes.map((m) => m.l)) : undefined;

  // premium / discount location across all six timeframes
  const pa = useMemo(
    () =>
      readPriceAction({
        minutes: chartMinutes.map((m) => ({ high: m.h, low: m.l, t: m.t, d: m.d })),
        lastPrice,
        sessionHigh: sessHigh,
        sessionLow: sessLow,
      }),
    [chartMinutes, lastPrice, sessHigh, sessLow],
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
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.25em] text-long">live strategies · tick to card</p>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">NQ scalping · momentum · RTH · open drive</h1>
        </div>
        <span className={`flex items-center gap-2 font-mono text-xs ${live?.connected ? "text-long" : "text-short"}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${live?.connected ? "bg-long shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-short"}`} />
          {live?.connected ? "connected" : "reconnecting…"}
        </span>
      </div>

      {/* HEALTH PIPELINE — every step of signal production → execution,
          one node per stage with its live health level. Reads the same
          /api/gc?action=health poll as the strip below. Display-only. */}
      <HealthPipeline health={execHealth} />

      {/* LIVE EXEC STATUS — the operator strip: guard state, account
          snapshot, day-plan rules, feeds, tape. Polls /api/gc?action=health
          every 20s. Display-only — the real gate is crossGuardGate(). */}
      <ExecStatusBar data={execHealth} />

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

      {/* BENTO BAND 1 · the page starts with the session scroller and the
          chart above the fold — all macro context lives in the Macro tab */}

      {/* session browser — every collected date, grouped with its windows */}
      <div className="mt-4">
        <SessionPicker
          datasets={datasets}
          selected={sel}
          isLive={viewingLive}
          onPick={(date, session) => {
            setSel({ date, session });
            setFocusT(null); // the old session's bar doesn't exist in this one
            setTradeView(null); // the visualized trade belongs to the old session
          }}
        />
      </div>

      {/* BENTO BAND 2 · the trading workspace (sacred: chart + rail) */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,360px)]">
        {/* left: chart + footprint ladder — side by side on xl+ so the chart
            and every control that drives it sit on ONE screen (no scroll) */}
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,380px)]">
          <section ref={chartSectionRef} className={`scroll-mt-14 flex flex-col rounded-md border border-zinc-800 bg-panel p-3 ${chartMax ? "fixed inset-0 z-40 rounded-none bg-zinc-950" : ""}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-zinc-50">
                1-min candles — delta tinted{" "}
                <span className="font-mono text-xs font-normal text-zinc-500">
                  · {dataDate} {sel?.session ?? ""}
                  {viewingLive ? " · live" : ""}
                  {loadingSession ? " · loading…" : ""}
                </span>
                {tradeView && (
                  <span className={`ml-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${tradeView.side === "long" ? "border-long/40 bg-long/10 text-long" : "border-short/40 bg-short/10 text-short"}`}>
                    {tradeView.side.toUpperCase()} signal {tradeView.timeET} NY · entry {tradeView.entry.toFixed(2)} · stop {tradeView.stop.toFixed(2)} · target {tradeView.target.toFixed(2)}
                    <button
                      onClick={() => setTradeView(null)}
                      className="ml-1.5 rounded border border-zinc-700 px-1 text-zinc-400 hover:text-zinc-200"
                      title="clear the visualized trade"
                    >
                      ✕
                    </button>
                  </span>
                )}
              </h2>
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
                  dataDate={dataDate}
                  colorBy="delta"
                  height={560}
                  autoHeight
                  focus={focusT}
                  trade={tradeView}
                />
              ) : (
                <p className="p-8 font-mono text-sm text-zinc-600">waiting for data…</p>
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-md border border-zinc-800 bg-panel p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-zinc-50">Footprint — minute ladder</h2>
              <p className="font-mono text-[10px] text-zinc-500">
                bid×ask per tick · ▲▼ = imbalance ·{" "}
                {sel?.session === "RTH" ? "RTH 09:30 → 16:00 NY" : "full day 18:00 → 16:59 NY"} · {ladderDate}
              </p>
            </div>
            {ladderMinutes.length > 0 ? (
              <MinuteNavigator
                minutes={ladderMinutes}
                date={ladderDate}
                timeMode="cdt"
                onSelect={(t, d) => {
                  setFocusT({ t, d });
                  revealChart();
                }}
              />
            ) : (
              <p className="p-8 font-mono text-sm text-zinc-600">no footprint data — collect with gcdata</p>
            )}
          </section>
        </div>

        {/* right: the strategy — the LIVE signal (every box, full detail)
            sits FIRST, then the signal history (click → trade on chart) */}
        <aside className="space-y-4">
          <LiveSignalPanel />
          <SignalHistory onInspect={inspectSignal} />
          <PriceActionPanel
            read={pa}
            asOfET={asOfET}
            stale={!live?.connected}
            source={viewingLive && live?.connected ? "live" : "collected"}
          />
          <SweepReclaimPanel minutes={chartMinutes} cur={viewingLive ? live?.cur : null} lastPrice={lastPrice} />
          <TickMomentumPanel />
          <DomIcebergPanel />
        </aside>
      </div>

      {/* the macro boxes (pulse / cross-asset / rates / earnings / news /
          AI briefing) live in the Macro tab — this page is the workspace */}
    </main>
  );
}
