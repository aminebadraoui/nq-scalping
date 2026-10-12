/* ------------------------------------------------------------------ *
 * One naming scheme for strategies across every surface (UI, insights,
 * narratives). Internal family ids (momentum_flush, rth, …) never leak
 * into user-facing or AI-facing text.
 * ------------------------------------------------------------------ */

export const FAMILY_LABEL: Record<string, string> = {
  momentum_flush: "MOM·flush",
  momentum_expansion: "MOM·expansion",
  momentum: "MOM",
  rth: "RTH",
  open: "OPEN",
  open_drive: "OPEN DRIVE",
  open_pullback: "OPEN PULL",
  open_sniper: "SNIPER",
  sweep_reclaim: "SWEEP-RECLAIM",
  reversal: "REVERSAL",
  other: "OTHER",
};

export const familyName = (f: string): string => FAMILY_LABEL[f] ?? f;
