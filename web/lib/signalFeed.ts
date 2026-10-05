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
import { readOptionsFromSnapshot, wallsFromRead } from "./options";
import { applyWallStop } from "./wallStop";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "./openDrive";
import { detectSoftMomentum, SOFT_PROD } from "./softMomentum";
import { momentumSize, cappedContracts, daySizeMultiplier, parseSizeTiers, DEFAULT_SIZE_TIERS } from "./propRules";
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
import { crossGuardDayPnl } from "./crossGuard";
import { newsBlockedNow } from "./newsGate";
import { registerExpectation, registerSendFailure, checkExpectations, attachLimitOrderId } from "./execWatch";
import { momentumProfile, rthProfile, applyProfile, timeExitAt } from "./profile";
import { registerTimeExit, checkTimeExits } from "./timeExit";
import { logExec } from "./execLog";
import { signalWindowOpen } from "./marketHours";

function refreshSeconds(): number {
  // 15s default (was 30): the momentum/RTH triggers fire only on the
  // just-completed minute bar, so a slower loop skips bars when a tick
  // runs long — 15s halves the miss window.
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
  private ctxCache: { date: string; ctx: CollectedContext } | null = null;
  private lastCtxLoad = 0;
  private sent = new Set<string>();
  private reclaimSent = new Set<string>();
  private volumeAlerted = new Set<string>();
  private momentumSent = new Set<string>();
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

  /** cross-asset context from the live ES twin buffer, aligned to the NQ
   *  feed-clock minutes (the same utcToFeedStamp conversion the footprint
   *  uses). Null while the ES twin has fewer than 30 usable bars. */
  private esContext(fp: FootprintMinute[]): EsContext | null {
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

  /** build the current signal — from LIVE data only, or null when closed/stale */
  async buildSnapshot(): Promise<SignalSnapshot | null> {
    const ctx = await this.ctx();
    const live = getLive().state;
    let gamma = getOptionsFeed().snapshot();
    if (!gamma) gamma = await optionsSnapshot().catch(() => null);

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
      return null;
    }

    const minutes = liveMinutesToFootprint(liveMins);
    if (!minutes.length) return null;
    this.liveOk = true;
    this.lastNote = "live";

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

  /** shrink contracts as the day's profit climbs (tiered sizing) */
  private async applyDayTier(
    size: { contracts: number; dollarRisk: number; capped: boolean },
    riskPts: number,
  ): Promise<{ contracts: number; dollarRisk: number; capped: boolean; mult: number }> {
    const dayPnl = crossTradeEnabled() ? await crossGuardDayPnl() : 0;
    const mult = daySizeMultiplier(dayPnl, sizeTiers);
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
    const fp = liveMinutesToFootprint(live.minutes);
    const setup = detectOneSidedReclaim(fp);
    if (!setup) return;
    const key = `${setup.day}|${setup.dir}|${setup.t}`;
    if (this.reclaimSent.has(key)) return;
    this.reclaimSent.add(key);
    if (this.reclaimSent.size > 500) this.reclaimSent = new Set([...this.reclaimSent].slice(-250));

    // position size for a fixed dollar risk (PROP_RISK_PER_TRADE, default $170)
    const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || 170;
    const rawContracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, setup.risk)));
    const tiered = await this.applyDayTier(
      { contracts: rawContracts, dollarRisk: rawContracts * setup.risk * 2, capped: false },
      setup.risk,
    );
    const contracts = tiered.contracts;
    const sizeStr = `${contracts} MNQ · risk $${Math.round(contracts * setup.risk * RAPID_EOD_50K.pointValue)}`;

    // emit the order intent to the executor (dry-run by default)
    void placeOrder({
      symbol: symbol(),
      dir: setup.dir,
      contracts,
      entry: setup.entry,
      stop: setup.stop,
      target: setup.target,
      timeET: setup.timeET,
    })
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
    const fp = liveMinutesToFootprint(live.minutes);
    // cross-asset context for the measured ES chips (null while the twin
    // buffer is too young — chips simply don't print)
    const esCtx = this.esContext(fp);
    const nqMid = fp.map((m) => (m.high + m.low) / 2);
    // ladder management for open scale-out runners (CrossTrade backend only,
    // no new polling — reuses this tick's completed minutes)
    if (crossTradeEnabled()) void runnerTracker.evaluate(fp).catch(() => {});
    if (!FEED_MOMENTUM) return;
    const nb = newsBlockedNow(Date.now());
    const momSigs = detectMomentum(fp, MOM_PROD);
    const expSigs = detectExpansionScalp(fp, EXP_PROD);
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
          features: signalFeatures(s as unknown as Record<string, unknown>, { family: fam, newsBlocked: nb, ...es.features, ...seasonal.features }),
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
      const chipLine = [...seasonal.labels, ...es.labels].length ? `${[...seasonal.labels, ...es.labels].join(" · ")} · ` : "";

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
      // fixed $170 risk, 30-micro cap, $2/pt MNQ. FIXED_CONTRACTS overrides
      // with an exact contract count (the sizing study optimum: 9).
      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const fixed = Number(process.env.FIXED_CONTRACTS) || 0;
      const prof = momentumProfile();
      const profBracket = prof.enabled ? applyProfile(s.dir, s.entry, s.risk, prof) : null;
      // the optimized profile (0.35× stop / 2.25R / 60-bar) is single-leg;
      // the validated scale-out keeps its own 1R ladder and needs an
      // explicit CROSSTRADE_SCALEOUT=1 opt-in when the profile is on
      const scaleOut = prof.enabled
        ? process.env.CROSSTRADE_SCALEOUT === "1"
        : process.env.CROSSTRADE_SCALEOUT !== "0" && crossTradeEnabled();
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
          features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, firstToday, family, retrace: true, gates: this.gateSnapshot(ov), ...es.features }),
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
          `<i>${STATS.momentum.stat}</i>`,
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
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, firstToday, family, gates: this.gateSnapshot(ov), wallStop: wallNote || undefined, ...es.features, ...seasonal.features }),
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
        return res;
      } catch (e) {
        this.lastError = `scale-out: ${String(e)}`;
        return { ok: false, reason: String(e) };
      }
    }
    try {
      const limitTag = limitPrice !== undefined ? " (limit)" : "";
      const res = await placeOrder(intent, limitPrice !== undefined ? { limitPrice } : {});
      void logExec({
        key: `mom|${key}`,
        label: `momentum ${intent.dir} ${et}${suffix}${limitTag}`,
        attempt: "initial",
        outcome: res.ok ? "ok" : "failed",
        reason: res.reason,
      });
      if (!res.ok) registerSendFailure(`mom|${key}`, `momentum ${intent.dir} ${et}${suffix}${limitTag}`, res.reason);
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
    const fp = liveMinutesToFootprint(live.minutes);
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
    // CROSSTRADE_LIMIT_ENTRIES=1 mirrors the tape-side resting limit at the
    // BROKER as a resting limit at the same price (single-leg only) — the
    // watcher cancels it when the retrace window expires unfilled.
    const useLimit = process.env.CROSSTRADE_LIMIT_ENTRIES === "1" && !p.scaleOut;
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
    const fp = liveMinutesToFootprint(live.minutes);
    const esCtx = this.esContext(fp);
    const nqMid = fp.map((m) => (m.high + m.low) / 2);
    if (nb) console.log(`[news] ${nb} blackout — skipping RTH cards (candidates recorded)`);
    for (const s of detectSoftMomentum(fp, SOFT_PROD)) {
      if (s.breakIdx !== fp.length - 1) continue;
      if (nb) {
        const es = esCardChips(esCtx, nqMid, s, false);
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
          features: signalFeatures(s as unknown as Record<string, unknown>, { family: "rth", newsBlocked: nb, ...es.features }),
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
          }),
        });
        continue;
      }
      this.rthSent.add(key);
      if (this.rthSent.size > 200) this.rthSent = new Set([...this.rthSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const cap = Number(process.env.RTH_RISK_CAP ?? "200");
      const prof = rthProfile();
      const profBracket = prof.enabled ? applyProfile(s.dir, s.entry, s.risk, prof) : null;
      const fixed = prof.enabled ? fixedContracts(0) : fixedContracts(9);
      const stop = profBracket ? profBracket.stop : s.stop;
      const target = profBracket ? profBracket.target : s.target;
      const riskPts = profBracket ? profBracket.riskPts : s.risk;
      const contracts =
        fixed > 0
          ? cappedContracts(fixed, riskPts, cap)
          : momentumSize(riskPts, riskBudget * (prof.enabled ? prof.sizeMult : 1)).contracts;
      const size = await this.applyDayTier(
        { contracts, dollarRisk: contracts * riskPts * 2, capped: fixed > 0 && cap > 0 && fixed > contracts },
        riskPts,
      );
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? ` ($${cap} risk cap)` : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;

      const et = cdtToET(s.t);
      void placeOrder({
        symbol: symbol(),
        dir: s.dir,
        contracts: size.contracts,
        entry: s.entry,
        stop,
        target,
        timeET: et,
      })
        .then((res) => {
          void logExec({
            key: `rth|${key}`,
            label: `rth ${s.dir} ${et}`,
            attempt: "initial",
            outcome: res.ok ? "ok" : "failed",
            reason: res.reason,
          });
          if (!res.ok) registerSendFailure(`rth|${key}`, `rth ${s.dir} ${et}`, res.reason);
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
      const chipLine = es.labels.length ? `${es.labels.join(" · ")} · ` : "";
      const text = [
        `🟦 <b>${STATS.rth.name} ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(s.entry)} · ${et} NY</b>`,
        ``,
        `<code>ENTRY   ${fmtPx(s.entry)}</code>`,
        `<code>STOP    ${fmtPx(stop)}   ${distTxt(s.entry, stop)}</code>`,
        `<code>TARGET  ${fmtPx(target)}   ${distTxt(s.entry, target)}${profBracket ? ` (${prof.targetR}R @ ${prof.stopMult}× stop)` : ""}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        `${aPlus ? `A+ (${STATS.rth.aPlus}) · ` : ""}${chipLine}${Math.round(s.breakFrac * 100)}% one-sided · clusters ✓ · big bar · RTH continuation`,
        `<i>${STATS.rth.stat}${profBracket ? ` · ${prof.targetR}R @ ${prof.stopMult}× profile` : " · 0.75R plan — journal separately"}</i>`,
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
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, gates: this.gateSnapshot(ov), ...es.features }),
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
          stop: s.stop,
          target: s.target,
          timeET: et,
        },
        scaleOut: false,
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
    const fp = liveMinutesToFootprint(live.minutes);

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
      { key: "open", title: STATS.openDrive.name, sigs: FEED_OPEN_DRIVE ? detectOpenDrive(fp, OPEN_PROD) : [], plan: "fixed TP/SL plan", resting: false, stat: STATS.openDrive.stat },
      { key: "pullback", title: STATS.openPullback.name, sigs: FEED_OPEN_PULLBACK ? detectOpenDrive(fp, PULLBACK_PROD) : [], plan: "1R plan", resting: false, stat: STATS.openPullback.stat },
      { key: "sniper", title: STATS.openSniper.name, sigs: FEED_OPEN_SNIPER ? detectOpenDrive(fp, SNIPER_PROD) : [], plan: "resting limit · flush-high target", resting: true, stat: STATS.openSniper.stat },
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
          features: signalFeatures(s as unknown as Record<string, unknown>, { kind: family, newsBlocked: nb }),
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
          }),
        });
        continue;
      }
      this.openSent.add(key);
      if (this.openSent.size > 200) this.openSent = new Set([...this.openSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const cap = Number(process.env.OPEN_RISK_CAP ?? "200");
      const fixed = fixedContracts(9);
      const contracts =
        fixed > 0 ? cappedContracts(fixed, s.risk, cap) : momentumSize(s.risk, riskBudget).contracts;
      const size = await this.applyDayTier(
        { contracts, dollarRisk: contracts * s.risk * 2, capped: fixed > 0 && cap > 0 && fixed > contracts },
        s.risk,
      );
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? ` ($${cap} risk cap)` : ""}${size.mult < 1 ? ` (day tier ${Math.round(size.mult * 100)}%)` : ""}`;

      const et = cdtToET(s.t);
      void placeOrder({
        symbol: symbol(),
        dir: s.dir,
        contracts: size.contracts,
        entry: s.entry,
        stop: s.stop,
        target: s.target,
        timeET: et,
      })
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
        features: signalFeatures(s as unknown as Record<string, unknown>, { kind: family, gates: this.gateSnapshot(ov) }),
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
    const riskPerTrade = Number(process.env.PROP_RISK_PER_TRADE) || 170;
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

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
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
        return;
      }
      const snap = await this.buildSnapshot();
      this.lastRun = Date.now();
      if (snap) {
        this.lastSnapshot = snap;
        this.lastError = null;
        await this.maybeSend(snap);
      }
      await this.checkReclaimSetup();
      await this.checkUnusualVolume();
      await this.checkPullbackWatch();
      await this.checkExpRetrace();
      await this.checkMomentum();
      await this.checkOpen();
      await this.checkRth();
      this.feedGapCheck();
      // post-fire outcome tracking: re-score today's still-open signals from
      // the live bars and write win/loss into the signals table as the day
      // progresses. OBSERVATIONAL ONLY — the outcome columns are never read
      // by the signal engine, so this can never change a decision
      // (fire-and-forget; DB hiccups are swallowed inside).
      void updateLiveOutcomes(getLive().state.minutes).catch(() => {});
      void checkExpectations().catch(() => {});
      void checkTimeExits().catch(() => {});
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.ticking = false;
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
    this.tick();
    this.timer = setInterval(() => this.tick(), refreshSeconds() * 1000);
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
