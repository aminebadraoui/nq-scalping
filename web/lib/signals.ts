/* ------------------------------------------------------------------ *
 * Signal boxes + the final composer.
 *
 * A "signal box" is an independent, swappable source of a directional
 * read. Each box answers one question and returns the SAME contract:
 * a side (long/short/none), a tone, a 0..1 conviction score and a
 * plain-language verdict. Adding or removing a box is one line in the
 * compose call — nothing else in the app has to know about it.
 *
 *   order flow   — the reversal sequence (location → absorption →
 *                  divergence → reclaim). This is the TRIGGER.
 *   price action — discount/premium alignment across 1m…1d. This is
 *                  the LOCATION filter ("buy cheap, sell expensive").
 *
 * The composer is deliberately strict, mirroring the playbook's
 * "required pieces" philosophy: every box must agree on the direction,
 * otherwise it is a conflict and there is no trade. A box that is
 * neutral does not block the others — it simply has not voted yet.
 * ------------------------------------------------------------------ */

import type { MechanismRead } from "./mechanism";
import type { PriceActionRead } from "./priceaction";
import type { OptionsRead } from "./options";

export type Side = "long" | "short" | null;
export type Tone = "long" | "short" | "neutral" | "forming";

export type BoxVerdict = {
  id: string;
  name: string;
  side: Side;
  tone: Tone;
  /** 0..1 conviction in the chosen side (0 when neutral) */
  score: number;
  verdict: string;
  /** directional boxes vote long/short; context boxes gate instead of voting */
  kind?: "directional" | "context";
  /** display tag for context boxes (e.g. "CHOP" / "TREND") */
  label?: string;
};

export type Signal = {
  side: Side;
  tone: Tone;
  verdict: string;
  headline: string;
  /** true when every directional box that has a side agrees on it */
  agree: boolean;
  boxes: BoxVerdict[];
  /** context boxes (regime/location) — reported, never voted */
  contexts: BoxVerdict[];
  contextNotes: string[];
};

export function boxFromMechanism(read: MechanismRead): BoxVerdict {
  return {
    id: "orderflow",
    name: "Order flow",
    side: read.side,
    tone: read.tone,
    score: read.present / 6,
    verdict: read.verdict,
    kind: "directional",
  };
}

export function boxFromPriceAction(read: PriceActionRead): BoxVerdict {
  const score = read.side ? Math.max(read.longScore, read.shortScore) / read.maxScore : 0;
  return {
    id: "priceaction",
    name: "Price action",
    side: read.side,
    tone: read.tone,
    score,
    verdict: read.verdict,
    kind: "directional",
  };
}

/** The options box is a CONTEXT box: it reports dealer positioning (regime +
 *  walls) but never votes long/short — it gates the fade vs follow-through
 *  decision instead. */
export function boxFromOptions(read: OptionsRead): BoxVerdict {
  return {
    id: "options",
    name: "Options / gamma",
    side: null,
    tone: "neutral",
    score: 0,
    verdict: read.note,
    kind: "context",
    label: read.regime === "chop" ? "CHOP" : read.regime === "trend" ? "TREND" : "—",
  };
}

export function composeSignals(boxes: BoxVerdict[]): Signal {
  const directional = boxes.filter((b) => b.kind !== "context");
  const contexts = boxes.filter((b) => b.kind === "context");
  const longs = directional.filter((b) => b.side === "long");
  const shorts = directional.filter((b) => b.side === "short");

  let side: Side = null;
  let tone: Tone = "neutral";
  let verdict: string;
  let headline: string;
  let agree = false;

  if (longs.length > 0 && shorts.length === 0) {
    side = "long";
    agree = longs.length === directional.length;
    tone = agree ? "long" : "forming";
    verdict = agree
      ? `ALIGNED LONG — every box agrees (${longs.map((b) => b.name).join(" + ")})`
      : `LONG — ${longs.map((b) => b.name).join(" + ")} agree; the rest are neutral`;
    headline = agree
      ? "order flow and price action both point long"
      : "long, but not every box has voted yet";
  } else if (shorts.length > 0 && longs.length === 0) {
    side = "short";
    agree = shorts.length === directional.length;
    tone = agree ? "short" : "forming";
    verdict = agree
      ? `ALIGNED SHORT — every box agrees (${shorts.map((b) => b.name).join(" + ")})`
      : `SHORT — ${shorts.map((b) => b.name).join(" + ")} agree; the rest are neutral`;
    headline = agree
      ? "order flow and price action both point short"
      : "short, but not every box has voted yet";
  } else if (longs.length > 0 && shorts.length > 0) {
    side = null;
    tone = "neutral";
    verdict = "CONFLICT — boxes disagree on direction; no trade";
    headline = `${longs.map((b) => b.name).join(" + ")} say long, ${shorts.map((b) => b.name).join(" + ")} say short`;
  } else {
    side = null;
    tone = "neutral";
    verdict = "NO SIGNAL — no box has a directional read yet";
    headline = "wait for the sequence to develop";
  }

  const contextNotes = contexts.map((c) => c.verdict).filter(Boolean);

  return { side, tone, verdict, headline, agree, boxes, contexts, contextNotes };
}

/* ------------------------------------------------------------------ *
 * The card gate — docs/strategy/STRATEGY.md "When a signal exists", gates 1–3.
 *
 * A trade card exists only when, at the same minute:
 *   · every directional box agrees (ALIGNED LONG / SHORT)   — gate 2
 *   · all three required ingredients are present: location, mechanism,
 *     trigger — location "yes" means at/inside an LVN (gamma walls and
 *     session extremes only ever score PARTIAL)              — gates 1+3,
 *     and "no reclaim, no trade"
 *   · at least one confirmation ingredient is present, i.e. present ≥ 4/6
 *                                                            — gate 1
 *
 * The two footprint filters (stack side, entry-bar delta) are applied by
 * the caller (lib/signalFeed.ts) and are deliberately NOT part of this
 * function, so the dashboard and the feed share the same three gates.
 * ------------------------------------------------------------------ */
export function cardGateOpen(signal: Signal, mech: MechanismRead): { ok: boolean; reason: string } {
  const aligned = signal.tone === "long" || signal.tone === "short";
  if (!aligned) return { ok: false, reason: "boxes not aligned — no directional agreement" };
  const required = mech.ingredients.filter((i) => i.role === "required");
  const missing = required.filter((i) => i.state !== "yes").map((i) => i.name);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing required ${missing.length > 1 ? "pieces" : "piece"}: ${missing.join(", ").toLowerCase()}`,
    };
  }
  if (mech.present < 4) return { ok: false, reason: `${mech.present}/6 present — below the 4/6 card gate` };
  return { ok: true, reason: "sequence complete — all 3 required + ≥1 confirmation" };
}
