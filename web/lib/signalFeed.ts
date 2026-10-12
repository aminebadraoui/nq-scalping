/* ------------------------------------------------------------------ *
 * Signal feed — the always-on Telegram loop (LIVE ONLY).
 *
 * Mirrors lib/optionsFeed.ts and lib/live.ts: a long-lived singleton
 * that, every SIGNAL_REFRESH_SECONDS (default 30s), recomputes the full
 * signal from the LIVE GoCharting feed + collected levels and pushes the
 * cards below when their sequence completes.
 *
 * TELEGRAM-SIGNALS-ONLY MODE (owner rule, 2026-10-05): Telegram receives
 * ONLY the trade-signal cards (momentum, RTH, open drive). The
 * unusual-volume heads-up and its pullback watch (FEED_UNUSUAL_VOLUME)
 * and the feed-gap operational alert (FEED_GAP_ALERTS) are OFF by
 * default; the reversal, sweep-reclaim and pullback-ticket cards are
 * also off. Set the FEED_* flags to 1 to re-enable any of them.
 *
 * It is started from instrumentation.ts so it runs without any browser
 * being open. It is deliberately LIVE-ONLY: if the tick feed is not
 * connected or the last print is stale (market closed / maintenance
 * break), it produces nothing — a closed-market signal has no value.
 * Collected data is used only for the static level stack.
 * ------------------------------------------------------------------ */

import { getLive } from "./live";
import { getOptionsFeed } from "./optionsFeed";
import { optionsSnapshot } from "./gcdata";
import type { FootprintMinute } from "./gcdata";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, midOf, type MomentumSignal } from "./momentum";
import { buildEsContext, esCardChips, type EsContext, type EsMinute } from "./esJoin";
import { seasonalChips } from "./seasonal";
import { roundNumberChips } from "./roundNumbers";
import { gapInventory, gapChips } from "./gapTracker";
import { wallProxChips } from "./wallProx";
import { readOptionsFromSnapshot, wallsFromRead, type OptionsRead } from "./options";
import { applyWallStop } from "./wallStop";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "./openDrive";
import { detectSoftMomentum, SOFT_PROD } from "./softMomentum";
import { momentumSize, cappedContracts, daySizeMultiplier, parseSizeTiers, DEFAULT_SIZE_TIERS, PROP_RISK_PER_TRADE } from "./propRules";
import {
  loadCollectedContext,
  computeSignal,
  liveMinutesToFootprint,
  liveVwap,
  type CollectedContext,
  type SignalSnapshot,
} from "./signalEngine";
import { detectOneSidedReclaim } from "./reclaimSetup";
import { contractsForRisk, RAPID_EOD_50K } from "./propRules";
import { rvol, isUnusualVolume } from "./volumeProfile";
import { utcToET, cdtToET, utcToFeedStamp } from "./times";
import { placeOrder, placeScaleOut, type OrderIntent } from "./executor";
import { crossTradeEnabled } from "./crossTrade";
import { runnerTracker } from "./runnerTracker";
import { cardGateOpen } from "./signals";
import { sizeLine } from "./mechanism";
import { uvWatchCheck, type UVWatch } from "./unusualVolume";
import { updateLiveOutcomes } from "./signalOutcomes";
import { sendTelegram } from "./notify";
import { formatSignalHtml, formatReclaimSetupHtml } from "./signalText";
import { recordSignal } from "./signalHistory";
import { domContextForSignal } from "./dom";
import { STATS, headsUpWrLine } from "./strategyStats";
import { getOverrides, decideSignal } from "./strategyOverrides";
import { crossGuardDayPnl, crossGuardSizeMult } from "./crossGuard";
import { newsBlockedNow } from "./newsGate";
import { registerExpectation, registerSendFailure, attachLimitOrderId } from "./execWatch";
import { stopCrossedAtDispatch, limitCrossedAtDispatch } from "./crossTrade";
import { tradingHalted } from "./tradingHalt";
import { counterGateDecision, counterGateParams } from "./rthExitLog";
import { startCycle, markStage, markCheck, markBarAge, finishCycle } from "./execLatency";
import { cachedFootprint, detectMomentumMemo, detectExpansionScalpMemo, detectSoftMomentumMemo, detectOpenDriveMemo } from "./detectorCache";
import { momentumProfile, rthProfile, applyProfile, timeExitAt, type FamilyProfile } from "./profile";
import { registerTimeExit, checkTimeExits } from "./timeExit";
import { logExec } from "./execLog";
import { signalWindowOpen, marketOpenAt } from "./marketHours";
import { ticketVetoDecision, ticketVetoBar } from "./ticketVeto";
import { hourBucketOf } from "./tradeStats";

function refreshSeconds(): number {
  // 15s default (was 30): the momentum/RTH triggers fire only on the
  // just-completed minute bar, so a slower loop skips bars when a tick
  // runs long — 15s halves the miss window. SIGNAL_EVENT_TICK=1 (owner
  // approval) adds an event-driven tick on top so detection latency
  // drops from ~15s to the feed's own emit latency.
  const n = Number(process.env.SIGNAL_REFRESH_SECONDS);
  return Number.isFinite(n) && n >= 10 ? n : 15;
}

/** gap in minutes between two feed-clock "HH:mm" stamps (0 = adjacent;
 *  null = unparseable). Midnight wraps forward. Pure, unit-tested. */
export function feedMinutesGap(prev: string, last: string): number | null {
  const toMin = (s: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const a = toMin(prev);
  const b = toMin(last);
  if (a === null || b === null) return null;
  return (b - a + 1440) % 1440;
}

function symbol(): string {
  return process.env.GOCHARTING_SYMBOL || "NQZ26";
}

/** close epoch (ms) of a completed minute bar from its UTC du+t stamps;
 *  null when unparseable. The tail's du/t basis makes plain key compare
 *  unreliable (the vendor frame re-replaces the tail with a lagging
 *  candle, oscillating the tail between two stamps), so both cadence
 *  rules compare CLOSE EPOCHS against a monotonic max instead. */
export function barCloseMs(bar: { t: string; du?: string } | undefined): number | null {
  if (!bar || !/^\d{2}:\d{2}$/.test(bar.t) || !bar.du) return null;
  const [y, mo, d] = bar.du.split("-").map(Number);
  const [hh, mm] = bar.t.split(":").map(Number);
  const ms = Date.UTC(y, mo - 1, d, hh, mm) + 60_000;
  return Number.isFinite(ms) ? ms : null;
}

/** pure event-tick decision, monotonic over the MAX close ever seen:
 *  · close > max → a new bar appeared → fire
 *  · close == max → remember the source at max; fire only on the
 *    tick→candle confirmation flip (once)
 *  · close == max, already candle-confirmed, but the vendor REVISED the
 *    tail (barsRevision bumped) → fire again — a revision can flip the
 *    tape gate or change a detector output, and the event path must
 *    re-evaluate exactly like the poll path did (barsRevision is the
 *    same signal the detector caches key on).
 *  · close < max → a backward tail oscillation → ignore
 *  Repeat frames and oscillation re-advances can never fire twice. */
export function eventTickDecision(
  prev: { maxCloseMs: number; srcAtMax: string; revAtMax?: number },
  next: { closeMs: number; barSrc: string; revision?: number },
): { fire: boolean; maxCloseMs: number; srcAtMax: string; revAtMax: number } {
  const prevRev = prev.revAtMax ?? 0;
  const rev = next.revision ?? 0;
  if (next.closeMs > prev.maxCloseMs) return { fire: true, maxCloseMs: next.closeMs, srcAtMax: next.barSrc, revAtMax: rev };
  if (next.closeMs === prev.maxCloseMs) {
    const flip = prev.srcAtMax === "tick" && next.barSrc === "candle";
    if (flip) return { fire: true, maxCloseMs: prev.maxCloseMs, srcAtMax: "candle", revAtMax: rev };
    const revised = prev.srcAtMax === "candle" && next.barSrc === "candle" && rev > prevRev;
    if (revised) return { fire: true, maxCloseMs: prev.maxCloseMs, srcAtMax: "candle", revAtMax: rev };
    return { fire: false, maxCloseMs: prev.maxCloseMs, srcAtMax: prev.srcAtMax, revAtMax: prevRev };
  }
  return { fire: false, maxCloseMs: prev.maxCloseMs, srcAtMax: prev.srcAtMax, revAtMax: prevRev };
}

/** pure poll-backstop decision: the interval tick is the safety net only.
 *  Skip while the tail's close epoch is not NEWER than the max the events
 *  have seen — a poll adds nothing there. It fires the moment the buffer
 *  rolls a bar the emits missed (tail advances past the max) or the tail
 *  is unparseable (never guess). */
export function pollBackstopSkip(lastBar: { t: string; du?: string } | undefined, maxCloseMs: number): boolean {
  const close = barCloseMs(lastBar);
  if (close === null) return false;
  return close <= maxCloseMs;
}

/** env feature flags: FEED_* — "1/true/yes/on" enables, "0/false/no/off" disables. */
function feedFlag(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v);
}

/** FEED_REVERSAL — the LVN-reversal scalp card (the full strategy). PAUSED by
 *  default: the owner is building on the volume-footprint alerts first. Set
 *  FEED_REVERSAL=1 to re-enable. */
export const FEED_REVERSAL = feedFlag("FEED_REVERSAL", false);
/** FEED_SWEEP_RECLAIM — the session-extreme sweep-reclaim 1R card. OFF by
 *  default: single-strategy focus (momentum only). The fade products fired
 *  shorts into one-sided runs — the momentum card is the one live product. */
export const FEED_SWEEP_RECLAIM = feedFlag("FEED_SWEEP_RECLAIM", false);
/** FEED_UNUSUAL_VOLUME — the volume-footprint heads-up alert + its pullback
 *  watch context. OFF by default (owner rule: Telegram gets trade signals
 *  only, no volume heads-ups, no pullback watch messages). The pullback
 *  trade ticket is gated separately by FEED_PULLBACK_TICKET. */
export const FEED_UNUSUAL_VOLUME = feedFlag("FEED_UNUSUAL_VOLUME", false);
/** FEED_PULLBACK_TICKET — the pullback-exhausted 1R trade ticket. OFF by
 *  default: single-strategy focus means the momentum card is the only
 *  trade signal; the pullback watch still prints its context messages. */
export const FEED_PULLBACK_TICKET = feedFlag("FEED_PULLBACK_TICKET", false);
/** FEED_MOMENTUM — the failed-flush → response → one-sided-breakout momentum
 *  card (lib/momentum.ts, MOM_PROD). THE single active strategy. 77.5% win /
 *  PF 2.98 in the 568-session replay — joins the one-sided run. */
export const FEED_MOMENTUM = feedFlag("FEED_MOMENTUM", true);
/** broker resting-limit entry TTL — the expansion-retrace window is 5 bars;
 *  the broker limit mirrors it and is cancelled by the watcher at expiry
 *  (CROSSTRADE_LIMIT_ENTRIES=1). */
const LIMIT_ENTRY_TTL_MS = 5 * 60_000;
/** FEED_RTH — the RTH soft-continuation card (lib/softMomentum.ts).
 *  ON: footprint-proven continuation — 10,325 trades, 82.2% win, PF 3.47,
 *  every year ≥ 77.7%, account sim never breaches (see PLAYBOOK.md). */
export const FEED_RTH = feedFlag("FEED_RTH", true);
/** RTH daily card cap — the gap-only validation (scripts/gapOnlyValidation.ts,
 *  docs/research/fix-plan-2026-10-05.md) found the first-N RTH cards keep
 *  the eval consistency cap safe at real frictions (first-3 structural:
 *  +4.28 pts/trade, eval PASS). 0 = off. */
export const rthMaxCardsPerDay = (): number => {
  const v = Number(process.env.RTH_MAX_CARDS_PER_DAY);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};
/** FEED_OPEN — master switch for the 9:30-10:30 open family. */
export const FEED_OPEN = feedFlag("FEED_OPEN", true);
/** FEED_OPEN_DRIVE — the scan: first new opening extreme backed by
 *  cumD >= 300 and a >=55% one-sided bar. TP +15 / SL -35. 93% hit
 *  at TP15/SL35 (96% at TP10/SL30), 87% of days. ON. */
export const FEED_OPEN_DRIVE = feedFlag("FEED_OPEN_DRIVE", true);
/** FEED_OPEN_PULLBACK — trend + exhausted pullback + reclaim, 1R.
 *  69.8% win, +5.2 pts, 4 days in 5. OFF until requested. */
export const FEED_OPEN_PULLBACK = feedFlag("FEED_OPEN_PULLBACK", false);
/** FEED_OPEN_SNIPER — the 9:36:01 trade: big flush holding the opening
 *  anchor, resting limit, flush-high target. 55.8% win, +6.5 pts,
 *  ~1 day in 11. OFF until requested. */
export const FEED_OPEN_SNIPER = feedFlag("FEED_OPEN_SNIPER", false);
/** FEED_GAP_ALERTS — the feed-gap operational alert ("possible missed
 *  signal"). OFF by default (owner rule: Telegram gets trade signals
 *  only). The gap detector still runs for the logs; only the push is
 *  silenced. */
export const FEED_GAP_ALERTS = feedFlag("FEED_GAP_ALERTS", false);

/** fixed contracts per card family: the sizing study optimum is 9 for the
 *  momentum + RTH cards (median day +$347, 0% annual breach); the open
 *  family's wide 35-pt drive stop breaches at >=4, so it keeps the
 *  $170-budget sizing. FIXED_CONTRACTS env overrides everything. */
function fixedContracts(defaultN: number): number {
  const f = Number(process.env.FIXED_CONTRACTS) || 0;
  return f > 0 ? Math.min(30, f) : defaultN;
}

const CONTEXT_TTL_MS = 10 * 60 * 1000;
/** a live feed whose last print is older than this is treated as closed */
const STALE_MS = 5 * 60 * 1000;
/** need at least this many live minutes before a reversal can even form */
const MIN_LIVE_MINUTES = 5;
/** stage-2 pullback watch lifetime after an unusual-volume bar (data: dominance breaks within ~1–3 min, p90) */
const UV_WATCH_MS = 6 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Tape-gate watchdog (2026-10-05/06 outage): the candle-confirmation
 * gate held every card family when the vendor's candle data stopped
 * reaching the VPS (intermittent gaps — the tail sometimes recovered,
 * so a wall-clock stall detector never armed while cards stayed held).
 * Cards keep HOLDING on unconfirmed bars (the owner chose hold+alert,
 * not fail-open); this watchdog pages the operator on Telegram when the
 * tail of consecutive unconfirmed completed bars grows past the alert
 * threshold, so a gap pattern can never again look like "a quiet
 * market".
 * ------------------------------------------------------------------ */

/** consecutive trailing tick-source bars needed to page the operator
 *  (healthy merges leave a tail of 1–2). */
