/* ------------------------------------------------------------------ *
 * Account attribution — the ONE source of truth for which trading
 * account a journal entry belongs to.
 *
 * Rules (in order):
 *   1. FIRE-TIME — the account name stamped on the row at write time
 *      (`trades.account` from the fill record's accountName, written by
 *      scripts/reconcileTrades.ts) always wins. Source: "fire-time".
 *   2. TIMELINE — legacy rows without a stamp fall back to the known
 *      account-switch timeline (deploy/STATE.md "Account history", the
 *      same timeline the weekly-review backfill used):
 *        ≤ 2026-10-14  MFFUSFREOD706880008  (sim funded)
 *        2026-10-15    MFFUEVREOD706880009  (fresh eval)
 *        ≥ 2026-10-16  DEMO2323960          (current demo)
 *      Source: "timeline".
 *
 * Every surface that shows a trade's account (journal, weekly review,
 * trade ledger, Telegram cards) must go through resolveAccount() —
 * never its own constants. Keep the timeline in this one file.
 * ------------------------------------------------------------------ */

export type AccountSource = "fire-time" | "timeline" | "";

export type AccountAttribution = { account: string; source: AccountSource };

export type TimelineStep = { untilDay: string; account: string };

/** Known switch timeline, oldest first; the last step is open-ended. */
export const ACCOUNT_TIMELINE: TimelineStep[] = [
  { untilDay: "2026-10-14", account: "MFFUSFREOD706880008" },
  { untilDay: "2026-10-15", account: "MFFUEVREOD706880009" },
  { untilDay: "9999-12-31", account: "DEMO2323960" },
];

/** timeline fallback for a trading day ("YYYY-MM-DD") */
export function accountForDay(day: string): string {
  for (const step of ACCOUNT_TIMELINE) {
    if (day <= step.untilDay) return step.account;
  }
  // unreachable (last step is open-ended) — fail closed to the current
  return ACCOUNT_TIMELINE[ACCOUNT_TIMELINE.length - 1].account;
}

/** the canonical attribution: stored fire-time stamp wins, timeline fills. */
export function resolveAccount(storedAccount: unknown, day: string): AccountAttribution {
  const stored = typeof storedAccount === "string" ? storedAccount.trim() : "";
  if (stored) return { account: stored, source: "fire-time" };
  return { account: accountForDay(day), source: "timeline" };
}

/** UI shorthand: the last 4 characters of the account id. */
export function shortAccount(account: string): string {
  return account ? account.slice(-4) : "";
}

/** The "recent era" accounts — the fresh-eval reset (2026-10-15) onward.
 *  Research surfaces use this for their new/old account split. */
export const RECENT_ACCOUNTS: ReadonlySet<string> = new Set(["MFFUEVREOD706880009", "DEMO2323960"]);

export function isRecentAccount(account: string): boolean {
  return RECENT_ACCOUNTS.has(account);
}

/** starting balance used for the account P&L headline ($50k eval/demo;
 *  ACCOUNT_START_BALANCE env overrides globally). */
export function startBalanceFor(account: string): number {
  const override = Number(process.env.ACCOUNT_START_BALANCE ?? "");
  if (Number.isFinite(override) && override > 0) return override;
  void account;
  return 50_000;
}
