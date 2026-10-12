/* ------------------------------------------------------------------ *
 * Side-filter card chips — the measured one-sided cells from
 * scripts/sideFilterStudy.ts + docs/research/side-filter-study-2026-10-09.md,
 * printed on the live momentum card as journal-only labels (same
 * contract as seasonal.ts / esJoin.ts: labels only, never gates).
 *
 * Only the cells computable IN-MEMORY at signal time print here:
 *   · P2 LONG-ONLY 74%     — Asia engulfs London (chop containment);
 *     longs n=46 73.9% WR / +2.23 pt, shorts the ONLY negative cell
 *     (−0.47 pt). Pattern known once London completes (08:00 ET).
 *   · P4 SHORT-ONLY 84%    — late-night 23–02 ET; shorts n=38 84% WR /
 *     +4.11 pt, train 80 / test 89.
 *   · 08–09 SHORT-ONLY 89% — the pre-open hour, non-FOMC days only;
 *     shorts n=38 89% WR / +4.42 pt, train 87 / test 100 (test n=8 —
 *     watch-item). Longs in the same window 66–68%.
 *
 * The gap-regime rules (mid gaps → longs, large gap up → shorts) need
 * the prior RTH close, which the live card path does not hold in
 * memory — they ride in the briefing chips (lib/biasChips.ts sideLean)
 * where the archive provides it.
 *
 * Pure functions of signal fields; unit-tested.
 * ------------------------------------------------------------------ */

import type { AlnPattern } from "./biasChips";
import { sessionDateOf, FOMC_DAYS } from "./seasonal";

export type SideFilterChips = {
  labels: string[];
  features: {
    sideFilterAlnP2?: boolean;
    sideFilterP4ShortLate?: boolean;
    sideFilterPreOpenShort?: boolean;
  };
};

/** The three in-memory one-sided chips. `aln` is the session ALN pattern
 *  (callers compute it once per check); it is only USED for entries at
 *  08:00 ET+ when the London range is complete. */
export function sideFilterChips(s: { t: string; d: string; hourET: number; aln: AlnPattern | null }): SideFilterChips {
  const labels: string[] = [];
  const features: SideFilterChips["features"] = {};

  /* ALN rules — only after London completes (08:00 ET) */
  if (s.hourET >= 8 && s.aln) {
    if (s.aln === "P2") {
      features.sideFilterAlnP2 = true;
      labels.push("P2 LONG-ONLY 74%");
    }
    if (s.aln === "P4" && (s.hourET >= 23 || s.hourET <= 2)) {
      features.sideFilterP4ShortLate = true;
      labels.push("P4 23–02 SHORT-ONLY 84%");
    }
  }

  /* pre-open shorts — non-FOMC days only (the measured cell was fomc=other) */
  const preOpen = s.hourET === 8 || s.hourET === 9;
  if (preOpen) {
    const session = sessionDateOf(s.t, s.d);
    const [y, m, dd] = session.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
    if (!FOMC_DAYS.has(session) && !FOMC_DAYS.has(next)) {
      features.sideFilterPreOpenShort = true;
      labels.push("08–09 SHORT-ONLY 89%");
    }
  }

  return { labels, features };
}
