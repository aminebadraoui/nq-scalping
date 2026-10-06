/* ------------------------------------------------------------------ *
 * The A+ day plan, as backtested — pure replay engine shared by the
 * study CLIs (scripts/apRulesStudy.ts, scripts/apChallengeTiming.ts,
 * scripts/apPlanSweep.ts).
 *
 * Pools (switchable):
 *   "ap"   A+ only — momentum A+ (both triggers on the same bar) +
 *          RTH A+ (>=65% one-sided) — the two A+ tiers the cards print
 *   "all"  regular + A+ across all live strategies — every momentum,
 *          expansion, RTH and open-drive signal (same-bar momentum/
 *          expansion double-fires dedupe to one card)
 *
 * Trade mechanics:
 *   · $100 risk/trade → contracts = floor(100 / (riskPts × $2)), min 1 MNQ
 *   · target 2R (open drive keeps its native fixed TP15/SL35 — that IS
 *     its measured design) · first-touch stop-first scoring · 0.5 pt cost ·
 *     60-bar hold (RTH capped at the 15:00 bar) · $0.95/contract/side comm
 *   · daily rules: −$300 stop · +$400 arms the one-more-trade rule
 *     (a win grants one more; the first loss after +$400 ends the day)
 *
 * Account model (MFF Rapid EOD 50k, help-center rules Aug 2026):
 *   · EVAL: balance starts at $0 (nominal $50,000), target +$3,000,
 *     MLL $2,000 END-OF-DAY trailing, floor locks at the STARTING
 *     BALANCE once it reaches it, 4 min trading days, 30% consistency
 *   · FUNDED: balance starts at $0, MLL $2,000 EOD trailing, floor
 *     locks at $100 once it reaches there — which is exactly when the
 *     $2,100 first-payout buffer clears; payouts unlock every +$500
 *     after that, 90/10, min request $500
 *
 * Measured results live in docs/research/ap-daily-rules-2026-10-05.md
 * and docs/research/ap-full-pool-2026-10-05.md.
 * ------------------------------------------------------------------ */

import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "./momentum";
import { detectSoftMomentum, SOFT_PROD } from "./softMomentum";
import { detectOpenDrive, OPEN_PROD } from "./openDrive";

export const COST = 0.5; // pts round-trip slippage+commission, baked into pnlPts
export const COMM_PER_SIDE = 0.95; // $/contract/side, same convention as riskStackStudy
export const RISK_CAP = 100; // $ risk per trade
export const TARGET_R = 2; // 2R target
export const LOSS_HALT = -300; // daily stop
export const PROFIT_ARM = 400; // +$400 arms the one-more-trade rule

/** the plan's tunable knobs (the sweep studies vary these) */
export type PlanParams = {
  riskCap: number; // $ risk per trade (sizing)
  targetR: number; // target = entry ± targetR × stop distance
  /** optional per-family target override (kept for the RTH-native question) */
  rthTargetR?: number;
  lossHalt: number; // day P&L at/below this → no more trades today
  profitArm: number; // day P&L at/above this → one-more-trade mode
};

export const DEFAULT_PLAN: PlanParams = {
  riskCap: RISK_CAP,
  targetR: TARGET_R,
  lossHalt: LOSS_HALT,
  profitArm: PROFIT_ARM,
};

/* ---------------- pools ---------------- */

export type PoolMode = "ap" | "all";
export type Fam = "momA+" | "rthA+" | "momentum" | "expansion" | "rth" | "open";
export type PoolSignal = { s: MomentumSignal; fam: Fam; aPlus: boolean };

/** A+ only — the two A+ tiers the live cards print */
export function detectAPlus(minutes: MomMinute[]): PoolSignal[] {
  return detectPool(minutes, "ap");
}

