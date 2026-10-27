/* ------------------------------------------------------------------ *
 * Sweep-reclaim v2 — the Pulcini fade with ATR-push proof.
 *
 * The retired sweep-reclaim card entered on the reclaim alone and fired
 * shorts into one-sided runs. Pulcini's rule (Titans Of Tomorrow
 * interview, 2026-10): a stop-run is only faded AFTER the market proves
 * the break failed by pushing a full ATR away from the swept extreme —
 * "if it's able to push away a full ATR from that event, that's
 * meaningful." Stop sits on the FAR side of the event (the trapped
 * traders' stops), target 1R.
 *
 * Sequence per direction (long shown, short is the mirror):
 *   1 SWEEP     bar breaks the anchor low (session low or trailing
 *               sweepBars-bar low) by ≥ sweepTolPts
 *   2 RECLAIM   within reclaimWindow bars, a bar trades back above the
 *               anchor (the failed break — stops left behind)
 *   3 CONFIRM   within confirmWindow bars after the reclaim, a bar
 *               closes ≥ atrMult × atrPad × ATR14 away from the anchor
 *               in the fade direction — the push that proves the run
 *               is dead. THE ENTRY (at that bar's close/mid).
 *   stop        anchor ∓ stopPad (far side of the event)
 *   target      entry ± targetR × risk
 *
 * Pure function of the minute array + config — replayable, testable.
 * atrMult = 0 skips the confirmation (the retired v1 behaviour: enter on
 * the reclaim bar) so the study can price the confirmation gate.
 * ------------------------------------------------------------------ */

import { closeOf, midOf, type MomMinute } from "./momentum";
import { upperMedian } from "./stats";

export type SweepReclaimV2Config = {
  /** what the sweep must break: "session" = running session extreme,
   *  "local" = the trailing sweepBars-bar extreme */
  anchor: "session" | "local";
  sweepBars: number;
  sweepTolPts: number;
  /** bars allowed for the reclaim after the sweep */
  reclaimWindow: number;
  /** min entry-side share of the reclaim bar's volume (0 = off) */
  reclaimOneSided: number;
  /** bars allowed for the ATR push after the reclaim */
  confirmWindow: number;
  /** k × ATR14 the market must push away from the anchor. 0 = enter on the
   *  reclaim bar (v1 behaviour, no proof). */
  atrMult: number;
  /** ATR lookback (bars) */
  atrBars: number;
  /** ATR pad multiplier (Pulcini's "+15%" = 1.15) */
  atrPad: number;
  /** stop distance beyond the anchor */
  stopPad: number;
  targetR: number;
  maxRiskPts: number;
  minRiskPts: number;
  /** ignore new sequences for this many bars after an entry */
  minGapBars: number;
  hourFilter: "none" | "globex";
};

export const SWEEP_RECLAIM_V2_DEFAULTS: SweepReclaimV2Config = {
  anchor: "local",
  sweepBars: 20,
  sweepTolPts: 0.25,
  reclaimWindow: 2,
  reclaimOneSided: 0,
  confirmWindow: 10,
  atrMult: 1.0,
  atrBars: 14,
  atrPad: 1.15,
  stopPad: 0.5,
  targetR: 1,
  maxRiskPts: 40,
  minRiskPts: 1.5,
  minGapBars: 5,
  hourFilter: "globex",
};

export type SweepReclaimV2Signal = {
  dir: "long" | "short";
  /** the swept anchor price (the event) */
  extreme: number;
  sweepIdx: number;
  reclaimIdx: number;
  /** the bar whose close completes the ATR proof — the entry bar */
  confirmIdx: number;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  t: string;
  d: string;
  hourET: number;
  atr14: number;
  /** entry-side share of the reclaim bar's volume (0..1) */
  buyPct: number;
};

const med = upperMedian;

/** archive clock "HH:mm" is Chicago (CDT); ET hour = (hh + 1) % 24 */
function hourET(t: string): number {
  return (Number(t.slice(0, 2)) + 1) % 24;
}

function rthBlocked(hh: number, mm: number, filter: "none" | "globex"): boolean {
  if (filter === "none") return false;
  return (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15) || (hh === 16 && mm === 0);
}

function fracOf(m: MomMinute): number {
  const v = m.buy + m.sell;
  return v > 0 ? m.buy / v : 0.5;
}

