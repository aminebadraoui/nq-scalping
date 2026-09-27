"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type ISeriesPrimitiveBase,
  type SeriesAttachedParameter,
  type IPrimitivePaneView,
} from "lightweight-charts";
import type { LiveMinute } from "@/lib/useLive";
import { cdtToET, utcToET, fmtETTime, feedToEpoch, utcToEpoch } from "@/lib/times";

export type LevelSet = {
  id: string;
  label: string;
  color: string;
  poc: number;
  vah: number;
  val: number;
  lvns: [number, number][];
  on: boolean;
  recency: number; // 0 = most recent
};

export function fmt(n: number | null | undefined, dp = 2) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * "HH:mm" label → epoch seconds. Collected bars are stamped in the exchange
 * clock (US Central), live tick bars in UTC; both need a DST-aware offset
 * (a hardcoded +5h plotted every winter bar an hour early).
 */
function toTime(t: string, dataDate: string, live: boolean, barDate?: string): UTCTimestamp {
  return (live ? utcToEpoch(t, dataDate) : feedToEpoch(t, barDate || dataDate)) as UTCTimestamp;
}

/* ------------------------------------------------------------------ */
/* Level overlay primitive: POC / VAH / VAL lines + LVN zone edge       */
/* lines with labels. Drawn inside a series primitive so it NEVER       */
/* affects the price autoscale (price lines were squashing the bars).   */
/* ------------------------------------------------------------------ */

type OverlayLine = { price: number; color: string; dashed: boolean; width: number; label: string; isPoc: boolean };

/* Progressive-disclosure thresholds, in POINTS of distance from price.
 * Near zones lead (full alpha, fill, label); far zones stay drawn but
 * recede, and anything outside the view becomes an edge chip instead of
 * silently disappearing. */
const NEAR_LABEL = 30; // LVN labels only within this distance
const NEAR_FILL = 18; // zone fills only this close
const FAR_LEVEL = 90; // distance at which a level line hits minimum alpha

class LevelOverlayPrimitive implements ISeriesPrimitiveBase<SeriesAttachedParameter> {
  private param: SeriesAttachedParameter | null = null;
  sets: LevelSet[] = [];
  vwap?: number;
  showPoc = true;
  showVa = true;

  attached(param: SeriesAttachedParameter) {
    this.param = param;
  }
  detached() {
    this.param = null;
  }
  /** last traded price — drives the distance-based emphasis ramp */
  lastPrice = 0;

  update(sets: LevelSet[], vwap?: number, showPoc = true, showVa = true, lastPrice = 0) {
    this.sets = sets;
    this.vwap = vwap;
    this.showPoc = showPoc;
    this.showVa = showVa;
    this.lastPrice = lastPrice;
    try {
      (this.param as unknown as { requestUpdate?: () => void })?.requestUpdate?.();
    } catch {
      /* ignore */
    }
  }