/** the full live suite: regular + A+ signals of every strategy */
export function detectPool(minutes: MomMinute[], mode: PoolMode): PoolSignal[] {
  const mom = detectMomentum(minutes, MOM_PROD);
  const exp = detectExpansionScalp(minutes, EXP_PROD);
  const rth = detectSoftMomentum(minutes, SOFT_PROD);
  const momKeys = new Set(mom.map((x) => `${x.entryIdx}|${x.dir}`));
  const expKeys = new Set(exp.map((x) => `${x.entryIdx}|${x.dir}`));
  const isMomA = (x: MomentumSignal) => expKeys.has(`${x.entryIdx}|${x.dir}`);

  if (mode === "ap") {
    const out: PoolSignal[] = [];
    // mom A+ = both triggers on the same bar (repo convention: the expansion
    // signal represents the overlap card, deduped — see momentumStudy --mode overlap)
    for (const s of exp) if (momKeys.has(`${s.entryIdx}|${s.dir}`)) out.push({ s, fam: "momA+", aPlus: true });
    // rth A+ = >=65% one-sided (the card's A+ label)
    for (const s of rth) if (s.breakFrac >= 0.65 || s.breakFrac <= 0.35) out.push({ s, fam: "rthA+", aPlus: true });
    return out.sort((a, b) => a.s.entryIdx - b.s.entryIdx);
  }

  const out: PoolSignal[] = [];
  for (const s of mom) out.push({ s, fam: "momentum", aPlus: isMomA(s) });
  for (const s of exp) if (!momKeys.has(`${s.entryIdx}|${s.dir}`)) out.push({ s, fam: "expansion", aPlus: false });
  for (const s of rth) out.push({ s, fam: "rth", aPlus: s.breakFrac >= 0.65 || s.breakFrac <= 0.35 });
  for (const s of detectOpenDrive(minutes, OPEN_PROD)) out.push({ s, fam: "open", aPlus: false });
  return out.sort((a, b) => a.s.entryIdx - b.s.entryIdx);
}

/* ---------------- trade scoring ---------------- */

export type Scored = {
  date: string;
  fam: Fam;
  aPlus: boolean;
  dir: "long" | "short";
  entryIdx: number;
  entry: number;
  stop: number;
  riskPts: number;
  pnlPts: number;
  hit: "stop" | "target" | "time";
  heldBars: number;
  contracts: number;
  pnlUsd: number;
  grossTargetUsd: number;
};

/** first-touch scoring over one signal: stop-first (pessimistic), 0.5 pt cost,
 *  60-bar hold (RTH capped at the 15:00 bar), target = stop + targetR×risk */
export function score2R(minutes: MomMinute[], s: MomentumSignal, fam: Fam, date: string, params: PlanParams = DEFAULT_PLAN, aPlus = false): Scored | null {
  const dir = s.dir === "long" ? 1 : -1;
  const risk = s.risk;
  if (!(risk > 0)) return null;
  const tR = (fam === "rth" || fam === "rthA+") && params.rthTargetR !== undefined ? params.rthTargetR : params.targetR;
  const target = s.entry + dir * tR * risk;
  return scoreWith(minutes, s, fam, date, params, s.stop, target, aPlus);
}

/** the open drive keeps its NATIVE fixed ticket (TP15/SL35) — that is its
 *  measured design; forcing 2R on it destroys the edge */
function scoreNative(minutes: MomMinute[], s: MomentumSignal, fam: Fam, date: string, params: PlanParams = DEFAULT_PLAN, aPlus = false): Scored | null {
  if (!(s.risk > 0) || !Number.isFinite(s.target)) return null;
  return scoreWith(minutes, s, fam, date, params, s.stop, s.target, aPlus);
}

