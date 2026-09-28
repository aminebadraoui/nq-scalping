/* ------------------------------------------------------------------ *
 * Pullback / trend-continuation signal.
 *
 * The reversal mechanism (lib/mechanism.ts) fades a failed break of an
 * extreme — by construction it CANNOT buy a higher low in an uptrend,
 * because the session low never gets broken. This module is the other
 * half of the tape: the trend-continuation entry.
 *
 *   TREND    is the bias: price above/below the session VWAP.
 *   RETEST   is the location: price pulled back to a support/resistance
 *            reference (a recent pivot low/high, VWAP, or the nearest POC).
 *   TRIGGER  is the entry: a fresh footprint stack of the matching side
 *            (buyers/sellers stepping in at the retest).
 *
 * All three must be "yes" together — the same "required pieces" philosophy
 * as the reversal, applied to the trend rather than to the fade.
 * ------------------------------------------------------------------ */

import type { ImbalanceRollup } from "./gcdata";

export type PullbackIngredient = {
  key: "trend" | "retest" | "trigger";
  n: string;
  name: string;
  role: "required";
  state: "yes" | "partial" | "no";
  short: string;
  value: string;
  why: string;
};

export type PullbackRead = {
  side: "long" | "short" | null;
  tone: "long" | "short" | "neutral" | "forming";
  verdict: string;
  headline: string;
  narrative: string;
  ingredients: PullbackIngredient[];
  present: number;
  missing: string[];
  trigger: string;
  invalidation: string;
  target: string;
  asOf: string;
  live: boolean;
  /** numeric trade levels for backtesting / tooling (NaN when not established) */
  entryPx: number;
  stopPx: number;
  targetPx: number;
};

export type PullbackInput = {
  /** visible minutes, chronological; `t` is "HH:mm" in the feed clock */
  minutes: { t: string; high: number; low: number; delta: number }[];
  lastPrice: number;
  vwap: number;
  poc: { label: string; p: number } | null;
  sessionHigh: number;
  sessionLow: number;
  imbalance: ImbalanceRollup | null;
  newsWin: boolean;
};

const PB_NEAR = 3; // pts — retest tolerance to a support/resistance
const PIVOT_LOOKBACK = 20; // bars — how far back a swing still counts as "recent"
const STACK_AGE = 3; // bars — how fresh the footprint entry must be

