/* ------------------------------------------------------------------ *
 * Tick-momentum engine — the objective decode of "the candle is pushing
 * more up than down".
 *
 * That feeling is a path property (how price moved THROUGH TIME), while
 * the footprint is a histogram (where volume happened). This module
 * computes the path measures from a time-ordered trade tape:
 *
 *   VELOCITY    up/down points per second + their asymmetry (velImb)
 *               — "pushing more up than down"
 *   LEGS        mean size of consecutive same-direction runs (amplitude)
 *               — "the amplitude at which they go up"
 *   INTENSITY   trades/sec, contracts/sec, buy/sell arrival asymmetry
 *               — the tape's temperature
 *   IMPACT      points moved per contract of aggressive buying vs
 *               selling (lambda ratio) — "the same selling doesn't move
 *               it" = sellers being absorbed
 *   REJECTION   recent probes (dips from local highs / rallies from
 *               local lows): depth, duration, and how fast price
 *               retraced them — "the speed at which they reject down
 *               movement"
 *   ACCEL       leg-size trend across the window (second derivative)
 *
 * The archive cannot backtest any of this: it discards intra-minute
 * time at collection. These measures are live-tape only until an
 * event-time dataset (CME MBO via Databento) lands. Study aid, not an
 * entry signal — see docs/strategy/TICK_MOMENTUM.md.
 * ------------------------------------------------------------------ */

export type Tick = {
  /** wall-clock ms of the print (feed date, Date.now() fallback) */
  ms: number;
  /** last traded price, points */
  ltp: number;
  /** contracts */
  size: number;
  /** aggressor side: 1 = lifted ask (buy), -1 = hit bid (sell) */
  side: 1 | -1;
};

export const TICK_PTS = 0.25;

export type TickMomConfig = {
  /** rolling analysis window (velocity/legs/intensity/impact/accel) */
  windowMs: number;
  /** probe-tracking window (rejections) */
  longMs: number;
  /** minimum probe depth in ticks (3 = 0.75 pt) before a poke counts */
  probeMinTicks: number;
  /** fraction of the probe retraced = answered */
  probeRetrace: number;
  /** report only with at least this many ticks in the window */
  minWindowTicks: number;
  /** probes kept per direction */
  maxProbes: number;
  /** a tick gap longer than this aborts in-flight probes (feed blip);
   *  must stay well inside windowMs so a gapped tape still analyzes */
  staleGapMs: number;
  /** path energy (pts/sec) above which a balanced tape reads "two-sided" */
  churnPtsPerSec: number;
};

export const TM_DEFAULTS: TickMomConfig = {
  windowMs: 5_000,
  longMs: 60_000,
  probeMinTicks: 3,
  probeRetrace: 0.5,
  minWindowTicks: 3,
  maxProbes: 6,
  staleGapMs: 2_000,
  churnPtsPerSec: 0.4,
};

export type ProbeEvent = {
  /** down = dip from a local high (the "rejects down movement" poke);
   *  up = rally from a local low (the short mirror) */
  dir: "down" | "up";
  /** deepest drawdown/rally, points */
  depth: number;
  /** ms of the extreme the probe launched from */
  startMs: number;
  /** ms of the deepest point */
  troughMs: number;
  answered: boolean;
  /** ms from the deepest point to the answering print (0 = unanswered) */
  recoveryMs: number;
  /** fraction of depth retraced when answered */
  retrace: number;
  /** depth / recovery seconds — the rejection speed, pts/sec (0 unanswered) */
  speed: number;
};

