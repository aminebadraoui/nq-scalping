/* ------------------------------------------------------------------ *
 * Signal feed — the always-on Telegram loop (LIVE ONLY).
 *
 * Mirrors lib/optionsFeed.ts and lib/live.ts: a long-lived singleton
 * that, every SIGNAL_REFRESH_SECONDS (default 30s), recomputes the full
 * signal from the LIVE GoCharting feed + collected levels and, when the
 * order-flow sequence completes (location + mechanism + trigger all
 * present — the reclaim is the last piece, i.e. the entry event), pushes
 * a formatted card to Telegram once per distinct setup.
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
import {
  loadCollectedContext,
  computeSignal,
  liveMinutesToFootprint,
  liveVwap,
  type CollectedContext,
  type SignalSnapshot,
} from "./signalEngine";
import { sendTelegram } from "./notify";
import { formatSignalHtml } from "./signalText";
import { recordSignal } from "./signalHistory";

function refreshSeconds(): number {
  const n = Number(process.env.SIGNAL_REFRESH_SECONDS);
  return Number.isFinite(n) && n >= 10 ? n : 30;
}

function symbol(): string {
  return process.env.GOCHARTING_SYMBOL || "NQZ26";
}

const CONTEXT_TTL_MS = 10 * 60 * 1000;
/** a live feed whose last print is older than this is treated as closed */
const STALE_MS = 5 * 60 * 1000;
/** need at least this many live minutes before a reversal can even form */
const MIN_LIVE_MINUTES = 5;

class SignalFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private ctxCache: { date: string; ctx: CollectedContext } | null = null;
  private lastCtxLoad = 0;
  private sent = new Set<string>();

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
    // Auto-notify on EITHER completed setup: the reversal sequence (location +
    // mechanism + trigger) OR the trend-continuation pullback (trend + retest +
    // footprint). Each fires once per distinct setup; the two are independent.
    const setups: { kind: "REVERSAL" | "PULLBACK"; read: SignalSnapshot["mech"] | SignalSnapshot["pb"] }[] = [];
    if (snap.mech.tone === "long" || snap.mech.tone === "short") setups.push({ kind: "REVERSAL", read: snap.mech });
    if (snap.pb.tone === "long" || snap.pb.tone === "short") setups.push({ kind: "PULLBACK", read: snap.pb });
    if (!setups.length) return;

    for (const { kind, read } of setups) {
      const sig = this.signature(snap, kind);
      if (this.sent.has(sig)) continue;
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
        verdict: read.verdict,
        headline: read.headline,
        source: snap.source,
        test: false,
        sent: res.sent,
        reason: res.reason,
      });
    }
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
    } catch (e) {
      this.lastError = String(e);
    } finally {
      this.ticking = false;
    }
  }

  /** force a push of the current signal (test button / manual check) */
  async pushNow(): Promise<{ sent: boolean; reason: string }> {
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
