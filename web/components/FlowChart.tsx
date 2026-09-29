"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type AutoscaleInfo,
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
/* Level overlay primitive: POC / VAH / VAL lines + LVN zone BANDS.     */
/* Drawn inside a series primitive so it NEVER affects the price        */
/* autoscale (price lines were squashing the bars).                     */
/*                                                                      */
/* Progressive disclosure:                                              */
/*   · profile gating — at a wide price zoom only the most recent       */
/*     profile(s) are drawn; older profiles (P1→P5) appear as you zoom  */
/*     the price axis in. Zones in view but gated are counted in a      */
/*     "hidden" chip instead of being dropped silently.                 */
/*   · zone bands — a zone whose pixel height is big enough is drawn as */
/*     a filled band with ONE label centred in the middle (not two bare */
/*     edges with text). Thin-on-screen zones stay as edge lines.       */
/*   · emphasis — alpha ramps down with distance from the last price;   */
/*     the label budget caps on-screen labels so the chart never turns  */
/*     into a wall of text.                                             */
/* ------------------------------------------------------------------ */

type OverlayLine = { price: number; color: string; dashed: boolean; width: number; label: string; isPoc: boolean };

const NEAR_LABEL = 30; // pts — POC labels emphasized within this distance
const NEAR_FILL = 18; // pts — bands within this of price get a fill
const FAR_LEVEL = 90; // pts — distance at which a level fades to min alpha
const MIN_ALPHA = 0.16; // floor alpha for far levels
const MIN_BAND_PX = 9; // bitmap px — min band height for a fill
const BIG_BAND_PX = 26; // bitmap px — bands this tall get a fill even when far
const LABEL_MIN_PX = 12; // bitmap px — min band height for a zone label
const LABEL_STEP = 36; // media px — one label per this much pane height

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
  /** visible bar count — set by the component's range subscription; used for
   *  the time-zoom disclosure gate ("wide candle spacing reveals everything") */
  visBars = 0;

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

  /** POC / VAH / VAL / VWAP lines for the gated (revealed) profiles. */
  private lines(sets: LevelSet[]): OverlayLine[] {
    const out: OverlayLine[] = [];
    for (const s of [...sets].sort((a, b) => b.recency - a.recency)) {
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
              const H = (scope.mediaSize.height as number) * vr;
              const yOf = (price: number): number | null => {
                const y = p.series.priceToCoordinate(price);
                return y === null ? null : (y as number) * vr;
              };

              // 0 · visible price span → progressive profile gating. The
              //     series' own coordinate mapping gives the price at the top
              //     and bottom of the pane; the span decides how much of the
              //     P0→P5 stack is revealed. A deep TIME zoom (wide candle
              //     spacing) reveals the full stack too — "zoom in" works on
              //     either axis.
              let span = 0;
              try {
                const top = p.series.coordinateToPrice(0);
                const bot = p.series.coordinateToPrice(scope.mediaSize.height as number);
                if (top !== null && bot !== null) span = Math.abs((top as number) - (bot as number));
              } catch {
                span = 0;
              }
              let maxRec = span > 220 ? 0 : span > 110 ? 1 : span > 55 ? 2 : span > 28 ? 3 : 99;
              if (this.visBars > 0 && W / this.visBars >= 16) maxRec = 99;
              const sets = span > 0 ? this.sets.filter((s) => s.recency <= maxRec) : this.sets;

              // 1 · zone geometry + census (all sets: off-screen → chips,
              //     in-view but gated → "hidden" chip until the user zooms in)
              type Zone = { s: LevelSet; a: number; b: number; y1: number; y2: number; px: number; cy: number; dist: number };
              const zones: Zone[] = [];
              const off = { above: 0, below: 0, nearestAbove: 0, nearestBelow: 0, hidden: 0 };
              for (const s of this.sets) {
                const shown = span <= 0 || s.recency <= maxRec;
                for (const [a, b] of s.lvns) {
                  const y1 = yOf(a);
                  const y2 = yOf(b);
                  if (y1 === null || y2 === null) continue;
                  const top = Math.min(y1, y2);
                  const bot = Math.max(y1, y2);
                  if (bot < -2) {
                    off.above++;
                    off.nearestAbove = Math.max(off.nearestAbove, b);
                    continue;
                  }
                  if (top > H + 2) {
                    off.below++;
                    off.nearestBelow = Math.min(off.nearestBelow || Infinity, a);
                    continue;
                  }
                  if (!shown) {
                    off.hidden++;
                    continue;
                  }
                  const cy = (top + bot) / 2;
                  zones.push({
                    s,
                    a,
                    b,
                    y1: top,
                    y2: bot,
                    px: bot - top,
                    cy,
                    dist: this.lastPrice > 0 ? Math.abs((a + b) / 2 - this.lastPrice) : 0,
                  });
                }
              }
              const fillable = (z: Zone) => z.px >= MIN_BAND_PX && (z.dist <= NEAR_FILL || z.px >= BIG_BAND_PX);

              // 2 · zone bands — the fill is what makes a zone read as a
              //     ZONE; the edge lines only delineate it. Near zones lead.
              //     Clamped to the pane so a straddling band never paints
              //     over the time axis.
              for (const z of zones) {
                if (!fillable(z)) continue;
                const top = Math.max(z.y1, 0);
                const bot = Math.min(z.y2, H);
                if (bot - top < 1) continue;
                ctx.globalAlpha = z.dist <= NEAR_FILL ? 0.15 : 0.09;
                ctx.fillStyle = z.s.color;
                ctx.fillRect(0, top, W, bot - top);
              }
              ctx.globalAlpha = 1;

              // 3 · zone edges — always drawn while on screen; alpha ramps
              //     with distance from price, filled bands stay stronger
              for (const z of zones) {
                const ramp = this.lastPrice > 0 ? Math.max(0, 1 - z.dist / FAR_LEVEL) : 0.5;
                let alpha = MIN_ALPHA + (0.85 - MIN_ALPHA) * ramp;
                if (fillable(z)) alpha = Math.min(1, alpha + 0.15);
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = z.s.color;
                ctx.lineWidth = 1 * vr;
                ctx.setLineDash([]);
                for (const y of [z.y1, z.y2]) {
                  if (y < -1 || y > H + 1) continue;
                  ctx.beginPath();
                  ctx.moveTo(0, y);
                  ctx.lineTo(W, y);
                  ctx.stroke();
                }
              }
              ctx.globalAlpha = 1;

              // 4 · POC / VAH / VAL / VWAP lines
              const lines = this.lines(sets);
              for (const l of lines) {
                const y = yOf(l.price);
                if (y === null || y < -2 || y > H + 2) continue;
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

              // 5 · labels — ONE per zone, centred in the band. Near zones
              //     win the budget; collisions are skipped, never overlapped.
              const placed: number[] = [];
              const budget = Math.max(4, Math.floor((scope.mediaSize.height as number) / LABEL_STEP));
              type Cand = { text: string; y: number; color: string; dist: number; px: number };
              const cands: Cand[] = [];
              const seen = new Set<string>();
              for (const z of zones) {
                if (z.px < LABEL_MIN_PX || z.dist > FAR_LEVEL) continue;
                const text = `${z.s.label} LVN ${fmt(z.a)}–${fmt(z.b)}`;
                if (seen.has(text)) continue;
                seen.add(text);
                cands.push({ text, y: z.cy, color: z.s.color, dist: z.dist, px: z.px });
              }
              for (const l of lines) {
                if (!l.label) continue;
                const y = yOf(l.price);
                if (y === null || y < 0 || y > H) continue;
                const d = this.lastPrice > 0 ? Math.abs(l.price - this.lastPrice) : 0;
                if (!l.isPoc && d > NEAR_LABEL * 2) continue;
                cands.push({ text: l.label, y, color: l.color, dist: d, px: 0 });
              }
              cands.sort((a, b) => a.dist - b.dist || b.px - a.px);
              ctx.font = `${9 * vr}px ui-monospace, monospace`;
              ctx.textBaseline = "middle";
              for (const c of cands) {
                if (placed.length >= budget) break;
                const y = Math.max(7 * vr, Math.min(H - 7 * vr, c.y));
                if (placed.some((q) => Math.abs(q - y) < 13 * vr)) continue;
                placed.push(y);
                const w = ctx.measureText(c.text).width;
                ctx.fillStyle = "rgba(12,12,15,0.82)";
                ctx.fillRect(4 * hr, y - 6.5 * vr, w + 6 * hr, 13 * vr);
                ctx.fillStyle = c.color;
                ctx.fillText(c.text, 7 * hr, y);
              }

              // 6 · edge chips: zones outside the view + profiles gated by
              //     the current zoom level (nothing is silently lost)
              const chip = (text: string, y: number, col: string) => {
                ctx.font = `${8.5 * vr}px ui-monospace, monospace`;
                const w = ctx.measureText(text).width;
                ctx.fillStyle = "rgba(12,12,15,0.75)";
                ctx.fillRect(4 * hr, y - 6 * vr, w + 6 * hr, 12 * vr);
                ctx.fillStyle = col;
                ctx.fillText(text, 7 * hr, y);
              };
              if (off.above > 0 && this.lastPrice > 0) {
                chip(`▲ ${off.above} LVN zone${off.above > 1 ? "s" : ""} above · nearest ${fmt(off.nearestAbove)}`, 10 * vr, "#71717a");
              }
              if (off.below > 0 && this.lastPrice > 0) {
                chip(`▼ ${off.below} LVN zone${off.below > 1 ? "s" : ""} below · nearest ${fmt(off.nearestBelow)}`, H - 10 * vr, "#71717a");
              }
              if (off.hidden > 0) {
                chip(`⊘ ${off.hidden} LVN zone${off.hidden > 1 ? "s" : ""} hidden · zoom in to reveal`, (off.above > 0 ? 24 : 10) * vr, "#52525b");
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
}: {
  minutes: LiveMinute[];
  levels: LevelSet[];
  markers?: { t: string; d?: string; bias: "bull" | "bear" | null; kind?: string }[];
  dataDate?: string;
  vwap?: number;
  vwapSeries?: { t: string; d?: string; value: number }[];
  showPoc?: boolean;
  showVa?: boolean;
  /** "move" = classic up/down candles · "delta" = tint by buy/sell dominance */
  colorBy?: "move" | "delta";
  height?: number;
  /** measure the wrapper div and resize the chart to fill it (for big flexible layouts) */
  autoHeight?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const overlayRef = useRef<LevelOverlayPrimitive | null>(null);
  const [ohlcCount, setOhlcCount] = useState(0);
  const barsRef = useRef<{ low: number; high: number; close: number }[]>([]);
  const visRef = useRef({ from: 0, to: 0 });

  // axis measurements (declared before the chart effect — its rAF uses it)
  const [axis, setAxis] = useState({ priceW: 68, timeH: 26 });
  const measureAxes = () => {
    const c = chartRef.current;
    if (!c) return;
    try {
      setAxis({ priceW: c.priceScale("right").width(), timeH: c.timeScale().height() });
    } catch {
      /* ignore */
    }
  };

  const rangeInitRef = useRef<WeakSet<object>>(new WeakSet());

  const date = dataDate || new Date().toISOString().slice(0, 10);
  const sig = `${minutes.length}|${minutes[minutes.length - 1]?.t}|${minutes[minutes.length - 1]?.c ?? minutes[minutes.length - 1]?.h}|${minutes[minutes.length - 1]?.vol}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  /**
   * Zoom policy (TradingView-like):
   *   · open on the most recent DEFAULT_WINDOW bars — readable candles, not a
   *     hairline full day and not three giant live bars
   *   · the 1h / 2h / 4h / day selector refits to that span
   *   · scrolling back towards the left edge LOADS more of the day in
   *     progressively larger chunks, so the whole session stays reachable
   *   · double-click the time axis → back to the default window
   *   · double-click the price axis → reset the price scale to auto-fit
   */
  const DEFAULT_WINDOW = 120;
  const WINDOWS: { bars: number; label: string }[] = [
    { bars: 60, label: "1h" },
    { bars: 120, label: "2h" },
    { bars: 240, label: "4h" },
    { bars: Infinity, label: "day" },
  ];
  const [windowBars, setWindowBars] = useState<number>(DEFAULT_WINDOW);

  /* ── "center" mode (TradingView "fixed range", scalping flavour) ─────────
   * Keeps a minimum band of FOCUS_PTS points around the LAST price whenever
   * the live edge is on screen. Effect: constant pixel size per point — the
   * candles never jump or squash from bar to bar, and price stays near the
   * pane centre. It only ever EXPANDS the visible range, so a big candle
   * still fits; when the user scrolls back into history the scale fits the
   * visible bars instead. Implemented with autoscaleInfoProvider (the
   * documented way to adjust the autoscale computation). */
  const FOCUS_PTS = 50;
  const [center, setCenter] = useState(true);
  const centerRef = useRef(true);
  // keep the provider (created once, at chart setup) in sync with the state
  useLayoutEffect(() => {
    centerRef.current = center;
  }, [center]);

  const prevLenRef = useRef(0);
  const prevFromRef = useRef(0);
  /** paging is only allowed after the user has actually touched the chart —
   *  the library emits range events of its own (fit, resize) that must not be
   *  mistaken for a scroll to the left edge */
  const userTouchedRef = useRef(false);
  /** true while a pagination step (not incoming data) changed the loaded span */
  const pagingRef = useRef(false);
  const data = useMemo(() => minutes.slice(-windowBars), [sig, windowBars, minutes]);

  /** Set the loaded span to a chosen window and re-fit the view to it. */
  const applyWindow = (bars: number) => {
    pagingRef.current = false;
    userTouchedRef.current = false; // resume auto-fitting
    prevFromRef.current = 0; // the upcoming fit is not a leftward scroll
    prevLenRef.current = 0; // force the data effect to re-fit
    setWindowBars(bars);
    const chart = chartRef.current;
    if (!chart) return;
    try {
      chart.timeScale().fitContent();
    } catch {
      /* ignore */
    }
  };

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
        // NOTE: no rightOffset / barSpacing / minBarSpacing here on purpose.
        // rightOffset makes the axis draw extrapolated time labels past the
        // last candle, and explicit spacing options fight fitContent() (the
        // loaded-window slice IS the zoom control) — both made the time axis
        // look wrong. lockVisibleTimeRangeOnResize is also left off so a
        // resize keeps fitting the loaded span.
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
      // center mode: hold a FOCUS_PTS band around the last close while the
      // live edge is visible, so candle size stays constant and price sits
      // near the middle of the pane. Purely additive — a wide candle still
      // stretches the scale, and history browsing is untouched.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res || !res.priceRange) return res;
        const bars = barsRef.current;
        const last = bars[bars.length - 1];
        const vis = visRef.current;
        if (!centerRef.current || !last || vis.to < bars.length - 8) return res;
        const half = FOCUS_PTS / 2;
        res.priceRange.minValue = Math.min(res.priceRange.minValue, last.close - half);
        res.priceRange.maxValue = Math.max(res.priceRange.maxValue, last.close + half);
        return res;
      },
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
        if (overlayRef.current) overlayRef.current.visBars = r.to - r.from;
      });
    } catch {
      /* ignore */
    }

    requestAnimationFrame(measureAxes);
    const ro = new ResizeObserver(() =>
      {
        chart.applyOptions({ width: el.clientWidth, ...(autoHeight ? { height: Math.max(220, el.clientHeight) } : {}) });
        measureAxes();
      },
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

  // ── TradingView-style axis gestures ───────────────────────────────────────
  // Double-click the price axis → reset the price scale to auto-fit.
  // Double-click the time axis → back to the default zoom window.
  // Detected by hit-testing the container so axis DRAGGING still works.
  const resetPriceScale = () => {
    try {
      const ps = candleRef.current?.priceScale();
      if (!ps) return;
      // toggling forces the library to recompute the fit to the visible bars
      ps.applyOptions({ autoScale: false });
      ps.applyOptions({ autoScale: true });
    } catch {
      /* ignore */
    }
  };
  const resetZoom = () => {
    applyWindow(DEFAULT_WINDOW);
  };
  const toggleCenter = () => {
    setCenter((v) => !v);
    // the provider reads centerRef (synced by the layout effect before paint);
    // re-run the autoscale so the new mode takes effect immediately
    requestAnimationFrame(() => {
      try {
        const ps = candleRef.current?.priceScale();
        if (!ps) return;
        ps.applyOptions({ autoScale: false });
        ps.applyOptions({ autoScale: true });
      } catch {
        /* ignore */
      }
    });
  };
  const onChartDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= rect.width - axis.priceW) resetPriceScale();
    else if (y >= rect.height - axis.timeH) resetZoom();
  };

  // Load more of the day when the user scrolls back towards the left edge
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = (r: { from: number; to: number } | null) => {
      if (!r) return;
      const movedLeft = r.from < prevFromRef.current - 1;
      prevFromRef.current = r.from;
      // page in older bars only when the user has genuinely scrolled to the
      // left edge of the loaded span (not on the initial fit or a resize)
      if (userTouchedRef.current && movedLeft && r.from <= 12 && windowBars < minutes.length) {
        pagingRef.current = true;
        setWindowBars((v) => Math.min(minutes.length, Math.max(v * 2, DEFAULT_WINDOW)));
      }
    };
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      } catch {
        /* ignore */
      }
    };
  }, [minutes.length, windowBars]);

  // developing VWAP curve — sliced to the loaded window, otherwise the line
  // drags the price scale back to the session open and squashes the candles
  useEffect(() => {
    const s = vwapSeriesRef.current;
    if (!s) return;
    s.setData(
      vwapSeries
        .slice(-windowBars)
        .map((v) => ({ time: toTime(v.t, date, false, v.d), value: v.value }))
        .filter((v) => Number.isFinite(v.time)),
    );
  }, [vwapSeries, date, windowBars]);

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
    // lightweight-charts throws ("time must be of type BusinessDay") on NaN
    // epochs; a defensive filter keeps the chart alive even with bad input
    const goodBars = bars.filter((b) => Number.isFinite(b.time));
    barsRef.current = goodBars.map((b) => ({ low: b.low, high: b.high, close: b.close }));
    if (cur !== lastSigRef.current) {
      lastSigRef.current = cur;
      series.setData(goodBars);
    }
    // initial window: the most recent ~90 minutes (the visible-range ref must
    // be populated BEFORE the provider runs, or "fit" falls back to the whole
    // dataset and wastes most of the pane height)
    // show exactly what is loaded: the price scale then fits those bars, which
    // is what makes the candles fill the pane instead of floating in it
    // ── window management ────────────────────────────────────────────────
    // Default: after every data change, fit the loaded span (the loaded span IS
    // the default 240-bar window, so the candles are readable and the price
    // scale fits exactly what is shown). Once the user zooms/pans, their view is
    // respected — except after a reset or a pagination step, which shifts the
    // visible range so the bars they were looking at stay put.
    const len = goodBars.length;
    const prevLen = prevLenRef.current;
    prevLenRef.current = len;
    if (!len) {
      /* nothing to show */
    } else if (pagingRef.current && len > prevLen) {
      pagingRef.current = false;
      const shift = len - prevLen;
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r) {
        try {
          chart.timeScale().setVisibleLogicalRange({ from: r.from + shift, to: r.to + shift });
        } catch {
          /* ignore */
        }
      }
    } else if (!userTouchedRef.current) {
      const fit = () => {
        try {
          chart.timeScale().fitContent();
        } catch {
          /* ignore */
        }
      };
      fit();
      requestAnimationFrame(() => {
        fit();
        requestAnimationFrame(fit);
      });
    }
    try {
      const mp = createSeriesMarkers(series, []);
      const firstTime = goodBars[0]?.time ?? 0;
      mp.setMarkers(
        markers
          .map((mk) => ({
            time: toTime(mk.t, date, false, mk.d),
            position: "aboveBar" as const,
            color: mk.bias === "bull" ? "#34d399" : mk.bias === "bear" ? "#f87171" : "#fbbf24",
            shape: mk.bias === "bull" ? ("arrowUp" as const) : mk.bias === "bear" ? ("arrowDown" as const) : ("circle" as const),
          }))
          .filter((mk) => mk.time >= firstTime),
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
      <div
        ref={wrapRef}
        className="min-h-0 w-full flex-1"
        onDoubleClick={onChartDoubleClick}
        onWheel={() => {
          userTouchedRef.current = true;
        }}
        onPointerDown={() => {
          userTouchedRef.current = true;
        }}
      />
      <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="mr-1 text-zinc-600">window</span>
          {WINDOWS.map((w) => {
            const isDay = w.bars === Infinity;
            const active = isDay ? windowBars >= minutes.length && minutes.length > 240 : windowBars === w.bars;
            return (
              <button
                key={w.label}
                onClick={() => applyWindow(w.bars)}
                title={isDay ? "the whole collected session (scroll left to page back from any smaller window)" : `show the most recent ${w.label}`}
                className={`rounded border px-1.5 py-0.5 transition-colors ${
                  active ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-panel text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {w.label}
              </button>
            );
          })}
          <span className="mx-1 h-3 w-px bg-zinc-700" />
          <button
            onClick={toggleCenter}
            title="center = pin a 50-pt band around the last price while the live edge is visible, so candle size stays constant and price sits mid-pane (off = fit the visible bars exactly)"
            className={`rounded border px-1.5 py-0.5 transition-colors ${
              center ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-panel text-zinc-500 hover:text-zinc-300"
            }`}
          >
            center
          </button>
        </span>
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
          LVN = colored bands, one label per zone · zoom the price axis in to reveal older profiles (P1→P5) progressively · center = constant candle size around the live price (off = fit visible bars) · double-click the price axis = refit & re-center · double-click the time axis = reset the zoom · scroll = zoom · drag = pan · POC = solid thick · VAH/VAL = dashed
        </span>
      </div>
    </div>
  );
}
