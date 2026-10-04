/* ------------------------------------------------------------------ *
 * Seasonal card chips — calendar facts as journal-only labels.
 *
 * The seasonal almanac (scripts/seasonalAlmanac.ts + docs/research/
 * seasonal-almanac-2026-10-05.md) measured every calendar window across
 * the momentum-card replay (649 sessions, 3,266 sequential trades,
 * 0.5 pt cost, 2026-01-01 split). Three cells beat baseline AND agreed
 * across train/test — these chips are those cells, printed on the card
 * exactly like the ES chips:
 *
 *   · FOMC DAY      — 99 trades, 83.8% WR / PF 5.16, train 81.7 / test 89.3
 *     (the pre-announcement drift: +94 pts in the 24h into the decision)
 *   · PRE-FOMC      — 138 trades, 67.4% WR / PF 1.64, train 71.7 / test 53.1
 *     (the worst cell in the study; the full pre-FOMC day drifts negative)
 *   · HOUR 3–7 ET   — 904 trades, 79.8% WR / PF 3.27, train 79.3 / test 81.0
 *     (the prime window, sitting on the overnight-drift leg)
 *
 * Chips are LABELS ONLY — nothing here votes, gates, or blocks (same
 * contract as esJoin.ts). Pure functions of the signal's own fields;
 * unit-tested.
 *
 * Date convention: chips key off the signal's RTH trading day, not the
 * minute's calendar date — a bar at 17:00–23:59 CT belongs to the next
 * calendar day's session file, which is how the almanac tagged trades.
 * ------------------------------------------------------------------ */

import { FOMC_DECISION_DAYS } from "./newsGate";

/* FOMC decision days before the current-year calendar in newsGate —
 * historical only, used by backtests and unit tests. */
const FOMC_HISTORICAL = [
  "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31",
  "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30",
  "2025-09-17", "2025-10-29", "2025-12-10",
];

export const FOMC_DAYS: Set<string> = new Set([...FOMC_HISTORICAL, ...FOMC_DECISION_DAYS]);

/** The RTH trading day for a feed-clock minute: minutes 17:00–23:59 CT are
 *  the evening leg of the NEXT calendar day's session. */
export function sessionDateOf(t: string, d: string): string {
  const h = Number(t.slice(0, 2));
  if (h < 17) return d;
  const [y, m, dd] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
}

export type SeasonalChips = {
  labels: string[];
  features: {
    seasonalFomcDay?: boolean;
    seasonalPreFomc?: boolean;
    seasonalHour37?: boolean;
  };
};

const HOUR37_LO = 3;
const HOUR37_HI = 7;

/** The three measured seasonal chips for a card (journal-only labels).
 *  s = the signal's feed fields: t "HH:mm" CT, d minute calendar date,
 *  hourET (CT + 1). */
export function seasonalChips(s: { t: string; d: string; hourET: number }): SeasonalChips {
  const labels: string[] = [];
  const features: SeasonalChips["features"] = {};

  const session = sessionDateOf(s.t, s.d);
  if (FOMC_DAYS.has(session)) {
    features.seasonalFomcDay = true;
    labels.push("FOMC DAY 84%");
  } else {
    const [y, m, dd] = session.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
    if (FOMC_DAYS.has(next)) {
      features.seasonalPreFomc = true;
      labels.push("PRE-FOMC 67%");
    }
  }

  if (s.hourET >= HOUR37_LO && s.hourET <= HOUR37_HI) {
    features.seasonalHour37 = true;
    labels.push("HOUR 3–7 ET 80%");
  }

  return { labels, features };
}