function fmt(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export type PullbackPre = {
  indexOf?: Map<string, number>;
  pivLows?: { t: string; price: number; idx: number }[];
  pivHighs?: { t: string; price: number; idx: number }[];
};

export function readPullback(inp: PullbackInput, pbNear: number = PB_NEAR, pre?: PullbackPre): PullbackRead {
  const { minutes, lastPrice, vwap, poc, sessionHigh, sessionLow, imbalance, newsWin } = inp;
  const n = minutes.length;
  const price = lastPrice > 0 ? lastPrice : minutes[n - 1]?.high ?? 0;

  const base: PullbackRead = {
    side: null,
    tone: "neutral",
    verdict: "NO PULLBACK — not enough bars in the visible window",
    headline: "no trend-continuation setup",
    narrative: "no bars to locate a pullback against.",
    ingredients: [],
    present: 0,
    missing: [],
    trigger: "no bars in the visible window yet — nothing to trigger",
    invalidation: "no retest level yet — no invalidation, no trade",
    target: poc ? `${poc.label} ${fmt(poc.p)} · ${fmt(Math.abs(poc.p - price))} pts away` : "no POC loaded",
    asOf: minutes[n - 1]?.t ?? "—",
    live: false,
    entryPx: price,
    stopPx: NaN,
    targetPx: poc ? poc.p : NaN,
  };
  if (n < 5 || price <= 0) return base;

  const idx = pre?.indexOf ?? new Map(minutes.map((m, i) => [m.t, i] as const));
  const ageOf = (t: string) => {
    const i = idx.get(t);
    // i > n - 1 = an event AFTER this window (only possible with a precomputed
    // full-session index, e.g. the backtest) — treat as not present
    return i === undefined || i > n - 1 ? null : n - 1 - i;
  };

  /* ---------- pivot swings (±2 bars) ---------- */
  let pivLows: { t: string; price: number }[];
  let pivHighs: { t: string; price: number }[];
  if (pre?.pivLows && pre.pivHighs) {
    // precomputed over the full session — keep only those that are a valid
    // pivot inside this prefix (need two bars after them)
    pivLows = pre.pivLows.filter((p) => p.idx <= n - 3).map((p) => ({ t: p.t, price: p.price }));
    pivHighs = pre.pivHighs.filter((p) => p.idx <= n - 3).map((p) => ({ t: p.t, price: p.price }));
  } else {
    const lows = minutes.map((m) => m.low);
    const highs = minutes.map((m) => m.high);
    pivLows = [];
    pivHighs = [];
    for (let i = 2; i < n - 2; i++) {
      if (lows[i] < Math.min(lows[i - 1], lows[i - 2], lows[i + 1], lows[i + 2])) pivLows.push({ t: minutes[i].t, price: lows[i] });
      if (highs[i] > Math.max(highs[i - 1], highs[i - 2], highs[i + 1], highs[i + 2])) pivHighs.push({ t: minutes[i].t, price: highs[i] });
    }
  }
  const recentPivLow = [...pivLows].reverse().find((p) => (ageOf(p.t) ?? 999) <= PIVOT_LOOKBACK) ?? null;
  const recentPivHigh = [...pivHighs].reverse().find((p) => (ageOf(p.t) ?? 999) <= PIVOT_LOOKBACK) ?? null;

  /* ---------- trend: above/below the session VWAP ---------- */
  const aboveVwap = vwap > 0 && price > vwap;
  const belowVwap = vwap > 0 && price < vwap;

  /* ---------- retest references ---------- */
  const supports = [recentPivLow?.price, vwap, poc?.p].filter((x): x is number => Number.isFinite(x));
  const resistances = [recentPivHigh?.price, vwap, poc?.p].filter((x): x is number => Number.isFinite(x));
  const nearest = (xs: number[]) => (xs.length ? xs.reduce((a, b) => (Math.abs(b - price) < Math.abs(a - price) ? b : a)) : NaN);
  const nearestSupport = nearest(supports);
  const nearestResistance = nearest(resistances);
  const retestLong = Number.isFinite(nearestSupport) && Math.abs(price - nearestSupport) <= pbNear;
  const retestShort = Number.isFinite(nearestResistance) && Math.abs(price - nearestResistance) <= pbNear;

  /* ---------- trigger: fresh footprint stack of the matching side ---------- */
  const lastStack = imbalance?.lastStack ?? null;
  const stackAge = lastStack ? ageOf(lastStack.t) : null;
  const buyStack = lastStack?.side === "buy" && stackAge !== null && stackAge <= STACK_AGE;
  const sellStack = lastStack?.side === "sell" && stackAge !== null && stackAge <= STACK_AGE;

  /* ---------- side ---------- */
  let side: "long" | "short" | null = null;
  if (aboveVwap && retestLong && buyStack) side = "long";
  else if (belowVwap && retestShort && sellStack) side = "short";

  const trend: PullbackIngredient = {
    key: "trend",
    n: "1",
    name: "Trend",
    role: "required",
    state: aboveVwap || belowVwap ? "yes" : "no",
    short: aboveVwap ? `above VWAP ${fmt(vwap)} — uptrend` : belowVwap ? `below VWAP ${fmt(vwap)} — downtrend` : "no VWAP reference",
    value:
      aboveVwap || belowVwap
        ? `price ${aboveVwap ? "above" : "below"} the session VWAP ${fmt(vwap)} — the ${aboveVwap ? "long" : "short"} bias of a trend-continuation trade`
        : "no session VWAP loaded, so no trend bias can be established",
    why: "a pullback is only tradeable WITH the trend; VWAP is the session's average price, so which side of it you are on is the regime.",
  };

  const retest: PullbackIngredient = {
    key: "retest",
    n: "2",
    name: "Retest",
    role: "required",
    state: retestLong || retestShort ? "yes" : "no",
    short: retestLong
      ? `at support ${fmt(nearestSupport)}`
      : retestShort
        ? `at resistance ${fmt(nearestResistance)}`
        : `support ${fmt(nearestSupport)} · resistance ${fmt(nearestResistance)}`,
    value:
      retestLong || retestShort
        ? `price has pulled back to within ${pbNear} pts of ${retestLong ? `support ${fmt(nearestSupport)}` : `resistance ${fmt(nearestResistance)}`} (recent pivot / VWAP / POC)`
        : `nearest support ${fmt(nearestSupport)} and resistance ${fmt(nearestResistance)} are farther than ${pbNear} pts — no retest yet`,
    why: "the entry is a pullback to a level the trend has already respected — a recent swing, the session average, or the value area POC.",
  };

  const trigger: PullbackIngredient = {
    key: "trigger",
    n: "3",
    name: "Trigger",
    role: "required",
    state: buyStack || sellStack ? "yes" : "no",
    short: lastStack
      ? `${lastStack.side === "buy" ? "buy" : "sell"} stack ×${lastStack.len} @ ${fmt(lastStack.from)}–${fmt(lastStack.to)}${stackAge !== null ? ` · ${stackAge} bars ago` : ""}`
      : "no footprint stack yet",
    value: buyStack || sellStack
      ? `${lastStack!.side === "buy" ? "buyers" : "sellers"} stacked over ${lastStack!.len} ticks at ${fmt(lastStack!.from)}–${fmt(lastStack!.to)} — the entry evidence`
      : "no fresh footprint stack of the matching side — the retest is not yet confirmed",
    why: "a stacked footprint imbalance (3+ consecutive same-side rows) is one side being filled systematically — that is the entry, not a forecast.",
  };

  const ingredients = [trend, retest, trigger];
  const requiredMet = ingredients.filter((i) => i.state === "yes").length;
  const present = requiredMet;
  const missing = ingredients.filter((i) => i.state !== "yes").map((i) => i.name);

  let tone: PullbackRead["tone"] = "neutral";
  let verdict: string;
  if (side) {
    tone = side;
    verdict =
      side === "long"
        ? "PULLBACK LONG — trend + retest + buy footprint (trend continuation)"
        : "PULLBACK SHORT — trend + retest + sell footprint (trend continuation)";
  } else if (requiredMet === 2) {
    tone = "forming";
    const miss = ingredients.find((i) => i.state !== "yes")?.name ?? "";
    verdict = `PULLBACK ${aboveVwap ? "LONG" : belowVwap ? "SHORT" : ""} FORMING — ${miss} is the missing piece`;
  } else {
    tone = "neutral";
    verdict = "NO PULLBACK — no trend-continuation setup";
  }

  const triggerLine =
    side === "long"
      ? `buy the retest of ${fmt(nearestSupport)} — confirm with a buy footprint stack`
      : side === "short"
        ? `sell the retest of ${fmt(nearestResistance)} — confirm with a sell footprint stack`
        : Number.isFinite(nearestSupport) && Number.isFinite(nearestResistance)
          ? `wait for a retest of ${fmt(nearestSupport)} (long) or ${fmt(nearestResistance)} (short) with a footprint stack`
          : "wait for a retest level with a footprint stack";
  const invalidation =
    side === "long"
      ? `a 1-minute close below the retest low ${fmt(nearestSupport)} invalidates the pullback`
      : side === "short"
        ? `a 1-minute close above the retest high ${fmt(nearestResistance)} invalidates the pullback`
        : "no retest level yet — no invalidation, no trade";

  const parts: string[] = [];
  if (aboveVwap) parts.push("price is above VWAP (uptrend)");
  else if (belowVwap) parts.push("price is below VWAP (downtrend)");
  if (retestLong) parts.push(`price has retested support ${fmt(nearestSupport)}`);
  if (retestShort) parts.push(`price has retested resistance ${fmt(nearestResistance)}`);
  if (buyStack) parts.push("a buy-side footprint stack confirms buyers stepping in");
  if (sellStack) parts.push("a sell-side footprint stack confirms sellers stepping in");
  const narrative = parts.length ? parts.join("; then ") + "." : "no trend-continuation sequence detected.";

  return {
    side,
    tone,
    verdict,
    headline: side ? `${side === "long" ? "Long" : "Short"} pullback: ${requiredMet}/3 required` : "No pullback setup",
    narrative,
    ingredients,
    present,
    missing,
    trigger: triggerLine,
    invalidation,
    target: base.target,
    asOf: minutes[n - 1]?.t ?? "—",
    live: false,
    entryPx: price,
    stopPx: side === "long" ? nearestSupport : side === "short" ? nearestResistance : NaN,
    targetPx: poc ? poc.p : NaN,
  };
}
