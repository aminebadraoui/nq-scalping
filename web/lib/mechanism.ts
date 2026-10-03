/* ------------------------------------------------------------------ *
 * Reversal mechanism interpreter.
 *
 * The point of this module: turn the raw detections (absorption, CVD
 * divergence, reclaim, footprint imbalance, location vs LVN/POC) into a
 * single plain-language read of WHAT IS HAPPENING RIGHT NOW, in the
 * causal order a reversal actually happens:
 *
 *   1 LOCATION   where  — a level that can produce a reversal (LVN edge,
 *                         session extreme). Without location nothing else
 *                         matters: absorption mid-range is noise.
 *   2 MECHANISM  who    — absorption: heavy one-sided aggression that did
 *                         NOT move price. Someone with size is standing
 *                         there. This is the cause.
 *   3 FUEL       how much — CVD divergence: the extreme was pushed with
 *                         less aggressive flow than the previous one, so
 *                         there is nothing left to continue it. Symptom.
 *   4 TRIGGER    when   — reclaim: price trades back inside the range it
 *                         just broke. Trapped stops become the fuel for
 *                         the other side. This is the actual entry event.
 *   5 EVIDENCE   footprint — stacked bid x ask imbalance on the reversal
 *                         side (aggressors being filled at a price).
 *   6 CONTEXT    vwap side / news guard — filter, never a reason alone.
 *
 * A reversal is not "predicted"; it is a sequence. This module scores how
 * much of that sequence currently exists, which is falsifiable and can be
 * journalled, instead of a magic signal.
 * ------------------------------------------------------------------ */

import type { ImbSummary, ImbalanceRollup } from "./gcdata";

export type IngredientState = "yes" | "partial" | "no";

export type Ingredient = {
  key: "location" | "mechanism" | "fuel" | "trigger" | "evidence" | "context";
  n: string;
  name: string;
  role: "required" | "support" | "filter";
  state: IngredientState;
  /** one-line scannable status (shown) */
  short: string;
  /** full detail (collapsible) */
  value: string;
  why: string;
};

export type MechanismInput = {
  /** visible minutes, chronological; `t` is "HH:mm" in the feed clock */
  minutes: { t: string; high: number; low: number; delta: number; imb?: ImbSummary | null }[];
  lastPrice: number;
  vwap: number;
  absorption: { t: string; price: number; side: "bid" | "ask"; bias: "bull" | "bear"; volume?: number; imbalance?: number }[];
  alerts: { t: string; kind: string; price: number; bias?: "bull" | "bear" | null }[];
  reclaims: { t: string; price: number; dir: "low" | "high" }[];
  imbalance: ImbalanceRollup | null;
  lvnEdges: { label: string; p: number; zone: string }[];
  poc: { label: string; p: number } | null;
  sessionHigh: number;
  sessionLow: number;
  newsWin: boolean;
  /** dealer gamma walls in NQ points: call = resistance, put = support,
   *  flip = regime boundary. Optional — location degrades gracefully when
   *  absent (the boxes stay independent). */
  walls?: { kind: "call" | "put" | "flip"; p: number }[];
};

export type MechanismRead = {
  side: "long" | "short" | null;
  tone: "long" | "short" | "neutral" | "forming";
  verdict: string;
  headline: string;
  narrative: string;
  ingredients: Ingredient[];
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
  /** delta of the last bar — the entry-bar confirmation (positive = aggressive buying) */
  lastDelta: number;
};

const NEAR_EDGE = 2.5; // pts — inside this distance you are "at" the LVN edge
const WALL_NEAR = 20; // pts — a QQQ strike is ~40 NQ points wide, so a wall is a coarse zone
const AGE = { mechanism: 15, fuel: 30, trigger: 10, evidence: 6 }; // bars
/** scalp stop distance in points — the backtest showed the absorption price is
 *  ~78 pts away (untradeable); a tight 5–7 pt stop is where the edge lives */
const SCALP_STOP_PTS = 7;