  private lines(): OverlayLine[] {
    const out: OverlayLine[] = [];
    for (const s of [...this.sets].sort((a, b) => b.recency - a.recency)) {
      for (const [a, b] of s.lvns) {
        out.push({ price: a, color: s.color, dashed: false, width: 1, label: `${s.label} LVN ${fmt(a)}–${fmt(b)}`, isPoc: false });
        out.push({ price: b, color: s.color, dashed: false, width: 1, label: "", isPoc: false });
      }
      if (this.showPoc) {
        out.push({ price: s.poc, color: s.color, dashed: false, width: 2, label: `${s.label} POC ${fmt(s.poc)}`, isPoc: true });
      }
      if (this.showVa) {
        out.push({ price: s.vah, color: s.color, dashed: true, width: 1, label: `${s.label} VAH ${fmt(s.vah)}`, isPoc: false });
        out.push({ price: s.val, color: s.color, dashed: true, width: 1, label: `${s.label} VAL ${fmt(s.val)}`, isPoc: false });
      }
    }
    if (this.vwap && this.vwap > 0) {
      out.push({ price: this.vwap, color: "#e4e4e7", dashed: true, width: 1, label: `VWAP ${fmt(this.vwap)}`, isPoc: false });
    }
    return out;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [
      {
        zOrder: () => "bottom" as const,
        renderer: () => ({
          draw: (target: any) => {
            target.useBitmapCoordinateSpace((scope: any) => {
              const p = this.param;
              if (!p) return;
              const ctx = scope.context as CanvasRenderingContext2D;
              const vr = scope.verticalPixelRatio as number;
              const hr = scope.horizontalPixelRatio as number;
              const W = (scope.mediaSize.width as number) * hr;
              const yOf = (price: number): number | null => {
                const y = p.series.priceToCoordinate(price);
                return y === null ? null : (y as number) * vr;
              };

              const H = (scope.mediaSize.height as number) * vr;
              const band = (a: number, b: number): string | null => {
                const y1 = yOf(a);
                const y2 = yOf(b);
                if (y1 === null || y2 === null) return null;
                const top = Math.min(y1, y2);
                const bot = Math.max(y1, y2);
                if (bot < -2 || top > H + 2) return null; // fully out of view
                return `${top}|${bot}`;
              };

              // 1 · zone fills — only near price, so the middle of the chart
              //     stays clean and far zones are indicated by their edges
              for (const s of this.sets) {
                for (const [a, b] of s.lvns) {
                  const near = this.lastPrice > 0 ? Math.abs((a + b) / 2 - this.lastPrice) <= NEAR_FILL : true;
                  if (!near) continue;
                  const y1 = yOf(a);
                  const y2 = yOf(b);
                  if (y1 === null || y2 === null) continue;
                  const top = Math.min(y1, y2);
                  ctx.fillStyle = s.color + "18";
                  ctx.fillRect(0, top, W, Math.max(1, Math.abs(y2 - y1)));
                }
              }

              // 2 · every level line is still drawn when it is on screen; the
              //     alpha ramps with distance from price (progressive emphasis)
              const lines = this.lines();
              const offscreen = { above: 0, below: 0, nearestAbove: 0, nearestBelow: 0 };
              for (const s of this.sets) {
                for (const [a, b] of s.lvns) {
                  const y1 = yOf(a);
                  const y2 = yOf(b);
                  if (y1 !== null && y2 !== null && Math.min(y1, y2) > -2 && Math.max(y1, y2) < H + 2) continue;
                  if (y1 === null || y1 < 0) {
                    offscreen.above++;
                    offscreen.nearestAbove = Math.max(offscreen.nearestAbove, b);
                  } else {
                    offscreen.below++;
                    offscreen.nearestBelow = Math.min(offscreen.nearestBelow || Infinity, a);
                  }
                }
              }
              for (const l of lines) {
                const y = yOf(l.price);
                if (y === null) continue;
                if (y < -2 || y > H + 2) continue; // off-screen: counted below
                const d = this.lastPrice > 0 ? Math.abs(l.price - this.lastPrice) : 0;
                const alpha = l.isPoc ? (d <= NEAR_LABEL ? 0.95 : 0.55) : 0.3 + 0.7 * Math.max(0, 1 - d / FAR_LEVEL);
                ctx.globalAlpha = Math.min(1, alpha);
                ctx.strokeStyle = l.color;
                ctx.lineWidth = l.width * vr;
                ctx.setLineDash(l.dashed ? [5 * hr, 4 * hr] : []);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(W, y);
                ctx.stroke();
                ctx.setLineDash([]);
              }
              ctx.globalAlpha = 1;

              // 3 · labels: always for POC/VA near price, LVN labels only when
              //     the zone is genuinely close (progressive disclosure)
              ctx.font = `${8.5 * vr}px ui-monospace, monospace`;
              ctx.textBaseline = "middle";
              const placed: number[] = [];
              const ordered = lines.filter((l) => l.label).sort((a, b) => (yOf(b.price) ?? 0) - (yOf(a.price) ?? 0));
              for (const l of ordered) {
                const y = yOf(l.price);
                if (y === null || y < 0 || y > H) continue;
                const d = this.lastPrice > 0 ? Math.abs(l.price - this.lastPrice) : 0;
                const isLvn = l.label.includes("LVN");
                if (isLvn && d > NEAR_LABEL) continue;
                if (!isLvn && !l.isPoc && d > NEAR_LABEL * 2) continue;
                if (placed.some((q) => Math.abs(q - y) < 11 * vr)) continue;
                placed.push(y);
                if (band(l.price, l.price)) {
                  const w = ctx.measureText(l.label).width;
                  ctx.fillStyle = "rgba(12,12,15,0.8)";
                  ctx.fillRect(4 * hr, y - 6 * vr, w + 6 * hr, 12 * vr);
                  ctx.fillStyle = l.color;
                  ctx.globalAlpha = 0.9;
                  ctx.fillText(l.label, 7 * hr, y);
                  ctx.globalAlpha = 1;
                }
              }

              // 4 · edge chips: zones that exist but sit outside the view, so
              //     nothing is silently lost when the scale is tight
              const chip = (text: string, y: number, col: string) => {
                ctx.font = `${8.5 * vr}px ui-monospace, monospace`;
                const w = ctx.measureText(text).width;
                ctx.fillStyle = "rgba(12,12,15,0.75)";
                ctx.fillRect(4 * hr, y - 6 * vr, w + 6 * hr, 12 * vr);
                ctx.fillStyle = col;
                ctx.fillText(text, 7 * hr, y);
              };
              if (offscreen.above > 0 && this.lastPrice > 0) {
                chip(`▲ ${offscreen.above} LVN zone${offscreen.above > 1 ? "s" : ""} above · nearest ${fmt(offscreen.nearestAbove)}`, 10 * vr, "#71717a");
              }
              if (offscreen.below > 0 && this.lastPrice > 0) {
                chip(`▼ ${offscreen.below} LVN zone${offscreen.below > 1 ? "s" : ""} below · nearest ${fmt(offscreen.nearestBelow)}`, H - 10 * vr, "#71717a");
              }
            });
          },
        }),
      },
    ];
  }
}

