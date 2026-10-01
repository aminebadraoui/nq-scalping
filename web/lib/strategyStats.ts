/* ------------------------------------------------------------------ *
 * Strategy identity + measured stats — the single source of truth for
 * the strategy name and win-rate line every Telegram card prints.
 *
 * Numbers are the 568-session lookahead-free replay (PLAYBOOK.md) or,
 * where noted, the lab study. The per-card stat line and the heads-up
 * WR summary both read from here so the numbers can never drift apart.
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
    stat: "WR 77.5% · PF 2.98 · 4,822 replay trades",
    wrShort: "momentum 77.5%",
    /** both triggers fire on the same bar */
    aPlus: "78.9% WR",
    /** the day's first card */
    firstOfDay: "77.2% WR · PF 3.15",
  },
  rth: {
    name: "RTH",
    stat: "WR 82.2% · PF 3.47 · 10,325 replay trades",
    wrShort: "RTH 82.2%",
    /** A+ tier: >=65% one-sided */
    aPlus: "80.1% WR · PF 3.07",
  },
  openDrive: {
    name: "OPEN DRIVE",
    // the live card trades TP15/SL35 (93% hit); 96% is the TP10/SL30 variant
    stat: "93% hit @ TP15/SL35 · 87% of days",
    wrShort: "drive 93%",
  },
  openPullback: {
    name: "OPEN PULLBACK",
    stat: "69.8% WR · +5.2 pts net · 440 trades",
    wrShort: "pullback 69.8%",
  },
  openSniper: {
    name: "OPEN SNIPER",
    stat: "55.8% WR · +6.5 pts net (longs)",
    wrShort: "sniper 55.8%",
  },
  reversal: {
    name: "REVERSAL",
    stat: "37% win · PF 2.16 · 683 sessions",
    wrShort: "reversal 37%",
  },
  sweepReclaim: {
    name: "SWEEP-RECLAIM",
    stat: "67% lab win @ 1R",
    wrShort: "sweep-reclaim 67%",
  },
} as const;

/** the one-line WR summary printed on the unusual-volume heads-up card */
export function headsUpWrLine(): string {
  return `WR: ${STATS.momentum.wrShort} · ${STATS.rth.wrShort} · ${STATS.openDrive.wrShort} · ${STATS.openPullback.wrShort} · ${STATS.openSniper.wrShort}`;
}
