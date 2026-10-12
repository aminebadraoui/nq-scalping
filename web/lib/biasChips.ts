/* ------------------------------------------------------------------ *
 * Bias chips — the structure-layer computations of the daily-bias
 * framework (docs/research/daily-bias-framework-2026-10-09.md §2+§5),
 * as pure functions over 1-minute bars. DISPLAY-ONLY: like the rest of
 * the macro layer, these chips are context for the human/AI briefing —
 * the signal engine never imports this module.
 *
 * Time convention: bars carry CT "HH:mm" t (the archive convention):
 *   Asia 19:00–00:59 · London 01:00–06:59 · RTH 08:30–14:59 CT.
 *
 * Chip semantics (score table §5, structure + VIX rows only):
 *   gap      gap% vs prior RTH close. <0.5% → fade-against (±2) ·
 *            0.5–1.5% → 0 · >1.5% → with-gap (±2), only if fades valid.
 *            Pre-open proxy: the latest minute close (the RTH open does
 *            not exist yet; the overnight-move factor collapses into
 *            this number at pre-open).
 *   aln      Asia–London–NY pattern: P3 +2 (lean long-side first move) ·
 *            P4 −2 · P1/P2 0.
 *   priorDay position vs PDH/PDL: above PDH +1 · below PDL −1 · else 0.
 *   vix      contango (VIX3M>VIX) & VIX<25 → fades valid (+1) · else −1
 *            and fade trades are capped.
 * ------------------------------------------------------------------ */

export type ChipMinute = { t: string; o: number; c: number; high: number; low: number };

export type AlnPattern = "P1" | "P2" | "P3" | "P4" | null;

export const closeOfChip = (m: ChipMinute) => (m.c > 0 ? m.c : (m.high + m.low) / 2);

const inAsia = (t: string) => t >= "19:00" || t <= "00:59";
const inLondon = (t: string) => t >= "01:00" && t <= "06:59";

/** Asia–London–NY pattern over the session minutes (needs 08:00+ ET of
 *  data: Asia 20:00–02:00 ET, London 02:00–08:00 ET). Null when a range
 *  is missing (too few bars). */
export function alnPattern(minutes: ChipMinute[]): AlnPattern {
  const asia = minutes.filter((m) => inAsia(m.t));
  const london = minutes.filter((m) => inLondon(m.t));
  if (asia.length < 30 || london.length < 30) return null;
  const aH = Math.max(...asia.map((m) => m.high));
  const aL = Math.min(...asia.map((m) => m.low));
  const lH = Math.max(...london.map((m) => m.high));
  const lL = Math.min(...london.map((m) => m.low));
  if (lH >= aH && lL <= aL) return "P1";
  if (aH >= lH && aL <= lL) return "P2";
  if (lH > aH && lL >= aL) return "P3";
  if (lL < aL && lH <= aH) return "P4";
  return null;
}

export const ALN_CHIP: Record<Exclude<AlnPattern, null>, { label: string; score: number }> = {
  P1: { label: "P1 London engulfs Asia → two-sided/expansion, tape decides", score: 0 },
  P2: { label: "P2 Asia engulfs London → rare containment, chop", score: 0 },
  P3: { label: "P3 London partial-engulf UP → lean long-side first move", score: 2 },
  P4: { label: "P4 London partial-engulf DOWN → lean short-side first move", score: -2 },
};

export type GapRegime = "small" | "mid" | "large" | null;

export function gapRegime(gapPct: number | null): GapRegime {
  if (gapPct == null || !Number.isFinite(gapPct)) return null;
  const a = Math.abs(gapPct);
  if (a < 0.5) return "small";
  if (a <= 1.5) return "mid";
  return "large";
}

/** gap score per the score table: small = fade-against, large = with-gap
 *  (capped unless fadesOk), mid = 0. */
export function gapChipScore(gapPct: number | null, fadesOk: boolean): number {
  const r = gapRegime(gapPct);
  if (r == null || gapPct == null) return 0;
  const sign = gapPct >= 0 ? 1 : -1;
  if (r === "small") return -sign * 2; // fade back to prior close
  if (r === "large") return fadesOk ? sign * 2 : 0; // continuation, VIX-gated
  return 0;
}

export function gapChipLabel(gapPct: number | null, fadesOk: boolean): string | null {
  const r = gapRegime(gapPct);
  if (r == null || gapPct == null) return null;
  const dir = gapPct >= 0 ? "up" : "down";
  if (r === "small") return `gap ${dir} ${gapPct.toFixed(2)}% small → fade toward prior close`;
  if (r === "large") return fadesOk ? `gap ${dir} ${gapPct.toFixed(2)}% large → continuation with gap` : `gap ${dir} ${gapPct.toFixed(2)}% large but VIX gate off → no fade, no forced bias`;
  return `gap ${dir} ${gapPct.toFixed(2)}% mid → no default direction`;
}

export function vixFadeGate(vixLevel: number | null, vix3m: number | null): { fadeOk: boolean; score: number; label: string } {
  if (vixLevel == null || vixLevel <= 0) return { fadeOk: true, score: 0, label: "VIX n/a — fade gate default on" };
  const term = vix3m != null && vix3m > 0 ? vix3m - vixLevel : 0;
  const fadeOk = vixLevel < 25 && term > 0;
  return {
    fadeOk,
    score: fadeOk ? 1 : -1,
    label: fadeOk
      ? `VIX ${vixLevel.toFixed(1)} contango (3M ${term >= 0 ? "+" : ""}${term.toFixed(1)}) → fades valid`
      : `VIX ${vixLevel.toFixed(1)} ${term <= 0 ? "backwardation" : "≥25"} → no fade trades, expect expansion`,
  };
}

