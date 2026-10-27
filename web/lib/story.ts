/* ------------------------------------------------------------------ *
 * Footprint STORY — relationship analysis across consecutive minutes.
 *
 * Single candles show WHO printed where. The story is what the sequence
 * of candles is DOING: value migrating, an auction flipping, an effort
 * not paying off. Every state below is computable from our per-minute
 * data (OHLC, buy/sell, per-tick clusters) and follows the practitioner
 * definitions researched (VSA "relative to prior bars", Axia delta
 * reversal, Dalton POC migration):
 *
 *   INITIATIVE  delta >= 20% of volume AND a new 3-bar extreme
 *   CLIMAX      volume >= 2x median AND range >= 1.5x median AND the bar
 *               closes OFF its extreme (exhaustion, not yet a turn)
 *   TEST        narrow range, volume < both prior bars, touches a recent
 *               extreme within 1 pt but fails to extend (no-supply/
 *               no-demand — the VSA confirmation test)
 *   VACUUM      low volume (< 0.5x median) but a big range (> 1.5x) —
 *               move with no participation, prone to retracement
 *   ABSORPTION  the analyzer's defended-price event (multi-bar by def)
 *   ROTATION    two-way business, nothing directional
 *
 * Precedence (a bar can satisfy several predicates — the first match wins):
 *   ABSORPTION (analyzer event) > CLIMAX > INITIATIVE > TEST > VACUUM > ROTATION
 * so a thin, wide bar that also makes a new extreme with 20% delta is an
 * INITIATIVE bar, never a VACUUM one.
 *
 * Caveats (from the research): sequences confirm at bar close only (the
 * 1-min scalp is often done), and any pattern grammar can overfit — the
 * narrative is a STUDY AID, not an entry signal.
 * ------------------------------------------------------------------ */

import { median as trueMedian } from "./stats";

export type StoryMinute = {
  t: string;
  o: number;
  c: number;
  high: number;
  low: number;
  buy: number;
  sell: number;
  delta: number;
  levels: { price: number; buy: number; sell: number }[];
  imb?: { stacked?: { side: "buy" | "sell"; from: number; to: number; len: number } | null } | null;
};

export type BarState =
  | "INITIATIVE_UP"
  | "INITIATIVE_DN"
  | "CLIMAX_UP"
  | "CLIMAX_DN"
  | "TEST"
  | "VACUUM"
  | "ABSORPTION"
  | "ROTATION";

export type StoryBar = {
  t: string;
  state: BarState;
  poc: number | null;
  pocStep: number; // ticks of POC migration vs previous bar (0.25 = 1 tick)
  deltaPct: number;
  range: number;
  vol: number;
  text: string;
};

export type Story = {
  bars: StoryBar[];
  pocTrail: "up" | "down" | "flat";
  pocTrailLen: number;
  deltaFlip: { t: string; dir: "up" | "down" } | null;
  effort: { t: string; kind: "stall" | "vacuum" } | null;
  transitions: { t: string; from: BarState; to: BarState }[];
  sequence: { t: string; kind: "exhaustion_reversal" | "absorption_hold" | "vacuum_retrace" } | null;
  narrative: string;
};

// true median: average the two middle values on even samples (the upper
// element alone inflates both thresholds slightly)
const median = trueMedian;

function barPoc(levels: StoryMinute["levels"]): number | null {
  if (!levels.length) return null;
  let best = levels[0];
  for (const l of levels) if (l.buy + l.sell > best.buy + best.sell) best = l;
  return best.price;
}

const STATE_TEXT: Record<BarState, string> = {
  INITIATIVE_UP: "initiative up",
  INITIATIVE_DN: "initiative down",
  CLIMAX_UP: "buying climax",
  CLIMAX_DN: "selling climax",
  TEST: "quiet retest",
  VACUUM: "vacuum move",
  ABSORPTION: "absorption",
  ROTATION: "rotation",
};

