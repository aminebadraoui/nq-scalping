/* ------------------------------------------------------------------ *
 * Cost-adjusted ticket veto — a pre-send expectancy gate for the
 * momentum / expansion / RTH tickets.
 *
 * Research input (NOT a validation — sweeps only, no account sim):
 *   · hourExpectancyStudy.ts  — 649 sessions, first-touch, 60-bar,
 *     0.5 pt cost: expected pts/trade per family × hour bucket
 *   · expansionStudy.ts       — adds the side split for the close
 *     window (expansion shorts 16:00–17:00 ET: +0.75 pts/trade)
 *
 * The gate is OFF unless TICKET_MIN_EXP_PTS is a positive number —
 * enabling it is a live-execution env change and needs the explicit
 * approval step (EXEC_CHANGE_POLICY rule 4). A ticket is vetoed when
 * its measured cell expectancy is below the bar; unmeasured cells
 * fail OPEN (no veto) so a table gap can never silently kill tickets.
 *
 * Live costs today: ~0.65 pt/trade commissions before slippage, so a
 * sensible bar sits around 1.0–1.25 pts — below that a ticket cannot
 * pay its own costs even at the measured win rate.
 * ------------------------------------------------------------------ */

export type TicketCtx = {
  family: string; // failed_flush_breakout | huge_bar_expansion | session_continuation
  hourBucket: string; // the tradeStats hourBucketOf value
  dir?: "long" | "short"; // side-specific cells override the bucket cell
};

/** expected pts/trade per family × hour bucket (0.5 pt cost, 60-bar exit) */
export const TICKET_EXPECTANCY: Record<string, Record<string, number>> = {
  failed_flush_breakout: {
    globex_early: 2.22,
    globex_core: 1.91,
    globex_late: 2.14,
    globex_dawn: 2.73,
    premkt: 2.17,
    close: 2.23,
  },
  huge_bar_expansion: {
    globex_early: 2.38,
    globex_core: 2.52,
    globex_late: 2.52,
    globex_dawn: 2.65,
    premkt: 2.75,
    close: 1.42,
  },
  session_continuation: {
    rth: 3.86,
  },
};

/** side-specific overrides: "<family>/<bucket>/<dir>" → expected pts */
export const TICKET_EXPECTANCY_SIDES: Record<string, number> = {
  "huge_bar_expansion/close/long": 2.13,
  "huge_bar_expansion/close/short": 0.75,
};

/** the active bar in pts/trade; 0 or unset = gate OFF */
export function ticketVetoBar(): number {
  const v = Number(process.env.TICKET_MIN_EXP_PTS);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export type VetoDecision = { veto: boolean; reason: string };

/** pure gate decision — unit-tested. Unknown cells fail OPEN. */
export function ticketVetoDecision(ctx: TicketCtx, barPts: number): VetoDecision {
  if (!(barPts > 0)) return { veto: false, reason: "ticket gate off" };
  let exp: number | undefined;
  if (ctx.dir) {
    exp = TICKET_EXPECTANCY_SIDES[`${ctx.family}/${ctx.hourBucket}/${ctx.dir}`];
  }
  if (exp === undefined) exp = TICKET_EXPECTANCY[ctx.family]?.[ctx.hourBucket];
  if (exp === undefined) return { veto: false, reason: "ticket gate: unmeasured cell" };
  if (exp < barPts) {
    return { veto: true, reason: `ticket veto: expected +${exp.toFixed(2)} pts/trade < bar ${barPts.toFixed(2)}` };
  }
  return { veto: false, reason: "ticket gate: expected pts ≥ bar" };
}