export function detectSweepReclaimV2(
  minutes: MomMinute[],
  cfg: SweepReclaimV2Config = SWEEP_RECLAIM_V2_DEFAULTS,
): SweepReclaimV2Signal[] {
  const n = minutes.length;
  const out: SweepReclaimV2Signal[] = [];
  if (n < 30) return out;

  const atrAt = (i: number): number => {
    const from = Math.max(0, i - cfg.atrBars);
    const arr: number[] = [];
    for (let k = from; k < i; k++) arr.push(minutes[k].high - minutes[k].low);
    return med(arr);
  };

  let sessLo = Infinity;
  let sessHi = -Infinity;
  let lastEntry = -10_000;

  type Watch = { dir: "long" | "short"; anchor: number; sweepIdx: number; reclaimIdx: number; reclaimBuyPct: number };
  let watch: Watch | null = null;

  for (let i = 1; i < n; i++) {
    sessLo = Math.min(sessLo, minutes[i - 1].low);
    sessHi = Math.max(sessHi, minutes[i - 1].high);

    if (watch) {
      // the reclaim has its own window; the confirmation extends from there
      const age = i - watch.sweepIdx;
      if (watch.reclaimIdx < 0 && age > cfg.reclaimWindow) {
        watch = null; // never reclaimed in time — the break held, it was real
      } else if (watch.reclaimIdx < 0) {
        // waiting for the reclaim
        const backInside =
          watch.dir === "long" ? midOf(minutes[i]) > watch.anchor : midOf(minutes[i]) < watch.anchor;
        if (backInside) {
          watch.reclaimIdx = i;
          watch.reclaimBuyPct = fracOf(minutes[i]);
          // v1 mode: no ATR proof — the reclaim bar IS the entry (the
          // retired card's behaviour: one-sided reclaim required)
          if (cfg.atrMult <= 0) {
            const oneSidedOk =
              cfg.reclaimOneSided <= 0 ||
              (watch.dir === "long"
                ? watch.reclaimBuyPct >= cfg.reclaimOneSided
                : watch.reclaimBuyPct <= 1 - cfg.reclaimOneSided);
            if (!oneSidedOk) {
              watch = null;
              // fall through to the sweep scan
            } else {
              const entry = closeOf(minutes[i]);
            const stop = watch.dir === "long" ? watch.anchor - cfg.stopPad : watch.anchor + cfg.stopPad;
            const risk = watch.dir === "long" ? entry - stop : stop - entry;
            if (risk >= cfg.minRiskPts && risk <= cfg.maxRiskPts && i - lastEntry >= cfg.minGapBars) {
              const et = hourET(minutes[i].t);
              const [hh, mm] = minutes[i].t.split(":").map(Number);
              if (!rthBlocked(hh, mm, cfg.hourFilter)) {
                lastEntry = i;
                out.push({
                  dir: watch.dir,
                  extreme: watch.anchor,
                  sweepIdx: watch.sweepIdx,
                  reclaimIdx: i,
                  confirmIdx: i,
                  entry,
                  stop,
                  target: watch.dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk,
                  risk,
                  t: minutes[i].t,
                  d: minutes[i].d,
                  hourET: et,
                  atr14: atrAt(watch.sweepIdx),
                  buyPct: watch.reclaimBuyPct,
                });
              }
            }
            watch = null;
            }
          }
        }
      } else {
        // reclaimed — waiting for the ATR push proof
        const oneSidedOk =
          cfg.reclaimOneSided <= 0 ||
          (watch.dir === "long" ? watch.reclaimBuyPct >= cfg.reclaimOneSided : watch.reclaimBuyPct <= 1 - cfg.reclaimOneSided);
        const atr = atrAt(watch.sweepIdx);
        const need = watch.dir === "long"
          ? watch.anchor + cfg.atrMult * cfg.atrPad * atr
          : watch.anchor - cfg.atrMult * cfg.atrPad * atr;
        const proven = watch.dir === "long" ? closeOf(minutes[i]) >= need : closeOf(minutes[i]) <= need;
        const tooLate = i - watch.reclaimIdx > cfg.confirmWindow;
        if (tooLate) {
          watch = null;
        } else if (proven && oneSidedOk) {
          const entry = closeOf(minutes[i]);
          const stop = watch.dir === "long" ? watch.anchor - cfg.stopPad : watch.anchor + cfg.stopPad;
          const risk = watch.dir === "long" ? entry - stop : stop - entry;
          if (risk >= cfg.minRiskPts && risk <= cfg.maxRiskPts && i - lastEntry >= cfg.minGapBars) {
            const et = hourET(minutes[i].t);
            const [hh, mm] = minutes[i].t.split(":").map(Number);
            if (!rthBlocked(hh, mm, cfg.hourFilter)) {
              lastEntry = i;
              out.push({
                dir: watch.dir,
                extreme: watch.anchor,
                sweepIdx: watch.sweepIdx,
                reclaimIdx: watch.reclaimIdx,
                confirmIdx: i,
                entry,
                stop,
                target: watch.dir === "long" ? entry + cfg.targetR * risk : entry - cfg.targetR * risk,
                risk,
                t: minutes[i].t,
                d: minutes[i].d,
                hourET: et,
                atr14: atr,
                buyPct: watch.reclaimBuyPct,
              });
            }
          }
          watch = null;
        }
      }
      if (watch === null) {
        // fall through to scan for a NEW sweep on this same bar
      } else {
        continue;
      }
    }

    if (i - lastEntry < cfg.minGapBars) continue;

    // ---- scan for a new sweep ----
    let lo = Infinity;
    let hi = -Infinity;
    if (cfg.anchor === "local") {
      const from = Math.max(0, i - cfg.sweepBars);
      for (let k = from; k < i; k++) {
        lo = Math.min(lo, minutes[k].low);
        hi = Math.max(hi, minutes[k].high);
      }
    } else {
      lo = sessLo;
      hi = sessHi;
    }

    if (minutes[i].low < lo - cfg.sweepTolPts) {
      watch = { dir: "long", anchor: lo, sweepIdx: i, reclaimIdx: -1, reclaimBuyPct: 0.5 };
    } else if (minutes[i].high > hi + cfg.sweepTolPts) {
      watch = { dir: "short", anchor: hi, sweepIdx: i, reclaimIdx: -1, reclaimBuyPct: 0.5 };
    }
  }
  return out;
}
