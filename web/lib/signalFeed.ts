/* ------------------------------------------------------------------ *
 * Signal feed — the always-on Telegram loop (LIVE ONLY).
 *
 * Mirrors lib/optionsFeed.ts and lib/live.ts: a long-lived singleton
 * that, every SIGNAL_REFRESH_SECONDS (default 30s), recomputes the full
 * signal from the LIVE GoCharting feed + collected levels and pushes the
 * cards below when their sequence completes.
 *
 * SINGLE-STRATEGY MODE: the momentum card (FEED_MOMENTUM) is the one
 * TRADE signal. The unusual-volume heads-up alert stays on as context
 * (FEED_UNUSUAL_VOLUME, informational only); the reversal, sweep-reclaim
 * and pullback-ticket cards are off by default (set their FEED_* flags
 * to 1 to re-enable).
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
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD } from "./momentum";
import { detectOpenDrive, OPEN_PROD, PULLBACK_PROD, SNIPER_PROD } from "./openDrive";
import { detectSoftMomentum, SOFT_PROD } from "./softMomentum";
import { momentumSize } from "./propRules";
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
import { utcToET, cdtToET } from "./times";
import { placeOrder } from "./executor";
import { crossTradeEnabled, placeCrossTradeScaleOut } from "./crossTrade";
import { runnerTracker } from "./runnerTracker";
import { cardGateOpen } from "./signals";
import { sizeLine } from "./mechanism";
import { uvWatchCheck, type UVWatch } from "./unusualVolume";
import { sendTelegram } from "./notify";
import { formatSignalHtml, formatReclaimSetupHtml } from "./signalText";
import { recordSignal } from "./signalHistory";
import { STATS, headsUpWrLine } from "./strategyStats";
import { getOverrides, decideSignal } from "./strategyOverrides";
import { newsBlockedNow } from "./newsGate";
import { registerExpectation, registerSendFailure, checkExpectations } from "./execWatch";

function refreshSeconds(): number {
  const n = Number(process.env.SIGNAL_REFRESH_SECONDS);
  return Number.isFinite(n) && n >= 10 ? n : 30;
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
 *  watch context. ON: the alert is informational only ("heads-up only — not
 *  a trade signal"); the pullback trade ticket is gated separately by
 *  FEED_PULLBACK_TICKET so the momentum card stays the ONLY trade signal. */
export const FEED_UNUSUAL_VOLUME = feedFlag("FEED_UNUSUAL_VOLUME", true);
/** FEED_PULLBACK_TICKET — the pullback-exhausted 1R trade ticket. OFF by
 *  default: single-strategy focus means the momentum card is the only
 *  trade signal; the pullback watch still prints its context messages. */
export const FEED_PULLBACK_TICKET = feedFlag("FEED_PULLBACK_TICKET", false);
/** FEED_MOMENTUM — the failed-flush → response → one-sided-breakout momentum
 *  card (lib/momentum.ts, MOM_PROD). THE single active strategy. 77.5% win /
 *  PF 2.98 in the 568-session replay — joins the one-sided run. */
export const FEED_MOMENTUM = feedFlag("FEED_MOMENTUM", true);
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

