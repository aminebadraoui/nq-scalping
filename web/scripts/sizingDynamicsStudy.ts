/* ------------------------------------------------------------------ *
 * Sizing-dynamics study — Option A vs Option B.
 *
 * The question: should we keep the same size in drawdown and SHRINK as
 * the day's profit climbs (Option A — the live tiers), or shrink as we
 * lose and GROW as we win, never risking more than the day's P&L
 * (Option B — house-money scaling)?
 *
 * Same trade stream as riskStackStudy (momentum + expansion + RTH +
 * open drive, globally sequenced one-position-at-a-time, fixed 1R-style
 * exits, 0.5pt cost + $0.95/side commissions), give-back halt ON for
 * every scheme (it is the adopted protection — only SIZING differs).
 * Each scheme computes contracts per trade from its own state machine,
 * then the trade lists go through the canonical MFF account simulator.
 *
 * Schemes:
 *   flat            $170 momentum / $200 RTH+open budget, always
 *   tiers           flat + 2/3 size @ +$300, 1/3 @ +$600   (OPTION A, live)
 *   lossHalve       ×0.5 per consecutive loss, reset on win
 *   lossQuarter     ×0.75 per consecutive loss, reset on win
 *   winScaleRaw     ×1.5 per win (cap ×2), reset on loss — no brake
 *   winScale        ×1.5 per win + risk ≤ day P&L ceiling
 *   greenBudget     risk ≤ max(0, day P&L) — the house-money rule alone
 *   floorFractional risk = 8.5% × (equity − EOD floor), per trade
 *   b-full          shrink on loss ×0.5 + grow on win ×1.5 + day-P&L
 *                   ceiling — Option B verbatim
 *   tiers+lossHalve Option A + the drawdown leg of Option B
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/sizingDynamicsStudy.ts [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { simulateAccount, accountLine } from "../lib/propAccount";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";

const CONCURRENCY = 8;
const COST = 0.5; // pts slippage+cost baked into the fixed scorer
const COMM_PER_SIDE = 0.95; // the measured all-in per side ($)
const MOM_BUDGET = 170;
const RTH_BUDGET = 200;
const MOM_CAP = 30;
const RTH_CAP = 9;
const FRACTION = MOM_BUDGET / 2000; // 8.5% of the $2,000 MLL per trade

type FamTag = "momentum" | "expansion" | "rth" | "open";

function detectAll(minutes: MomMinute[]): Array<{ s: MomentumSignal; fam: FamTag }> {
  const out: Array<{ s: MomentumSignal; fam: FamTag }> = [];
  for (const s of detectMomentum(minutes, MOM_PROD)) out.push({ s, fam: "momentum" });
  for (const s of detectExpansionScalp(minutes, EXP_PROD)) out.push({ s, fam: "expansion" });
  for (const s of detectSoftMomentum(minutes, SOFT_PROD)) out.push({ s, fam: "rth" });
  for (const s of detectOpenDrive(minutes, OPEN_PROD)) out.push({ s, fam: "open" });
  return out.sort((a, b) => a.s.entryIdx - b.s.entryIdx);
}

/** fixed 1R-style exit scorer — the same pessimistic first-touch scoring
 *  riskStackStudy uses (stop first when both sit in one bar, 0.5pt cost). */
function scoreFixed(
  minutes: MomMinute[],
  entry: number,
  stop0: number,
  dir: 1 | -1,
  entryIdx: number,
  targetR: number,
  maxBars: number,
): { pnl: number; risk: number; heldBars: number } | null {
  const risk = Math.abs(entry - stop0);
  if (!(risk > 0)) return null;
  const target = entry + dir * targetR * risk;
  const start = entryIdx + 1;
  const end = Math.min(minutes.length - 1, entryIdx + maxBars);
  if (start > end) return null;
  let hit: "stop" | "target" | "time" = "stop";
  let exit = stop0;
  let heldBars = 0;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop0 : b.high >= stop0;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      heldBars = j - entryIdx;
      break;
    }
    if (tgtHit) {
      exit = target;
      hit = "target";
      heldBars = j - entryIdx;
      break;
    }
  }
  if (hit === "stop" && heldBars === end - entryIdx) {
    const stopHitLast = dir > 0 ? minutes[end].low <= stop0 : minutes[end].high >= stop0;
    if (!stopHitLast) {
      hit = "time";
      exit = (minutes[end].high + minutes[end].low) / 2;
    }
  }
  return { pnl: (exit - entry) * dir - COST, risk, heldBars };
}