export function buildStory(
  minutes: StoryMinute[],
  absorption: { t: string }[],
  fmt: (t: string) => string = (t) => t,
): Story | null {
  const n = minutes.length;
  if (n < 8) return null;
  const absorbSet = new Set(absorption.map((a) => a.t));

  const last20 = minutes.slice(-20);
  const medRange = median(last20.map((m) => m.high - m.low)) || 1;
  const medVol = median(last20.map((m) => m.buy + m.sell)) || 1;

  const bars: StoryBar[] = [];
  for (let i = 0; i < n; i++) {
    const m = minutes[i];
    const vol = m.buy + m.sell;
    const range = m.high - m.low;
    const deltaPct = vol > 0 ? m.delta / vol : 0;
    const prev3 = minutes.slice(Math.max(0, i - 3), i);
    const max3High = Math.max(m.high, ...prev3.map((x) => x.high));
    const min3Low = Math.min(m.low, ...prev3.map((x) => x.low));
    const closePos = range > 0 ? (m.c - m.low) / range : 0.5;
    const hasOhlc = m.o > 0 && m.c > 0;
    const closesOffHigh = hasOhlc ? closePos < 0.45 : false;
    const closesOffLow = hasOhlc ? closePos > 0.55 : false;

    let state: BarState = "ROTATION";
    if (absorbSet.has(m.t)) state = "ABSORPTION";
    else if (vol >= 2 * medVol && range >= 1.5 * medRange) {
      if (m.high >= max3High && closesOffHigh) state = "CLIMAX_UP";
      else if (m.low <= min3Low && closesOffLow) state = "CLIMAX_DN";
      else if (Math.abs(deltaPct) >= 0.2) {
      // same rule as the sibling branch below: an initiative bar needs BOTH
      // aggression and a new 3-bar extreme, otherwise it is just a big bar
      if (deltaPct > 0 && m.high >= max3High) state = "INITIATIVE_UP";
      else if (deltaPct < 0 && m.low <= min3Low) state = "INITIATIVE_DN";
    }
    } else if (Math.abs(deltaPct) >= 0.2) {
      if (m.high >= max3High && deltaPct > 0) state = "INITIATIVE_UP";
      else if (m.low <= min3Low && deltaPct < 0) state = "INITIATIVE_DN";
    }
    if (state === "ROTATION") {
      const narrow = range <= 0.5 * medRange;
      const quiet = i >= 2 && vol < minutes[i - 1].buy + minutes[i - 1].sell && vol < minutes[i - 2].buy + minutes[i - 2].sell;
      const touchesHigh = Math.abs(m.high - max3High) <= 1;
      const touchesLow = Math.abs(m.low - min3Low) <= 1;
      if (narrow && quiet && (touchesHigh || touchesLow)) state = "TEST";
      else if (vol <= 0.5 * medVol && range >= 1.5 * medRange) state = "VACUUM";
    }

    const poc = barPoc(m.levels);
    const prevPoc = i > 0 ? bars[i - 1].poc : null;
    bars.push({
      t: m.t,
      state,
      poc,
      pocStep: poc !== null && prevPoc !== null ? Math.round((poc - prevPoc) * 4) : 0, // ticks
      deltaPct,
      range,
      vol,
      text: `${STATE_TEXT[state]}${poc !== null ? ` · POC ${poc.toFixed(2)}` : ""} · Δ ${deltaPct >= 0 ? "+" : ""}${(deltaPct * 100).toFixed(0)}% · ${vol} ct`,
    });
  }

  /* POC migration trail: 3+ consecutive same-sign steps */
  let trailLen = 0;
  let trailSide: "up" | "down" = "up";
  for (let i = n - 1; i >= 1; i--) {
    const s = Math.sign(bars[i].pocStep);
    if (s === 0) break;
    if (trailLen === 0) trailSide = s > 0 ? "up" : "down";
    else if ((s > 0 ? "up" : "down") !== trailSide) break;
    trailLen++;
  }
  const pocTrail: Story["pocTrail"] = trailLen >= 3 ? trailSide : "flat";

  /* delta flip: adjacent bars, opposite signs, both >= 15% of volume */
  let deltaFlip: Story["deltaFlip"] = null;
  for (let i = n - 1; i >= 1; i--) {
    const a = bars[i - 1].deltaPct;
    const b = bars[i].deltaPct;
    if (a * b < 0 && Math.abs(a) >= 0.15 && Math.abs(b) >= 0.15) {
      deltaFlip = { t: bars[i].t, dir: b > 0 ? "up" : "down" };
      break;
    }
  }

  /* effort vs result over rolling 3-bar windows */
  let effort: Story["effort"] = null;
  for (let i = Math.min(n - 1, 3); i < n; i++) {
    // effort and result must span the same three bars (i-2 .. i), otherwise a
    // 3-bar effort is compared against a 4-bar close move
    const eff = minutes[i - 2].buy + minutes[i - 2].sell + minutes[i - 1].buy + minutes[i - 1].sell + minutes[i].buy + minutes[i].sell;
    const res = Math.abs(minutes[i].c - minutes[i - 2].c);
    if (eff >= 1.5 * 3 * medVol && res <= 0.5 * 3 * medRange) effort = { t: minutes[i].t, kind: "stall" };
    else if (eff <= 0.5 * 3 * medVol && res >= 1.5 * 3 * medRange) effort = { t: minutes[i].t, kind: "vacuum" };
  }

  /* transitions: state changes across adjacent bars */
  const transitions: Story["transitions"] = [];
  for (let i = 1; i < n; i++) {
    if (bars[i].state !== bars[i - 1].state) transitions.push({ t: bars[i].t, from: bars[i - 1].state, to: bars[i].state });
  }

  /* the named sequences that matter */
  let sequence: Story["sequence"] = null;
  const recent = transitions.slice(-6);
  const has = (f: BarState, t: BarState) => recent.some((x) => x.from === f && x.to === t);
  if (has("CLIMAX_DN", "TEST") || has("CLIMAX_DN", "ROTATION") || has("CLIMAX_UP", "TEST") || has("CLIMAX_UP", "ROTATION")) {
    sequence = { t: recent[recent.length - 1].t, kind: "exhaustion_reversal" };
  } else if (has("ABSORPTION", "VACUUM") || has("ABSORPTION", "INITIATIVE_UP") || has("ABSORPTION", "INITIATIVE_DN")) {
    sequence = { t: recent[recent.length - 1].t, kind: "absorption_hold" };
  } else if (has("VACUUM", "ROTATION") || has("VACUUM", "TEST")) {
    sequence = { t: recent[recent.length - 1].t, kind: "vacuum_retrace" };
  }

  /* narrative — plain language, composed from real states */
  const parts: string[] = [];
  if (pocTrail !== "flat") {
    parts.push(`value is migrating ${pocTrail} (POC ${trailLen} steps in a row) — ${pocTrail === "up" ? "buyers are marking higher accepted prices" : "sellers are marking lower accepted prices"}`);
  } else {
    parts.push("POC is sticky — price is moving but the most-traded price is not, so value is not yet confirming the move");
  }
  if (deltaFlip) parts.push(`the auction last flipped ${deltaFlip.dir === "up" ? "from selling to buying" : "from buying to selling"} at ${fmt(deltaFlip.t)}`);
  if (effort) parts.push(effort.kind === "stall" ? `effort rising while range shrinks at ${fmt(effort.t)} — absorption signature (someone is standing there)` : `a low-participation vacuum move at ${fmt(effort.t)} — often retraced`);
  const lastState = bars[n - 1].state;
  // a real exhaustion sequence: climax then a retest within the NEXT FEW bars —
  // only look at the last 20 bars so a morning climax can't pair with an
  // afternoon retest (that is coincidence, not a sequence)
  const recentBars = bars.slice(-20);
  const climaxIdx = recentBars.findIndex((b) => b.state === "CLIMAX_UP" || b.state === "CLIMAX_DN");
  let tested = false;
  let testBar = null as null | StoryBar;
  if (climaxIdx !== -1) {
    for (let k = climaxIdx + 1; k < Math.min(recentBars.length, climaxIdx + 6); k++) {
      if (recentBars[k].state === "TEST") {
        tested = true;
        testBar = recentBars[k];
        break;
      }
    }
  }
  if (climaxIdx !== -1 && tested && testBar) {
    parts.push(`climax at ${fmt(recentBars[climaxIdx].t)} then a quiet retest at ${fmt(testBar.t)} that failed to extend — the VSA reversal shape, watch for the first initiative bar to confirm`);
  } else if (climaxIdx !== -1) {
    parts.push(`climax at ${fmt(recentBars[climaxIdx].t)} has not been retested yet — exhaustion marks fatigue, not the turn`);
  }
  if (sequence) {
    parts.push(
      sequence.kind === "exhaustion_reversal"
        ? `sequence: exhaustion → failed retest — a reversal candidate`
        : sequence.kind === "absorption_hold"
          ? `sequence: absorption → initiative — the level held and flow resumed`
          : `sequence: vacuum move → rotation — thin participation is fading back`,
    );
  }
  if (parts.length === 0) parts.push(`last bar: ${STATE_TEXT[lastState]} — the tape is two-way, nothing directional yet`);

  return {
    bars,
    pocTrail,
    pocTrailLen: trailLen,
    deltaFlip,
    effort,
    transitions,
    sequence,
    narrative: parts.join("; then ") + ".",
  };
}