export const TAPE_GATE_TAIL_ALERT = 8;
/** while the tail stays above the alert threshold, re-page at most this
 *  often. */
export const TAPE_GATE_REALERT_MS = 30 * 60_000;

/** consecutive trailing bars that are NOT candle-confirmed (the "hole"
 *  at the buffer tail). Pure — unit-tested. */
export function tapeTailCount(fp: FootprintMinute[]): number {
  let n = 0;
  for (let i = fp.length - 1; i >= 0; i--) {
    if ((fp[i].src ?? "tick") === "candle") break;
    n++;
  }
  return n;
}

/**
 * Pure hold/alert decision for the tape gate. `tail < fp.length` guards
 * the fresh-boot case (a buffer that has never seen a candle yet is a
 * seed-in-flight, not a stall). Unit-tested (tests/liveTapeGate.test.ts).
 */
export function tapeGateDecision(
  tailTicks: number,
  totalBars: number,
  now: number,
  lastAlertAt: number,
): { hold: boolean; alert: boolean } {
  const hold = tailTicks >= 1;
  const alert =
    tailTicks >= TAPE_GATE_TAIL_ALERT &&
    tailTicks < totalBars &&
    (lastAlertAt === 0 || now - lastAlertAt >= TAPE_GATE_REALERT_MS);
  return { hold, alert };
}

/** How long the self-heal ladder may work an episode before the operator
 *  page fires (2026-10-07: 8 stalls, 8 auto-heals, 8 noisy pages — most
 *  episodes closed within ~1 min via the first forced fetch). */
export const TAPE_PAGE_DELAY_MS = 120_000;

/**
 * Should the operator actually be paged, given the self-heal ladder's
 * live state? Pure — unit-tested (tests/liveTapeGate.test.ts).
 *   - ladder absent or not in an episode  → page (a blind gate must never
 *     be silenced: tail ≥ 8 with no ladder running is itself the alarm)
 *   - ladder escalated (step ≥ 2: forced fetches failed → reconnect/
 *     re-seed) → page
 *   - episode younger than TAPE_PAGE_DELAY_MS → hold the page (the
 *     ladder's first forced fetch usually confirms the tail in seconds)
 */
export function tapePageDecision(
  heal: { sinceAt: number; step: number } | null,
  now: number,
): boolean {
  if (!heal || heal.sinceAt === 0) return true;
  if (heal.step >= 2) return true;
  return now - heal.sinceAt >= TAPE_PAGE_DELAY_MS;
}

/* ------------------------------------------------------------------ *
 * Expansion retrace entry — the 2026-10-02 trade review's fix for the
 * huge-bar expansion family, validated on 649 sessions (entryQuality
 * study: 44% → 68% WR, −$299K → +$58K, PF 0.57 → 1.29, train+test).
 *
 * No market order at the signal bar's close (pure chase risk). Instead:
 * rest a limit `EXP_RETRACE_PTS` (1 pt) behind the close for up to
 * `EXP_RETRACE_BARS` (5) minutes; if the tape comes back to us, fill
 * there — brackets rebuilt from the fill, risk anchored to the signal's
 * structural stop distance. If the retrace never trades, the signal is
 * skipped (and journaled as such for the insight loop). EXP_RETRACE=0
 * returns expansion to the old immediate market entry.
 * ------------------------------------------------------------------ */
const EXP_RETRACE_PTS = 1.0;
const EXP_RETRACE_BARS = 5;
const expRetraceEnabled = (): boolean => feedFlag("EXP_RETRACE", true);

/**
 * Broker leg of a filled expansion retrace: a RESTING LIMIT at the tape
 * fill price by default. Backtested: scripts/retraceSlippageStudy.ts
 * (649 sessions, --offline) — the market-order path loses −$49/trade at
 * just 0.5 pt of adverse slip (162 W→L flips, zero L→W), while a
 * resting limit can only fill AT or better. CROSSTRADE_LIMIT_ENTRIES=0
 * restores the old market entry as an explicit escape hatch; scale-out
 * pairs (bank + runner) keep the market path because the REST pair has
 * no resting-limit leg.
 */
export function retraceUseLimit(scaleOut: boolean): boolean {
  return process.env.CROSSTRADE_LIMIT_ENTRIES !== "0" && !scaleOut;
}

/** RTH limit-entry redesign (validated by scripts/rthLimitValidation.ts,
 *  2026-10-06): the drift-aware replay showed market entries with absolute
 *  brackets are unfundable (PF 0.50 across 650 sessions) while RESTING-
 *  LIMIT entries at the signal price with a half structural stop and a
 *  2.5R target pass train/OOS/year checks (+$13.8k at $1.90/RT, all years
 *  PASS). OFF by default — RTH_LIMIT_ENTRIES=1 enables; the validated
 *  knobs are the defaults. The TTL default stays under the exec-watch
 *  give-up clock (10 min) so expiry takes the clean limit_expired path. */
export function rthLimitParams(env: Record<string, string | undefined> = process.env): {
  enabled: boolean;
  stopMult: number;
  targetR: number;
  ttlMs: number;
} {
  const num = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    enabled: env.RTH_LIMIT_ENTRIES === "1",
    stopMult: num(env.RTH_LIMIT_STOP_MULT, 0.5),
    targetR: num(env.RTH_LIMIT_TARGET_R, 2.5),
    ttlMs: num(env.RTH_LIMIT_TTL_MS, 9 * 60_000),
  };
}

export type RetraceDecision =
  | { status: "fill"; fill: number; barIdx: number }
  | { status: "expired" }
  | { status: "wait" };

/**
 * Resolve a pending retrace limit against the bars completed since the
 * signal bar. Pure + no lookahead: only bars AFTER the signal are read,
 * the first touch fills, a gap through the level fills at the bar open
 * (better than the limit). Untraded after `windowBars` bars = expired.
 */
export function resolveRetrace(
  bars: Array<{ o: number; high: number; low: number }>,
  dir: "long" | "short",
  level: number,
  windowBars: number,
): RetraceDecision {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const touched = dir === "long" ? b.low <= level : b.high >= level;
    if (!touched) continue;
    const open = b.o > 0 ? b.o : (b.high + b.low) / 2;
    const fill = dir === "long" ? Math.min(open, level) : Math.max(open, level);
    return { status: "fill", fill, barIdx: i };
  }
  return bars.length >= windowBars ? { status: "expired" } : { status: "wait" };
}

/** expansion retrace armed by the momentum card, resolved every tick */
type PendingRetrace = {
  key: string;
  day: string;
  dir: "long" | "short";
  level: number;
  armedIdx: number;
  maxIdx: number;
  sEntry: number;
  sStop: number;
  sTarget: number;
  risk: number;
  fixed: number;
  riskBudget: number;
  scaleOut: boolean;
  t: string;
  aPlus: boolean;
  firstToday: boolean;
  et: string;
  features: Record<string, unknown>;
};

function distTxt(from: number, to: number): string {
  const pts = Math.abs(to - from);
  const ticks = Math.round(pts / 0.25);
  return `${to < from ? "−" : "+"}${pts.toFixed(2)} pts · ${ticks} ticks`;
}

/** day-P&L tiered sizing: shrink contracts as the day's profit climbs
 *  (profit protection + $900 consistency-cap safety). Defaults from the
 *  648-session replay (97% of profit, zero breach days): 2/3 size above
 *  +$300, 1/3 size above +$600. SIZE_TIERS="300:0.66,600:0.33" overrides,
 *  SIZE_TIERS="" disables. */
const sizeTiers = (() => {
  const raw = process.env.SIZE_TIERS;
  return raw === undefined ? DEFAULT_SIZE_TIERS : parseSizeTiers(raw);
})();

/** capture the detector's feature vector at signal time — the input the
 *  strategy analysis layer (lib/strategyInsights.ts) mines for improvement
 *  patterns. Picks the known feature fields; extras layer on top. */
function signalFeatures(s: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const keys = [
    "kind", "flushFrac", "flushVol", "flushRange", "failDepth", "respFrac", "respVol", "respDelay", "respProof",
    "breakFrac", "breakVol", "breakDelay", "refDist", "progressPts", "medVol", "distVwapPts", "cumDelta", "deltaFromFlush",
    "atr14", "riskPts", "trailLowDist", "trailHighDist", "breakRangeR", "breakStack", "breakVwapPos", "flushRangeR",
    "deltaFrac", "domClusters",
    "hourET", "extreme", "buyPct", "dir", "risk",
  ];
  const f: Record<string, unknown> = {};
  for (const k of keys) {
    const v = s[k];
    if (v !== undefined && v !== null) f[k] = v;
  }
  return { ...f, ...extra };
}