export function priorDayPosChip(atPrice: number | null, pdh: number | null, pdl: number | null): { pos: "abovePDH" | "belowPDL" | "inside" | null; score: number; label: string | null } {
  if (atPrice == null || pdh == null || pdl == null || pdh <= 0 || pdl <= 0) return { pos: null, score: 0, label: null };
  if (atPrice >= pdh) return { pos: "abovePDH", score: 1, label: `price above PDH (${pdh}) → acceptance lean long` };
  if (atPrice <= pdl) return { pos: "belowPDL", score: -1, label: `price below PDL (${pdl}) → acceptance lean short` };
  return { pos: "inside", score: 0, label: "price inside prior-day range → balanced" };
}

export type BiasChips = {
  /** latest-minute price used as the pre-open gap proxy */
  atPrice: number | null;
  gapPct: number | null;
  gap: { regime: GapRegime; score: number; label: string | null };
  aln: { pattern: AlnPattern; score: number; label: string | null };
  priorDay: { pos: "abovePDH" | "belowPDL" | "inside" | null; score: number; label: string | null };
  vixGate: { fadeOk: boolean; score: number; label: string };
  /** one-sided filter cells (sideFilterStudy, measured on the card):
   *  gap regime + ALN + HTF + pre-open hour — advisory, never gates */
  sideLean: string[];
  /** structure-layer subtotal (gap + aln + priorDay + vix), ±6 */
  score: number;
  chips: string[];
};

export type BiasChipsOpts = {
  /** current NY hour (ET, 0–23) — enables the pre-open/late-night rules */
  hourET?: number | null;
  /** daily HTF structure as "bull" | "bear" | "chop" — enables P3+bear */
  htfDaily?: string | null;
  /** true on FOMC decision or pre-FOMC days — suppresses the pre-open rule */
  eventDay?: boolean;
};

/** one-sided sideLean labels from the measured cells (side-filter study,
 *  docs/research/side-filter-study-2026-10-09.md). Labels only. */
export function sideLeanChips(
  gap: { regime: GapRegime; gapPct: number | null },
  aln: AlnPattern,
  opts: BiasChipsOpts,
): string[] {
  const out: string[] = [];
  if (gap.gapPct != null) {
    if (gap.regime === "mid" && gap.gapPct < 0) out.push("LONG-ONLY gap mid-down 79%");
    if (gap.regime === "mid" && gap.gapPct > 0) out.push("LONG-ONLY gap mid-up 81%");
    if (gap.regime === "large" && gap.gapPct > 0) out.push("SHORT-ONLY gap large-up 79%");
    if (gap.regime === "large" && gap.gapPct < 0) out.push("LONG-LEAN gap large-down (thin n=12)");
  }
  if (aln === "P2") out.push("LONG-ONLY ALN P2 74%");
  if (aln === "P3" && opts.htfDaily === "bear") out.push("LONG-ONLY P3+bear 83%");
  if (aln === "P4" && opts.hourET != null && (opts.hourET >= 23 || opts.hourET <= 2)) out.push("SHORT-ONLY P4 23–02 84%");
  if (opts.hourET != null && (opts.hourET === 8 || opts.hourET === 9) && !opts.eventDay) out.push("SHORT-ONLY 08–09 89%");
  return out;
}

/** the whole structure-layer chip set in one call. `minutes` must cover
 *  the current session up to the latest bar (Asia+London complete for a
 *  pre-open ALN read); `priorRth*` = the prior session's RTH values. */
export function biasChips(
  minutes: ChipMinute[],
  priorRthClose: number | null,
  priorRthHigh: number | null,
  priorRthLow: number | null,
  vixLevel: number | null,
  vix3m: number | null,
  opts: BiasChipsOpts = {},
): BiasChips {
  const at = minutes.length ? closeOfChip(minutes[minutes.length - 1]) : null;
  const gapPct = at != null && priorRthClose != null && priorRthClose > 0 ? ((at - priorRthClose) / priorRthClose) * 100 : null;
  const vixGate = vixFadeGate(vixLevel, vix3m);
  const aln = alnPattern(minutes);
  const alnInfo = aln ? ALN_CHIP[aln] : { label: null, score: 0 };
  const priorDay = priorDayPosChip(at, priorRthHigh, priorRthLow);
  const gap = { regime: gapRegime(gapPct), score: gapChipScore(gapPct, vixGate.fadeOk), label: gapChipLabel(gapPct, vixGate.fadeOk) };

  const sideLean = sideLeanChips({ regime: gap.regime, gapPct }, aln, opts);
  const structure = [alnInfo.label, gap.label, priorDay.label, vixGate.label].filter((x): x is string => x != null);
  const chips = [...sideLean, ...structure];
  const score = gap.score + (aln ? alnInfo.score : 0) + priorDay.score + vixGate.score;

  return {
    atPrice: at,
    gapPct,
    gap,
    aln: { pattern: aln, score: aln ? alnInfo.score : 0, label: alnInfo.label },
    priorDay,
    vixGate,
    sideLean,
    score,
    chips,
  };
}
