/* ------------------------------------------------------------------ *
 * liveReads — the per-strategy LIVE READ behind the dashboard's
 * "live signal board".
 *
 * WHY THIS EXISTS (the one-line answer to "why only the reversal had a
 * read"): the reversal composer (signalEngine.computeSignal) recomputes
 * a FULL state every cycle — boxes, votes, ingredients, the card gate —
 * whether or not anything fires, so /api/signal has always had a
 * standing "read" to render. The direct detectors (momentum flush +
 * expansion, RTH, open drive) are edge detectors: they produce output
 * only on the just-completed bar when every condition aligns. Between
 * fires they leave nothing behind, so the dashboard had no per-strategy
 * read to show. This module builds that missing standing read for EVERY
 * strategy from the same inputs the feed itself consumes:
 *
 *   · FIRE truth  — the same memoized detectors the tick loop runs
 *     (lib/detectorCache.ts), on the same footprint, same revision:
 *     the read can never disagree with what actually trades.
 *   · INGREDIENT gauges — the just-closed bar's measured inputs against
 *     the same PROD config objects the detectors consume (MOM_PROD /
 *     EXP_PROD / SOFT_PROD / OPEN_PROD), read live, never copied, so
 *     thresholds cannot drift from the code (registry rule 2).
 *   · ARMED state — the two genuine transient states the feed keeps
 *     (expansion retrace pending, unusual-volume pullback watch).
 *   · GATES — news blackout, signal window, trading halt, tape source,
 *     active strategy_overrides.
 *
 * DISPLAY-ONLY, BY CONSTRUCTION: nothing here can fire, send, size or
 * gate a trade. It runs from the /api/signal route on request (never
 * from the dispatch tick), and it reads the two private armed-state
 * fields of the SignalFeed class through ONE documented cast below, so
 * this module never needs a live-execution change-gate tag
 * (web/EXEC_CHANGE_POLICY.md §2). Both cast fields are null-checked:
 * a future rename degrades to "no armed state shown", never to a wrong
 * read and never to a crash.
 * ------------------------------------------------------------------ */

import { getLive } from "./live";
import {
  cachedFootprint,
  detectMomentumMemo,
  detectExpansionScalpMemo,
  detectSoftMomentumMemo,
  detectOpenDriveMemo,
} from "./detectorCache";
import { MOM_PROD, EXP_PROD, type MomentumSignal } from "./momentum";
import { SOFT_PROD, inRTH } from "./softMomentum";
import { OPEN_PROD } from "./openDrive";
import { tailOrJustClosedBar } from "./signalFeed";
import type { FootprintMinute } from "./gcdata";
import type { SignalHistoryEntry } from "./signalHistory";
import { newsBlockedNow } from "./newsGate";
import { signalWindowOpen } from "./marketHours";
import { tradingHalted } from "./tradingHalt";
import { getOverrides } from "./strategyOverrides";
import { cdtToET } from "./times";
import { strategyById, labelFor } from "./strategies/registry";
import { canonicalFamily } from "./strategies/aliases";

/* ------------------------------ types ------------------------------ */

export type GaugeState = "pass" | "fail" | "info" | "na";

export type LiveGauge = {
  key: string;
  label: string;
  /** the measured value, human-readable */
  value: string;
  /** the threshold the detector compares it against */
  need: string;
  state: GaugeState;
  note?: string;
};

export type ArmedNote = {
  /** which board tab owns this armed state ("gates" = shown in the header strip only) */
  tab: "flush" | "expansion" | "rth" | "open" | "gates";
  text: string;
  hot: boolean;
};

export type DetectorRead = {
  /** registry StrategyId */
  id: string;
  label: string;
  status: "live" | "off" | "retired";
  feedOn: boolean;
  window: { open: boolean; note: string };
  tape: { live: boolean; note: string };
  tail: { timeET: string; day: string; price: number } | null;
  /** the detector fires on the just-closed bar RIGHT NOW (same function the feed trades) */
  firedNow: { dir: "long" | "short"; entry: number; stop: number; target: number; kind: string } | null;
  todayCount: number;
  lastFire: { timeET: string; dir: string; outcome: string } | null;
  gapBars: number | null;
  gauges: LiveGauge[];
  armed: ArmedNote[];
};