type Trade = {
  date: string;
  fam: FamTag;
  pnlUsd: number;
  contracts: number;
};

type Scheme = {
  name: string;
  desc: string;
  tiers: boolean;
  lossMult: number; // <1: shrink after each loss, reset on win (1 = off)
  winMult: number; // >1: grow after each win (cap ×2), reset on loss (1 = off)
  dayPnlCeil: boolean; // risk never exceeds the day's realized P&L
  fractional: boolean; // risk = FRACTION × (equity − EOD floor), per trade
};

const TIERS = [
  { threshold: 600, multiplier: 1 / 3 },
  { threshold: 300, multiplier: 2 / 3 },
];

const SCHEMES: Scheme[] = [
  { name: "flat", desc: "same size always ($170/$200)", tiers: false, lossMult: 1, winMult: 1, dayPnlCeil: false, fractional: false },
  { name: "tiers", desc: "OPTION A: shrink as the day climbs (live)", tiers: true, lossMult: 1, winMult: 1, dayPnlCeil: false, fractional: false },
  { name: "lossHalve", desc: "×0.5 per loss, reset on win", tiers: false, lossMult: 0.5, winMult: 1, dayPnlCeil: false, fractional: false },
  { name: "lossQuarter", desc: "×0.75 per loss, reset on win", tiers: false, lossMult: 0.75, winMult: 1, dayPnlCeil: false, fractional: false },
  { name: "winScaleRaw", desc: "×1.5 per win (cap ×2), no brake", tiers: false, lossMult: 1, winMult: 1.5, dayPnlCeil: false, fractional: false },
  { name: "winScale", desc: "×1.5 per win + risk ≤ day P&L (1st trade full)", tiers: false, lossMult: 1, winMult: 1.5, dayPnlCeil: true, fractional: false },
  { name: "greenBudget", desc: "risk ≤ day P&L (1st trade full)", tiers: false, lossMult: 1, winMult: 1, dayPnlCeil: true, fractional: false },
  { name: "floorFractional", desc: "8.5% of equity−floor per trade", tiers: false, lossMult: 1, winMult: 1, dayPnlCeil: false, fractional: true },
  { name: "b-full", desc: "OPTION B: loss ×0.5 + win ×1.5 + P&L ceil", tiers: false, lossMult: 0.5, winMult: 1.5, dayPnlCeil: true, fractional: false },
  { name: "tiers+lossHalve", desc: "A + the drawdown leg of B", tiers: true, lossMult: 0.5, winMult: 1, dayPnlCeil: false, fractional: false },
];

/** the day engine: sizes + scores every signal of one session under one
 *  scheme. `ctx` (day-start equity + EOD floor) is only needed by the
 *  fractional scheme; null otherwise. */