function fmtN(n: number, dp = 2) {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** The printed sizing line (docs/strategy/STRATEGY.md "The trade, in four lines"):
 *  contracts = risk ÷ (stop distance in pts × $20) — $20 = NQ point value.
 *  Single source of truth: the Telegram card, the checklist panel and the
 *  signal history all render this exact line. */
export function sizeLine(read: { stopPx: number; entryPx: number }): string {
  const pts = Math.abs(read.stopPx - read.entryPx);
  return Number.isFinite(pts) && pts > 0
    ? `contracts = risk ÷ (${pts.toFixed(2)} pts × $20)`
    : `contracts = risk ÷ (${SCALP_STOP_PTS.toFixed(2)} pts × $20)`;
}

export function readMechanism(inp: MechanismInput, indexOf?: Map<string, number>): MechanismRead {
  const { minutes, lastPrice } = inp;
  const n = minutes.length;
  const price = lastPrice > 0 ? lastPrice : minutes[n - 1]?.high ?? 0;
  const idx = indexOf ?? new Map(minutes.map((m, i) => [m.t, i] as const));
  const ageOf = (t: string) => {
    const i = idx.get(t);
    // i > n - 1 = an event AFTER this window (only possible when a precomputed
    // full-session index is passed, e.g. the backtest) — treat as not present
    return i === undefined || i > n - 1 ? null : n - 1 - i;
  };

  /* ---------- side selection: which reversal has evidence ---------- */
  const lastAbs = [...inp.absorption].reverse().find((a) => (ageOf(a.t) ?? 999) <= AGE.mechanism * 2) ?? null;
  const divs = inp.alerts.filter((a) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
  // look back further than AGE.fuel so the "partial" (stale) state is reachable
  const lastDiv = [...divs].reverse().find((a) => (ageOf(a.t) ?? 999) <= AGE.fuel * 2) ?? null;
  const lastRec = [...inp.reclaims].reverse().find((a) => (ageOf(a.t) ?? 999) <= AGE.trigger * 2) ?? null;
  const lastStack = inp.imbalance?.lastStack ?? null;
  const stackAge = lastStack ? ageOf(lastStack.t) : null;
  const stackFresh = stackAge !== null && stackAge <= AGE.evidence;

  // a recent stack counts fully for its side; an older (partial) one counts
  // half — otherwise a 20-bar-old stack reports "nothing is opposing price"
  const stackSideAge = lastStack ? ageOf(lastStack.t) : null;
  const stackPartial = lastStack && stackSideAge !== null && stackSideAge <= AGE.evidence * 4;
  const bull =
    [lastAbs?.bias === "bull", lastDiv?.kind === "DIVERGENCE_D2", lastRec?.dir === "low"].filter(Boolean).length +
    (stackFresh && lastStack?.side === "buy" ? 1 : stackPartial && lastStack?.side === "buy" ? 0.5 : 0);
  const bear =
    [lastAbs?.bias === "bear", lastDiv?.kind === "DIVERGENCE_D4", lastRec?.dir === "high"].filter(Boolean).length +
    (stackFresh && lastStack?.side === "sell" ? 1 : stackPartial && lastStack?.side === "sell" ? 0.5 : 0);
  // ties are resolved by the REQUIRED evidence (who absorbed / what reclaimed);
  // a genuine tie with no such evidence stays neutral instead of silently
  // defaulting to long
  let side: "long" | "short" | null = bull > bear ? "long" : bear > bull ? "short" : null;
  if (side === null && bull > 0) {
    if (lastAbs) side = lastAbs.bias === "bull" ? "long" : "short";
    else if (lastRec) side = lastRec.dir === "low" ? "long" : "short";
  }
  const want = side === "short" ? "bear" : "bull";
  const dirWord = side === "short" ? "down" : "up";

  /* ---------- 1 · LOCATION ---------- */
  const edges = inp.lvnEdges
    .map((e) => ({ ...e, d: Math.abs(e.p - price) }))
    .sort((a, b) => a.d - b.d);
  const edge = edges[0];
  const inZone = inp.lvnEdges.find((e) => {
    const [a, b] = e.zone.split("–").map((s) => parseFloat(s.replace(/,/g, "")));
    return price >= Math.min(a, b) && price <= Math.max(a, b);
  });
  const atExtreme = inp.sessionHigh > 0 && (price <= inp.sessionLow + 2.5 || price >= inp.sessionHigh - 2.5);

  // dealer gamma walls: coarse magnet ZONES (a QQQ strike ≈ 40 NQ points),
  // so they count as PARTIAL location, never the tick-precise "yes" an LVN
  // edge earns. They carry a direction: call wall = resistance, put = support.
  const walls = inp.walls ?? [];
  const nearestWall = walls
    .map((w) => ({ ...w, d: Math.abs(w.p - price) }))
    .sort((a, b) => a.d - b.d)[0];
  const atWall = nearestWall !== undefined && nearestWall.d <= WALL_NEAR;
  const wallWord =
    nearestWall?.kind === "call"
      ? "call wall (dealer resistance)"
      : nearestWall?.kind === "put"
        ? "put wall (dealer support)"
        : nearestWall?.kind === "flip"
          ? "gamma flip"
          : null;

  const atEdge = !!edge && edge.d <= NEAR_EDGE;
  // location "yes" = at OR inside an LVN (the low-volume node). Being in the
  // zone counts fully — the reversal trades the LVN back toward the target.
  const locState: IngredientState = atEdge || inZone ? "yes" : atWall ? "partial" : atExtreme ? "partial" : "no";
  const location: Ingredient = {
    key: "location",
    n: "1",
    name: "Location",
    role: "required",
    state: locState,
    short: atEdge
      ? `at ${edge!.label} LVN edge ${fmtN(edge!.p)}`
      : inZone
        ? `inside ${inZone.label} LVN ${inZone.zone}`
        : atWall
          ? `near ${wallWord} ${fmtN(nearestWall!.p)}`
          : edge
            ? `${fmtN(edge.d)} pts from ${edge.label} LVN edge ${fmtN(edge.p)}`
            : "no LVN levels loaded",
    value: atEdge
      ? `at ${edge!.label} LVN edge ${fmtN(edge!.p)} (zone ${edge!.zone})`
      : inZone
        ? `inside ${inZone.label} LVN zone ${inZone.zone} — reversal targets ${inp.poc ? `${inp.poc.label} ${fmtN(inp.poc.p)}` : "the POC"}`
        : atWall
          ? `within ${WALL_NEAR} pts of the ${wallWord} at ${fmtN(nearestWall!.p)} — a coarse dealer-hedging magnet (zone), not a tick edge`
          : edge
            ? `nearest LVN edge ${fmtN(edge.p)} (${edge.label}) is ${fmtN(edge.d)} pts away`
            : "no LVN levels loaded",
    why: "reversals are made at levels that already rejected price — LVN edges and session extremes from the tape, plus dealer gamma walls (call = resistance, put = support) from the options book. Mid-range absorption is just chop.",
  };

  /* ---------- 2 · MECHANISM (absorption) ---------- */
  const absAge = lastAbs ? ageOf(lastAbs.t) : null;
  const mechState: IngredientState = lastAbs && absAge !== null && absAge <= AGE.mechanism ? "yes" : lastAbs && absAge !== null && absAge <= AGE.mechanism * 2 ? "partial" : "no";
  const mechSideOk = lastAbs ? (want === "bull" ? lastAbs.bias === "bull" : lastAbs.bias === "bear") : false;
  const mechanism: Ingredient = {
    key: "mechanism",
    n: "2",
    name: "Mechanism",
    role: "required",
    state: mechState === "yes" && mechSideOk ? "yes" : mechState === "no" ? "no" : "partial",
    short: lastAbs
      ? `${lastAbs.side === "bid" ? "sell" : "buy"} aggression ${lastAbs.volume ? `${lastAbs.volume.toLocaleString()} ct` : ""} @ ${fmtN(lastAbs.price)}${mechSideOk ? "" : " (wrong side)"}`
      : "no absorption recently",
    value: lastAbs
      ? `${lastAbs.side === "bid" ? "sell" : "buy"} aggression of ${lastAbs.volume ? lastAbs.volume.toLocaleString() : "?"} ct${lastAbs.imbalance !== undefined ? ` (${(lastAbs.imbalance * 100).toFixed(0)}% one-sided)` : ""} at ${fmtN(lastAbs.price)} held${absAge !== null ? ` · ${absAge} bars ago` : ""}${mechSideOk ? "" : " — wrong side for this read"}`
      : "no absorption in the recent window",
    why: "absorption is the CAUSE: size absorbed the aggression at a price and price did not move through it. It is a place, a size and a time — not a forecast.",
  };

  /* ---------- 3 · FUEL (divergence) ---------- */
  const divAge = lastDiv ? ageOf(lastDiv.t) : null;
  const divOk = lastDiv ? (want === "bull" ? lastDiv.kind === "DIVERGENCE_D2" : lastDiv.kind === "DIVERGENCE_D4") : false;
  const fuelState: IngredientState = lastDiv && divAge !== null && divAge <= AGE.fuel && divOk ? "yes" : lastDiv && divOk ? "partial" : "no";
  const fuel: Ingredient = {
    key: "fuel",
    n: "3",
    name: "Fuel",
    role: "support",
    state: fuelState,
    short: lastDiv
      ? divOk
        ? `${lastDiv.kind === "DIVERGENCE_D2" ? "D2 bull — price LL / CVD HL" : "D4 bear — price HH / CVD LH"}`
        : `${lastDiv.kind === "DIVERGENCE_D2" ? "D2 bull (this read is short)" : "D4 bear (this read is long)"}`
      : "flow still confirming price",
    value: lastDiv
      ? divOk
        ? `${lastDiv.kind === "DIVERGENCE_D2" ? "price lower low / CVD higher low" : "price higher high / CVD lower high"} · ${divAge ?? "?"} bars ago`
        : `${lastDiv.kind === "DIVERGENCE_D2" ? "bullish" : "bearish"} divergence, but this read is ${side === "short" ? "short" : "long"}`
      : "flow still confirming price (no divergence)",
    why: "divergence is the SYMPTOM: the extreme was made with less aggressive flow than the last one. It can persist for a long time in a trend, so it never triggers anything on its own.",
  };

  /* ---------- 4 · TRIGGER (reclaim) ---------- */
  const recAge = lastRec ? ageOf(lastRec.t) : null;
  const recOk = lastRec ? (want === "bull" ? lastRec.dir === "low" : lastRec.dir === "high") : false;
  const triggerState: IngredientState = lastRec && recAge !== null && recAge <= AGE.trigger && recOk ? "yes" : lastRec && recOk ? "partial" : "no";
  const trigger: Ingredient = {
    key: "trigger",
    n: "4",
    name: "Trigger",
    role: "required",
    state: triggerState,
    short: lastRec
      ? `${lastRec.dir === "low" ? "failed low" : "failed high"} reclaimed @ ${fmtN(lastRec.price)}${recOk ? "" : " (wrong side)"}`
      : "no reclaim yet",
    value: lastRec
      ? `${lastRec.dir === "low" ? "failed low" : "failed high"} at ${fmtN(lastRec.price)} reclaimed${recAge !== null ? ` · ${recAge} bars ago` : ""}${recOk ? "" : " — wrong side"}`
      : "no reclaim after the last extreme",
    why: "the reclaim is the TRIGGER: price broke an extreme, failed, and traded back inside — stops left behind at the extreme become the fuel for the move back.",
  };

  /* ---------- 5 · EVIDENCE (footprint imbalance) ---------- */
  const st = inp.imbalance?.lastStack ?? null;
  const evOk = !!st && (want === "bull" ? st.side === "buy" : st.side === "sell");
  const evidence: Ingredient = {
    key: "evidence",
    n: "5",
    name: "Footprint",
    role: "support",
    state: evOk && stackFresh ? "yes" : evOk ? "partial" : "no",
    short: st
      ? `${st.side === "buy" ? "buy" : "sell"} stack ×${st.len} @ ${fmtN(st.from)}–${fmtN(st.to)}`
      : inp.imbalance
        ? `${inp.imbalance.buyRows}▲ / ${inp.imbalance.sellRows}▼ rows, no stack`
        : "no footprint window",
    value: st
      ? `${st.side === "buy" ? "buy" : "sell"}-side imbalance stacked over ${st.len} ticks ${fmtN(st.from)}–${fmtN(st.to)} (${st.t})${stackAge !== null ? ` · ${stackAge} bars ago` : ""}${st.side === "buy" ? "" : ""}`
      : inp.imbalance
        ? `${inp.imbalance.buyRows} buy rows / ${inp.imbalance.sellRows} sell rows imbalanced, no stack`
        : "no footprint window",
    why: "a single imbalanced tick is noise; 3+ consecutive ticks imbalanced the same way is one side being filled systematically at a price — that is what absorption looks like in the raw tape.",
  };

  /* ---------- 6 · CONTEXT ---------- */
  const vwapAbove = inp.vwap > 0 && price >= inp.vwap;
  const contextState: IngredientState = inp.newsWin ? "no" : "yes";
  const context: Ingredient = {
    key: "context",
    n: "6",
    name: "Context",
    role: "filter",
    state: contextState,
    short: inp.newsWin
      ? "news window — veto"
      : `${vwapAbove ? "above" : "below"} VWAP${inp.vwap > 0 ? ` ${fmtN(inp.vwap)}` : ""} · no release`,
    value: inp.newsWin ? "inside a ±5 min release window — veto" : `${vwapAbove ? "above" : "below"} VWAP${inp.vwap > 0 ? ` (${fmtN(inp.vwap)})` : ""} · no release due`,
    why: "which side of the session average price you are on, and whether a scheduled release is about to invalidate the whole read.",
  };

  const ingredients = [location, mechanism, fuel, trigger, evidence, context];
  const required = ingredients.filter((i) => i.role === "required");
  const requiredMet = required.filter((i) => i.state === "yes").length;
  const present = ingredients.filter((i) => i.state === "yes").length;
  const missing = ingredients.filter((i) => i.state !== "yes").map((i) => `${i.name} (${i.state === "partial" ? "partial" : "missing"})`);

  /* ---------- verdict ---------- */
  let verdict: string;
  let tone: MechanismRead["tone"] = "neutral";
  if (!side) {
    verdict = "NO MECHANISM — nothing is opposing price";
  } else if (requiredMet === 3 && present >= 5) {
    verdict = `${side === "long" ? "LONG" : "SHORT"} REVERSAL MECHANISM — ${requiredMet}/3 required + ${present - requiredMet} support`;
    tone = side === "long" ? "long" : "short";
  } else if (requiredMet === 3) {
    verdict = `${side === "long" ? "LONG" : "SHORT"} SEQUENCE COMPLETE — thin on supporting evidence`;
    tone = side === "long" ? "long" : "short";
  } else if (requiredMet === 2) {
    verdict = `${side === "long" ? "LONG" : "SHORT"} FORMING — ${required.find((i) => i.state !== "yes")?.name} is the missing piece`;
    tone = "forming";
  } else {
    verdict = `${side === "long" ? "LONG" : "SHORT"} INTEREST — partial only, do not trade it yet`;
    tone = "forming";
  }

  /* ---------- narrative: the causal chain in words ---------- */
  const parts: string[] = [];
  if (lastAbs) {
    parts.push(
      `${lastAbs.side === "bid" ? "Sellers" : "Buyers"} pushed ${lastAbs.volume ? `${lastAbs.volume.toLocaleString()} ` : ""}contracts${lastAbs.imbalance !== undefined ? ` (${(lastAbs.imbalance * 100).toFixed(0)}% one-sided)` : ""} into ${fmtN(lastAbs.price)} and price did not move through it (absorption)`,
    );
  }
  if (lastDiv && divOk) {
    parts.push(
      `the ${lastDiv.kind === "DIVERGENCE_D2" ? "new low" : "new high"} at ${fmtN(lastDiv.price)} came with less aggressive flow than the previous extreme (CVD divergence — no fuel left)`,
    );
  } else if (divs.length && lastDiv) {
    parts.push(`flow is diverging, but on the ${lastDiv.kind === "DIVERGENCE_D2" ? "buy" : "sell"} side — the opposite of this read`);
  }
  if (lastRec && recOk) {
    parts.push(`${lastRec.dir === "low" ? "the failed low" : "the failed high"} at ${fmtN(lastRec.price)} was reclaimed, which is the trigger`);
  } else {
    parts.push(`what is still missing is the reclaim of the failed extreme — until price trades back inside, this is only a hypothesis`);
  }
  if (evOk && st) parts.push(`footprint shows ${st.side === "buy" ? "buyers" : "sellers"} stacked over ${st.len} ticks at ${fmtN(st.from)}–${fmtN(st.to)}`);
  const narrative = parts.length ? parts.join("; then ") + "." : "No sequence detected in the visible window — flows are aligned with price, so there is nothing to fade.";

  /* ---------- practical lines ---------- */
  const recentLows = minutes.slice(-10).map((m) => m.low).filter(Number.isFinite);
  const recentHighs = minutes.slice(-10).map((m) => m.high).filter(Number.isFinite);
  const leanLong = side !== "short";
  const leanPrice = recentLows.length && recentHighs.length ? (leanLong ? Math.min(...recentLows) : Math.max(...recentHighs)) : NaN;
  const noData = !Number.isFinite(leanPrice) || minutes.length === 0;
  const triggerLine = noData
    ? "no bars in the visible window yet — nothing to trigger"
    : !lastRec || !recOk
    ? `${leanLong ? "long" : "short"} trigger not there yet: wait for price to ${leanLong ? "break below" : "break above"} ${fmtN(leanPrice)} and trade back inside within 2 bars (a reclaim) — that failed break is the entry event`
    : `reclaim already printed at ${fmtN(lastRec.price)}${recAge !== null ? ` (${recAge} bars ago)` : ""}: the confirmation is holding on the retest, i.e. ${leanLong ? "no 1-minute close back below" : "no 1-minute close back above"} ${fmtN(lastRec.price)}`;
  const invalidation =
    side === "long"
      ? `a 1-minute close below ${fmtN(price - SCALP_STOP_PTS)} (${SCALP_STOP_PTS}-pt scalp stop) invalidates`
      : side === "short"
        ? `a 1-minute close above ${fmtN(price + SCALP_STOP_PTS)} (${SCALP_STOP_PTS}-pt scalp stop) invalidates`
        : "no side established — no invalidation level, no trade";
  const target = inp.poc
    ? `${inp.poc.label} ${fmtN(inp.poc.p)} · ${fmtN(Math.abs(inp.poc.p - price))} pts away${side ? ` (${dirWord}-target)` : ""}`
    : "no POC loaded";

  return {
    side,
    tone,
    verdict,
    headline: side
      ? `${side === "long" ? "Long" : "Short"} read: ${requiredMet}/3 required conditions, ${present}/6 total`
      : "No reversal sequence in the visible window",
    narrative,
    ingredients,
    present,
    missing,
    trigger: triggerLine,
    invalidation,
    target,
    asOf: minutes[n - 1]?.t ?? "—",
    live: false,
    entryPx: price,
    stopPx: side === "long" ? price - SCALP_STOP_PTS : side === "short" ? price + SCALP_STOP_PTS : NaN,
    targetPx: inp.poc ? inp.poc.p : NaN,
    lastDelta: minutes[n - 1]?.delta ?? 0,
  };
}
