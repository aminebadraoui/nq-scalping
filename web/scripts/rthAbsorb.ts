/* ------------------------------------------------------------------ *
 * RTH absorption study — the mean-reversion side of the thick tape.
 *
 * Pattern family: a heavy one-sided push INTO an extreme that FAILS to
 * break it (effort without result) — fade the exhausted push.
 *
 *   A  FAILED EXTREME PUSH:  buy-frac ≥ F (short) / ≤ 1−F (long),
 *      volume ≥ V× trailing 60-bar median, high fails to break the
 *      trailing 20-bar high by more than stallTol (stalls at the
 *      extreme). SHORT at the bar close, stop = trailHi20 + 1,
 *      target 1R (risk ≤ riskCap). Mirrored at lows.
 *   B  SHRINKING COUNTER:    |push delta| < |previous same-side bar's
 *      delta| (the thrust is exhausting). An exploratory prevBar flavor
 *      compares against bar k−1 regardless of sign.
 *   C  TICK PROOF:           ≥2 dominant opposite-side clusters on the
 *      push bar (rows with the opposite side ≥3 lots and ≥2× the push
 *      side) at prices within 2 pts of the extreme — the absorption
 *      fingerprint.
 *   D  CLOSE POSITION:       the push bar closes in the BOTTOM half of
 *      its range for a short (gave back the pop) / top half for a long.
 *      The archive has no true closes (c=0), so the volume-weighted
 *      position of the bar is the honest proxy.
 *
 * SCORING (first-touch, pessimistic): bars k+1..k+60 — stop first →
 * −risk−0.5, target first → +risk−0.5, neither → excluded from WR,
 * 0 expectancy. 0.5 pt cost.
 *
 * MFF grounding: Rapid EOD 50k via lib/propAccount — collect
 * {date, pnlPts, riskPts}, print accountLine (eval + funded) and
 * by-year WR for the best variant.
 *
 * GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs scripts/rthAbsorb.ts
 * ------------------------------------------------------------------ */

import { writeFileSync } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { closeOf, type MomMinute } from "../lib/momentum";

/* ---------------------------- pattern params --------------------------- */

type Variant = {
  name: string;
  /** buy-frac threshold for the short side (longs mirror at 1−frac) */
  frac: number;
  /** volume floor as a multiple of the trailing 60-bar median */
  volMult: number;
  /** risk (pts) cap — the spec's 12 */
  riskCap: number;
  /** risk floor — skips noise-sized stops (0 = off) */
  riskMin: number;
  /** how far the push may exceed the 20-bar extreme and still count as failed */
  stallTol: number;
  /** 0 = off; else require the push to reach within this many pts of the
   *  extreme (high ≥ trailHi − prox for a short) — "stalls AT the extreme" */
  proxPts: number;
  /** B: exhaustion vs a previous counter-direction bar */
  shrink: "off" | "sameSide" | "prevBar";
  /** C: the absorption fingerprint */
  tickProof: boolean;
  /** D: close in the fade-favored half of the bar */
  closePos: boolean;
  side: "short" | "long" | "both";
};

type Setup = {
  k: number;
  dir: "short" | "long";
  entry: number;
  stop: number;
  target: number;
  risk: number;
  frac: number;
  vol: number;
  medVol: number;
  trailHi: number;
  trailLo: number;
  pushDelta: number;
  prevSameDelta: number | null;
  prevBarDelta: number | null;
  tickProofN: number;
  vwapPos: number;
  range: number;
  outcome: "win" | "loss" | "timeout";
  pnlPts: number;
};

type Stats = {
  n: number;
  wins: number;
  losses: number;
  grossWin: number;
  grossLoss: number;
  net: number;
  byYear: Map<string, { n: number; wins: number; losses: number }>;
};