function runDay(
  scheme: Scheme,
  date: string,
  minutes: MomMinute[],
  signals: Array<{ s: MomentumSignal; fam: FamTag }>,
  ctx: { equity: number; floor: number } | null,
): Trade[] {
  const trades: Trade[] = [];
  let dayPnl = 0;
  let dayPeak = 0;
  let halt = false;
  let openUntil = -1;
  let mult = 1; // the streak multiplier (loss- or win-driven)
  let traded = false; // has the day taken its bootstrap trade yet?
  for (const { s, fam } of signals) {
    if (s.entryIdx <= openUntil) continue; // one MNQ position at a time
    const dir = s.dir === "long" ? 1 : -1;
    const mb = fam === "rth" ? Math.min(60, Math.max(1, minutes.findIndex((m) => m.t === "15:00") - s.entryIdx)) : 60;
    if (mb < 1) continue;
    const targetR = fam === "rth" ? 0.75 : fam === "open" ? 15 / 35 : 1;
    const sc = scoreFixed(minutes, s.entry, s.stop, dir, s.entryIdx, targetR, mb);
    if (!sc) continue;
    if (halt) continue; // give-back halt: no new entries for the rest of the day
    const riskPts = Math.abs(s.entry - s.stop);

    // ---- the scheme's contract count ----
    let budget: number;
    if (scheme.fractional) {
      const margin = ctx ? ctx.equity + dayPnl - ctx.floor : 2000;
      budget = FRACTION * Math.max(0, margin);
    } else {
      budget = fam === "momentum" || fam === "expansion" ? MOM_BUDGET : RTH_BUDGET;
    }
    let tier = 1;
    if (scheme.tiers) {
      for (const t of TIERS) if (dayPnl >= t.threshold) { tier = t.multiplier; break; }
    }
    let contracts = Math.max(1, Math.floor((budget * mult * tier) / (riskPts * 2)));
    contracts = Math.min(fam === "momentum" || fam === "expansion" ? MOM_CAP : RTH_CAP, contracts);
    if (scheme.dayPnlCeil) {
      // the house-money rule: the FIRST trade of the day takes the base size
      // (nothing exists to risk yet); afterwards, dollar risk never exceeds
      // the day's realized P&L, and a red day takes no more trades.
      if (traded && dayPnl <= 0) continue;
      if (traded) contracts = Math.min(contracts, Math.max(0, Math.floor(dayPnl / (riskPts * 2))));
      if (contracts < 1) continue;
    }

    const pnlUsd = sc.pnl * contracts * 2 - 2 * contracts * COMM_PER_SIDE;
    trades.push({ date, fam, pnlUsd, contracts });
    traded = true;
    dayPnl += pnlUsd;
    dayPeak = Math.max(dayPeak, dayPnl);
    openUntil = s.entryIdx + sc.heldBars;

    // streak update (after the trade settles)
    if (pnlUsd > 0) mult = scheme.winMult > 1 ? Math.min(2, mult * scheme.winMult) : 1;
    else mult = scheme.lossMult < 1 ? mult * scheme.lossMult : 1;

    // give-back halt (constant across schemes)
    if (dayPeak > 250) {
      const limit = Math.max(250, 0.5 * dayPeak);
      if (dayPnl <= dayPeak - limit) halt = true;
    }
  }
  return trades;
}

/** per-stage account engine — the EOD-trailing MLL + consistency + payout
 *  rules (0-based, mirrors propAccount.simulateAccount). Needed so the
 *  fractional scheme can see the running equity/floor. */
type Engine = {
  equity: number;
  floor: number;
  locked: boolean;
  breachDay: string | null;
  tradingDays: number;
  bestDay: number;
  passDay: string | null;
  payouts: number;
};

function eodUpdate(e: Engine, stage: "eval" | "funded", date: string, dayPnl: number, hadTrades: boolean): void {
  if (hadTrades) e.tradingDays++;
  e.equity += dayPnl;
  e.bestDay = Math.max(e.bestDay, dayPnl);
  if (!e.breachDay && e.equity < e.floor) e.breachDay = date;
  if (stage === "eval" && !e.passDay && !e.breachDay && e.equity >= 3000 && e.tradingDays >= 4 && e.bestDay <= 0.3 * e.equity) {
    e.passDay = date;
  }
  e.floor = Math.max(e.floor, e.equity - 2000);
  if (stage === "funded" && !e.locked && e.floor >= 100) {
    e.floor = 100;
    e.locked = true;
  }
  if (stage === "funded" && !e.breachDay && e.equity >= 2100) {
    e.payouts = 1 + Math.floor((e.equity - 2100) / 500);
  }
}

function seedEngine(): Engine {
  return { equity: 0, floor: -2000, locked: false, breachDay: null, tradingDays: 0, bestDay: 0, passDay: null, payouts: 0 };
}