export type TickMomentum = {
  now: number;
  /** ticks in the analysis window */
  n: number;
  /** wall-clock span of the window, ms (>= 1) */
  spanMs: number;
  /** span in seconds */
  spanSec: number;
  /* velocity — the path decode */
  upPts: number;
  downPts: number;
  upSpeed: number; // pts/sec of upward movement
  downSpeed: number; // pts/sec of downward movement
  netVel: number; // (upPts - downPts) / spanSec
  velImb: number; // (upSpeed - downSpeed) / (upSpeed + downSpeed), -1..1
  /* legs — amplitude */
  upLegs: number;
  downLegs: number;
  meanUpLeg: number; // pts per up-leg
  meanDownLeg: number; // pts per down-leg
  legImb: number; // (meanUp - meanDown) / (meanUp + meanDown), -1..1
  /* intensity — arrival */
  upTicks: number; // ticks that moved price up
  downTicks: number; // ticks that moved price down
  flatTicks: number; // ticks that moved nothing
  buyVol: number; // contracts, aggressor buys (delta share numerator)
  sellVol: number; // contracts, aggressor sells
  ticksPerSec: number;
  contractsPerSec: number;
  arrImb: number; // (buyVol - sellVol) / (buyVol + sellVol), -1..1
  /* impact — points per contract by aggressor side */
  impactUp: number; // sum |move| on buy ticks / buy contracts
  impactDown: number; // sum |move| on sell ticks / sell contracts
  impactRatio: number; // impactUp / impactDown; > 1 = buying moves price more
  /* rejection speed */
  probes: ProbeEvent[]; // newest last
  medianRecoveryMs: number; // over answered probes
  rejectSpeed: number; // median depth/recovery over answered probes, pts/sec
  /* acceleration — leg-size trend across the window */
  accelUp: number; // pts/sec per second (approx)
  accelDown: number;
  /* composite */
  push: number; // documented blend, -1..1 (+ = up)
  verdict: "pushing up" | "pushing down" | "two-sided" | "quiet";
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function emptyTickMomentum(now = Date.now()): TickMomentum {
  return {
    now,
    n: 0,
    spanMs: 1,
    spanSec: 0.001,
    upPts: 0,
    downPts: 0,
    upSpeed: 0,
    downSpeed: 0,
    netVel: 0,
    velImb: 0,
    upLegs: 0,
    downLegs: 0,
    meanUpLeg: 0,
    meanDownLeg: 0,
    legImb: 0,
    upTicks: 0,
    downTicks: 0,
    flatTicks: 0,
    buyVol: 0,
    sellVol: 0,
    ticksPerSec: 0,
    contractsPerSec: 0,
    arrImb: 0,
    impactUp: 0,
    impactDown: 0,
    impactRatio: 0,
    probes: [],
    medianRecoveryMs: 0,
    rejectSpeed: 0,
    accelUp: 0,
    accelDown: 0,
    push: 0,
    verdict: "quiet",
  };
}

/** sanitize + order the tape (newest last, by wall clock) */
function cleanTicks(ticks: Tick[]): Tick[] {
  const out: Tick[] = [];
  for (const t of ticks) {
    if (!Number.isFinite(t.ms) || !Number.isFinite(t.ltp) || !(t.size > 0)) continue;
    if (t.side !== 1 && t.side !== -1) continue;
    out.push(t);
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

const med = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** legs (maximal same-sign runs) over a tick slice; returns counts + means */
function legsOf(ticks: Tick[]): { upLegs: number; downLegs: number; meanUpLeg: number; meanDownLeg: number } {
  let upLegs = 0;
  let downLegs = 0;
  let upSum = 0;
  let downSum = 0;
  let run = 0;
  let sign = 0;
  for (let i = 1; i < ticks.length; i++) {
    const d = ticks[i].ltp - ticks[i - 1].ltp;
    if (d === 0) continue; // flats extend, never break, a leg
    const s = d > 0 ? 1 : -1;
    if (s !== sign) {
      // close the previous leg
      if (sign === 1) {
        upLegs++;
        upSum += run;
      } else if (sign === -1) {
        downLegs++;
        downSum += run;
      }
      sign = s;
      run = 0;
    }
    run += Math.abs(d);
  }
  if (sign === 1) {
    upLegs++;
    upSum += run;
  } else if (sign === -1) {
    downLegs++;
    downSum += run;
  }
  return { upLegs, downLegs, meanUpLeg: upLegs ? upSum / upLegs : 0, meanDownLeg: downLegs ? downSum / downLegs : 0 };
}

/** one-pass zigzag probe tracker (single direction, mirrorable) */
function trackProbes(
  ticks: Tick[],
  dir: "down" | "up",
  cfg: TickMomConfig,
  out: ProbeEvent[],
): void {
  // "peak" holds the running extreme the probe launches from
  let extreme = ticks[0].ltp;
  let extremeMs = ticks[0].ms;
  let trough = extreme;
  let troughMs = extremeMs;
  let depth = 0;
  let active = false;

  const deeper = (p: number) => (dir === "down" ? extreme - p : p - extreme);
  const answeredAt = (p: number): number | null => {
    if (!(depth > 0)) return null;
    // retrace fraction from the deepest point
    const r = (p - trough) / depth;
    return dir === "down" ? r : -r; // for "up" probes, trough is a high
  };

  for (let i = 1; i < ticks.length; i++) {
    const p = ticks[i].ltp;
    const ms = ticks[i].ms;
    if (ms - ticks[i - 1].ms > cfg.staleGapMs) {
      if (active) {
        out.push({ dir, depth, startMs: extremeMs, troughMs, answered: false, recoveryMs: 0, retrace: 0, speed: 0 });
      }
      extreme = p;
      extremeMs = ms;
      trough = p;
      troughMs = ms;
      depth = 0;
      active = false;
      continue;
    }
    const crossedBack = dir === "down" ? p >= extreme : p <= extreme;
    if (active) {
      if (crossedBack) {
        out.push({
          dir,
          depth,
          startMs: extremeMs,
          troughMs,
          answered: true,
          recoveryMs: ms - troughMs,
          retrace: 1,
          speed: ms > troughMs ? depth / ((ms - troughMs) / 1000) : 0,
        });
        extreme = p;
        extremeMs = ms;
        trough = p;
        troughMs = ms;
        depth = 0;
        active = false;
        continue;
      }
      const r = answeredAt(p);
      if (r !== null && r >= cfg.probeRetrace) {
        out.push({
          dir,
          depth,
          startMs: extremeMs,
          troughMs,
          answered: true,
          recoveryMs: ms - troughMs,
          retrace: r,
          speed: ms > troughMs ? depth / ((ms - troughMs) / 1000) : 0,
        });
        extreme = p;
        extremeMs = ms;
        trough = p;
        troughMs = ms;
        depth = 0;
        active = false;
        continue;
      }
      const dd = deeper(p);
      if (dd > depth) {
        depth = dd;
        trough = p;
        troughMs = ms;
      }
    } else {
      if (crossedBack) {
        extreme = p;
        extremeMs = ms;
        continue;
      }
      const dd = deeper(p);
      if (dd >= cfg.probeMinTicks * TICK_PTS) {
        active = true;
        depth = dd;
        trough = p;
        troughMs = ms;
      }
    }
  }
  if (active) {
    out.push({ dir, depth, startMs: extremeMs, troughMs, answered: false, recoveryMs: 0, retrace: 0, speed: 0 });
  }
}

export function computeTickMomentum(ticks: Tick[], cfg: TickMomConfig = TM_DEFAULTS): TickMomentum {
  const clean = cleanTicks(ticks);
  if (!clean.length) return emptyTickMomentum();
  const now = clean[clean.length - 1].ms;

  // velocity/intensity metrics on the analysis window (always includes the last tick)
  let lo = clean.length - 1;
  while (lo > 0 && clean[lo - 1].ms >= now - cfg.windowMs) lo--;
  const w = clean.slice(lo);
  const m = emptyTickMomentum(now);
  m.n = w.length;
  m.spanMs = Math.max(1, w[w.length - 1].ms - w[0].ms);
  m.spanSec = m.spanMs / 1000;
  if (m.n < cfg.minWindowTicks) return m;

  for (let i = 1; i < w.length; i++) {
    const d = w[i].ltp - w[i - 1].ltp;
    const a = Math.abs(d);
    if (d > 0) {
      m.upPts += d;
      m.upTicks++;
    } else if (d < 0) {
      m.downPts += a;
      m.downTicks++;
    } else {
      m.flatTicks++;
    }
    // impact attribution: each tick's own move is credited to its aggressor
    // side — the per-trade price impact (a correlation, not causation)
    if (w[i].side === 1) {
      m.impactUp += a;
      m.buyVol += w[i].size;
    } else {
      m.impactDown += a;
      m.sellVol += w[i].size;
    }
  }
  // the first tick's volume counts toward arrival but moved nothing
  if (w[0].side === 1) m.buyVol += w[0].size;
  else m.sellVol += w[0].size;

  m.upSpeed = m.upPts / m.spanSec;
  m.downSpeed = m.downPts / m.spanSec;
  m.netVel = (m.upPts - m.downPts) / m.spanSec;
  m.velImb = m.upPts + m.downPts > 0 ? (m.upPts - m.downPts) / (m.upPts + m.downPts) : 0;

  const legs = legsOf(w);
  m.upLegs = legs.upLegs;
  m.downLegs = legs.downLegs;
  m.meanUpLeg = legs.meanUpLeg;
  m.meanDownLeg = legs.meanDownLeg;
  m.legImb = legs.meanUpLeg + legs.meanDownLeg > 0 ? (legs.meanUpLeg - legs.meanDownLeg) / (legs.meanUpLeg + legs.meanDownLeg) : 0;

  m.ticksPerSec = m.n / m.spanSec;
  m.contractsPerSec = (m.buyVol + m.sellVol) / m.spanSec;
  m.arrImb = m.buyVol + m.sellVol > 0 ? (m.buyVol - m.sellVol) / (m.buyVol + m.sellVol) : 0;

  m.impactUp = m.buyVol > 0 ? m.impactUp / m.buyVol : 0;
  m.impactDown = m.sellVol > 0 ? m.impactDown / m.sellVol : 0;
  m.impactRatio = m.impactDown > 0 ? m.impactUp / m.impactDown : 0;

  // probes over the long window
  let plo = clean.length - 1;
  while (plo > 0 && clean[plo - 1].ms >= now - cfg.longMs) plo--;
  const lg = clean.slice(plo);
  const probes: ProbeEvent[] = [];
  trackProbes(lg, "down", cfg, probes);
  trackProbes(lg, "up", cfg, probes);
  probes.sort((a, b) => a.troughMs - b.troughMs);
  m.probes = probes.slice(-cfg.maxProbes);
  const answered = m.probes.filter((p) => p.answered);
  if (answered.length) {
    m.medianRecoveryMs = med(answered.map((p) => p.recoveryMs));
    m.rejectSpeed = med(answered.map((p) => (p.recoveryMs > 0 ? p.depth / (p.recoveryMs / 1000) : 0)));
  }

  // acceleration: mean leg size, second half vs first half of the window
  if (m.n >= 4) {
    const half = Math.floor(w.length / 2);
    const l1 = legsOf(w.slice(0, half));
    const l2 = legsOf(w.slice(half));
    m.accelUp = (l2.meanUpLeg - l1.meanUpLeg) / m.spanSec;
    m.accelDown = (l2.meanDownLeg - l1.meanDownLeg) / m.spanSec;
  }

  // composite — documented blend (see docs/strategy/TICK_MOMENTUM.md)
  const imp = m.impactRatio > 0 ? clamp((m.impactRatio - 1) * 2, -1, 1) : 0;
  m.push = clamp(0.4 * m.velImb + 0.2 * m.legImb + 0.2 * m.arrImb + 0.2 * imp, -1, 1);
  const energy = (m.upPts + m.downPts) / m.spanSec;
  if (m.push >= 0.35) m.verdict = "pushing up";
  else if (m.push <= -0.35) m.verdict = "pushing down";
  else if (energy >= cfg.churnPtsPerSec) m.verdict = "two-sided";
  else m.verdict = "quiet";
  return m;
}