function scoreWith(
  minutes: MomMinute[],
  s: MomentumSignal,
  fam: Fam,
  date: string,
  params: PlanParams,
  stop: number,
  target: number,
  aPlus: boolean,
): Scored | null {
  const dir = s.dir === "long" ? 1 : -1;
  const risk = Math.abs(s.entry - stop);
  if (!(risk > 0)) return null;
  const start = s.entryIdx + 1;
  // RTH trades may not run past the 15:00 bar (same cap as riskStackStudy)
  const mb = fam === "rth" || fam === "rthA+" ? Math.min(60, Math.max(1, minutes.findIndex((m) => m.t === "15:00") - s.entryIdx)) : 60;
  const end = Math.min(minutes.length - 1, s.entryIdx + mb);
  if (start > end) return null;

  let hit: Scored["hit"] = "stop";
  let exit = stop;
  let heldBars = end - s.entryIdx;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) { heldBars = j - s.entryIdx; break; } // pessimistic: stop first
    if (tgtHit) { exit = target; hit = "target"; heldBars = j - s.entryIdx; break; }
  }
  if (hit === "stop" && heldBars === end - s.entryIdx) {
    const stopHitLast = dir > 0 ? minutes[end].low <= stop : minutes[end].high >= stop;
    if (!stopHitLast) { hit = "time"; exit = (minutes[end].high + minutes[end].low) / 2; }
  }
  const pnlPts = (exit - s.entry) * dir - COST;
  const contracts = Math.max(1, Math.floor(params.riskCap / (risk * 2)));
  const pnlUsd = pnlPts * contracts * 2 - 2 * contracts * COMM_PER_SIDE;
  return {
    date,
    fam,
    aPlus,
    dir: s.dir,
    entryIdx: s.entryIdx,
    entry: s.entry,
    stop,
    riskPts: risk,
    pnlPts,
    hit,
    heldBars,
    contracts,
    pnlUsd,
    grossTargetUsd: Math.abs(target - s.entry) * 2 * contracts,
  };
}

/** score one pool signal under the plan (native ticket for the open drive) */
export function scoreTrade(minutes: MomMinute[], ps: PoolSignal, date: string, params: PlanParams = DEFAULT_PLAN): Scored | null {
  return ps.fam === "open"
    ? scoreNative(minutes, ps.s, ps.fam, date, params, ps.aPlus)
    : score2R(minutes, ps.s, ps.fam, date, params, ps.aPlus);
}

/* ---------------- daily-rule layer ---------------- */

export type RuleSet = { name: string; lossHalt: boolean; profitRule: boolean };

/** the rule variants the rules study decomposes (base / each layer / full) */
export const RULES: RuleSet[] = [
  { name: "base", lossHalt: false, profitRule: false },
  { name: "loss-300", lossHalt: true, profitRule: false },
  { name: "profit-400", lossHalt: false, profitRule: true },
  { name: "full", lossHalt: true, profitRule: true },
];

/** the plan as the owner stated it */
export const FULL_PLAN: RuleSet = RULES[3];

export type DayRun = {
  trades: Scored[];
  dayPnl: number;
  halted: "none" | "loss" | "profit";
  skippedByHalt: number;
};

export function runDay(rule: RuleSet, date: string, minutes: MomMinute[], signals: PoolSignal[], params: PlanParams = DEFAULT_PLAN): DayRun {
  const trades: Scored[] = [];
  let dayPnl = 0;
  let halted: DayRun["halted"] = "none";
  let armed = false; // day P&L crossed the profit arm
  let openUntil = -1;
  let skippedByHalt = 0;
  for (const ps of signals) {
    if (ps.s.entryIdx <= openUntil) continue; // one position at a time
    if (halted !== "none") { skippedByHalt++; continue; }
    const sc = scoreTrade(minutes, ps, date, params);
    if (!sc) continue;
    trades.push(sc);
    dayPnl += sc.pnlUsd;
    openUntil = sc.entryIdx + sc.heldBars;
    if (!armed && dayPnl >= params.profitArm) armed = true;
    if (rule.lossHalt && dayPnl <= params.lossHalt) { halted = "loss"; continue; }
    if (rule.profitRule && armed && sc.pnlUsd < 0) { halted = "profit"; continue; }
  }
  return { trades, dayPnl, halted, skippedByHalt };
}