export default function FlowChart({
  minutes,
  levels,
  markers = [],
  dataDate,
  vwap,
  vwapSeries = [],
  showPoc = true,
  showVa = false,
  colorBy = "move",
  height = 420,
  autoHeight = false,
  viewBars = 120,
}: {
  minutes: LiveMinute[];
  levels: LevelSet[];
  markers?: { t: string; bias: "bull" | "bear" | null; kind?: string }[];
  dataDate?: string;
  vwap?: number;
  vwapSeries?: { t: string; value: number }[];
  showPoc?: boolean;
  showVa?: boolean;
  /** "move" = classic up/down candles · "delta" = tint by buy/sell dominance */
  colorBy?: "move" | "delta";
  height?: number;
  /** measure the wrapper div and resize the chart to fill it (for big flexible layouts) */
  autoHeight?: boolean;
  /** how many minutes to load — the library autoscales over loaded data, so
   *  this is what actually controls how much of the pane the candles fill */
  viewBars?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlayRef = useRef<LevelOverlayPrimitive | null>(null);
  const [ohlcCount, setOhlcCount] = useState(0);
  const barsRef = useRef<{ low: number; high: number; close: number }[]>([]);
  const visRef = useRef({ from: 0, to: 0 });
  const viewBarsRef = useRef(0);
  const rangeInitRef = useRef<WeakSet<object>>(new WeakSet());

  const date = dataDate || new Date().toISOString().slice(0, 10);
  const sig = `${minutes.length}|${minutes[minutes.length - 1]?.t}|${minutes[minutes.length - 1]?.c ?? minutes[minutes.length - 1]?.h}|${minutes[minutes.length - 1]?.vol}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => minutes.slice(-viewBars), [sig, viewBars]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: autoHeight ? Math.max(220, el.clientHeight) : height,
      layout: {
        background: { type: ColorType.Solid, color: "#0c0c0f" },
        textColor: "#8b8b93",
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
      grid: {
        vertLines: { color: "rgba(39,39,42,0.5)" },
        horzLines: { color: "rgba(39,39,42,0.5)" },
      },
      rightPriceScale: {
        borderColor: "rgba(63,63,70,0.8)",
        // the library default (top .2 / bottom .1) burns ~30% of the pane
        // height on empty space — candles should own the pane
        scaleMargins: { top: 0.03, bottom: 0.03 },
      },
      timeScale: {
        borderColor: "rgba(63,63,70,0.8)",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: number) => fmtETTime(time),
      },
      localization: {
        locale: "en-US",
        timeFormatter: (time: number) => fmtETTime(time),
      },
      crosshair: {
        vertLine: { color: "rgba(113,113,122,0.6)", labelBackgroundColor: "#27272a" },
        horzLine: { color: "rgba(113,113,122,0.6)", labelBackgroundColor: "#27272a" },
      },
    });
    chartRef.current = chart;

    // Price-axis policy. "fit" sizes the scale to the bars actually on screen
    // (the whole-dataset range was wasting ~40% of the pane height because the
    // session extremes sat outside the visible window); "focus" pins a fixed
    // window around the current price for scalping; "auto" is the library default.
    // normal 1-minute candles — real OHLC from the TS/V2 feed when available
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f87171",
      borderUpColor: "#34d399",
      borderDownColor: "#f87171",
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
      borderVisible: true,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.25 },
    }) as ISeriesApi<"Candlestick">;
    vwapSeriesRef.current = chart.addSeries(LineSeries, {
      color: "#e4e4e7",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // dev-only introspection hook (used by tooling to verify scale/window behaviour)
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __flow?: unknown }).__flow = {
        chart,
        get series() {
          return candleRef.current;
        },
        refs: { visRef, barsRef },
      };
    }

    try {
      const overlay = new LevelOverlayPrimitive();
      candleRef.current.attachPrimitive(overlay);
      overlayRef.current = overlay;
    } catch {
      /* ignore */
    }

    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (!r) return;
        visRef.current = { from: r.from, to: r.to };
      });
    } catch {
      /* ignore */
    }

    const ro = new ResizeObserver(() =>
      chart.applyOptions({ width: el.clientWidth, ...(autoHeight ? { height: Math.max(220, el.clientHeight) } : {}) }),
    );
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      vwapSeriesRef.current = null;
      overlayRef.current = null;
    };
  }, [height, autoHeight]);

  // developing VWAP curve — sliced to the loaded window, otherwise the line
  // drags the price scale back to the session open and squashes the candles
  useEffect(() => {
    const s = vwapSeriesRef.current;
    if (!s) return;
    s.setData(vwapSeries.slice(-viewBars).map((v) => ({ time: toTime(v.t, date, false), value: v.value })));
  }, [vwapSeries, date, viewBars]);

  // bars + markers
  const lastSigRef = useRef("");
  const rangedRef = useRef(false);
  const mSig = markers.map((m) => `${m.t}|${m.bias}|${m.kind}`).join(",");
  useEffect(() => {
    const series = candleRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; color?: string; borderColor?: string; wickColor?: string };
    const bars: Bar[] = [];
    let real = 0;
    for (const m of data) {
      const hasOhlc = m.o > 0 && m.c > 0;
      if (hasOhlc) real++;
      const mid = (m.h + m.l) / 2;
      const bar: Bar = {
        time: toTime(m.t, date, m.live, m.d),
        open: hasOhlc ? m.o : mid,
        high: m.h,
        low: m.l,
        close: hasOhlc ? m.c : mid,
      };
      if (colorBy === "delta") {
        // tint by who was aggressive, shape stays the real OHLC
        const col = m.buy >= m.sell ? "#34d399" : "#f87171";
        bar.color = col;
        bar.borderColor = col;
        bar.wickColor = col;
      }
      bars.push(bar);
    }
    setOhlcCount(real);
    const last = bars[bars.length - 1];
    const cur = `${bars.length}:${last?.time}:${last?.close}:${last?.open}:${colorBy}:${mSig}`;
    barsRef.current = bars.map((b) => ({ low: b.low, high: b.high, close: b.close }));
    if (cur !== lastSigRef.current) {
      lastSigRef.current = cur;
      series.setData(bars);
    }
    // initial window: the most recent ~90 minutes (the visible-range ref must
    // be populated BEFORE the provider runs, or "fit" falls back to the whole
    // dataset and wastes most of the pane height)
    // show exactly what is loaded: the price scale then fits those bars, which
    // is what makes the candles fill the pane instead of floating in it
    if (bars.length && (viewBarsRef.current !== viewBars || !rangeInitRef.current.has(chart))) {
      viewBarsRef.current = viewBars;
      rangeInitRef.current.add(chart);
      // fitContent() is the canonical "show all loaded bars" call: it also
      // makes the price scale re-fit, which is what fills the pane with candles
      const apply = () => {
        try {
          chart.timeScale().fitContent();
        } catch {
          /* ignore */
        }
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
    }
    try {
      const mp = createSeriesMarkers(series, []);
      mp.setMarkers(
        markers.map((mk) => ({
          time: toTime(mk.t, date, false),
          position: "aboveBar" as const,
          color: mk.bias === "bull" ? "#34d399" : mk.bias === "bear" ? "#f87171" : "#fbbf24",
          shape: mk.bias === "bull" ? ("arrowUp" as const) : mk.bias === "bear" ? ("arrowDown" as const) : ("circle" as const),
        })),
      );
    } catch {
      /* markers unsupported */
    }
  }, [data, date, mSig, markers, colorBy]);

  // levels + vwap → overlay primitive
  useEffect(() => {
    const lp = data.length ? data[data.length - 1].c || data[data.length - 1].h : 0;
    overlayRef.current?.update(
      levels.filter((l) => l.on),
      vwap,
      showPoc,
      showVa,
      lp,
    );
  }, [levels, vwap, showPoc, showVa, data]);

  return (
    <div className="flex h-full w-full flex-col">
      <div ref={wrapRef} className="min-h-0 w-full flex-1" />
      <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] text-zinc-500">
        <span>
          1-minute candles · <span className="text-zinc-300">{data.length} bars</span> ·{" "}
          {data[0] ? (data[0].live ? utcToET(data[0].t) : cdtToET(data[0].t)) : "—"} →{" "}
          {data[data.length - 1] ? (data[data.length - 1].live ? utcToET(data[data.length - 1].t) : cdtToET(data[data.length - 1].t)) : "—"}{" "}
          (New York) · <span className="text-zinc-300">{date}</span>
        </span>
        <span>
          {ohlcCount === data.length && data.length > 0 ? (
            <span className="text-long">real OHLC {ohlcCount}/{data.length}</span>
          ) : ohlcCount > 0 ? (
            <span className="text-warn">real OHLC {ohlcCount}/{data.length} · rest = mid-price range bars</span>
          ) : (
            <span className="text-warn">no OHLC for this date — range bars (o=c=mid)</span>
          )}
          {" · "}
          {colorBy === "delta" ? "tinted by buy/sell dominance" : "normal candles (up/down)"}
        </span>
        <span>
          {vwap && vwap > 0 ? <span>VWAP <span className="text-zinc-200">{fmt(vwap)}</span> · </span> : null}
          scroll = zoom · drag = pan · POC = solid thick · VAH/VAL = dashed · LVN = solid edges (near zones lead, far ones fade; off-screen zones are counted at the chart edges)
        </span>
      </div>
    </div>
  );
}