/* ------------------------------- helpers ------------------------------- */

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
const inRTH = (t: string): boolean => {
  const h = hourET(t);
  const mm = mmOf(t);
  return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

const COST = 0.5;

/** volume-weighted position inside the bar's range (0..1) — the close
 *  proxy the archive forces on us (no true closes). */
function vwapPos(m: MomMinute): number {
  const range = m.high - m.low;
  if (!(range > 0.25)) return 0.5;
  let num = 0;
  let den = 0;
  for (const l of m.levels) {
    const v = l.buy + l.sell;
    num += l.price * v;
    den += v;
  }
  return den > 0 ? (num / den - m.low) / range : 0.5;
}

/** C: dominant opposite-side clusters within 2 pts of the extreme */
function tickProof(m: MomMinute, dir: "short" | "long"): number {
  let n = 0;
  for (const l of m.levels) {
    if (dir === "short") {
      if (l.price < m.high - 2) continue;
      if (l.sell >= 3 && l.sell >= 2 * l.buy) n++;
    } else {
      if (l.price > m.low + 2) continue;
      if (l.buy >= 3 && l.buy >= 2 * l.sell) n++;
    }
  }
  return n;
}

/** B: the most recent bar (within `look` bars) whose delta shares the push
 *  bar's sign — the previous counter-direction thrust. */
function prevSameSideDelta(minutes: MomMinute[], k: number, look: number, pushSign: number): number | null {
  for (let j = k - 1; j >= Math.max(0, k - look); j--) {
    const d = minutes[j].buy - minutes[j].sell;
    if (Math.sign(d) === pushSign && d !== 0) return d;
  }
  return null;
}

/* --------------------------- detection + scoring ------------------------ */

function detectAndScore(minutes: MomMinute[], variants: Variant[]): Map<string, Stats> {
  const n = minutes.length;
  const agg = new Map<string, Stats>();

  // one pass per bar: build the base setup for each direction, then gate it
  // through every variant. Scoring is identical across variants for a given
  // bar+direction, so it is computed once and cached per (k, dir).
  for (let k = 20; k < n - 1; k++) {
    if (!inRTH(minutes[k].t)) continue;
    const m = minutes[k];
    const vol = m.buy + m.sell;
    if (vol <= 0) continue;
    const frac = vol > 0 ? m.buy / vol : 0.5;

    const vols: number[] = [];
    for (let j = Math.max(0, k - 60); j < k; j++) vols.push(minutes[j].buy + minutes[j].sell);
    const medVol = med(vols);

    let trailHi = -Infinity;
    let trailLo = Infinity;
    for (let j = Math.max(0, k - 20); j < k; j++) {
      trailHi = Math.max(trailHi, minutes[j].high);
      trailLo = Math.min(trailLo, minutes[j].low);
    }

    const pushDelta = m.buy - m.sell;
    const range = m.high - m.low;
    const vp = vwapPos(m);

    for (const dir of ["short", "long"] as const) {
      const isShort = dir === "short";
      const oneSided = isShort ? frac >= 0.5 : frac <= 0.5; // direction sanity for the setup side
      void oneSided;

      const entry = closeOf(m);
      const stop = isShort ? trailHi + 1 : trailLo - 1;
      const risk = isShort ? stop - entry : entry - stop;
      if (!(risk > 0)) continue;
      const target = isShort ? entry - risk : entry + risk;

      // first-touch, pessimistic: stop checked first inside each bar
      let outcome: Setup["outcome"] = "timeout";
      const end = Math.min(n - 1, k + 60);
      for (let j = k + 1; j <= end; j++) {
        const b = minutes[j];
        if (isShort ? b.high >= stop : b.low <= stop) {
          outcome = "loss";
          break;
        }
        if (isShort ? b.low <= target : b.high >= target) {
          outcome = "win";
          break;
        }
      }
      const pnlPts = outcome === "win" ? risk - COST : outcome === "loss" ? -risk - COST : 0;

      const setup: Setup = {
        k,
        dir,
        entry,
        stop,
        target,
        risk,
        frac,
        vol,
        medVol,
        trailHi,
        trailLo,
        pushDelta,
        prevSameDelta: prevSameSideDelta(minutes, k, 20, Math.sign(pushDelta)),
        prevBarDelta: k > 0 ? minutes[k - 1].buy - minutes[k - 1].sell : null,
        tickProofN: tickProof(m, dir),
        vwapPos: vp,
        range,
        outcome,
        pnlPts,
      };

      for (const v of variants) {
        if (v.side !== "both" && v.side !== dir) continue;
        if (isShort ? frac < v.frac : frac > 1 - v.frac) continue;
        if (vol < v.volMult * medVol) continue;
        if (isShort ? m.high > trailHi + v.stallTol : m.low < trailLo - v.stallTol) continue;
        if (v.proxPts > 0 && (isShort ? m.high < trailHi - v.proxPts : m.low > trailLo + v.proxPts)) continue;
        if (risk > v.riskCap || risk < v.riskMin) continue;
        if (v.shrink === "sameSide") {
          if (setup.prevSameDelta === null || Math.abs(pushDelta) >= Math.abs(setup.prevSameDelta)) continue;
        } else if (v.shrink === "prevBar") {
          if (setup.prevBarDelta === null || Math.abs(pushDelta) >= Math.abs(setup.prevBarDelta)) continue;
        }
        if (v.tickProof && setup.tickProofN < 2) continue;
        if (v.closePos && (isShort ? setup.vwapPos > 0.5 : setup.vwapPos < 0.5)) continue;

        const s = agg.get(v.name) ?? {
          n: 0,
          wins: 0,
          losses: 0,
          grossWin: 0,
          grossLoss: 0,
          net: 0,
          byYear: new Map(),
        };
        s.n++;
        if (setup.outcome === "win") {
          s.wins++;
          s.grossWin += setup.pnlPts;
        } else if (setup.outcome === "loss") {
          s.losses++;
          s.grossLoss += -setup.pnlPts;
        }
        s.net += setup.pnlPts;
        const year = minutes[k].d.slice(0, 4);
        const y = s.byYear.get(year) ?? { n: 0, wins: 0, losses: 0 };
        y.n++;
        if (setup.outcome === "win") y.wins++;
        else if (setup.outcome === "loss") y.losses++;
        s.byYear.set(year, y);
        agg.set(v.name, s);
      }
    }
  }
  return agg;
}

/* ----------------------------- variant table ---------------------------- */

/** Round-1 baseline: A–D exactly as specified, plus the stacked filters. */
const VARIANTS: Variant[] = [
  { name: "a-short", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: false, side: "short" },
  { name: "a-long", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: false, side: "long" },
  { name: "a-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: false, side: "both" },
  { name: "b-short", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: false, closePos: false, side: "short" },
  { name: "b-long", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: false, closePos: false, side: "long" },
  { name: "b-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: false, closePos: false, side: "both" },
  { name: "b-prevBar-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "prevBar", tickProof: false, closePos: false, side: "both" },
  { name: "c-short", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: true, closePos: false, side: "short" },
  { name: "c-long", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: true, closePos: false, side: "long" },
  { name: "c-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: true, closePos: false, side: "both" },
  { name: "d-short", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: true, side: "short" },
  { name: "d-long", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: true, side: "long" },
  { name: "d-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: false, closePos: true, side: "both" },
  { name: "bc-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: true, closePos: false, side: "both" },
  { name: "bd-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: false, closePos: true, side: "both" },
  { name: "cd-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "off", tickProof: true, closePos: true, side: "both" },
  { name: "bcd-both", frac: 0.65, volMult: 1.0, riskCap: 12, riskMin: 0, stallTol: 0.5, proxPts: 0, shrink: "sameSide", tickProof: true, closePos: true, side: "both" },
];

const wrOf = (s: Stats): number => (s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : 0);
const pfOf = (s: Stats): number => (s.grossLoss > 0 ? s.grossWin / s.grossLoss : Infinity);

/* --------------------------------- main --------------------------------- */

async function main() {
  const dates = await archiveDates();
  console.log(`RTH absorption study over ${dates.length} sessions…`);
  const t0 = Date.now();

  const agg = new Map<string, Stats>();
  let sessions = 0;
  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    sessions++;
    const per = detectAndScore(minutes, VARIANTS);
    for (const [k, s] of per) {
      const a = agg.get(k) ?? { n: 0, wins: 0, losses: 0, grossWin: 0, grossLoss: 0, net: 0, byYear: new Map() };
      a.n += s.n;
      a.wins += s.wins;
      a.losses += s.losses;
      a.grossWin += s.grossWin;
      a.grossLoss += s.grossLoss;
      a.net += s.net;
      for (const [y, v] of s.byYear) {
        const yy = a.byYear.get(y) ?? { n: 0, wins: 0, losses: 0 };
        yy.n += v.n;
        yy.wins += v.wins;
        yy.losses += v.losses;
        a.byYear.set(y, yy);
      }
      agg.set(k, a);
    }
  }
  console.log(`scored ${sessions} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const rows = [...agg.entries()].sort((a, b) => wrOf(b[1]) - wrOf(a[1]));
  console.log("variant          | side  | n    | scored | wr     | PF     | net    | exp/pt");
  for (const [name, s] of rows) {
    const scored = s.wins + s.losses;
    console.log(
      `${name.padEnd(16)} | ${String(s.n).padStart(5)} | ${String(scored).padStart(6)} | ${(100 * wrOf(s)).toFixed(1).padStart(5)}% | ${pfOf(s) === Infinity ? "  ∞" : pfOf(s).toFixed(2).padStart(5)} | ${s.net.toFixed(1).padStart(6)} | ${(s.net / Math.max(1, s.n)).toFixed(3).padStart(6)}`,
    );
  }

  // best ≥75% config (or closest with ≥300 scored trades)
  const candidates = rows.filter(([, s]) => s.wins + s.losses >= 300);
  const over75 = candidates.filter(([, s]) => wrOf(s) >= 0.75);
  const best = (over75.length ? over75 : candidates)[0] ?? rows[0];
  const [bestName, bestStats] = best;
  console.log(`\nBEST: ${bestName} — n=${bestStats.n}, scored=${bestStats.wins + bestStats.losses}, WR=${(100 * wrOf(bestStats)).toFixed(1)}%${over75.length ? " (≥75% ✓)" : " (closest to 75%)"}`);
  console.log("per-year WR:");
  for (const [y, v] of [...bestStats.byYear.entries()].sort()) {
    const scored = v.wins + v.losses;
    console.log(`  ${y}: n=${String(v.n).padStart(4)}  scored=${String(scored).padStart(4)}  WR=${(100 * (scored ? v.wins / scored : 0)).toFixed(1).padStart(5)}%`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
