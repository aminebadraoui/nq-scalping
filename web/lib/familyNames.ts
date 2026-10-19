/* ------------------------------------------------------------------ *
 * One naming scheme for strategies across every surface (UI, insights,
 * narratives). Internal family ids never leak into user-facing or
 * AI-facing text.
 *
 * 2026-10-19 rename: every strategy got a name that says what it DOES.
 * Legacy keys (momentum_flush, rth, …) are kept mapped to the new
 * labels so historical rows (Neon, daybook, exec ledger) still render.
 * ------------------------------------------------------------------ */

export const FAMILY_LABEL: Record<string, string> = {
  // strategies (canonical ids)
  failed_flush_breakout: "Failed-Flush Breakout",
  huge_bar_expansion: "Huge-Bar Expansion",
  session_continuation: "Session Continuation",
  open_drive: "Open Drive",
  open_pullback: "Morning Pullback",
  open_sniper: "9:36 Sniper",
  sweep_reclaim: "Sweep-Reclaim Fade",
  lvn_reversal: "LVN Reversal Box",
  // legacy strategy ids (rename bridge — same labels)
  momentum_flush: "Failed-Flush Breakout",
  momentum_expansion: "Huge-Bar Expansion",
  rth: "Session Continuation",
  reversal: "LVN Reversal Box",
  // group / plumbing families
  momentum: "MOMENTUM",
  open: "OPEN",
  momentum_bigbar: "Big-Bar Continuation",
  pullback_ticket: "Pullback Ticket",
  unusual_volume: "Unusual Volume",
  gap_alerts: "Gap Alerts",
  other: "OTHER",
};

export const familyName = (f: string): string => FAMILY_LABEL[f] ?? f;