async function main() {
  const offline = process.argv.includes("--offline");
  const maxArg = process.argv.indexOf("--max");
  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (maxArg >= 0) dates = dates.slice(0, Number(process.argv[maxArg + 1]));
  console.log(`sizing-dynamics study · ${dates.length} sessions · give-back halt ON for every scheme`);
  for (const s of SCHEMES) console.log(`  ${s.name.padEnd(18)} ${s.desc}`);
  console.log();
  const t0 = Date.now();

  // per-scheme state: trades + one engine per stage (eval, funded)
  const acc = SCHEMES.map((scheme) => ({
    scheme,
    eval: seedEngine(),
    funded: seedEngine(),
    tradesEval: [] as Trade[],
    tradesFunded: [] as Trade[],
  }));

  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals = detectAll(minutes);
      for (const a of acc) {
        const s = a.scheme;
        if (s.fractional) {
          const tE = runDay(s, date, minutes, signals, { equity: a.eval.equity, floor: a.eval.floor });
          a.tradesEval.push(...tE);
          const tF = runDay(s, date, minutes, signals, { equity: a.funded.equity, floor: a.funded.floor });
          a.tradesFunded.push(...tF);
        } else {
          const t = runDay(s, date, minutes, signals, null);
          a.tradesEval.push(...t);
          a.tradesFunded.push(...t);
        }
        const dayE = a.tradesEval.filter((t) => t.date === date).reduce((x, t) => x + t.pnlUsd, 0);
        const dayF = a.tradesFunded.filter((t) => t.date === date).reduce((x, t) => x + t.pnlUsd, 0);
        eodUpdate(a.eval, "eval", date, dayE, dayE !== 0);
        eodUpdate(a.funded, "funded", date, dayF, dayF !== 0);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  // cross-check: my engine vs the canonical simulator (must agree on
  // breach day + final equity; passDay is nulled by the sim after a breach
  // while the engine keeps it, so compare it only when neither breached)
  for (const a of acc) {
    const ev = simulateAccount(a.tradesEval.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "eval");
    const enginePass = a.eval.breachDay ? null : a.eval.passDay;
    if (ev.breachDay !== a.eval.breachDay || ev.passDay !== enginePass || Math.abs(ev.finalEquity - a.eval.equity) > 0.01) {
      console.log(
        `ENGINE MISMATCH (eval) for ${a.scheme.name}: sim breach=${ev.breachDay ?? "-"} pass=${ev.passDay ?? "-"} eq=${ev.finalEquity.toFixed(2)} vs ` +
          `engine breach=${a.eval.breachDay ?? "-"} pass=${enginePass ?? "-"} eq=${a.eval.equity.toFixed(2)}`,
      );
    }
  }

  console.log(
    `${"variant".padEnd(18)} ${"trades".padStart(6)} ${"total".padStart(11)} ${"med day".padStart(8)} ${"worst".padStart(8)} ${"dayVol".padStart(7)} ${"P≥500".padStart(6)} ${"P≥900".padStart(6)} ${">900d".padStart(5)} ${"avgC".padStart(5)} ${"$/vol".padStart(6)}`,
  );
  for (const a of acc) {
    const tE = a.tradesEval;
    const byDay = new Map<string, number>();
    for (const t of tE) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnlUsd);
    const days = [...byDay.values()];
    const sorted = [...days].sort((x, y) => x - y);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const mean = days.length ? days.reduce((x, y) => x + y, 0) / days.length : 0;
    const dayVol = days.length ? Math.sqrt(days.reduce((x, y) => x + (y - mean) ** 2, 0) / days.length) : 0;
    const total = tE.reduce((x, t) => x + t.pnlUsd, 0);
    const breaches = days.filter((d) => d > 900).length;
    const pGoal = (g: number) => (days.length ? ((days.filter((d) => d >= g).length / days.length) * 100).toFixed(0) : "0");
    const avgC = tE.length ? tE.reduce((x, t) => x + t.contracts, 0) / tE.length : 0;
    const totalStr = `${total >= 0 ? "+" : "−"}$${Math.abs(Math.round(total)).toLocaleString("en-US")}`;
    console.log(
      `${a.scheme.name.padEnd(18)} ${String(tE.length).padStart(6)} ${totalStr.padStart(11)} ${`${med >= 0 ? "+$" : "−$"}${Math.abs(Math.round(med))}`.padStart(8)} ${`${(sorted[0] ?? 0) <= 0 ? "−$" : "+$"}${Math.abs(Math.round(sorted[0] ?? 0))}`.padStart(8)} ${`$${Math.round(dayVol)}`.padStart(7)} ${`${pGoal(500)}%`.padStart(6)} ${`${pGoal(900)}%`.padStart(6)} ${String(breaches).padStart(5)} ${avgC.toFixed(1).padStart(5)} ${(dayVol > 0 ? total / dayVol : 0).toFixed(0).padStart(6)}`,
    );
    const ev = simulateAccount(tE.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "eval");
    const fu = simulateAccount(a.tradesFunded.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "funded");
    console.log(`                     eval: ${accountLine(ev)}`);
    console.log(`                     funded: ${accountLine(fu)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
