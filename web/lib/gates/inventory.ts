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
 * Every entry answers one question: should THIS card, in THIS context,
 * be allowed to fire? Pure data — one home for the regime story.
 * Source: the 2026-10-11 architecture review §2.6
 * (docs/architecture/ARCHITECTURE-REVIEW.md) and the live-pipeline
 * sweep of lib/signalFeed.ts.
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
    decides: "blocks everything outside the trading week — the feed runs Sun 18:00 → Fri 16:00 ET, with a daily 16:00–18:00 halt",
    where: "lib/signalFeed.ts:2284 · lib/marketHours.ts:108-118",
    knob: "hardcoded calendar",
    liveSource: "execution.market",
  },
  {
    id: "feed-freshness",
    name: "Feed freshness",
    group: "regime",
    decides: "blocks all cards when the GoCharting feed is disconnected, has fewer than 5 live minutes, or the last tick is stale (closed market / maintenance)",
    where: "lib/signalFeed.ts:594-605",
    knob: "hardcoded",
    liveSource: "execution.liveFeed",
  },
  {
    id: "tape-gate",
    name: "Tape gate (candle confirmation)",
    group: "regime",
    decides: "holds every card until the trigger bar is confirmed by the vendor candle feed — tick-built bars are a lossy sample of the real tape; pages the operator at ≥8 unconfirmed bars",
    where: "lib/signalFeed.ts:474-536",
    knob: "hardcoded (TAPE_GATE_TAIL_ALERT=8)",
    liveSource: "execution.liveFeed.tapeGateTail",
  },
  {
    id: "feed-flags",
    name: "FEED_* family switches",
    group: "regime",
    decides: "switches whole families on or off — momentum, RTH and open drive live; pullback, sniper, reversal, sweep-reclaim and the alert feeds off until switched",
    where: "lib/signalFeed.ts:112-161",
    knob: "env (Coolify)",
    liveSource: "execution.feeds",
  },
  {
    id: "news-blackout",
    name: "News blackout",
    group: "session",
    decides: "blocks cards inside release windows (FOMC −10/+20 min, BLS −5/+10 min); funded also bans MFF T1 news ±3 min — skipped candidates are journaled, never silently lost",
    where: "lib/newsGate.ts calendar · lib/accountGuard.ts:319-333",
    knob: "hardcoded calendar (refreshed annually)",
    liveSource: "",
  },
  {
    id: "bar-freshness",
    name: "Bar freshness + dedupe",
    group: "session",
    decides: "only the just-closed bar can fire (no repaint), and one card per day/bar/strategy; the day's first momentum card is marked 1st today",
    where: "lib/signalFeed.ts:959 · dedupe sets :432-437",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "strategy-overrides",
    name: "Self-improvement overrides",
    group: "card",
    decides: "the self-improvement actuator — approved DB rows filter the next card without a redeploy: family on/off, hour veto, trend filter, min break fraction/range, max risk, first-of-day only",
    where: "lib/signalFeed.ts:981-1020 → lib/strategyOverrides.ts:90-165",
    knob: "DB (strategy_overrides table, 5-min cache)",
    liveSource: "execution.rules",
  },
  {
    id: "ticket-veto",
    name: "Ticket expectancy veto",
    group: "card",
    decides: "skips a momentum card whose measured cell expectancy is below the bar — unmeasured cells fail OPEN, so a veto never invents a block",
    where: "lib/ticketVeto.ts:33-55",
    knob: "env (TICKET_MIN_EXP_PTS, 0 = off)",
    liveSource: "",
  },
  {
    id: "rth-counter-gate",
    name: "RTH counter-signal gate",
    group: "card",
    decides: "skips an RTH entry that sits within N points of an opposite-side winner from the last M minutes — the tape just proved the other direction (owner-approved, 651-session validated)",
    where: "lib/signalFeed.ts:1636-1672 · lib/rthExitLog.ts",
    knob: "env (RTH_COUNTER_GATE_MIN/_PTS, 0 = off)",
    liveSource: "",
  },
  {
    id: "rth-daily-cap",
    name: "RTH daily card cap",
    group: "card",
    decides: "caps RTH to the first N cards of the day — first-3 keeps the +$900 consistency cap safe at real frictions",
    where: "lib/signalFeed.ts:1673-1704",
    knob: "env (RTH_MAX_CARDS_PER_DAY, 0 = off)",
    liveSource: "",
  },
  {
    id: "card-gate",
    name: "Card gate (box pipeline)",
    group: "card",
    decides: "reversal card only: every directional box must agree, all 3 required ingredients present, ≥4/6 confirmation, and both footprint filters pass",
    where: "lib/signals.ts:161-174",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "crossed-prices",
    name: "Crossed-stop / crossed-limit at dispatch",
    group: "card",
    decides: "refuses the order when the tape already traded through its stop or limit (1 pt) before dispatch — the price no longer exists",
    where: "lib/crossTrade.ts:579-597 (+ feed + re-send copies)",
    knob: "hardcoded",
    liveSource: "",
  },
  {
    id: "kill-switch",
    name: "Trading halt (kill switch)",
    group: "account",
    decides: "the operator's hard stop: every order refused, cards become info-only; resuming requires the admin password",
    where: "lib/tradingHalt.ts · lib/crossTrade.ts:565",
    knob: "operator file (trading-halt.json)",
    liveSource: "execution.tradingHalt",
  },
];

/** the /gates tab's live board: session + card groups only (the account
 *  group belongs to /risk — the account-protection layer). */
export const REGIME_GROUPS: GateGroup[] = ["regime", "session", "card"];

export const gateById = (id: string): GateEntry | undefined => GATES.find((g) => g.id === id);