function distTxt(from: number, to: number): string {
  const pts = Math.abs(to - from);
  const ticks = Math.round(pts / 0.25);
  return `${to < from ? "−" : "+"}${pts.toFixed(2)} pts · ${ticks} ticks`;
}

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

  private async maybeSend(snap: SignalSnapshot): Promise<void> {
    if (!FEED_REVERSAL) return;
    // The card gate (STRATEGY.md "When a signal exists"): every directional
    // box aligned AND all three required ingredients present — location
    // "yes" = at/inside an LVN, and "no reclaim, no trade" — AND at least
    // one confirmation (present >= 4 of 6). Backtest optimum: 4/6 hits
    // ~PF 2.0 out-of-sample (6/6 never fires, 5/6 leaves PF ~1.7).
    // Pullbacks are deliberately not notified.
    const gate = cardGateOpen(snap.signal, snap.mech);
    if (!gate.ok) return;

    // Footprint signature filters (see FOOTPRINT_REVERSAL_RESEARCH.md):
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
    const res = await sendTelegram(text, { parseMode: "HTML" });
    if (!res.sent) this.lastError = res.reason;
    // record the push so the dashboard has a history to consult (best-effort —
    // a persistence failure must never block the Telegram loop)
    await recordSignal({
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
    const contracts = Math.max(1, Math.floor(contractsForRisk(riskPerTrade, setup.risk)));
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
        if (!res.ok) registerSendFailure(key, `sweep-reclaim ${setup.dir} ${setup.timeET}`, res.reason);
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
    const res = await sendTelegram(text, { parseMode: "HTML" });
    if (!res.sent) this.lastError = res.reason;
    await recordSignal({
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
    // ladder management for open scale-out runners (CrossTrade backend only,
    // no new polling — reuses this tick's completed minutes)
    if (crossTradeEnabled()) void runnerTracker.evaluate(fp).catch(() => {});
    if (!FEED_MOMENTUM) return;
    const nb = newsBlockedNow(Date.now());
    if (nb) {
      console.log(`[news] ${nb} blackout — skipping momentum card`);
      return;
    }
    const momSigs = detectMomentum(fp, MOM_PROD);
    const expSigs = detectExpansionScalp(fp, EXP_PROD);
    // A+ = both triggers fire on the same bar (78.9% win / PF 3.23 — the
    // highest-conviction Globex signal). The momentum signal wins the dedupe.
    const expKeys = new Set(expSigs.map((x) => `${x.d}|${x.dir}|${x.t}`));
    const sigs = [...momSigs, ...expSigs];
    for (const s of sigs) {
      if (s.breakIdx !== fp.length - 1) continue; // only the just-closed bar
      const key = `${s.d}|${s.dir}|${s.t}`;
      const aPlus = expKeys.has(key) && momSigs.some((x) => `${x.d}|${x.dir}|${x.t}` === key);
      if (this.momentumSent.has(key)) continue;
      const et = cdtToET(s.t);
      const firstToday = !this.cardedDays.has(s.d);

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
        continue;
      }

      this.momentumSent.add(key);
      if (this.momentumSent.size > 500) this.momentumSent = new Set([...this.momentumSent].slice(-250));

      // position size grounded in the Rapid EOD 50k rules (lib/propRules.ts):
      // fixed $170 risk, 30-micro cap, $2/pt MNQ. FIXED_CONTRACTS overrides
      // with an exact contract count (the sizing study optimum: 9).
      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const fixed = Number(process.env.FIXED_CONTRACTS) || 0;
      const size =
        fixed > 0
          ? { contracts: Math.min(30, fixed), dollarRisk: Math.min(30, fixed) * s.risk * 2, capped: false }
          : momentumSize(s.risk, riskBudget);

      // emit the order intent to the executor (dry-run by default).
      // Scale-out is ON by default (re-validated 2026-10-02 on the rr1.0
      // gate: expR 0.47 vs 0.44 fixed-1R, account sim PASS): bank 2/3 at
      // 1R + runner 1/3 laddered via CHANGE orders. CROSSTRADE_SCALEOUT=0
      // returns the momentum card to a single bracketed order.
      const scaleOut = process.env.CROSSTRADE_SCALEOUT !== "0" && crossTradeEnabled();
      if (scaleOut) {
        void placeCrossTradeScaleOut({
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          timeET: cdtToET(s.t),
        })
          .then((res) => {
            if (res.runnerOrderId) {
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
                entryTimeET: cdtToET(s.t),
                createdAt: new Date().toISOString(),
              });
            }
            if (!res.ok) {
              this.lastError = `scale-out: ${res.reason}`;
              registerSendFailure(key, `momentum ${s.dir} ${et} (scale-out)`, res.reason);
            }
          })
          .catch((e) => {
            this.lastError = `scale-out: ${String(e)}`;
          });
      } else {
        void placeOrder({
          symbol: symbol(),
          dir: s.dir,
          contracts: size.contracts,
          entry: s.entry,
          stop: s.stop,
          target: s.target,
          timeET: cdtToET(s.t),
        })
          .then((res) => {
            if (!res.ok) registerSendFailure(key, `momentum ${s.dir} ${et}`, res.reason);
          })
          .catch(() => {});
      }

      this.cardedDays.add(s.d);
      if (this.cardedDays.size > 20) this.cardedDays = new Set([...this.cardedDays].slice(-10));
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}`;
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
        `<code>STOP    ${fmtPx(s.stop)}   ${distTxt(s.entry, s.stop)}</code>`,
        scaleOut
          ? `<code>BANK 2/3 @ +1R · RUN 1/3 ladder (BE @1R · +1R @2R · +2R @3R…)</code>`
          : `<code>TARGET  ${fmtPx(s.target)}   ${distTxt(s.entry, s.target)}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        `${aPlus ? `A+ both triggers (${STATS.momentum.aPlus}) · ` : ""}${firstToday ? `1st today (${STATS.momentum.firstOfDay}) · ` : ""}${evidence}`,
        `<i>${STATS.momentum.stat}</i>`,
      ].join("\n");
      const res = await sendTelegram(text, { parseMode: "HTML" });
      if (!res.sent) this.lastError = res.reason;
      await recordSignal({
        timeET: et,
        day: s.d,
        symbol: symbol(),
        side: s.dir,
        price: s.entry,
        entry: s.entry.toFixed(2),
        stop: s.stop.toFixed(2),
        target: s.target.toFixed(2),
        size: sizeStr,
        verdict: s.kind === "expansion" ? "momentum (huge-bar expansion)" : "momentum (failed-flush breakout)",
        headline: `NQ momentum ${s.dir}`,
        source: "live",
        test: false,
        sent: res.sent,
        reason: res.reason,
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus, firstToday, family }),
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
          stop: s.stop,
          target: s.target,
          timeET: et,
        },
        scaleOut,
      });
    }
  }

  /** RTH soft-continuation (lib/softMomentum.ts) — EXPERIMENTAL, off by
   *  default. 60% one-sided bars continue in the thick RTH tape. */
  private rthSent = new Set<string>();

  private async checkRth(): Promise<void> {
    if (!FEED_RTH) return;
    const nb = newsBlockedNow(Date.now());
    if (nb) {
      console.log(`[news] ${nb} blackout — skipping RTH card`);
      return;
    }
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 30) return;
    const fp = liveMinutesToFootprint(live.minutes);
    for (const s of detectSoftMomentum(fp, SOFT_PROD)) {
      if (s.breakIdx !== fp.length - 1) continue;
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
        console.log(`[overrides] rth ${s.dir} SKIPPED — ${dec.reasons.join("; ")}`);
        continue;
      }
      this.rthSent.add(key);
      if (this.rthSent.size > 200) this.rthSent = new Set([...this.rthSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const fixed = fixedContracts(9);
      const size =
        fixed > 0
          ? { contracts: fixed, dollarRisk: fixed * s.risk * 2, capped: false }
          : momentumSize(s.risk, riskBudget);
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}`;

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
          if (!res.ok) registerSendFailure(key, `rth ${s.dir} ${et}`, res.reason);
        })
        .catch(() => {});

      const aPlus = s.breakFrac >= 0.65 || s.breakFrac <= 0.35;
      const text = [
        `🟦 <b>${STATS.rth.name} ${s.dir === "long" ? "🟢 LONG" : "🔴 SHORT"} · ${fmtPx(s.entry)} · ${et} NY</b>`,
        ``,
        `<code>ENTRY   ${fmtPx(s.entry)}</code>`,
        `<code>STOP    ${fmtPx(s.stop)}   ${distTxt(s.entry, s.stop)}</code>`,
        `<code>TARGET  ${fmtPx(s.target)}   ${distTxt(s.entry, s.target)}</code>`,
        `<code>SIZE    ${sizeStr}</code>`,
        ``,
        `${aPlus ? `A+ (${STATS.rth.aPlus}) · ` : ""}${Math.round(s.breakFrac * 100)}% one-sided · clusters ✓ · big bar · RTH continuation`,
        `<i>${STATS.rth.stat} · 0.75R plan — journal separately</i>`,
      ].join("\n");
      const res = await sendTelegram(text, { parseMode: "HTML" });
      if (!res.sent) this.lastError = res.reason;
      await recordSignal({
        timeET: et,
        day: s.d,
        symbol: symbol(),
        side: s.dir,
        price: s.entry,
        entry: s.entry.toFixed(2),
        stop: s.stop.toFixed(2),
        target: s.target.toFixed(2),
        size: sizeStr,
        verdict: "rth soft-continuation (experimental)",
        headline: `NQ RTH ${s.dir}`,
        source: "live",
        test: false,
        sent: res.sent,
        reason: res.reason,
        features: signalFeatures(s as unknown as Record<string, unknown>, { aPlus }),
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
    if (nb) {
      console.log(`[news] ${nb} blackout — skipping open card`);
      return;
    }
    const live = getLive().state;
    if (!live.connected || live.minutes.length < 60) return;
    const fp = liveMinutesToFootprint(live.minutes);
    const jobs = [
      { key: "open", title: STATS.openDrive.name, sigs: FEED_OPEN_DRIVE ? detectOpenDrive(fp, OPEN_PROD) : [], plan: "fixed TP/SL plan", resting: false, stat: STATS.openDrive.stat },
      { key: "pullback", title: STATS.openPullback.name, sigs: FEED_OPEN_PULLBACK ? detectOpenDrive(fp, PULLBACK_PROD) : [], plan: "1R plan", resting: false, stat: STATS.openPullback.stat },
      { key: "sniper", title: STATS.openSniper.name, sigs: FEED_OPEN_SNIPER ? detectOpenDrive(fp, SNIPER_PROD) : [], plan: "resting limit · flush-high target", resting: true, stat: STATS.openSniper.stat },
    ];
    for (const job of jobs) {
    for (const s of job.sigs) {
      if (s.breakIdx !== fp.length - 1) continue; // only the just-closed bar
      const key = `${job.key}|${s.d}|${s.dir}|${s.t}`;
      if (this.openSent.has(key)) continue;
      const family = job.key === "sniper" ? "open_sniper" : job.key === "pullback" ? "open_pullback" : "open_drive";
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
        continue;
      }
      this.openSent.add(key);
      if (this.openSent.size > 200) this.openSent = new Set([...this.openSent].slice(-100));

      const riskBudget = Number(process.env.PROP_RISK_PER_TRADE) || 170;
      const fixed = fixedContracts(9);
      const size =
        fixed > 0
          ? { contracts: fixed, dollarRisk: fixed * s.risk * 2, capped: false }
          : momentumSize(s.risk, riskBudget);
      const sizeStr = `${size.contracts} MNQ · $${size.dollarRisk.toFixed(0)}${size.capped ? " (30-micro cap)" : ""}`;

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
          if (!res.ok) registerSendFailure(key, `${family} ${s.dir} ${et}`, res.reason);
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
      const res = await sendTelegram(text, { parseMode: "HTML" });
      if (!res.sent) this.lastError = res.reason;
      await recordSignal({
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
        features: signalFeatures(s as unknown as Record<string, unknown>, { kind: family }),
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
    const res = await sendTelegram(text, { parseMode: "HTML" });
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
      const res = await sendTelegram(text, { parseMode: "HTML" });
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
      const res = await sendTelegram(text, { parseMode: "HTML" });
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
    const res = await sendTelegram(text, { parseMode: "HTML" });
    if (!res.sent) this.lastError = res.reason;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
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
      await this.checkMomentum();
      await this.checkOpen();
      await this.checkRth();
      void checkExpectations().catch(() => {});
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
    const snap = await this.buildSnapshot();
    if (!snap) return { sent: false, reason: this.lastNote ?? "no live signal to send" };
    this.lastSnapshot = snap;
    const text = formatSignalHtml(snap.signal, snap.mech, snap.pa, snap.opt, {
      symbol: snap.symbol,
      price: snap.lastPrice,
      timeET: snap.timeET,
      source: snap.source,
    });
    const res = await sendTelegram(text, { parseMode: "HTML" });
    await recordSignal({
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
