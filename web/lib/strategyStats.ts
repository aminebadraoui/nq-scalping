/* ------------------------------------------------------------------ *
 * Strategy identity + measured stats — the single source of truth for
 * the strategy name and win-rate line every Telegram card prints.
 *
 * Numbers: the LIVE brackets are the 651-session live-style replay
 * (counterGateScratch/rthCapScratch convention: limit entries, drift
 * rules, current stop/target knobs); where a card still trades the
 * market-entry bracket the research replay numbers are kept and marked
 * "(research)". The per-card stat line and the heads-up WR summary both
 * read from here so the numbers can never drift apart.
 * ------------------------------------------------------------------ */

export type StrategyStat = {
  /** short strategy name printed in the card's title */
  name: string;
  /** one-line measured stat printed in italics under the ticket */
  stat: string;
  /** short win-rate fragment for the heads-up summary line */
  wrShort: string;
};

export const STATS = {
  momentum: {
    name: "MOMENTUM",
    stat: "WR 77.5% · PF 2.98 · 4,822 replay trades (market-entry research)",
    wrShort: "momentum 68%",
    /** both triggers fire on the same bar (market-entry replay) */
    aPlus: "78.9% WR (research bracket)",
    /** the day's first card (market-entry replay) */
    firstOfDay: "77.2% WR · PF 3.15 (research bracket)",
    /** the LIVE expansion path: 1-pt retrace limit, brackets rebuilt
     *  from the fill (entryQuality study, 649 sessions, train+test) */
    expRetrace: "WR 68% · PF 1.29 · 649-session entryQuality redesign",
  },
  sessionContinuation: {
    name: "SESSION CONTINUATION",
    // the LIVE bracket is the limit-entry redesign (TTL 9 min, 0.5× stop,
    // 2.5R target) — measured on the 651-session live-style replay; the
    // 82.2% / 0.75R numbers are the market-entry RESEARCH optimum only
    stat: "WR 37.7% · PF 1.49 · 9,009 replay trades · 2.5R limit bracket",
    wrShort: "session 37.7%",
    /** A+ tier: >=65% one-sided (0.75R research replay) */
    aPlus: "80.1% WR · PF 3.07 (0.75R research)",
  },
  openDrive: {
    name: "OPEN DRIVE",
    // the live card trades TP15/SL35 (93% hit); 96% is the TP10/SL30 variant
    stat: "93% hit @ TP15/SL35 · 87% of days",
    wrShort: "drive 93%",
  },
  openPullback: {
    name: "MORNING PULLBACK",
    stat: "69.8% WR · +5.2 pts net · 440 trades",
    wrShort: "pullback 69.8%",
  },
  openSniper: {
    name: "9:36 SNIPER",
    stat: "55.8% WR · +6.5 pts net (longs)",
    wrShort: "sniper 55.8%",
  },
  lvnReversal: {
    name: "LVN REVERSAL",
    stat: "37% win · PF 2.16 · 683 sessions",
    wrShort: "reversal 37%",
  },
  sweepReclaim: {
    name: "SWEEP-RECLAIM FADE",
    stat: "67% lab win @ 1R",
    wrShort: "sweep-reclaim 67%",
  },
} as const;

/** the one-line WR summary printed on the unusual-volume heads-up card */
export function headsUpWrLine(): string {
  return `WR: ${STATS.momentum.wrShort} · ${STATS.sessionContinuation.wrShort} · ${STATS.openDrive.wrShort} · ${STATS.openPullback.wrShort} · ${STATS.openSniper.wrShort}`;
}