function fmtPx(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

class SignalFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** event-driven tick state (SIGNAL_EVENT_TICK=1): the MAX completed-bar
   *  close epoch the subscription has seen + the confirmation source of
   *  that bar, so a live-state emit only triggers a tick when the tail
   *  advances past the max or confirms at the max — backward oscillations
   *  and repeat footprint frames are skipped. revAtMax tracks the buffer
   *  revision at the max so a vendor REVISION of the confirmed tail
   *  re-fires the tick (same close, new revision — the poll path always
   *  re-evaluated revisions; the event path must too). */
  private eventTickMaxClose = 0;
  private eventTickSrcAtMax = "";
  private eventTickRevAtMax = 0;
  private eventTickLast = 0;
  private pollSkipLoggedAt = 0;
  /** coalesced pending tick: a tick that arrived while another was
   *  running is QUEUED (last one wins), never dropped — a dropped event
   *  tick would permanently lose its bar (the max already advanced and
   *  the poll backstop skips it). */
  private pendingTick: "boot" | "poll" | "event" | "tick" | null = null;
  /** per-tick memo epoch — the O(n) chip helpers (esContext, gaps, mid)
   *  are computed once per tick and shared by the three card checkers */
  private tickEpoch = 0;
  private tickMemo: {
    epoch: number;
    fp: FootprintMinute[];
    es: EsContext | null;
    gaps: ReturnType<typeof gapInventory>;
    nqMid: number[];
  } | null = null;
  /** per-tick tape-gate hold memo — the tail/hold are pure functions of
   *  the footprint, computed once per tick and shared by every scan */
  private tapeHoldMemo: { epoch: number; fp: FootprintMinute[]; tail: number; hold: boolean } | null = null;
  /** display-snapshot timer — the heavy computeSignal runs on this 30s
   *  cadence for the dashboard/API, OFF the dispatch-critical tick */
  private displayTimer: ReturnType<typeof setInterval> | null = null;
  private ctxCache: { date: string; ctx: CollectedContext } | null = null;
  private lastCtxLoad = 0;
  private sent = new Set<string>();
  private reclaimSent = new Set<string>();
  private volumeAlerted = new Set<string>();
  private momentumSent = new Set<string>();
  /** RTH cards already emitted per session day (the RTH_MAX_CARDS_PER_DAY cap) */
  private rthDayCount = new Map<string, number>();

  /** the RTH daily-cap counters for the rules board (display-only) */
  rthCapStats(): { day: string; count: number; cap: number } {
    let day = "";
    let count = 0;
    for (const [k, v] of this.rthDayCount) {
      if (k >= day) {
        day = k;
        count = v;
      }
    }
    return { day, count, cap: rthMaxCardsPerDay() };
  }
  /** days that already got a momentum card — the first card of the day is
   *  the best one (77.2% win / PF 3.15 vs 2.96 for the rest), so it gets a
   *  "1st today" marker for the one-trade-per-day discipline. */
  private cardedDays = new Set<string>();
  /** stage-2 watch armed by the latest unusual-volume alert (one at a time) */
  private pullbackWatch: UVWatch | null = null;
  /** expansion retrace limit armed by the momentum card (one at a time) */
  private expRetracePending: PendingRetrace | null = null;
  /** open-window diagnostic minutes already logged (once per bar) */
  private openDiagLogged = new Set<string>();

  /** per-scan throttle for the tape-gate log (one line per minute max) */
  private tapeGateLoggedAt = new Map<string, number>();

  /** last stall Telegram alert (ms) — one per episode, re-paged every
   *  TAPE_GATE_REALERT_MS while the tail stays unconfirmed */
  private tapeGateAlertedAt = 0;
  /** last console line for a HELD page (throttle — the alert re-evaluates
   *  every scan while the ladder works the episode) */
  private tapeGateHeldLoggedAt = 0;

  /** Cards may only fire on a bar confirmed by the vendor footprint candle.
   *  The tick-built tape undercounts volume (~7% of true volume measured
   *  2026-10-05) and produces signals the archive would never generate —
   *  the live-vs-backtest divergence that drove the 2026-10 bleed. The
   *  rolling candle refresh replaces completed bars within a minute or two,
   *  so a lagged fetch DELAYS the card; it never degrades it. */

  private logTapeGate(scan: string) {
    const now = Date.now();
    const prev = this.tapeGateLoggedAt.get(scan) ?? 0;
    if (now - prev < 60_000) return;
    this.tapeGateLoggedAt.set(scan, now);
    console.log(`[tape-gate] ${scan}: last completed bar not candle-confirmed — card deferred`);
  }

  /** Shared gate for every card family: hold while the last completed
   *  bar is tick-source, and page the operator when the tail of
   *  unconfirmed bars grows past TAPE_GATE_TAIL_ALERT (see
   *  tapeGateDecision). */
  private tapeGateHoldsCore(fp: FootprintMinute[], scan: string): boolean {
    // per-tick memo: tail + hold are pure functions of the footprint —
    // all three card checkers share one computation per tick (the alert
    // paging below stays per-scan so its throttles keep working)
    const now = Date.now();
    let tail: number;
    let hold: boolean;
    if (this.tapeHoldMemo && this.tapeHoldMemo.epoch === this.tickEpoch && this.tapeHoldMemo.fp === fp) {
      tail = this.tapeHoldMemo.tail;
      hold = this.tapeHoldMemo.hold;
    } else {
      tail = tapeTailCount(fp);
      hold = tapeGateDecision(tail, fp.length, now, this.tapeGateAlertedAt).hold;
      this.tapeHoldMemo = { epoch: this.tickEpoch, fp, tail, hold };
    }
    if (!hold) return false;
    this.logTapeGate(scan);
    if (tapeGateDecision(tail, fp.length, now, this.tapeGateAlertedAt).alert) {
      if (marketOpenAt(now)) {
        // the self-heal ladder (lib/live.ts) works the same stall the
        // pager sees: hold the page while an episode is young and the
        // ladder hasn't escalated — 8 pages for 8 self-healed stalls on
        // 2026-10-07 was pure noise. A blind gate (no ladder) still pages.
        const heal = getLive().state.heal ?? null;
        if (!tapePageDecision(heal ? { sinceAt: heal.sinceAt, step: heal.step } : null, now)) {
          // keep alertedAt stale so the page still fires the moment the
          // ladder escalates or the episode outlives the delay; throttle
          // the console line so a long episode doesn't spam the log
          if (now - this.tapeGateHeldLoggedAt >= 60_000) {
            this.tapeGateHeldLoggedAt = now;
            console.log(
              `[tape-gate] ${scan}: ${tail} unconfirmed bars — paging held, self-heal ladder active (step ${heal?.step ?? "-"} · ${Math.round((now - (heal?.sinceAt ?? now)) / 1000)}s)`,
            );
          }
          return true;
        }
        this.tapeGateAlertedAt = now;
        const et = new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" });
        void this.push(
          [
            `⚠ <b>TAPE-GATE GAP — every card family held</b>`,
            `<code>${symbol()} · ${et} ET</code>`,
            `The last ${tail} completed bars are not candle-confirmed (vendor candle data gap) — momentum/open/rth cards are all deferred.`,
            `Check /api/gc?action=health → barSource; restart the dashboard container to re-seed the confirmed bars.`,
          ].join("\n"),
        );
        console.log(`[tape-gate] ${scan}: ${tail} unconfirmed bars — operator alerted via Telegram`);
      } else {
        // market closed (weekend / daily 17:00–18:00 halt): no candles can
        // complete, so the tail cannot confirm and re-paging is pure noise —
        // the self-heal ladder pauses too; the pager re-arms after reopen
        this.tapeGateAlertedAt = now;
        console.log(`[tape-gate] ${scan}: ${tail} unconfirmed bars while the market is closed — paging suspended`);
      }
    }
    return true;
  }

  /** timed wrapper for the tape gate (telemetry only — see
   *  lib/execLatency.ts; the feedCheck stage is this duration) */
  private tapeGateHolds(fp: FootprintMinute[], scan: string): boolean {
    const t0 = performance.now();
    try {
      return this.tapeGateHoldsCore(fp, scan);
    } finally {
      markStage("feedCheck", performance.now() - t0);
    }
  }

  lastSnapshot: SignalSnapshot | null = null;
  lastError: string | null = null;
  lastNote: string | null = null;
  lastRun = 0;
  /** true only while the tick feed is connected AND printing now */
  liveOk = false;

  private async ctx(): Promise<CollectedContext | null> {
    if (this.ctxCache && Date.now() - this.lastCtxLoad < CONTEXT_TTL_MS) return this.ctxCache.ctx;
    const c = await loadCollectedContext();
    if (c) {
      this.ctxCache = { date: c.date, ctx: c };
      this.lastCtxLoad = Date.now();
    }
    return c;
  }

  /** per-tick memo for the O(n) chip helpers — momentum/RTH/open each
   *  rebuilt them (esContext twice, gapInventory three times, nqMid
   *  twice) every tick. Keyed by tick epoch + footprint identity: a
   *  mid-tick bar revision still recomputes, cross-tick staleness is
   *  impossible (the epoch advances every tick), and the three checkers
   *  share one computation per tick. */
  private tickChips(fp: FootprintMinute[]): { es: EsContext | null; gaps: ReturnType<typeof gapInventory>; nqMid: number[] } {
    if (this.tickMemo && this.tickMemo.epoch === this.tickEpoch && this.tickMemo.fp === fp) {
      return { es: this.tickMemo.es, gaps: this.tickMemo.gaps, nqMid: this.tickMemo.nqMid };
    }
    const m = {
      epoch: this.tickEpoch,
      fp,
      es: this.esContextRaw(fp),
      gaps: gapInventory(fp),
      nqMid: fp.map((x) => (x.high + x.low) / 2),
    };
    this.tickMemo = m;
    return { es: m.es, gaps: m.gaps, nqMid: m.nqMid };
  }

  /** cross-asset context from the live ES twin buffer, aligned to the NQ
   *  feed-clock minutes (the same utcToFeedStamp conversion the footprint
   *  uses). Null while the ES twin has fewer than 30 usable bars.
   *  Memoized per tick (tickChips) — the ES buffer mutates between
   *  ticks, so a cross-tick cache would serve stale chips. */
  private esContext(fp: FootprintMinute[]): EsContext | null {
    return this.tickChips(fp).es;
  }

  private esContextRaw(fp: FootprintMinute[]): EsContext | null {
    const es = getLive().state.es;
    const mins = es.cur ? [...es.minutes, es.cur] : es.minutes;
    if (mins.length < 30) return null;
    const esArr: EsMinute[] = [];
    for (const m of mins) {
      if (!/^\d{2}:\d{2}$/.test(m.t)) continue;
      const stamp = utcToFeedStamp(m.t, m.du);
      if (!stamp.hhmm) continue;
      esArr.push({ t: stamp.hhmm, d: stamp.day, high: m.h, low: m.l, buy: m.buy, sell: m.sell, total: m.vol, mid: (m.h + m.l) / 2 });
    }
    if (esArr.length < 30) return null;
    return buildEsContext(
      fp.map((x) => ({ t: x.t, d: x.d, high: x.high, low: x.low })),
      esArr,
    );
  }

  /** the options snapshot mapped to NQ points at the given last price —
   *  in-memory only (no network): the wall chips degrade silently while
   *  the options feed has no snapshot yet (journal-only context). */
  private wallReadFor(ltp: number): OptionsRead | null {
    const g = getOptionsFeed().snapshot();
    if (!g || !Number.isFinite(ltp) || ltp <= 0) return null;
    return readOptionsFromSnapshot(g, ltp);
  }

  /** build the current signal — from LIVE data only, or null when closed/stale */
  /** cheap feed-freshness probe — the liveOk/lastNote/bar health WITHOUT
   *  the heavy snapshot compute (aggregate/mechanism/price-action only
   *  feed the reversal card and the dashboard). Runs on EVERY tick so the
   *  health flags stay live; the heavy build runs on the 30s display
   *  cadence (refreshSnapshot), on boot, and on demand (pushNow). */
  private probeFreshness(): boolean {
    const live = getLive().state;
    const liveMins = live.cur ? [...live.minutes, live.cur] : live.minutes;
    const lastTickMs = live.ticks.length ? live.ticks[live.ticks.length - 1].ms : 0;
    const fresh =
      live.connected && liveMins.length >= MIN_LIVE_MINUTES && Date.now() - lastTickMs < STALE_MS;
    if (!fresh) {
      this.liveOk = false;
      this.lastNote = !live.connected
        ? "market closed — tick feed not connected"
        : liveMins.length < MIN_LIVE_MINUTES
          ? "market opening — not enough live minutes yet"
          : "market closed — last print is stale";
      return false;
    }
    this.liveOk = true;
    this.lastNote = "live";
    return true;
  }

  async buildSnapshot(): Promise<SignalSnapshot | null> {
    const ctx = await this.ctx();
    if (!this.probeFreshness()) return null;
    const live = getLive().state;
    let gamma = getOptionsFeed().snapshot();
    if (!gamma) gamma = await optionsSnapshot().catch(() => null);

    const minutes = cachedFootprint(live.minutes, live.barsRevision, live.cur ? live.cur : null);
    if (!minutes.length) return null;

    const last = minutes[minutes.length - 1];
    const lastPrice = live.snapshot?.ltp ?? last.c ?? last.high ?? 0;
    const vwap = liveVwap(minutes);
    const sessionHigh = live.snapshot?.high ?? Math.max(...minutes.map((m) => m.high));
    const sessionLow = live.snapshot?.low ?? Math.min(...minutes.map((m) => m.low));

    return computeSignal(minutes, ctx, {
      lastPrice,
      vwap,
      sessionHigh,
      sessionLow,
      gamma,
      symbol: symbol(),
      source: "live",
    });
  }

  private signature(snap: SignalSnapshot, setup: "REVERSAL" | "PULLBACK"): string {
    const a = snap.analysis;
    const lastRec = a?.reclaims[a.reclaims.length - 1];
    const lastAbs = a?.absorption[a.absorption.length - 1];
    return [
      setup,
      snap.day,
      snap.signal.side ?? "none",
      "rec",
      lastRec ? `${lastRec.t}:${lastRec.price.toFixed(2)}:${lastRec.dir}` : "—",
      "abs",
      lastAbs ? `${lastAbs.t}:${lastAbs.price.toFixed(2)}:${lastAbs.side}` : "—",
    ].join("|");
  }

  /** shrink contracts as the day's profit climbs (tiered sizing) and halve
   *  them while the challenge drawdown from the trailing reference is deep
   *  (the dd600→half rule — apPlan sweep 2026-10-05: funded blow 0.0%) */
  private async applyDayTier(
    size: { contracts: number; dollarRisk: number; capped: boolean },
    riskPts: number,
  ): Promise<{ contracts: number; dollarRisk: number; capped: boolean; mult: number }> {
    const [dayPnl, ddMult] = crossTradeEnabled()
      ? await Promise.all([crossGuardDayPnl(), crossGuardSizeMult()])
      : [0, 1];
    const mult = daySizeMultiplier(dayPnl, sizeTiers) * ddMult;
    const contracts = Math.max(1, Math.round(size.contracts * mult));
    return { contracts, dollarRisk: contracts * riskPts * 2, capped: size.capped, mult };
  }

  /** announce cards? Live feeds always do; dry-run feeds (local dev) are
   *  SILENT by default — they must opt in with TELEGRAM_ALLOW_DRYRUN=1,
   *  so a stale local instance can never confuse the operator again. */
  private announce(): boolean {
    return process.env.EXECUTE_LIVE === "1" || process.env.TELEGRAM_ALLOW_DRYRUN === "1";
  }

  private async push(text: string): Promise<{ sent: boolean; reason: string }> {
    if (!this.announce()) return { sent: false, reason: "announce disabled (dry-run feed)" };
    // while the owner's kill switch is set every card is INFO-ONLY —
    // the signal still flows, the label says no order will be placed
    if (tradingHalted()) {
      text += "\n\n🛑 <b>TRADING HALTED</b> — this signal is for information only (no order will be placed)";
    }
    return sendTelegram(text, { parseMode: "HTML" });
  }

  private async record(input: Parameters<typeof recordSignal>[0]): Promise<void> {
    if (!this.announce()) return;
    // stamp the LIVE DOM picture (iceberg candidates vs entry/stop/target)
    // into the signal's feature vector — observational only, best-effort,
    // and it can never change the signal itself
    let features = input.features ?? null;
    try {
      const dom = domContextForSignal({ entry: input.entry, stop: input.stop, target: input.target });
      features = { ...(features ?? {}), dom };
    } catch {
      /* evidence is optional */
    }
    await recordSignal({ ...input, features });
  }

  /** record a signal the feed vetoed (news blackout / overrides / retrace
   *  expiry / session rollover) — the self-improvement loop needs the FULL
   *  decision set (candidates + their features + the veto reason), not just
   *  the subset that traded, or the miner learns from a biased sample and
   *  rejection counts stay invisible. */
  private async recordSkip(input: {
    timeET: string;
    day: string;
    side: "long" | "short";
    price: number;
    entry: number;
    stop: number;
    target: number;
    verdict: string;
    headline: string;
    reason: string;
    features?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.record({
      timeET: input.timeET,
      day: input.day,
      symbol: symbol(),
      side: input.side,
      price: input.price,
      entry: input.entry.toFixed(2),
      stop: input.stop.toFixed(2),
      target: input.target.toFixed(2),
      size: "—",
      verdict: input.verdict,
      headline: input.headline,
      source: "live",
      test: false,
      sent: false,
      reason: input.reason,
      features: input.features ?? null,
    });
  }

  /** active override snapshot stamped into every recorded decision, so
   *  later analysis can attribute outcomes to the gates that were live
   *  at decision time */
  private gateSnapshot(ov: Array<{ family: string; gate: string }>): string[] {
    return ov.map((o) => `${o.family}.${o.gate}`);
  }

  private async maybeSend(snap: SignalSnapshot): Promise<void> {
    if (!FEED_REVERSAL) return;
    // The card gate (docs/strategy/STRATEGY.md "When a signal exists"): every directional
    // box aligned AND all three required ingredients present — location
    // "yes" = at/inside an LVN, and "no reclaim, no trade" — AND at least
    // one confirmation (present >= 4 of 6). Backtest optimum: 4/6 hits
    // ~PF 2.0 out-of-sample (6/6 never fires, 5/6 leaves PF ~1.7).
    // Pullbacks are deliberately not notified.
    const gate = cardGateOpen(snap.signal, snap.mech);
    if (!gate.ok) return;

    // Footprint signature filters (see docs/research/FOOTPRINT_REVERSAL_RESEARCH.md):
    // 1) a footprint stack forming AGAINST the trade is near-breakeven — skip it.
    // 2) the entry bar's delta must print in the trade direction.
    const lastStack = snap.analysis?.imbalance?.lastStack;
    if (lastStack && lastStack.side !== (snap.mech.side === "long" ? "buy" : "sell")) return;
    const lastDelta = snap.mech.lastDelta;
    if ((snap.mech.side === "long" && lastDelta <= 0) || (snap.mech.side === "short" && lastDelta >= 0)) return;

    const kind = "REVERSAL" as const;
    const read = snap.mech;
    const sig = this.signature(snap, kind);
    if (this.sent.has(sig)) return;
    this.sent.add(sig);
    if (this.sent.size > 500) {
      const keep = [...this.sent].slice(-250);
      this.sent = new Set(keep);
    }

    const text = formatSignalHtml(snap.signal, read, snap.pa, snap.opt, {
      symbol: snap.symbol,
      price: snap.lastPrice,
      timeET: snap.timeET,
      source: snap.source,
    }, kind);
    const res = await this.push(text);
    if (!res.sent) this.lastError = res.reason;
    // record the push so the dashboard has a history to consult (best-effort —
    // a persistence failure must never block the Telegram loop)
    await this.record({
      timeET: snap.timeET,
      day: snap.day,
      symbol: snap.symbol,
      side: read.side ?? "none",
      price: snap.lastPrice,
      entry: read.trigger,
      stop: read.invalidation,
      target: read.target,
      size: sizeLine(read),
      verdict: read.verdict,
      headline: read.headline,
      source: snap.source,
      test: false,
      sent: res.sent,
      reason: res.reason,
    });
  }

  /** Sweep-reclaim + one-sided confirmation — a separate, simpler signal than
   *  the full reversal sequence (theory-lab result: 67% win @ 1R). Fires once
   *  per distinct reclaim bar. */
  private async checkReclaimSetup(): Promise<void> {
    if (!FEED_SWEEP_RECLAIM) return;
    const nb = newsBlockedNow(Date.now());
    if (nb) {
      console.log(`[news] ${nb} blackout — skipping sweep-reclaim card`);
      return;
    }
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 3) return;
    const fp = cachedFootprint(live.minutes, live.barsRevision);
    const setup = detectOneSidedReclaim(fp);
    if (!setup) return;
    const key = `${setup.day}|${setup.dir}|${setup.t}`;
    if (this.reclaimSent.has(key)) return;
    this.reclaimSent.add(key);
    if (this.reclaimSent.size > 500) this.reclaimSent = new Set([...this.reclaimSent].slice(-250));

    // position size for a fixed dollar risk (PROP_RISK_PER_TRADE, default $100 — lib/propRules.ts PROP_RISK_PER_TRADE, the one plan constant)
    const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
    const rawContracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, setup.risk)));
    const tiered = await this.applyDayTier(
      { contracts: rawContracts, dollarRisk: rawContracts * setup.risk * 2, capped: false },
      setup.risk,
    );
    const contracts = tiered.contracts;
    const sizeStr = `${contracts} MNQ · risk $${Math.round(contracts * setup.risk * RAPID_EOD_50K.pointValue)}`;

    // emit the order intent to the executor (dry-run by default); the
    // executor registers the bracket + verifies the OSO legs (global)
    void placeOrder(
      {
        symbol: symbol(),
        dir: setup.dir,
        contracts,
        entry: setup.entry,
        stop: setup.stop,
        target: setup.target,
        timeET: setup.timeET,
      },
      { label: `sweep-reclaim ${setup.dir} ${setup.timeET}` },
    )
      .then((res) => {
        void logExec({
          key: `reclaim|${key}`,
          label: `sweep-reclaim ${setup.dir} ${setup.timeET}`,
          attempt: "initial",
          outcome: res.ok ? "ok" : "failed",
          reason: res.reason,
        });
        if (!res.ok) registerSendFailure(`reclaim|${key}`, `sweep-reclaim ${setup.dir} ${setup.timeET}`, res.reason);
      })
      .catch(() => {});

    const text = formatReclaimSetupHtml(
      setup,
      {
        symbol: symbol(),
        price: setup.entry,
        timeET: setup.timeET,
        source: "live",
      },
      sizeStr,
    );
    const res = await this.push(text);
    if (!res.sent) this.lastError = res.reason;
    await this.record({
      timeET: setup.timeET,
      day: setup.day,
      symbol: symbol(),
      side: setup.dir,
      price: setup.entry,
      entry: setup.entry.toFixed(2),
      stop: setup.stop.toFixed(2),
      target: setup.target.toFixed(2),
      size: sizeStr,
      verdict: "sweep-reclaim (one-sided)",
      headline: `NQ sweep-reclaim ${setup.dir}`,
      source: "live",
      test: false,
      sent: res.sent,
      reason: res.reason,
      features: signalFeatures(setup as unknown as Record<string, unknown>, {}),
    });
    registerExpectation({
      key: `reclaim|${key}`,
      ts: Date.now(),
      label: `sweep-reclaim ${setup.dir}`,
      intent: {
        symbol: symbol(),
        dir: setup.dir,
        contracts,
        entry: setup.entry,
        stop: setup.stop,
        target: setup.target,
        timeET: setup.timeET,
      },
      scaleOut: false,
    });
  }

  /** Momentum — the one-sided run card, two triggers (lib/momentum.ts):
   *  1) the failed-flush → one-sided breakout sequence (MOM_PROD)
   *  2) the huge-bar expansion scalp (EXP_PROD)
   *  Same ticket mechanics (entry at the bar's close, stop under its low,
   *  1R target); same-bar double-fires are deduped to one card. Fires only
   *  when the trigger bar is the just-completed minute. */
  private async checkMomentum(): Promise<void> {
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 30) return;
    const fp = cachedFootprint(live.minutes, live.barsRevision);
    if (this.tapeGateHolds(fp, "momentum")) return;
    // cross-asset context + gap inventory + mids — computed ONCE per tick
    // and shared by momentum/RTH/open (tickChips memo)
    const { es: esCtx, nqMid, gaps } = this.tickChips(fp);
    // ladder management for open scale-out runners (CrossTrade backend only,
    // no new polling — reuses this tick's completed minutes)
    // no new polling — reuses this tick's completed minutes)
    if (crossTradeEnabled()) void runnerTracker.evaluate(fp).catch(() => {});
    if (!FEED_MOMENTUM) return;
    const nb = newsBlockedNow(Date.now());
    const momSigs = detectMomentumMemo(fp, MOM_PROD, live.barsRevision);
    const expSigs = detectExpansionScalpMemo(fp, EXP_PROD, live.barsRevision);
    // A+ = both triggers fire on the same bar (78.9% win / PF 3.23 — the
    // highest-conviction Globex signal). The momentum signal wins the dedupe.
    const expKeys = new Set(expSigs.map((x) => `${x.d}|${x.dir}|${x.t}`));
    const sigs = [...momSigs, ...expSigs];

    // news blackout: no card, no order — but every just-fired candidate is
    // recorded as a skip so the insight loop can count what the gate ate
    if (nb) {
      for (const s of sigs) {
        if (s.breakIdx !== fp.length - 1) continue;
        const fam = s.kind === "expansion" ? "momentum_expansion" : "momentum_flush";
        const es = esCardChips(esCtx, nqMid, s, true);
        const seasonal = seasonalChips(s);
        const rn = roundNumberChips(s);
        const gch = gapChips(fp, s, gaps);
        const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict: s.kind === "expansion" ? "momentum (huge-bar expansion)" : "momentum (failed-flush breakout)",
          headline: `NQ momentum ${s.dir}`,
          reason: `news blackout — ${nb}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, { family: fam, newsBlocked: nb, ...es.features, ...seasonal.features, ...rn.features, ...gch.features, ...wall.features }),
        });
      }
      console.log(`[news] ${nb} blackout — skipping momentum card (${sigs.filter((s) => s.breakIdx === fp.length - 1).length} candidates recorded)`);
      return;
    }
    for (const s of sigs) {
      if (s.breakIdx !== fp.length - 1) continue; // only the just-closed bar
      const key = `${s.d}|${s.dir}|${s.t}`;
      const aPlus = expKeys.has(key) && momSigs.some((x) => `${x.d}|${x.dir}|${x.t}` === key);
      if (this.momentumSent.has(key)) continue;
      const et = cdtToET(s.t);
      const firstToday = !this.cardedDays.has(s.d);
      const es = esCardChips(esCtx, nqMid, s, true);
      const seasonal = seasonalChips(s);
      // journal-only context chips (Naso hypotheses — labels only, no gates):
      // round numbers, price gaps, gamma-wall proximity
      const rn = roundNumberChips(s);
      const gch = gapChips(fp, s, gaps);
      const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
      const chipLine = [...seasonal.labels, ...es.labels, ...rn.labels, ...gch.labels, ...wall.labels].length
        ? `${[...seasonal.labels, ...es.labels, ...rn.labels, ...gch.labels, ...wall.labels].join(" · ")} · `
        : "";

      // ---- self-improvement gates (strategy_overrides) — the approved
      //      insight loop filters the card BEFORE anything is sent ----
      const family = s.kind === "expansion" ? "momentum_expansion" : "momentum_flush";
      const ov = await getOverrides();
      const dec = decideSignal(ov, {
        families: [family, "momentum", "all"],
        hourET: s.hourET,
        side: s.dir,
        breakFrac: s.breakFrac,
        riskPts: s.risk,
        breakRangeR: s.breakRangeR,
        cumDelta: s.cumDelta,
        firstOfDay: firstToday,
      });
      if (!dec.allow) {
        console.log(`[overrides] momentum ${s.dir} ${et} SKIPPED — ${dec.reasons.join("; ")}`);
        await this.recordSkip({
          timeET: et,
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict: s.kind === "expansion" ? "momentum (huge-bar expansion)" : "momentum (failed-flush breakout)",
          headline: `NQ momentum ${s.dir}`,
          reason: `overrides: ${dec.reasons.join("; ")}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, {
            aPlus,
            firstToday,
            family,
            rejectedBy: dec.reasons,
            gates: this.gateSnapshot(ov),
            ...es.features,
            ...seasonal.features,
            ...rn.features,
            ...gch.features,
            ...wall.features,
          }),
        });
        continue;
      }

      // ---- cost-adjusted ticket veto (TICKET_MIN_EXP_PTS, OFF by default).
      //      Vetoes tickets whose measured cell expectancy cannot pay the
      //      live costs (~0.65 pt commissions before slippage). Research
      //      input: hourExpectancyStudy + expansionStudy sweeps — enabling
      //      the bar is a rule-4 env approval, not this code path.
      const vet = ticketVetoDecision(
        {
          family,
          hourBucket: hourBucketOf(`${String(s.hourET).padStart(2, "0")}:${s.t.slice(3, 5)}`),
          dir: s.dir,
        },
        ticketVetoBar(),
      );
      if (vet.veto) {
        console.log(`[ticketVeto] momentum ${s.dir} ${et} SKIPPED — ${vet.reason}`);
        await this.recordSkip({
          timeET: et,
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict:
            s.kind === "expansion"
              ? "momentum (huge-bar expansion · ticket veto)"
              : "momentum (failed-flush breakout · ticket veto)",
          headline: `NQ momentum ${s.dir}`,
          reason: vet.reason,
          features: signalFeatures(s as unknown as Record<string, unknown>, {
            aPlus,
            firstToday,
            family,
            vetoedBy: "ticket-min-exp",
            gates: this.gateSnapshot(ov),
            ...es.features,
            ...seasonal.features,
          }),
        });
        continue;
      }

      this.momentumSent.add(key);
      if (this.momentumSent.size > 500) this.momentumSent = new Set([...this.momentumSent].slice(-250));

      // wall-aware stop (Pulcini rule, WALL_STOP=1): widen the stop to the
      // far side of a near dealer wall instead of dying at the magnet.
      // Applied BEFORE sizing so the card's contracts reflect the wider risk.
      let wallNote = "";
      if (process.env.WALL_STOP === "1") {
        const g = getOptionsFeed().snapshot() ?? (await optionsSnapshot().catch(() => null));
        const ltp = live.snapshot?.ltp ?? s.entry;
        if (g && Number.isFinite(ltp) && ltp > 0) {
          const r = applyWallStop(
            { dir: s.dir, stop: s.stop, entry: s.entry },
            wallsFromRead(readOptionsFromSnapshot(g, ltp)),
          );
          if (r.widened) {
            s.stop = r.stop;
            s.risk = Math.abs(s.entry - s.stop);
            wallNote = r.note;
          }
        }
      }

      // position size grounded in the Rapid EOD 50k rules (lib/propRules.ts):
      // the day plan: $100 risk budget, 30-micro cap, $2/pt MNQ.
      // FIXED_CONTRACTS overrides with an exact contract count.
      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
      const fixed = Number(process.env.FIXED_CONTRACTS) || 0;
      const prof = momentumProfile();
      const profBracket = prof.enabled ? applyProfile(s.dir, s.entry, s.risk, prof) : null;
      // the day plan is single-leg (1R, structural stop); the validated
      // scale-out ladder stays available behind an explicit opt-in
      const scaleOut = process.env.CROSSTRADE_SCALEOUT === "1" && crossTradeEnabled();
      const stop = scaleOut ? s.stop : profBracket ? profBracket.stop : s.stop;
      const target = scaleOut ? s.target : profBracket ? profBracket.target : s.target;
      const riskPts = scaleOut ? s.risk : profBracket ? profBracket.riskPts : s.risk;
      const size = await this.applyDayTier(
        fixed > 0
          ? { contracts: Math.min(30, fixed), dollarRisk: Math.min(30, fixed) * riskPts * 2, capped: false }
          : momentumSize(riskPts, riskBudget * (prof.enabled && !scaleOut ? prof.sizeMult : 1)),
        riskPts,
      );

      // emit the order intent to the executor (dry-run by default)
      const intent: OrderIntent = {
        symbol: symbol(),
        dir: s.dir,
        contracts: size.contracts,
        entry: s.entry,
        stop,
        target,
        timeET: et,
      };
      this.cardedDays.add(s.d);
      if (this.cardedDays.size > 20) this.cardedDays = new Set([...this.cardedDays].slice(-10));

      // ---- expansion retrace: arm the resting limit instead of chasing ----
      if (s.kind === "expansion" && expRetraceEnabled()) {
        const dirSign = s.dir === "long" ? 1 : -1;
        const level = s.entry - dirSign * EXP_RETRACE_PTS;
        const armedIdx = fp.length - 1;
        // BROKER-ARMED path (2026-10-12): when CrossTrade is live and the
        // limit mode holds (single-leg), rest the limit at the broker THE
        // MOMENT THE CARD FIRES — the faithful execution of
        // retraceSlippageStudy's 0.0-pt cell (the model rests the limit
        // from the signal and counts a touch as a fill). Placing only
        // AFTER the touch bar closed meant the tape had already traded
        // through the level — live under-filled vs the model
        // (limit_expired). The executor's crossed gates refuse a broken
        // bracket; the watcher's limit lifecycle cancels at expiry,
        // window close, or kill switch. Brackets are pre-built from the
        // LIMIT (fill-anchored by construction — a resting limit can only
        // fill at or better).
        const brokerLimit = crossTradeEnabled() && retraceUseLimit(scaleOut);
        if (brokerLimit) {
          const risk = s.risk;
          const intent: OrderIntent = {
            symbol: symbol(),
            dir: s.dir,
            contracts: size.contracts,
            entry: level,
            stop: level - dirSign * risk,
            target: level + dirSign * risk,
            timeET: et,
          };
          const expireAtMs = Date.now() + EXP_RETRACE_BARS * 60_000;
          registerExpectation({
            key: `mom|${key}`,
            ts: Date.now(),
            label: `momentum ${s.dir} ${et} (retrace limit)`,
            intent,
            scaleOut,
            limit: { price: level, expireAtMs },
          });
          const sizeStrArm = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;
          const armText = [
            `🎯 <b>${STATS.momentum.name} · ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · expansion retrace — broker limit resting · ${et} NY</b>`,
            ``,
            `<code>LIMIT   ${fmtPx(level)}   (signal close ${fmtPx(s.entry)} ∓ ${EXP_RETRACE_PTS.toFixed(1)} pt)</code>`,
            `<code>STOP    fill ∓ ${risk.toFixed(2)} pts · TARGET fill ± ${risk.toFixed(2)} pts (1R)</code>`,
            `<code>SIZE    ${sizeStrArm}</code>`,
            ``,
            `${aPlus ? `A+ both triggers (${STATS.momentum.aPlus}) · ` : ""}${firstToday ? `1st today (${STATS.momentum.firstOfDay}) · ` : ""}${chipLine}limit rests at the broker for up to ${EXP_RETRACE_BARS} min, cancelled if untraded`,
            `<i>${STATS.momentum.expRetrace}</i>`,
          ].join("\n");
          const res = await this.push(armText);
          if (!res.sent) this.lastError = res.reason;
          void this.placeMomentumOrder(key, intent, scaleOut, et, " (retrace)", level).then((res) => {
            if (res.ok && res.orderId) attachLimitOrderId(`mom|${key}`, res.orderId);
          });
          console.log(`[expRetrace] broker limit placed ${s.dir} @ ${fmtPx(level)} · ${et} NY · expires after ${EXP_RETRACE_BARS} bars`);
          continue;
        }
        this.expRetracePending = {
          key,
          day: s.d,
          dir: s.dir,
          level,
          armedIdx,
          maxIdx: armedIdx + EXP_RETRACE_BARS,
          sEntry: s.entry,
          sStop: s.stop,
          sTarget: s.target,
          risk: s.risk,
          fixed,
          riskBudget,
          scaleOut,
          t: s.t,
          aPlus,
          firstToday,
          et,
          features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, firstToday, family, retrace: true, gates: this.gateSnapshot(ov), ...es.features, ...rn.features, ...gch.features, ...wall.features }),
        };
        const sizeStrArm = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;
        const armText = [
          `🎯 <b>${STATS.momentum.name} · ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · expansion retrace — resting limit · ${et} NY</b>`,
          ``,
          `<code>LIMIT   ${fmtPx(level)}   (signal close ${fmtPx(s.entry)} ∓ 1 pt)</code>`,
          `<code>STOP    fill ∓ ${s.risk.toFixed(2)} pts · TARGET fill ± ${s.risk.toFixed(2)} pts (1R)</code>`,
          scaleOut
            ? `<code>BANK 2/3 @ +1R · RUN 1/3 ladder (BE @1R · +1R @2R · +2R @3R…)</code>`
            : `<code>TARGET  +1R from the fill</code>`,
          `<code>SIZE    ~${sizeStrArm} at fill</code>`,
          ``,
          `${aPlus ? `A+ both triggers (${STATS.momentum.aPlus}) · ` : ""}${firstToday ? `1st today (${STATS.momentum.firstOfDay}) · ` : ""}${chipLine}no market order — waits up to ${EXP_RETRACE_BARS} min for the retrace, skipped if untraded`,
          `<i>${STATS.momentum.expRetrace}</i>`,
        ].join("\n");
        const res = await this.push(armText);
        if (!res.sent) this.lastError = res.reason;
        console.log(`[expRetrace] armed ${s.dir} limit ${fmtPx(level)} · ${et} NY · expires after ${EXP_RETRACE_BARS} bars`);
        continue;
      }

      // emit the order intent to the executor (dry-run by default) — the
      // same fire-and-forget mechanics as before, factored into one helper
      void this.placeMomentumOrder(key, intent, scaleOut, et).then((res) => {
        if (scaleOut && res.runnerOrderId) {
          runnerTracker.register({
            id: res.runnerOrderId.replace(/-run$/, ""),
            bankOrderId: res.bankOrderId ?? null,
            runnerOrderId: res.runnerOrderId,
            dir: s.dir === "long" ? 1 : -1,
            entry: s.entry,
            stop0: s.stop,
            risk: Math.abs(s.entry - s.stop),
            contracts: size.contracts,
            runnerQty: res.runnerQty ?? 0,
            lockedRungs: 0,
            entryTimeET: et,
            createdAt: new Date().toISOString(),
          });
        }
      });

      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;
      const evidence =
        s.kind === "expansion"
          ? `huge bar ${s.breakRangeR.toFixed(1)}×ATR · ${Math.round(s.breakFrac * 100)}% ${s.dir === "long" ? "buy" : "sell"}`
          : `failed ${s.dir === "long" ? "flush" : "rally"} · ${Math.round(s.breakFrac * 100)}% breakout`;
      // speed format: title line carries strategy + direction + price + time,
      // then the three ticket numbers each on their own line, size, one
      // evidence line, then the measured win-rate line
      const text = [
        `⚡ <b>${STATS.momentum.name} · ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(s.entry)} · ${et} NY</b>`,
        ``,
        `<code>ENTRY   ${fmtPx(s.entry)}</code>`,
        `<code>STOP    ${fmtPx(stop)}   ${distTxt(s.entry, stop)}</code>`,
        scaleOut
          ? `<code>BANK 2/3 @ +1R · RUN 1/3 ladder (BE @1R · +1R @2R · +2R @3R…)</code>`
          : `<code>TARGET  ${fmtPx(target)}   ${distTxt(s.entry, target)}${profBracket ? ` (${prof.targetR}R @ ${prof.stopMult}× stop)` : ""}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        `${aPlus ? `A+ both triggers (${STATS.momentum.aPlus}) · ` : ""}${firstToday ? `1st today (${STATS.momentum.firstOfDay}) · ` : ""}${chipLine}${evidence}${wallNote ? ` · ${wallNote}` : ""}`,
        `<i>${STATS.momentum.stat}</i>`,
      ].join("\n");
      const res = await this.push(text);
      if (!res.sent) this.lastError = res.reason;
      await this.record({
        timeET: et,
        day: s.d,
        symbol: symbol(),
        side: s.dir,
        price: s.entry,
        entry: s.entry.toFixed(2),
        stop: stop.toFixed(2),
        target: target.toFixed(2),
        size: sizeStr,
        verdict: s.kind === "expansion" ? "momentum (huge-bar expansion)" : "momentum (failed-flush breakout)",
        headline: `NQ momentum ${s.dir}`,
        source: "live",
        test: false,
        sent: res.sent,
        reason: res.reason,
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, firstToday, family, gates: this.gateSnapshot(ov), wallStop: wallNote || undefined, ...es.features, ...seasonal.features, ...rn.features, ...gch.features, ...wall.features }),
      });
      registerExpectation({
        key: `mom|${key}`,
        ts: Date.now(),
        label: `momentum ${s.dir}`,
        intent: {
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop,
          target,
          timeET: et,
        },
        scaleOut,
      });
    }
  }

  /** Place a momentum/expansion entry through the executor (scale-out pair
   *  or single bracketed order), fire-and-forget with exec-log + re-send
   *  registration. Shared by the immediate path and the retrace fill. */
  private async placeMomentumOrder(
    key: string,
    intent: OrderIntent,
    scaleOut: boolean,
    et: string,
    suffix = "",
    limitPrice?: number,
  ): Promise<{ ok: boolean; reason: string; orderId?: string; bankOrderId?: string; runnerOrderId?: string; runnerQty?: number }> {
    if (scaleOut) {
      try {
        const res = await placeScaleOut(intent);
        void logExec({
          key: `mom|${key}`,
          label: `momentum ${intent.dir} ${et} (scale-out${suffix})`,
          attempt: "initial",
          outcome: res.ok ? "ok" : "failed",
          reason: res.reason,
        });
        if (!res.ok) {
          this.lastError = `scale-out: ${res.reason}`;
          registerSendFailure(`mom|${key}`, `momentum ${intent.dir} ${et} (scale-out${suffix})`, res.reason);
        }
        // (the executor registers the bracket + verifies the legs itself —
        //  a global invariant shared by every entry path)
        return res;
      } catch (e) {
        this.lastError = `scale-out: ${String(e)}`;
        return { ok: false, reason: String(e) };
      }
    }
    try {
      const limitTag = limitPrice !== undefined ? " (limit)" : "";
      const label = `momentum ${intent.dir} ${et}${suffix}${limitTag}`;
      const res = await placeOrder(intent, { ...(limitPrice !== undefined ? { limitPrice } : {}), label });
      void logExec({
        key: `mom|${key}`,
        label,
        attempt: "initial",
        outcome: res.ok ? "ok" : "failed",
        reason: res.reason,
      });
      if (!res.ok) registerSendFailure(`mom|${key}`, label, res.reason);
      if (res.ok && !scaleOut && limitPrice === undefined) {
        const prof = momentumProfile();
        if (prof.enabled) {
          registerTimeExit({
            key: `mom|${key}`,
            label: `momentum ${intent.dir} ${et} (${prof.timeExitBars}-bar profile)`,
            symbol: intent.symbol,
            dir: intent.dir,
            exitAtMs: timeExitAt(Date.now(), prof),
          });
        }
      }
      return res;
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  /** Resolve the armed expansion retrace: fill it when the tape comes back
   *  to the limit within the window (brackets rebuilt from the fill), or
   *  skip the signal when it never trades. Runs every tick. */
  private async checkExpRetrace(): Promise<void> {
    const p = this.expRetracePending;
    if (!p) return;
    const live = getLive().state;
    if (!live.connected || !live.minutes.length) return;
    const fp = cachedFootprint(live.minutes, live.barsRevision);
    if (fp.length <= p.armedIdx + 1) return;

    // session rolled under the pending retrace — void it (recorded so the
    // insight loop can count the candidate)
    if ((fp[fp.length - 1].d ?? "") !== p.day) {
      this.expRetracePending = null;
      void this.push(
        [
          `🎯 <b>${STATS.momentum.name} · ${p.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · expansion retrace VOID</b>`,
          `<code>${symbol()}  ${fp[fp.length - 1].t} UTC</code>`,
          `session rolled before the retrace traded — skipped`,
        ].join("\n"),
      );
      await this.recordSkip({
        timeET: p.et,
        day: p.day,
        side: p.dir,
        price: p.sEntry,
        entry: p.level,
        stop: p.sStop,
        target: p.sTarget,
        verdict: "momentum (huge-bar expansion · retrace skipped)",
        headline: `NQ momentum ${p.dir}`,
        reason: "session rolled before the retrace traded — skipped",
        features: { ...p.features, retrace: "void" },
      });
      return;
    }

    const bars = fp.slice(p.armedIdx + 1, Math.min(fp.length, p.maxIdx + 1));
    const res = resolveRetrace(bars, p.dir, p.level, EXP_RETRACE_BARS);
    if (res.status === "wait") return;
    this.expRetracePending = null; // consume exactly once

    if (res.status === "expired") {
      const text = [
        `🎯 <b>${STATS.momentum.name} · ${p.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · expansion retrace EXPIRED</b>`,
        `<code>${symbol()}  limit ${fmtPx(p.level)} · ${p.et} NY</code>`,
        `price never came back ${EXP_RETRACE_PTS.toFixed(1)} pt within ${EXP_RETRACE_BARS} bars — signal skipped`,
      ].join("\n");
      const pushRes = await this.push(text);
      if (!pushRes.sent) this.lastError = pushRes.reason;
      await this.record({
        timeET: p.et,
        day: p.day,
        symbol: symbol(),
        side: p.dir,
        price: p.sEntry,
        entry: p.level.toFixed(2),
        stop: p.sStop.toFixed(2),
        target: p.sTarget.toFixed(2),
        size: "—",
        verdict: "momentum (huge-bar expansion · retrace skipped)",
        headline: `NQ momentum ${p.dir}`,
        source: "live",
        test: false,
        sent: false,
        reason: `expansion retrace not filled within ${EXP_RETRACE_BARS} bars — skipped`,
        features: { ...p.features, retrace: "expired" },
      });
      console.log(`[expRetrace] expired ${p.dir} limit ${fmtPx(p.level)} · ${p.et} NY`);
      return;
    }

    // ---- filled: rebuild the bracket from the actual fill price ----
    const touchBar = fp[p.armedIdx + 1 + res.barIdx];
    const et = cdtToET(touchBar.t);
    const dirSign = p.dir === "long" ? 1 : -1;
    const risk = Math.abs(p.sEntry - p.sStop);
    const entry = res.fill;
    const stop = entry - dirSign * risk;
    const target = entry + dirSign * risk;

    // no new entries during a news blackout — expire the fill instead
    const nb = newsBlockedNow(Date.now());
    if (nb) {
      const text = [
        `🎯 <b>${STATS.momentum.name} · ${p.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · expansion retrace SKIPPED</b>`,
        `<code>${symbol()}  ${fmtPx(entry)} · ${et} NY</code>`,
        `${nb} blackout at fill time — entry cancelled`,
      ].join("\n");
      const pushRes = await this.push(text);
      if (!pushRes.sent) this.lastError = pushRes.reason;
      await this.record({
        timeET: et,
        day: p.day,
        symbol: symbol(),
        side: p.dir,
        price: entry,
        entry: entry.toFixed(2),
        stop: stop.toFixed(2),
        target: target.toFixed(2),
        size: "—",
        verdict: "momentum (huge-bar expansion · retrace skipped)",
        headline: `NQ momentum ${p.dir}`,
        source: "live",
        test: false,
        sent: false,
        reason: `news blackout at fill — ${nb}`,
        features: { ...p.features, retrace: "news-blocked" },
      });
      return;
    }

    // size at fill time (day tier may have moved since the arm)
    const base =
      p.fixed > 0
        ? { contracts: Math.min(30, p.fixed), dollarRisk: Math.min(30, p.fixed) * risk * 2, capped: false }
        : momentumSize(risk, p.riskBudget);
    const size = await this.applyDayTier(base, risk);
    const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;
    const drift = (entry - p.sEntry) * dirSign;

    const intent: OrderIntent = {
      symbol: symbol(),
      dir: p.dir,
      contracts: size.contracts,
      entry,
      stop,
      target,
      timeET: et,
    };

    // CROSSTRADE_LIMIT_ENTRIES=0 opts back OUT of the broker resting
    // limit (market entry at the tape fill — the slippage-exposed path
    // the backtest rejects); see retraceUseLimit().
    const useLimit = retraceUseLimit(p.scaleOut);

    // crossed-stop dispatch gate (2026-10-08 incident): if the tape gapped
    // through the stop between the touch and dispatch, the OSO stop would
    // be rejected (InvalidPrice) and the entry would fill naked. Skip.
    const gateLtp = live.snapshot?.ltp ?? live.minutes.at(-1)?.c ?? null;
    if (useLimit && stopCrossedAtDispatch(p.dir, stop, gateLtp) === true) {
      console.log(`[expRetrace] crossed-stop gate: skipping ${p.dir} — tape ${Number(gateLtp).toFixed(2)} past stop ${stop.toFixed(2)} at dispatch`);
      await this.record({
        timeET: et,
        day: p.day,
        symbol: symbol(),
        side: p.dir,
        price: entry,
        entry: entry.toFixed(2),
        stop: stop.toFixed(2),
        target: target.toFixed(2),
        size: sizeStr,
        verdict: "momentum (huge-bar expansion · retrace skipped)",
        headline: `NQ momentum ${p.dir}`,
        source: "live",
        test: false,
        sent: false,
        reason: `crossed-stop gate — tape ${Number(gateLtp).toFixed(2)} past stop ${stop.toFixed(2)} at dispatch`,
        features: { ...p.features, retrace: "crossed-stop" },
      });
      return;
    }

    const text = [
      `⚡ <b>${STATS.momentum.name} · ${p.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(entry)} · ${et} NY — retrace filled ${drift >= 0 ? "+" : "−"}${Math.abs(drift).toFixed(2)} pts</b>`,
      ``,
      `<code>ENTRY   ${fmtPx(entry)}   (limit ${fmtPx(p.level)})</code>`,
      `<code>STOP    ${fmtPx(stop)}   ${distTxt(entry, stop)}</code>`,
      p.scaleOut
        ? `<code>BANK 2/3 @ +1R · RUN 1/3 ladder (BE @1R · +1R @2R · +2R @3R…)</code>`
        : `<code>TARGET  ${fmtPx(target)}   ${distTxt(entry, target)}</code>`,
      `<code>SIZE    ${sizeStr}</code>`,
      ``,
      `${p.aPlus ? `A+ both triggers (${STATS.momentum.aPlus}) · ` : ""}${p.firstToday ? `1st today (${STATS.momentum.firstOfDay}) · ` : ""}huge bar ${fmtPx(p.sEntry)} pulled back to the limit`,
      `<i>${STATS.momentum.stat}</i>`,
    ].join("\n");
    const pushRes = await this.push(text);
    if (!pushRes.sent) this.lastError = pushRes.reason;
    await this.record({
      timeET: et,
      day: p.day,
      symbol: symbol(),
      side: p.dir,
      price: entry,
      entry: entry.toFixed(2),
      stop: stop.toFixed(2),
      target: target.toFixed(2),
      size: sizeStr,
      verdict: "momentum (huge-bar expansion · retrace)",
      headline: `NQ momentum ${p.dir}`,
      source: "live",
      test: false,
      sent: pushRes.sent,
      reason: pushRes.reason,
      features: { ...p.features, retrace: "filled", drift },
    });
    // the retrace fill is dispatched immediately (the limit price IS the
    // just-touched tape) — the gate above already re-checked the tape
    const limitExpireAtMs = useLimit ? Date.now() + LIMIT_ENTRY_TTL_MS : undefined;
    registerExpectation({
      key: `mom|${p.key}`,
      ts: Date.now(),
      label: `momentum ${p.dir} (retrace${useLimit ? " limit" : ""})`,
      intent,
      scaleOut: p.scaleOut,
      limit: useLimit ? { price: entry, expireAtMs: limitExpireAtMs! } : undefined,
    });
    console.log(
      `[expRetrace] filled ${p.dir} @ ${fmtPx(entry)} (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}) · ${et} NY` +
        (useLimit ? ` · broker limit ${LIMIT_ENTRY_TTL_MS / 60_000}min TTL` : ""),
    );

    void this.placeMomentumOrder(p.key, intent, p.scaleOut, et, " (retrace)", useLimit ? entry : undefined).then((res) => {
      if (useLimit && res.ok && res.orderId) attachLimitOrderId(`mom|${p.key}`, res.orderId);
      if (p.scaleOut && res.runnerOrderId) {
        runnerTracker.register({
          id: res.runnerOrderId.replace(/-run$/, ""),
          bankOrderId: res.bankOrderId ?? null,
          runnerOrderId: res.runnerOrderId,
          dir: dirSign,
          entry,
          stop0: stop,
          risk,
          contracts: size.contracts,
          runnerQty: res.runnerQty ?? 0,
          lockedRungs: 0,
          entryTimeET: et,
          createdAt: new Date().toISOString(),
        });
      }
    });
  }

  /** RTH soft-continuation (lib/softMomentum.ts) — EXPERIMENTAL, off by
   *  default. 60% one-sided bars continue in the thick RTH tape. */
  private rthSent = new Set<string>();

  private async checkRth(): Promise<void> {
    if (!FEED_RTH) return;
    const nb = newsBlockedNow(Date.now());
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 30) return;
    const fp = cachedFootprint(live.minutes, live.barsRevision);
    if (this.tapeGateHolds(fp, "rth")) return;
    const { es: esCtx, nqMid, gaps } = this.tickChips(fp);
    if (nb) console.log(`[news] ${nb} blackout — skipping RTH cards (candidates recorded)`);
    for (const s of detectSoftMomentumMemo(fp, SOFT_PROD, live.barsRevision)) {
      if (s.breakIdx !== fp.length - 1) continue;
      if (nb) {
        const es = esCardChips(esCtx, nqMid, s, false);
        const rn = roundNumberChips(s);
        const gch = gapChips(fp, s, gaps);
        const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict: "rth soft-continuation (experimental)",
          headline: `NQ RTH ${s.dir}`,
          reason: `news blackout — ${nb}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, { family: "rth", newsBlocked: nb, ...es.features, ...rn.features, ...gch.features, ...wall.features }),
        });
        continue;
      }
      const key = `${s.d}|${s.dir}|${s.t}`;
      if (this.rthSent.has(key)) continue;
      const ov = await getOverrides();
      const dec = decideSignal(ov, {
        families: ["rth", "all"],
        hourET: s.hourET,
        side: s.dir,
        breakFrac: s.breakFrac,
        riskPts: s.risk,
        breakRangeR: null,
        cumDelta: s.cumDelta,
        firstOfDay: false,
      });
      if (!dec.allow) {
        const es = esCardChips(esCtx, nqMid, s, false);
        const rn = roundNumberChips(s);
        const gch = gapChips(fp, s, gaps);
        const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
        console.log(`[overrides] rth ${s.dir} SKIPPED — ${dec.reasons.join("; ")}`);
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict: "rth soft-continuation (experimental)",
          headline: `NQ RTH ${s.dir}`,
          reason: `overrides: ${dec.reasons.join("; ")}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, {
            family: "rth",
            rejectedBy: dec.reasons,
            gates: this.gateSnapshot(ov),
            ...es.features,
            ...rn.features,
            ...gch.features,
            ...wall.features,
          }),
        });
        continue;
      }
      this.rthSent.add(key);
      // counter-signal gate (RTH_COUNTER_GATE_MIN / RTH_COUNTER_GATE_PTS,
      // owner-approved): skip a card whose entry sits within PTS of an
      // opposite-side RTH card's WINNING exit in the last MIN minutes —
      // the trade-9 pattern (12:54 short stopped in 6s right after the
      // 12:44 long hit target in the same zone). A veto only: the skip is
      // journaled to the daybook like every other decision.
      const gate = counterGateParams();
      if (gate.enabled) {
        const g = counterGateDecision(s.dir, s.entry, Date.now(), gate.minMs, gate.pts);
        if (g.block && g.winner) {
          const mins = Math.max(1, Math.round((Date.now() - g.winner.exitAt) / 60_000));
          const es = esCardChips(esCtx, nqMid, s, false);
          const rn = roundNumberChips(s);
          const gch = gapChips(fp, s, gaps);
          const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
          console.log(
            `[rth] counter-gate: skipping ${key} — opposite ${g.winner.dir} winner exited ${g.winner.exitPrice.toFixed(2)} ${mins}m ago within ${gate.pts} pts`,
          );
          await this.recordSkip({
            timeET: cdtToET(s.t),
            day: s.d,
            side: s.dir,
            price: s.entry,
            entry: s.entry,
            stop: s.stop,
            target: s.target,
            verdict: "rth soft-continuation (experimental)",
            headline: `NQ RTH ${s.dir}`,
            reason: `counter-gate (opposite ${g.winner.dir} winner ${mins}m ago within ${gate.pts} pts)`,
            features: signalFeatures(s as unknown as Record<string, unknown>, {
              family: "rth",
              rejectedBy: [
                `counter-gate min=${process.env.RTH_COUNTER_GATE_MIN ?? "0"} pts=${process.env.RTH_COUNTER_GATE_PTS ?? "0"}`,
              ],
              ...es.features,
              ...rn.features,
              ...gch.features,
              ...wall.features,
            }),
          });
          continue;
        }
      }
      const rthCap = rthMaxCardsPerDay();
      if (rthCap > 0) {
        const sent = (this.rthDayCount.get(s.d) ?? 0) + 1;
        this.rthDayCount.set(s.d, sent);
        if (sent > rthCap) {          const es = esCardChips(esCtx, nqMid, s, false);
          const rn = roundNumberChips(s);
          const gch = gapChips(fp, s, gaps);
          const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
          console.log(`[rth] daily card cap ${rthCap} reached — skipping ${key}`);
          await this.recordSkip({
            timeET: cdtToET(s.t),
            day: s.d,
            side: s.dir,
            price: s.entry,
            entry: s.entry,
            stop: s.stop,
            target: s.target,
            verdict: "rth soft-continuation (experimental)",
            headline: `NQ RTH ${s.dir}`,
            reason: `daily card cap ${rthCap}`,
            features: signalFeatures(s as unknown as Record<string, unknown>, {
              family: "rth",
              rejectedBy: [`daily card cap ${rthCap}`],
              ...es.features,
              ...rn.features,
              ...gch.features,
              ...wall.features,
            }),
          });
          continue;
        }
      }
      if (this.rthSent.size > 200) this.rthSent = new Set([...this.rthSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
      const cap = Number(process.env.RTH_RISK_CAP ?? "100");
      const prof = rthProfile();
      const lim = rthLimitParams();
      const useLimitEntry = lim.enabled;
      // the limit-entry redesign reuses the profile bracket math with its
      // validated knobs (half stop, 2.5R target); the classic profile wins
      // when both are enabled (explicit knob discipline, one plan at a time)
      const bracket: FamilyProfile = useLimitEntry
        ? { enabled: true, stopMult: lim.stopMult, targetR: lim.targetR, sizeMult: 1, timeExitBars: 0 }
        : prof;
      const profBracket = bracket.enabled ? applyProfile(s.dir, s.entry, s.risk, bracket) : null;
      // the day plan: budget sizing (floor($100 ÷ stop$)), no fixed count
      const fixed = fixedContracts(0);
      const stop = profBracket ? profBracket.stop : s.stop;
      const target = profBracket ? profBracket.target : s.target;
      const riskPts = profBracket ? profBracket.riskPts : s.risk;
      const budget = cap > 0 ? Math.min(riskBudget, cap) : riskBudget;
      const contracts =
        fixed > 0
          ? cappedContracts(fixed, riskPts, cap)
          : momentumSize(riskPts, budget * (bracket.enabled ? bracket.sizeMult : 1)).contracts;
      const size = await this.applyDayTier(
        { contracts, dollarRisk: contracts * riskPts * 2, capped: fixed > 0 && cap > 0 && fixed > contracts },
        riskPts,
      );
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? ` ($${cap} risk cap)` : ""}${size.mult < 1 ? ` (size ×${Math.round(size.mult * 100)}%)` : ""}`;

      // crossed-stop / crossed-limit dispatch gates (2026-10-08 incidents):
      // a resting limit whose OSO stop sits on the marketable side of the
      // current tape is rejected by Tradovate at placement (InvalidPrice)
      // → naked fill; a limit the tape has already moved THROUGH fills at
      // the market and the signal-anchored stop compresses (the 12:16
      // 0.8-pt stop → 134-tick slippage). Skip quietly — the study models
      // both gates (rthDriftOptimizer gate / gate-limit cells).
      const gateLtp = live.snapshot?.ltp ?? live.minutes.at(-1)?.c ?? null;
      const crossedStop = useLimitEntry && stopCrossedAtDispatch(s.dir, stop, gateLtp) === true;
      const crossedLimit = useLimitEntry && limitCrossedAtDispatch(s.dir, s.entry, gateLtp) === true;
      if (crossedStop || crossedLimit) {
        const es = esCardChips(esCtx, nqMid, s, false);
        const rn = roundNumberChips(s);
        const gch = gapChips(fp, s, gaps);
        const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
        console.log(
          crossedStop
            ? `[rth] crossed-stop gate: skipping ${key} — tape ${Number(gateLtp).toFixed(2)} past stop ${stop.toFixed(2)} at dispatch (stop would be rejected → naked fill)`
            : `[rth] crossed-limit gate: skipping ${key} — tape ${Number(gateLtp).toFixed(2)} through limit ${s.entry.toFixed(2)} at dispatch (fill would drift and compress the stop)`,
        );
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop,
          target,
          verdict: "rth soft-continuation (experimental)",
          headline: `NQ RTH ${s.dir}`,
          reason: crossedStop
            ? `crossed-stop gate — tape ${Number(gateLtp).toFixed(2)} past stop ${stop.toFixed(2)} at dispatch (OSO stop would be rejected)`
            : `crossed-limit gate — tape ${Number(gateLtp).toFixed(2)} through limit ${s.entry.toFixed(2)} at dispatch (fill drift would compress the stop)`,
          features: signalFeatures(s as unknown as Record<string, unknown>, {
            family: "rth",
            rejectedBy: [crossedStop ? "crossed-stop dispatch gate" : "crossed-limit dispatch gate"],
            ...es.features,
            ...rn.features,
            ...gch.features,
            ...wall.features,
          }),
        });
        continue;
      }

      const et = cdtToET(s.t);
      const label = `rth ${s.dir} ${et}${useLimitEntry ? " (limit)" : ""}`;
      const intent: OrderIntent = {
        symbol: symbol(),
        dir: s.dir,
        contracts: size.contracts,
        entry: s.entry,
        stop,
        target,
        timeET: et,
      };
      void placeOrder(intent, { ...(useLimitEntry ? { limitPrice: s.entry } : {}), label })
        .then((res) => {
          void logExec({
            key: `rth|${key}`,
            label,
            attempt: "initial",
            outcome: res.ok ? "ok" : "failed",
            reason: res.reason,
          });
          if (!res.ok) registerSendFailure(`rth|${key}`, `rth ${s.dir} ${et}`, res.reason);
          if (res.ok && useLimitEntry && res.orderId) attachLimitOrderId(`rth|${key}`, res.orderId);
          if (res.ok && prof.enabled) {
            registerTimeExit({
              key: `rth|${key}`,
              label: `rth ${s.dir} ${et} (${prof.timeExitBars}-bar profile)`,
              symbol: symbol(),
              dir: s.dir,
              exitAtMs: timeExitAt(Date.now(), prof),
            });
          }
        })
        .catch(() => {});

      const aPlus = s.breakFrac >= 0.65 || s.breakFrac <= 0.35;
      const es = esCardChips(esCtx, nqMid, s, false);
      // journal-only context chips (Naso hypotheses — labels only, no gates)
      const rn = roundNumberChips(s);
      const gch = gapChips(fp, s, gaps);
      const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
      const chipLine = [...es.labels, ...rn.labels, ...gch.labels, ...wall.labels].length
        ? `${[...es.labels, ...rn.labels, ...gch.labels, ...wall.labels].join(" · ")} · `
        : "";
      const text = [
        `🟦 <b>${STATS.rth.name} ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(s.entry)} · ${et} NY</b>`,
        ``,
        `<code>ENTRY   ${useLimitEntry ? "LIMIT " : ""}${fmtPx(s.entry)}</code>`,
        `<code>STOP    ${fmtPx(stop)}   ${distTxt(s.entry, stop)}</code>`,
        `<code>TARGET  ${fmtPx(target)}   ${distTxt(s.entry, target)}${profBracket ? ` (${bracket.targetR}R @ ${bracket.stopMult}× stop)` : ""}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        `${aPlus ? `A+ (${STATS.rth.aPlus}) · ` : ""}${chipLine}${Math.round(s.breakFrac * 100)}% one-sided · clusters ✓ · big bar · RTH continuation`,
        `<i>${STATS.rth.stat}${profBracket ? ` · ${bracket.targetR}R @ ${bracket.stopMult}× stop · ${useLimitEntry ? "limit entry (validated redesign)" : "profile"}` : " · 0.75R plan — journal separately"}</i>`,
      ].join("\n");
      const res = await this.push(text);
      if (!res.sent) this.lastError = res.reason;
      await this.record({
        timeET: et,
        day: s.d,
        symbol: symbol(),
        side: s.dir,
        price: s.entry,
        entry: s.entry.toFixed(2),
        stop: stop.toFixed(2),
        target: target.toFixed(2),
        size: sizeStr,
        verdict: "rth soft-continuation (experimental)",
        headline: `NQ RTH ${s.dir}`,
        source: "live",
        test: false,
        sent: res.sent,
        reason: res.reason,
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, gates: this.gateSnapshot(ov), ...es.features, ...rn.features, ...gch.features, ...wall.features }),
      });
      registerExpectation({
        key: `rth|${key}`,
        ts: Date.now(),
        label: `rth ${s.dir}`,
        intent: {
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop,
          target,
          timeET: et,
        },
        scaleOut: false,
        limit: useLimitEntry ? { price: s.entry, expireAtMs: Date.now() + lim.ttlMs } : undefined,
      });
    }
  }

  /** The 9:30 opening-drive card (lib/openDrive.ts) — EXPERIMENTAL, off by
   *  default. One signal per day by construction; fires only when the drive
   *  bar is the just-completed minute. */
  private openSent = new Set<string>();

  private async checkOpen(): Promise<void> {
    if (!FEED_OPEN) return;
    const nb = newsBlockedNow(Date.now());
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 60) return;
    const fp = cachedFootprint(live.minutes, live.barsRevision);
    if (this.tapeGateHolds(fp, "open")) return;
    // price-gap inventory for the journal-only gap chips (Naso hypotheses)
    const { gaps } = this.tickChips(fp);

    // ---- open-window diagnostic: the archive says the drive fires ~87% of
    //      days, but the live record has zero open cards — log the scan's
    //      inputs once per minute inside the window so the cause (missing
    //      9:30 bar, weak cumD, low one-sidedness, or feed volume units)
    //      is visible in the VPS logs ----
    {
      const last = fp[fp.length - 1];
      const hET = (Number(last.t.slice(0, 2)) + 1) % 24;
      if (hET >= 9 && hET <= 10) {
        const diagKey = `${last.d}|${last.t}`;
        if (!this.openDiagLogged.has(diagKey)) {
          this.openDiagLogged.add(diagKey);
          if (this.openDiagLogged.size > 90) this.openDiagLogged = new Set([...this.openDiagLogged].slice(-45));
          let i0 = -1;
          for (let i = 0; i < fp.length; i++) {
            const t = fp[i].t;
            if ((Number(t.slice(0, 2)) + 1) % 24 === 9 && Number(t.slice(3, 5)) >= 30) {
              i0 = i;
              break;
            }
          }
          let cumS = 0;
          if (i0 >= 0) for (let k = i0; k < fp.length; k++) cumS += fp[k].buy - fp[k].sell;
          const vol = last.buy + last.sell;
          const frac = vol > 0 ? last.buy / vol : 0;
          console.log(
            `[openDrive] diag ${last.d} ${last.t} CDT · bars=${fp.length} i0=${i0} cumS=${cumS} lastVol=${vol} lastFrac=${frac.toFixed(2)} · open drive open`,
          );
        }
      }
    }
    const jobs = [
      { key: "open", title: STATS.openDrive.name, sigs: FEED_OPEN_DRIVE ? detectOpenDriveMemo(fp, OPEN_PROD, live.barsRevision) : [], plan: "fixed TP/SL plan", resting: false, stat: STATS.openDrive.stat },
      { key: "pullback", title: STATS.openPullback.name, sigs: FEED_OPEN_PULLBACK ? detectOpenDriveMemo(fp, PULLBACK_PROD, live.barsRevision) : [], plan: "1R plan", resting: false, stat: STATS.openPullback.stat },
      { key: "sniper", title: STATS.openSniper.name, sigs: FEED_OPEN_SNIPER ? detectOpenDriveMemo(fp, SNIPER_PROD, live.barsRevision) : [], plan: "resting limit · flush-high target", resting: true, stat: STATS.openSniper.stat },
    ];
    if (nb) console.log(`[news] ${nb} blackout — skipping open cards (candidates recorded)`);
    for (const job of jobs) {
    for (const s of job.sigs) {
      // the open detectors evaluate COMPLETED bars; accept the trigger bar
      // when it is the buffer tail or the just-closed bar (a tick race must
      // not lose the card — openSent dedupes; momentum/RTH keep the strict
      // gate because they fire on the in-progress bar)
      if (s.breakIdx < fp.length - 2) continue;
      const family = job.key === "sniper" ? "open_sniper" : job.key === "pullback" ? "open_pullback" : "open_drive";
      const verdict = job.key === "sniper" ? "open sniper (experimental)" : job.key === "pullback" ? "open pullback (experimental)" : "open drive (experimental)";
      const headline = `NQ ${job.key === "sniper" ? "open sniper" : job.key === "pullback" ? "open pullback" : "open drive"} ${s.dir}`;
      // journal-only context features (Naso hypotheses — features only on
      // these experimental cards, no labels)
      const rn = roundNumberChips(s);
      const gch = gapChips(fp, s, gaps);
      const wall = wallProxChips(this.wallReadFor(live.snapshot?.ltp ?? s.entry), s);
      if (nb) {
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict,
          headline,
          reason: `news blackout — ${nb}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, { kind: family, newsBlocked: nb, ...rn.features, ...gch.features, ...wall.features }),
        });
        continue;
      }
      const key = `${job.key}|${s.d}|${s.dir}|${s.t}`;
      if (this.openSent.has(key)) continue;
      const ov = await getOverrides();
      const dec = decideSignal(ov, {
        families: [family, "all"],
        hourET: parseInt(cdtToET(s.t).slice(0, 2), 10),
        side: s.dir,
        breakFrac: s.breakFrac,
        riskPts: s.risk,
        breakRangeR: null,
        cumDelta: s.cumDelta,
        firstOfDay: false,
      });
      if (!dec.allow) {
        console.log(`[overrides] ${family} ${s.dir} SKIPPED — ${dec.reasons.join("; ")}`);
        await this.recordSkip({
          timeET: cdtToET(s.t),
          day: s.d,
          side: s.dir,
          price: s.entry,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          verdict,
          headline,
          reason: `overrides: ${dec.reasons.join("; ")}`,
          features: signalFeatures(s as unknown as Record<string, unknown>, {
            kind: family,
            rejectedBy: dec.reasons,
            gates: this.gateSnapshot(ov),
            ...rn.features,
            ...gch.features,
            ...wall.features,
          }),
        });
        continue;
      }
      this.openSent.add(key);
      if (this.openSent.size > 200) this.openSent = new Set([...this.openSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
      const cap = Number(process.env.OPEN_RISK_CAP ?? "100");
      const fixed = fixedContracts(0);
      const budget = cap > 0 ? Math.min(riskBudget, cap) : riskBudget;
      const contracts =
        fixed > 0 ? cappedContracts(fixed, s.risk, cap) : momentumSize(s.risk, budget).contracts;
      const size = await this.applyDayTier(
        { contracts, dollarRisk: contracts * s.risk * 2, capped: fixed > 0 && cap > 0 && fixed > contracts },
        s.risk,
      );
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? ` ($${cap} risk cap)` : ""}${size.mult < 1 ? ` (size ×${Math.round(size.mult * 100)}%)` : ""}`;

      const et = cdtToET(s.t);
      void placeOrder(
        {
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          timeET: et,
        },
        { label: `${family} ${s.dir} ${et}` },
      )
        .then((res) => {
          void logExec({
            key: `open|${key}`,
            label: `${family} ${s.dir} ${et}`,
            attempt: "initial",
            outcome: res.ok ? "ok" : "failed",
            reason: res.reason,
          });
          if (!res.ok) registerSendFailure(`open|${key}`, `${family} ${s.dir} ${et}`, res.reason);
        })
        .catch(() => {});

      const evidence =
        job.key === "sniper"
          ? `flush ${s.flushVol} ct held the opening ${s.dir === "long" ? "low" : "high"} · rest the limit`
          : job.key === "pullback"
            ? `trend delta ${s.cumDelta >= 0 ? "+" : ""}${s.cumDelta} · pullback reclaimed with ${Math.round(s.breakFrac * 100)}% ${s.dir === "long" ? "buy" : "sell"}`
            : `opening-range breakout · delta ${s.cumDelta >= 0 ? "+" : ""}${s.cumDelta} · ${Math.round(s.breakFrac * 100)}% ${s.dir === "long" ? "buy" : "sell"}`;
      const text = [
        `🔔 <b>${job.title} ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(s.entry)} · ${et} NY</b>`,
        ``,
        `<code>ENTRY   ${fmtPx(s.entry)}</code>`,
        `<code>STOP    ${fmtPx(s.stop)}   ${distTxt(s.entry, s.stop)}</code>`,
        `<code>TARGET  ${fmtPx(s.target)}   ${distTxt(s.entry, s.target)}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        evidence,
        `<i>${job.stat} · ${job.plan} · experimental — journal separately</i>`,
      ].join("\n");
      const res = await this.push(text);
      if (!res.sent) this.lastError = res.reason;
      await this.record({
        timeET: et,
        day: s.d,
        symbol: symbol(),
        side: s.dir,
        price: s.entry,
        entry: s.entry.toFixed(2),
        stop: s.stop.toFixed(2),
        target: s.target.toFixed(2),
        size: sizeStr,
        verdict: job.key === "sniper" ? "open sniper (experimental)" : job.key === "pullback" ? "open pullback (experimental)" : "open drive (experimental)",
        headline: `NQ ${job.key === "sniper" ? "open sniper" : job.key === "pullback" ? "open pullback" : "open drive"} ${s.dir}`,
        source: "live",
        test: false,
        sent: res.sent,
        reason: res.reason,
        features: signalFeatures(s as unknown as Record<string, unknown>, { kind: family, gates: this.gateSnapshot(ov), ...rn.features, ...gch.features, ...wall.features }),
      });
      registerExpectation({
        key: `open|${key}`,
        ts: Date.now(),
        label: `${family} ${s.dir}`,
        intent: {
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          timeET: et,
        },
        scaleOut: false,
      });
    }
    }
  }

  /** Unusual-volume heads-up: a completed minute at >=2x its hour's norm with
   *  a one-sided print (>=70% buy or >=70% sell). The card carries the bar's
   *  own footprint context (POC + migration, close position, imbalance stack)
   *  and its location context (nearest level) — the "decision point" question.
   *  An alert, not a trade signal — fire once per minute. */
  private async checkUnusualVolume(): Promise<void> {
    if (!FEED_UNUSUAL_VOLUME) return;
    const live = getLive().state;
    if (!live.connected || !live.minutes.length) return;
    const n = live.minutes.length;
    const last = live.minutes[n - 1];
    if (!/^\d{2}:\d{2}$/.test(last.t)) return;
    const vol = last.buy + last.sell;
    if (vol <= 0) return;
    const buyFrac = last.buy / vol;
    if (buyFrac < 0.7 && buyFrac > 0.3) return; // skip 50/50-ish two-way volume
    const et = utcToET(last.t, last.du);
    const etHour = parseInt(et.slice(0, 2), 10);
    if (!isUnusualVolume(etHour, vol)) return;
    const key = `${last.du ?? ""}|${last.t}`;
    if (this.volumeAlerted.has(key)) return;
    this.volumeAlerted.add(key);
    if (this.volumeAlerted.size > 500) this.volumeAlerted = new Set([...this.volumeAlerted].slice(-250));

    const side = buyFrac >= 0.7 ? "buy" : "sell";
    const rv = rvol(etHour, vol);
    const buyPct = Math.round(buyFrac * 100);
    const watch: string[] = [];

    // ---- the momentum watch this bar arms: a one-sided bar that FAILS to
    //      make a new extreme is stage 1-2 of the momentum sequence ----
    const sessLow = live.snapshot?.low ?? Math.min(...live.minutes.map((m) => m.l));
    const sessHigh = live.snapshot?.high ?? Math.max(...live.minutes.map((m) => m.h));
    const prior = live.minutes.slice(Math.max(0, n - 21), n - 1);
    const trailLo = prior.length ? Math.min(...prior.map((m) => m.l)) : Infinity;
    const trailHi = prior.length ? Math.max(...prior.map((m) => m.h)) : -Infinity;
    if (side === "sell") {
      let ref = -Infinity;
      for (let k = Math.max(0, n - 3); k < n; k++) ref = Math.max(ref, live.minutes[k].h);
      if (last.l > sessLow) {
        watch.push(`failed flush (no new session low) → watch buy breakout > ${fmtPx(ref)}`);
      } else if (last.l > trailLo) {
        watch.push(`failed flush (no new local low) → watch buy breakout > ${fmtPx(ref)}`);
      }
    }
    if (side === "buy") {
      let ref = Infinity;
      for (let k = Math.max(0, n - 3); k < n; k++) ref = Math.min(ref, live.minutes[k].l);
      if (last.h < sessHigh) {
        watch.push(`failed rally (no new session high) → watch sell breakdown < ${fmtPx(ref)}`);
      } else if (last.h < trailHi) {
        watch.push(`failed rally (no new local high) → watch sell breakdown < ${fmtPx(ref)}`);
      }
    }

    const text = [
      `⚠ <b>NQ ${vol} ct · ${et} NY</b>`,
      `${rv.toFixed(1)}× volume · ${buyPct}% buy`,
      ...(watch.length ? [``, ...watch] : []),
      `<i>heads-up only · ${headsUpWrLine()}</i>`,
    ].join("\n");
    const res = await this.push(text);
    if (!res.sent) this.lastError = res.reason;

    // arm the stage-2 pullback watch on the alert bar
    this.pullbackWatch = {
      side,
      high: last.h,
      low: last.l,
      armedIdx: n - 1,
      armedAt: Date.now(),
      started: false,
      startIdx: -1,
      pullExtreme: 0,
    };
  }

  /** Stage 2 of the unusual-volume alert: watch the bars after a one-sided
   *  volume bar for the pullback (first aggressive counter-side bar) and its
   *  exhaustion (a flush of the pullback extreme reclaimed one-sidedly).
   *  The pullback-start is context; the reclaim prints a full 1R ticket. */
  private async checkPullbackWatch(): Promise<void> {
    if (!FEED_UNUSUAL_VOLUME) {
      this.pullbackWatch = null; // no new alerts → no watch either
      return;
    }
    const w = this.pullbackWatch;
    if (!w) return;
    const live = getLive().state;
    if (!live.connected || !live.minutes.length) return;
    const mins = live.minutes.map((m) => ({ t: m.t, high: m.h, low: m.l, buy: m.buy, sell: m.sell, c: m.c }));
    const ev = uvWatchCheck(w, mins, Date.now(), UV_WATCH_MS);
    if (!ev) return;

    if (ev.kind === "expired") {
      this.pullbackWatch = null;
      return;
    }

    if (ev.kind === "cancelled") {
      this.pullbackWatch = null;
      const lastMin = live.minutes[live.minutes.length - 1];
      const text = [
        `↩ <b>NQ PULLBACK WATCH OFF</b>`,
        `<code>${symbol()}  ${utcToET(lastMin.t, lastMin.du)} NY</code>`,
        `${ev.reason} — no pullback setup left to watch`,
      ].join("\n");
      const res = await this.push(text);
      if (!res.sent) this.lastError = res.reason;
      return;
    }

    if (ev.kind === "start") {
      w.started = true;
      w.startIdx = ev.idx;
      w.pullExtreme = ev.pullExtreme;
      const et = utcToET(ev.t, live.minutes[ev.idx]?.du);
      const pct = Math.round(ev.deltaPct * 100);
      const text = [
        `↩ <b>NQ PULLBACK STARTING</b>`,
        `<code>${symbol()}  ${fmtPx(ev.price)}  ${et} NY</code>`,
        `first aggressive ${ev.flipTo === "down" ? "sell" : "buy"} bar (${pct}% delta) after the unusual ${w.side} volume`,
        `<i>watching ${fmtPx(ev.pullExtreme)} for a sweep-reclaim</i>`,
      ].join("\n");
      const res = await this.push(text);
      if (!res.sent) this.lastError = res.reason;
      return;
    }

    // reclaim — the pullback is exhausted. The 1R trade ticket is gated by
    // FEED_PULLBACK_TICKET: single-strategy mode keeps the momentum card as
    // the ONLY trade signal (the watch still expires silently here).
    this.pullbackWatch = null;
    if (!FEED_PULLBACK_TICKET) return;
    const et = utcToET(ev.t, live.minutes[live.minutes.length - 1]?.du);
    const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || PROP_RISK_PER_TRADE;
    const contracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, Math.abs(ev.entry - ev.stop))));
    const sizeStr = `${contracts} MNQ · risk $${Math.round(contracts * Math.abs(ev.entry - ev.stop) * RAPID_EOD_50K.pointValue)}`;
    const text = [
      `↩ <b>NQ PULLBACK EXHAUSTED — ${ev.dir === "long" ? "🟢 LONG" : "🔴 SHORT"}</b>`,
      `<code>${symbol()}  ${fmtPx(ev.entry)}  ${et} NY</code>`,
      `flush of ${fmtPx(ev.swept)} reclaimed with ${Math.round(ev.buyPct * 100)}% ${ev.dir === "long" ? "buy" : "sell"} — the pullback after the unusual ${w.side} volume is likely over`,
      `<code>ENTRY ${fmtPx(ev.entry)} · STOP ${fmtPx(ev.stop)} · TARGET ${fmtPx(ev.target)}</code> · ${sizeStr}`,
      `<i>1R scalp — ${STATS.sweepReclaim.name.toLowerCase()} family (${STATS.sweepReclaim.stat})</i>`,
    ].join("\n");
    const res = await this.push(text);
    if (!res.sent) this.lastError = res.reason;
  }

  /** feed-gap watch: completed minutes that never reached us while the
   *  feed was connected = bars the detectors could not see (possible
   *  missed signals). Alert once per gap. Session-boundary gaps are
   *  ignored (du change or >10h). The push is gated by FEED_GAP_ALERTS
   *  (off by default — Telegram gets trade signals only); the detector
   *  itself keeps running. */
  private gapAlerted = new Set<string>();

  private feedGapCheck(): void {
    if (!FEED_GAP_ALERTS) return;
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 2) return;
    const mins = live.minutes;
    const prev = mins[mins.length - 2];
    const last = mins[mins.length - 1];
    if (prev.du !== last.du) return; // session/day boundary — expected
    const gap = feedMinutesGap(prev.t, last.t);
    if (gap === null || gap <= 1 || gap > 600) return; // adjacent or a maintenance break
    const key = `${last.du ?? ""}|${prev.t}`;
    if (this.gapAlerted.has(key)) return;
    this.gapAlerted.add(key);
    if (this.gapAlerted.size > 100) this.gapAlerted = new Set([...this.gapAlerted].slice(-50));
    const text = [
      `⚠ <b>FEED GAP — possible missed signal</b>`,
      `<code>${symbol()}  ${last.t} UTC</code>`,
      `${gap} minute(s) of completed bars never reached the feed while connected — the detectors could not see them`,
    ].join("\n");
    void this.push(text);
  }

  async tick(source: "boot" | "poll" | "event" | "tick" = "tick"): Promise<void> {
    if (this.ticking) {
      // non-lossy coalescing: a tick that arrives while one runs is
      // QUEUED (last source wins), never dropped. A dropped event tick
      // would permanently lose its bar — the max already advanced and
      // the poll backstop skips it.
      this.pendingTick = source;
      return;
    }
    this.ticking = true;
    this.tickEpoch += 1;
    startCycle(source);
    let err: string | null = null;
    try {
      // ---- signal window (owner rule): Sunday 18:00 ET → Friday 16:00 ET
      //      with a daily 16:00–18:00 ET halt Mon–Thu (MyFundedFutures
      //      rejects entries after 16:00; lib/marketHours.ts signalWindowOpen).
      //      Outside it NOTHING fires: no cards, no orders, no re-sends.
      //      Armed intra-window state (a resting expansion retrace, the
      //      pullback watch) is discarded so it can never fire on stale
      //      bars when the window reopens.
      if (!signalWindowOpen(Date.now())) {
        this.liveOk = false;
        this.lastNote = "signal window closed — Sunday 18:00 → Friday 16:00 NY · daily 16:00–18:00 halt";
        this.lastRun = Date.now();
        if (this.expRetracePending) {
          console.log(
            `[window] discarding armed expansion retrace ${this.expRetracePending.dir} ${this.expRetracePending.t} — window closed`,
          );
          this.expRetracePending = null;
        }
        this.pullbackWatch = null;
        finishCycle("signal window closed");
        return;
      }
      // ---- telemetry stage 1: getData = feed-freshness probe. The heavy
      //      snapshot (computeSignal — aggregate/mechanism/price-action)
      //      feeds ONLY the reversal card (FEED_REVERSAL, OFF on the live
      //      feed) and the /api/signal dashboard, so it moved to the 30s
      //      display cadence (refreshSnapshot) instead of riding the
      //      dispatch-critical tick.
      let t0 = performance.now();
      this.probeFreshness();
      markStage("getData", performance.now() - t0);
      // ---- telemetry: bar age = last completed bar close → now (the
      //      continuous detection-lag metric the event tick attacks)
      {
        const closeMs = barCloseMs(getLive().state.minutes.at(-1));
        if (closeMs !== null) markBarAge(Math.max(0, Date.now() - closeMs));
      }
      this.lastRun = Date.now();
      if (FEED_REVERSAL) {
        const snap = await this.buildSnapshot();
        if (snap) {
          this.lastSnapshot = snap;
          this.lastError = null;
          await this.maybeSend(snap);
        }
      }
      // ---- telemetry stage 3: compute = each detector/gate check
      //      (feedCheck rides along inside tapeGateHolds; dispatch is
      //      stamped at the executor choke point, lib/executor.ts)
      const checks: Array<[string, () => Promise<void>]> = [
        ["reclaim", () => this.checkReclaimSetup()],
        ["unusualVolume", () => this.checkUnusualVolume()],
        ["pullbackWatch", () => this.checkPullbackWatch()],
        ["expRetrace", () => this.checkExpRetrace()],
        ["momentum", () => this.checkMomentum()],
        ["openDrive", () => this.checkOpen()],
        ["rth", () => this.checkRth()],
      ];
      for (const [name, fn] of checks) {
        t0 = performance.now();
        await fn();
        markCheck(name, performance.now() - t0);
      }
      this.feedGapCheck();
      // post-fire outcome tracking: re-score today's still-open signals from
      // the live bars and write win/loss into the signals table as the day
      // progresses. OBSERVATIONAL ONLY — the outcome columns are never read
      // by the signal engine, so this can never change a decision
      // (fire-and-forget; DB hiccups are swallowed inside).
      void updateLiveOutcomes(getLive().state.minutes).catch(() => {});
      // (fill expectations now run on their own 5s timer in lib/execWatch,
      //  not on the feed tick — no quantization behind the feed cadence)
      void checkTimeExits().catch(() => {});
    } catch (e) {
      this.lastError = String(e);
      err = this.lastError;
    } finally {
      finishCycle(err ?? undefined);
      this.ticking = false;
      const queued = this.pendingTick;
      this.pendingTick = null;
      if (queued) void this.tick(queued);
    }
  }

  /** the heavy snapshot for the dashboard + reversal card, decoupled from
   *  the dispatch tick so computeSignal can never sit between detection
   *  and the order POST. 30s cadence (it used to run on every 15s tick)
   *  + boot + on demand (pushNow). */
  private async refreshSnapshot(): Promise<void> {
    if (this.ticking) return; // never compete with a live tick
    try {
      const snap = await this.buildSnapshot();
      if (snap) {
        this.lastSnapshot = snap;
        this.lastError = null;
      }
    } catch {
      /* display-only — a failed snapshot must never disturb the loop */
    }
  }

  /** force a push of the current signal (test button / manual check) */
  async pushNow(): Promise<{ sent: boolean; reason: string }> {
    if (!FEED_REVERSAL) {
      return { sent: false, reason: "LVN reversal feed is paused — set FEED_REVERSAL=1 to re-enable" };
    }
    if (!signalWindowOpen(Date.now())) {
      return { sent: false, reason: "signal window closed — Sunday 18:00 → Friday 16:00 NY · daily 16:00–18:00 halt" };
    }
    const snap = await this.buildSnapshot();
    if (!snap) return { sent: false, reason: this.lastNote ?? "no live signal to send" };
    this.lastSnapshot = snap;
    const text = formatSignalHtml(snap.signal, snap.mech, snap.pa, snap.opt, {
      symbol: snap.symbol,
      price: snap.lastPrice,
      timeET: snap.timeET,
      source: snap.source,
    });
    const res = await this.push(text);
    await this.record({
      timeET: snap.timeET,
      day: snap.day,
      symbol: snap.symbol,
      side: snap.signal.side ?? "none",
      price: snap.lastPrice,
      entry: snap.mech.trigger,
      stop: snap.mech.invalidation,
      target: snap.mech.target,
      size: sizeLine(snap.mech),
      verdict: snap.signal.verdict,
      headline: snap.signal.headline,
      source: snap.source,
      test: true,
      sent: res.sent,
      reason: res.reason,
    });
    return res;
  }

  start(): void {
    if (this.timer) return;
    // boot the live + options feeds (idempotent) so the loop has data to read
    getLive();
    getOptionsFeed();
    // re-attach to any runners left open by a previous process
    void runnerTracker.load();
    this.tick("boot");
    // the heavy display snapshot (dashboard /api/signal + the reversal
    // card) runs on its own 30s cadence — OFF the dispatch tick
    this.displayTimer = setInterval(() => {
      void this.refreshSnapshot().catch(() => {});
    }, 30_000);
    // the interval is the BACKSTOP: it sleeps while the tail's close is
    // not newer than the max the events have seen, and fires the moment
    // the buffer rolls a bar the emits missed (or the tail is unparseable)
    this.timer = setInterval(() => {
      const now = Date.now();
      if (!signalWindowOpen(now)) return;
      const skip = pollBackstopSkip(getLive().state.minutes.at(-1), this.eventTickMaxClose);
      if (skip) {
        if (now - this.pollSkipLoggedAt > 60_000) {
          this.pollSkipLoggedAt = now;
          console.log(`[signal-feed] poll backstop sleeping — tail close <= event max (${this.eventTickMaxClose})`);
        }
        return;
      }
      console.log(`[signal-feed] poll backstop firing — tail newer than event max (${this.eventTickMaxClose})`);
      void this.tick("poll");
    }, refreshSeconds() * 1000);
    this.startEventTick();
  }

  /** SIGNAL_EVENT_TICK=1 — zero-latency detection: instead of waiting for
   *  the next poll, run the tick the moment the live state shows a NEW
   *  completed bar (tail close past the max) or the max-close bar
   *  flipping to candle-confirmed (the tape gate still holds cards until
   *  confirmation, so this fires exactly when the first tradeable moment
   *  arrives). Backward tail oscillations and frames that merge nothing
   *  are ignored (eventTickDecision). The interval stays as the safety
   *  net — it fires the moment the buffer rolls a bar the emits missed.
   *  OFF by default — enablement is an execution-knob change and needs
   *  the owner's env approval first (web/EXEC_CHANGE_POLICY.md rule 4). */
  private startEventTick(): void {
    if (!feedFlag("SIGNAL_EVENT_TICK", false)) return;
    console.log("[signal-feed] event tick ENABLED (SIGNAL_EVENT_TICK=1) — bar-advance/confirm triggers");
    getLive().subscribe((st) => {
      const last = st.minutes[st.minutes.length - 1];
      const closeMs = barCloseMs(last) ?? 0;
      const barSrc = last?.source ?? "";
      const d = eventTickDecision(
        { maxCloseMs: this.eventTickMaxClose, srcAtMax: this.eventTickSrcAtMax, revAtMax: this.eventTickRevAtMax },
        { closeMs, barSrc, revision: st.barsRevision },
      );
      this.eventTickMaxClose = d.maxCloseMs;
      this.eventTickSrcAtMax = d.srcAtMax;
      this.eventTickRevAtMax = d.revAtMax;
      if (!d.fire) return;
      const now = Date.now();
      if (now - this.eventTickLast < 250) return; // stampede throttle
      if (!signalWindowOpen(now)) return;
      this.eventTickLast = now;
      void this.tick("event");
    });
  }
}

const g = globalThis as unknown as { __gcSignalFeed?: SignalFeed };

export function getSignalFeed(): SignalFeed {
  if (!g.__gcSignalFeed) {
    g.__gcSignalFeed = new SignalFeed();
    g.__gcSignalFeed.start();
  }
  return g.__gcSignalFeed;
}