export type GateRow = {
  label: string;
  state: "ok" | "block" | "info";
  text: string;
};

export type LiveReads = {
  asOf: { timeET: string; day: string; price: number; live: boolean; note: string } | null;
  detectors: DetectorRead[];
  gates: GateRow[];
  /** armed states that matter right now, regardless of tab — the board's header strip */
  hotArmed: ArmedNote[];
};

/* --------------------------- bar metrics --------------------------- */

/** median of the numbers (detector definition: upper-median on sort) */
export function medOf(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export type TailMetrics = {
  idx: number;
  m: FootprintMinute;
  vol: number;
  buyFrac: number;
  med60: number;
  atr14: number;
  range: number;
  rangeR: number;
  deltaFrac: number;
  domBuy: number;
  domSell: number;
  /** max(floor, min(mult × med60, capAbs)) — the momentum/expansion volume gate */
  volGateNeed: number;
};

/** the just-closed bar's raw inputs, computed with the same definitions
 *  the detectors use (buy ÷ (buy+sell), median of the trailing 60 bars'
 *  volume, ATR14 = median of the previous 14 ranges, dominant rows =
 *  ≥3 lots and ≥2× the opposite side). Pure — exported for tests. */
export function tailMetrics(fp: FootprintMinute[]): TailMetrics | null {
  const n = fp.length;
  if (!n) return null;
  const idx = n - 1;
  const m = fp[idx];
  const vol = m.buy + m.sell;
  const buyFrac = vol > 0 ? m.buy / vol : 0.5;
  const med60 = medOf(fp.slice(Math.max(0, idx - 60), idx).map((x) => x.buy + x.sell));
  const atr14 = medOf(fp.slice(Math.max(0, idx - 14), idx).map((x) => x.high - x.low));
  const range = m.high - m.low;
  const rangeR = range / Math.max(0.25, atr14);
  const deltaFrac = vol > 0 ? Math.abs(m.buy - m.sell) / vol : 0;
  let domBuy = 0;
  let domSell = 0;
  for (const l of m.levels) {
    if (l.buy >= 3 && l.buy >= 2 * l.sell) domBuy++;
    if (l.sell >= 3 && l.sell >= 2 * l.buy) domSell++;
  }
  const volGateNeed = Math.max(15, Math.min(0.5 * med60, 250));
  return { idx, m, vol, buyFrac, med60, atr14, range, rangeR, deltaFrac, domBuy, domSell, volGateNeed };
}

const pct = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;
const f2 = (x: number) => (Number.isFinite(x) ? x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");

/* --------------------------- gauge builders --------------------------- */
/* Each builder reads its thresholds LIVE from the strategy's PROD
 * config object — the same object the detector consumes — so a
 * threshold shown here can never disagree with the code that trades. */

export function flushGauges(fp: FootprintMinute[], g: TailMetrics, fired: MomentumSignal[]): LiveGauge[] {
  const cfg = MOM_PROD;
  const tail = g.m;
  const gap = gapSince(fired, fp.length - 1);
  return [
    {
      key: "window",
      label: "hour filter",
      value: inRTH(tail.t) ? "RTH hours" : "globex",
      need: "globex only (9:30–16:00 ET excluded)",
      state: inRTH(tail.t) ? "fail" : "pass",
      note: inRTH(tail.t) ? "detector inert until 16:00 — RTH bars are the RTH strategy's tape" : undefined,
    },
    {
      key: "gap",
      label: "bars since last flush fire",
      value: gap === null ? "—" : String(gap),
      need: `≥ ${cfg.minGapBars}`,
      state: gap === null || gap >= cfg.minGapBars ? "pass" : "fail",
    },
    {
      key: "frac",
      label: "tail one-sidedness",
      value: pct(g.buyFrac),
      need: `≤ ${pct(cfg.flushFrac)} flush · ≥ ${pct(cfg.breakFrac)} breakout`,
      state: g.buyFrac <= cfg.flushFrac || g.buyFrac >= cfg.breakFrac ? "pass" : "info",
      note: "inputs on the just-closed bar — the flush→breakout sequence decides the fire",
    },
    {
      key: "vol",
      label: "tail volume",
      value: `${f2(g.vol)} ct (med60 ${f2(g.med60)})`,
      need: `≥ ${f2(g.volGateNeed)}`,
      state: g.vol >= g.volGateNeed ? "pass" : "fail",
    },
    {
      key: "range",
      label: "tail candle size",
      value: `${g.rangeR.toFixed(2)} × ATR14 (ATR ${f2(g.atr14)})`,
      need: `≥ ${cfg.minBreakRangeR} × ATR14`,
      state: g.rangeR >= cfg.minBreakRangeR ? "pass" : "fail",
    },
    {
      key: "stack",
      label: "tail cluster stack",
      value: `buy ${g.domBuy} · sell ${g.domSell} rows`,
      need: "breakout stack must not oppose the trade",
      state: "info",
    },
  ];
}

export function expansionGauges(fp: FootprintMinute[], g: TailMetrics, fired: MomentumSignal[]): LiveGauge[] {
  const cfg = EXP_PROD;
  const tail = g.m;
  const gap = gapSince(fired, fp.length - 1);
  const stackRows = Math.max(g.domBuy, g.domSell);
  return [
    {
      key: "window",
      label: "hour filter",
      value: inRTH(tail.t) ? "RTH hours" : "globex",
      need: "globex only",
      state: inRTH(tail.t) ? "fail" : "pass",
    },
    {
      key: "range",
      label: "tail candle size",
      value: `${g.rangeR.toFixed(2)} × ATR14 (ATR ${f2(g.atr14)})`,
      need: `≥ ${cfg.minRangeR} × ATR14`,
      state: g.rangeR >= cfg.minRangeR ? "pass" : "fail",
    },
    {
      key: "delta",
      label: "tail one-sided delta",
      value: pct(g.deltaFrac),
      need: `≥ ${pct(cfg.minAbsDeltaFrac)}`,
      state: g.deltaFrac >= cfg.minAbsDeltaFrac ? "pass" : "fail",
    },
    {
      key: "stack",
      label: "tail cluster stack",
      value: `buy ${g.domBuy} · sell ${g.domSell}`,
      need: cfg.requireStack ? "≥ 3 dominant rows on the trade side" : "off",
      state: !cfg.requireStack ? "info" : stackRows >= 3 ? "pass" : "fail",
    },
    {
      key: "vol",
      label: "tail volume",
      value: `${f2(g.vol)} ct (med60 ${f2(g.med60)})`,
      need: `≥ ${f2(g.volGateNeed)}`,
      state: g.vol >= g.volGateNeed ? "pass" : "fail",
    },
    {
      key: "gap",
      label: "bars since last expansion fire",
      value: gap === null ? "—" : String(gap),
      need: `≥ ${cfg.minGapBars}`,
      state: gap === null || gap >= cfg.minGapBars ? "pass" : "fail",
    },
  ];
}

export function rthGauges(fp: FootprintMinute[], g: TailMetrics, fired: MomentumSignal[]): LiveGauge[] {
  const cfg = SOFT_PROD;
  const tail = g.m;
  const gap = gapSince(fired, fp.length - 1);
  const close = tail.c > 0 ? tail.c : (tail.high + tail.low) / 2;
  const dir: "long" | "short" = g.buyFrac >= 0.5 ? "long" : "short";
  const stop = dir === "long" ? tail.low - cfg.stopPad : tail.high + cfg.stopPad;
  const risk = dir === "long" ? close - stop : stop - close;
  return [
    {
      key: "window",
      label: "RTH window",
      value: inRTH(tail.t) ? "inside 9:30–16:00" : "outside",
      need: "RTH only",
      state: inRTH(tail.t) ? "pass" : "fail",
    },
    {
      key: "frac",
      label: "tail one-sidedness",
      value: pct(g.buyFrac),
      need: `≥ ${pct(cfg.minBuyFrac)} long · ≤ ${pct(1 - cfg.minBuyFrac)} short`,
      state: g.buyFrac >= cfg.minBuyFrac || g.buyFrac <= 1 - cfg.minBuyFrac ? "pass" : "fail",
    },
    {
      key: "vol",
      label: "tail volume",
      value: `${f2(g.vol)} ct (med60 ${f2(g.med60)})`,
      need: `≥ ${cfg.volMedMult} × med60`,
      state: g.vol >= cfg.volMedMult * g.med60 ? "pass" : "fail",
    },
    {
      key: "clusters",
      label: "footprint proof",
      value: `buy ${g.domBuy} · sell ${g.domSell} dominant rows`,
      need: `≥ ${cfg.minClusters} on the trade side`,
      state: Math.max(g.domBuy, g.domSell) >= cfg.minClusters ? "pass" : "fail",
    },
    {
      key: "range",
      label: "tail candle size",
      value: `${g.rangeR.toFixed(2)} × ATR14 (ATR ${f2(g.atr14)})`,
      need: `≥ ${cfg.minRangeR} × ATR14`,
      state: g.rangeR >= cfg.minRangeR ? "pass" : "fail",
    },
    {
      key: "risk",
      label: "bracket risk (dominant side)",
      value: `${risk.toFixed(2)} pts (${dir})`,
      need: `${cfg.minRiskPts}–${cfg.maxRiskPts} pts`,
      state: risk >= cfg.minRiskPts && risk <= cfg.maxRiskPts ? "pass" : "fail",
    },
    {
      key: "gap",
      label: "bars since last RTH fire",
      value: gap === null ? "—" : String(gap),
      need: `≥ ${cfg.minGapBars}`,
      state: gap === null || gap >= cfg.minGapBars ? "pass" : "fail",
    },
  ];
}

/** first bar of the 9:30 open (feed-clock hour 8:30) — same search the
 *  open-drive detector makes */
export function openStartIdx(fp: FootprintMinute[]): number {
  for (let i = 0; i < fp.length; i++) {
    const h = (Number(fp[i].t.slice(0, 2)) + 1) % 24;
    const mm = Number(fp[i].t.slice(3, 5));
    if (h === 9 && mm >= 30) return i;
  }
  return -1;
}

export function openGauges(fp: FootprintMinute[], g: TailMetrics, fired: MomentumSignal[]): LiveGauge[] {
  const cfg = OPEN_PROD;
  const i0 = openStartIdx(fp);
  const tail = g.m;
  const out: LiveGauge[] = [];
  const h = (Number(tail.t.slice(0, 2)) + 1) % 24;
  const mm = Number(tail.t.slice(3, 5));
  const preOpen = h < 9 || (h === 9 && mm < 30);

  if (i0 < 0) {
    out.push({
      key: "window",
      label: "open window",
      value: preOpen ? "before the 9:30 open" : "no 9:30 bar yet",
      need: "9:30–9:59 ET",
      state: "info",
    });
    return out;
  }

  const idx = fp.length - 1;
  const barsLeft = i0 + (cfg.windowMin ?? 30) - idx;
  const windowOpen = idx >= i0 && idx <= i0 + (cfg.windowMin ?? 30);
  out.push({
    key: "window",
    label: "open window",
    value: windowOpen ? `inside · ${Math.max(0, barsLeft)} bars left` : "closed",
    need: "9:30–9:59 ET scan window",
    state: windowOpen ? "pass" : "fail",
  });

  let cumS = 0;
  for (let k = i0; k <= idx; k++) cumS += fp[k].buy - fp[k].sell;
  out.push({
    key: "cumd",
    label: "cumulative delta since 9:30",
    value: `${cumS >= 0 ? "+" : ""}${cumS}`,
    need: `≥ +${cfg.cumDeltaFloor} or ≤ −${cfg.cumDeltaFloor}`,
    state: Math.abs(cumS) >= (cfg.cumDeltaFloor ?? 300) ? "pass" : "fail",
  });

  let priorHi = -Infinity;
  let priorLo = Infinity;
  for (let k = i0; k < idx; k++) {
    priorHi = Math.max(priorHi, fp[k].high);
    priorLo = Math.min(priorLo, fp[k].low);
  }
  const newExtreme = tail.high > priorHi || tail.low < priorLo;
  out.push({
    key: "extreme",
    label: "new opening extreme",
    value: newExtreme ? "tail prints a new extreme" : "no new extreme",
    need: "high > prior window high (mirror for lows)",
    state: newExtreme ? "pass" : "info",
  });

  out.push({
    key: "frac",
    label: "tail one-sidedness",
    value: pct(g.buyFrac),
    need: `≥ ${pct(cfg.minBuyFrac)} long · ≤ ${pct(1 - cfg.minBuyFrac)} short`,
    state: g.buyFrac >= cfg.minBuyFrac || g.buyFrac <= 1 - cfg.minBuyFrac ? "pass" : "fail",
  });

  out.push({
    key: "fired",
    label: "drive fired today",
    value: fired.length > 0 ? `yes · ${fired[0].dir} @ ${fired[0].t} UTC` : "not yet",
    need: "first backed extreme wins; one card per day",
    state: "info",
  });
  return out;
}

/* ------------------------- armed-state cast ------------------------- */
/* The ONE place this module touches SignalFeed private state. See the
 * header comment: display-only, null-checked, never writes. */

type PendingRetraceRead = {
  key: string;
  day: string;
  dir: "long" | "short";
  level: number;
  armedIdx: number;
  maxIdx: number;
  sEntry: number;
  sStop: number;
  sTarget: number;
  risk: number;
  fixed: number;
  riskBudget: number;
  scaleOut: boolean;
  t: string;
  aPlus: boolean;
  firstToday: boolean;
  et: string;
  features: Record<string, unknown>;
} | null;

type PullbackWatchRead = {
  side: "long" | "short";
  high: number;
  low: number;
  armedIdx: number;
  armedAt: number;
  started: boolean;
  startIdx: number;
  pullExtreme: number;
} | null;

type FeedSurface = {
  expRetracePending: PendingRetraceRead;
  pullbackWatch: PullbackWatchRead;
};

export function armedNotes(feed: unknown, fpLen: number, lastPrice: number): ArmedNote[] {
  const f = feed as FeedSurface;
  const out: ArmedNote[] = [];
  const p = f?.expRetracePending ?? null;
  if (p) {
    const barsLeft = Math.max(0, p.maxIdx - (fpLen - 1));
    const dist = Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice - p.level : null;
    out.push({
      tab: "expansion",
      hot: true,
      text:
        `EXPANSION RETRACE ARMED — ${p.dir.toUpperCase()} limit ${f2(p.level)}` +
        ` (signal ${f2(p.sEntry)} · ${p.et} NY) · ${barsLeft} bar${barsLeft === 1 ? "" : "s"} left` +
        (dist !== null ? ` · tape ${dist >= 0 ? "+" : "−"}${Math.abs(dist).toFixed(2)} pts away` : ""),
    });
  }
  const w = f?.pullbackWatch ?? null;
  if (w) {
    out.push({
      tab: "gates",
      hot: false,
      text:
        `PULLBACK WATCH — after the unusual ${w.side.toUpperCase()} volume bar · ` +
        `${w.started ? "pullback started" : "waiting for the first aggressive counter bar"} · watching ${f2(w.pullExtreme)}`,
    });
  }
  return out;
}

/* ---------------------------- fire truth ---------------------------- */

/** bars between the tail and the family's most recent detector fire
 *  (null = this family has never fired this session) */
export function gapSince(fired: MomentumSignal[], tailIdx: number): number | null {
  let last = -1;
  for (const s of fired) {
    if (s.breakIdx < tailIdx && s.breakIdx > last) last = s.breakIdx;
  }
  return last >= 0 ? tailIdx - last : null;
}

/** the signal on the just-closed bar, if the detector fires right now */
export function firedNow(fired: MomentumSignal[], fp: FootprintMinute[]): DetectorRead["firedNow"] {
  const n = fp.length;
  if (!n) return null;
  for (const s of fired) {
    if (s.breakIdx === n - 1 && tailOrJustClosedBar(fp, s.breakIdx)) {
      return { dir: s.dir, entry: s.entry, stop: s.stop, target: s.target, kind: s.kind };
    }
  }
  return null;
}

/* --------------------------- history mapping --------------------------- */

const FAMILY_KEYS: Record<string, string[]> = {
  failed_flush_breakout: ["failed_flush_breakout", "momentum_flush", "momentum_bigbar"],
  huge_bar_expansion: ["huge_bar_expansion", "momentum_expansion"],
  session_continuation: ["session_continuation", "rth"],
  open_drive: ["open_drive", "open_pullback", "open_sniper"],
};

function familyOf(h: SignalHistoryEntry): string | null {
  const f = h.features as { family?: string } | null;
  if (f?.family) return canonicalFamily(f.family);
  // fallback for rows recorded before the family stamp
  const v = h.verdict;
  if (v.includes("session continuation") || v.includes("rth")) return "session_continuation";
  if (v.includes("huge-bar expansion")) return "huge_bar_expansion";
  if (v.includes("failed-flush") || v.includes("big-bar") || v.includes("momentum")) return "failed_flush_breakout";
  if (v.includes("open")) return "open_drive";
  return null;
}

function historyFor(history: SignalHistoryEntry[], keys: string[], today: string | undefined): {
  todayCount: number;
  lastFire: DetectorRead["lastFire"];
} {
  const todayRows = history.filter((h) => (today ? h.day === today : true) && keys.includes(familyOf(h) ?? ""));
  const last = todayRows[0] ?? null;
  return {
    todayCount: todayRows.length,
    lastFire: last
      ? {
          timeET: last.timeET,
          dir: last.side,
          outcome: last.outcome?.outcome ?? "",
        }
      : null,
  };
}

/* ---------------------------- the read ---------------------------- */

type BuildArgs = {
  feed: unknown;
  history: SignalHistoryEntry[];
  /** the FEED_* flags as served by /api/signal (feeds map) */
  feeds: Record<string, boolean>;
};

export async function computeLiveReads(args: BuildArgs): Promise<LiveReads> {
  const live = getLive().state;
  const fp = cachedFootprint(live.minutes, live.barsRevision);
  const rev = live.barsRevision;
  const n = fp.length;
  const feeds = args.feeds ?? {};

  if (!n) {
    return {
      asOf: { timeET: "—", day: "—", price: 0, live: live.connected, note: "no live bars yet" },
      detectors: [],
      gates: [
        { label: "signal window", state: "info", text: signalWindowOpen(Date.now()) ? "open" : "closed" },
        { label: "tape", state: "info", text: live.connected ? "connected — no bars yet" : "tick feed not connected" },
      ],
      hotArmed: [],
    };
  }

  const tail = fp[n - 1];
  const g = tailMetrics(fp);
  const timeET = cdtToET(tail.t);
  const day = tail.d ?? "";
  const price = live.snapshot?.ltp ?? tail.c ?? tail.high ?? 0;

  // fire truth from the SAME memoized detectors the tick loop runs —
  // same footprint, same revision, zero drift by construction
  const momSigs = detectMomentumMemo(fp, MOM_PROD, rev);
  const expSigs = detectExpansionScalpMemo(fp, EXP_PROD, rev);
  const rthSigs = detectSoftMomentumMemo(fp, SOFT_PROD, rev);
  const openSigs = detectOpenDriveMemo(fp, OPEN_PROD, rev);
  const flushSigs = momSigs.filter((s) => s.kind === "flush");

  const armed = armedNotes(args.feed, n, price);
  const byTab = (tab: ArmedNote["tab"]) => armed.filter((a) => a.tab === tab);

  const detector = (
    id: "failed_flush_breakout" | "huge_bar_expansion" | "session_continuation" | "open_drive",
    sigs: MomentumSignal[],
    gauges: LiveGauge[],
    window: { open: boolean; note: string },
    feedOn: boolean,
  ): DetectorRead => {
    const decl = strategyById(id);
    const hist = historyFor(args.history, FAMILY_KEYS[id], day);
    return {
      id,
      label: decl ? labelFor(decl) : id,
      status: decl?.status ?? "live",
      feedOn,
      window,
      tape: {
        live: live.connected,
        note: live.connected
          ? `tail source ${tail.src ?? "tick"} · ${live.minutes.length} live minutes`
          : "tick feed not connected",
      },
      tail: { timeET, day, price },
      firedNow: firedNow(sigs, fp),
      todayCount: hist.todayCount,
      lastFire: hist.lastFire,
      gapBars: gapSince(sigs, n - 1),
      gauges,
      armed: byTab(id === "huge_bar_expansion" ? "expansion" : id === "failed_flush_breakout" ? "flush" : id === "session_continuation" ? "rth" : "open"),
    };
  };

  const detectors: DetectorRead[] = [
    detector("failed_flush_breakout", flushSigs, g ? flushGauges(fp, g, flushSigs) : [], {
      open: !inRTH(tail.t),
      note: inRTH(tail.t) ? "RTH hours — flush detector inert (its tape is globex)" : "globex window open",
    }, feeds.momentum === true),
    detector("huge_bar_expansion", expSigs, g ? expansionGauges(fp, g, expSigs) : [], {
      open: !inRTH(tail.t),
      note: inRTH(tail.t) ? "RTH hours — expansion detector inert (its tape is globex)" : "globex window open",
    }, feeds.momentum === true),
    detector("session_continuation", rthSigs, g ? rthGauges(fp, g, rthSigs) : [], {
      open: inRTH(tail.t),
      note: inRTH(tail.t) ? "inside 9:30–16:00 ET" : "outside RTH — detector inert",
    }, feeds.rth === true),
    detector("open_drive", openSigs, g ? openGauges(fp, g, openSigs) : [], {
      open: (() => {
        const i0 = openStartIdx(fp);
        if (i0 < 0) return false;
        return n - 1 <= i0 + (OPEN_PROD.windowMin ?? 30);
      })(),
      note: "9:30–9:59 ET scan window",
    }, feeds.open === true && feeds.openDrive === true),
  ];

  // gates
  const now = Date.now();
  const nb = newsBlockedNow(now);
  const gates: GateRow[] = [];
  gates.push({
    label: "news blackout",
    state: nb ? "block" : "ok",
    text: nb ?? "no release window active",
  });
  gates.push({
    label: "signal window",
    state: signalWindowOpen(now) ? "ok" : "block",
    text: signalWindowOpen(now)
      ? "open — cards can fire"
      : "closed — Sunday 18:00 → Friday 16:00 NY · daily 16:00–18:00 halt",
  });
  gates.push({
    label: "trading halt",
    state: tradingHalted() ? "block" : "ok",
    text: tradingHalted() ? "KILL SWITCH SET — signals are info-only" : "not set",
  });
  gates.push({
    label: "tape",
    state: live.connected ? "ok" : "block",
    text: live.connected
      ? `connected · tail bar ${tail.t} UTC source ${tail.src ?? "tick"}`
      : "tick feed not connected",
  });
  try {
    const ov = await getOverrides();
    gates.push({
      label: "strategy_overrides",
      state: ov.length ? "info" : "ok",
      text: ov.length ? ov.map((o) => `${o.family}.${o.gate}`).join(" · ") : "no active overrides",
    });
  } catch {
    gates.push({ label: "strategy_overrides", state: "info", text: "unreadable (best-effort)" });
  }

  return {
    asOf: {
      timeET,
      day,
      price,
      live: live.connected,
      note: live.connected ? "live" : "feed idle",
    },
    detectors,
    gates,
    hotArmed: armed.filter((a) => a.hot),
  };
}
