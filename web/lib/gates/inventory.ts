/* ------------------------------------------------------------------ *
 * Gate inventory — the REGIME layer between a signal and a ticket.
 *
 * A gate = anything that decides WHEN and WHERE a strategy is allowed to
 * execute (time windows, news blackouts, tape confirmation, counter-
 * gates, self-improvement overrides, vetoes) — distinct from the RISK
 * layer, which protects the ACCOUNT (floor, target, consistency, day
 * plan). The /gates tab renders this inventory; the live rows come from
 * /api/gc?action=health → execution.rules (groups: session, card) and
 * execution.feeds / liveFeed (tape gate).
 *
 * Pure data — one home for the regime story. Source: the 2026-10-11
 * architecture review §2.6 (docs/architecture/ARCHITECTURE-REVIEW.md)
 * and the live-pipeline sweep of lib/signalFeed.ts.
 * ------------------------------------------------------------------ */

export type GateGroup = "regime" | "session" | "card" | "account";

export type GateEntry = {
  id: string;
  name: string;
  group: GateGroup;
  /** the one-line answer to "what does this gate decide?" */
  decides: string;
  /** where it is enforced */
  where: string;
  /** config: env knob / DB-driven / hardcoded */
  knob: string;
  /** live source in the health payload ("" = inventory-only) */
  liveSource: string;
};

export const GATES: GateEntry[] = [
  {
    id: "signal-window",
    name: "Signal window",
    group: "regime",
    decides: "the feed only runs Sun 18:00 → Fri 16:00 ET (daily 16–18 halt) — cards cannot exist outside it",
    where: "lib/signalFeed.ts:2284 · lib/marketHours.ts:108-118",
    knob: "hardcoded calendar",
    liveSource: "execution.market",
  },
  {
    id: "feed-freshness",
    name: "Feed freshness",
    group: "regime",
    decides: "no cards when the GoCharting feed is disconnected, younger than 5 minutes, or the last tick is stale",
    where: "lib/signalFeed.ts:594-605",
    knob: "hardcoded",
    liveSource: "execution.liveFeed",
  },
  {
    id: "tape-gate",
    name: "Tape gate (candle confirmation)",
    group: "regime",
    decides: "holds all cards while the trigger bar is tick-built instead of vendor-candle-built; pages the operator at ≥8 unconfirmed bars",
    where: "lib/signalFeed.ts:474-536",
    knob: "hardcoded (TAPE_GATE_TAIL_ALERT=8)",
    liveSource: "execution.liveFeed.tapeGateTail",
  },
  {
    id: "feed-flags",
    name: "FEED_* family switches",
    group: "regime",
    decides: "which strategies exist at all (momentum / RTH / open drive live; the rest off)",
    where: "lib/signalFeed.ts:112-161",
    knob: "env (Coolify)",
    liveSource: "execution.feeds",
  },
  {
    id: "news-blackout",
    name: "News blackout",
    group: "session",
    decides: "no card inside a release window (FOMC −10/+20 min, BLS −5/+10); funded adds the MFF T1 ±3 min ban; skipped candidates are journaled",
    where: "lib/newsGate.ts calendar · lib/accountGuard.ts:319-333",
    knob: "hardcoded calendar (refreshed annually)",
    liveSource: "",
  },
  {
    id: "bar-freshness",
    name: "Bar freshness + dedupe",
    group: "session",
    decides: "the trigger must be the just-closed bar, and one card per day/bar/strategy (the day's first momentum card is marked 1st today)",
    where: "lib/signalFeed.ts:959 · dedupe sets :432-437",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "strategy-overrides",
    name: "Self-improvement overrides",
    group: "card",
    decides: "approved strategy_overrides rows filter the next card without a deploy: family enable, hour veto, trend filter, min break fraction/range, max risk, first-of-day only",
    where: "lib/signalFeed.ts:981-1020 → lib/strategyOverrides.ts:90-165",
    knob: "DB (strategy_overrides table, 5-min cache)",
    liveSource: "execution.rules",
  },
  {
    id: "ticket-veto",
    name: "Ticket expectancy veto",
    group: "card",
    decides: "vetoes a momentum card when its measured cell expectancy is below the bar (unmeasured cells fail open)",
    where: "lib/ticketVeto.ts:33-55",
    knob: "env (TICKET_MIN_EXP_PTS, 0 = off)",
    liveSource: "",
  },
  {
    id: "rth-counter-gate",
    name: "RTH counter-signal gate",
    group: "card",
    decides: "skips an RTH entry when it sits within PTS of an opposite-side winner in the last MIN minutes (owner-approved, 651-session validated)",
    where: "lib/signalFeed.ts:1636-1672 · lib/rthExitLog.ts",
    knob: "env (RTH_COUNTER_GATE_MIN/_PTS, 0 = off)",
    liveSource: "",
  },
  {
    id: "rth-daily-cap",
    name: "RTH daily card cap",
    group: "card",
    decides: "skips RTH cards beyond the first N of the day (the gap-only validation: first-3 keeps the consistency cap safe at real frictions)",
    where: "lib/signalFeed.ts:1673-1704",
    knob: "env (RTH_MAX_CARDS_PER_DAY, 0 = off)",
    liveSource: "",
  },
  {
    id: "card-gate",
    name: "Card gate (box pipeline)",
    group: "card",
    decides: "reversal card only: every directional box agrees + all 3 required ingredients + ≥4/6 present + 2 footprint filters",
    where: "lib/signals.ts:161-174",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "crossed-prices",
    name: "Crossed-stop / crossed-limit at dispatch",
    group: "card",
    decides: "refuses the order when the tape already traded through the stop or limit (1 pt) before dispatch",
    where: "lib/crossTrade.ts:579-597 (+ feed + re-send copies)",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "kill-switch",
    name: "Trading halt (kill switch)",
    group: "account",
    decides: "operator hard stop: all orders refused, cards become info-only; resume is password-gated",
    where: "lib/tradingHalt.ts · lib/crossTrade.ts:565",
    knob: "operator file (trading-halt.json)",
    liveSource: "execution.tradingHalt",
  },
];

/** the /gates tab's live board: session + card groups only (the account
 *  group belongs to /risk — the account-protection layer). */
export const REGIME_GROUPS: GateGroup[] = ["regime", "session", "card"];

export const gateById = (id: string): GateEntry | undefined => GATES.find((g) => g.id === id);
