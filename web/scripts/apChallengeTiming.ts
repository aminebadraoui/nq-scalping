/* ------------------------------------------------------------------ *
 * A+ plan — challenge timing study.
 * "How long to pass the MFF Rapid EOD 50k eval trading the plan?"
 *
 * Pools: --pool ap (A+ only) | --pool all (regular + A+ across every
 * live strategy) [default]. Replays the plan (lib/apPlan.ts FULL_PLAN)
 * over the archive and answers the question three ways:
 *
 *   1. Chronologically — the actual historical path from a fresh start.
 *   2. Monte Carlo — 10,000 random orderings of the realized day P&Ls
 *      through the exact eval gates. Random orderings destroy serial
 *      correlation, so this brackets "any start date".
 *   3. Funded stage — the same day distribution through the SIM FUNDED
 *      gates: balance starts at $0, MLL $2,000 EOD trailing, floor
 *      locks at $100 (which is exactly when the $2,100 first-payout
 *      buffer clears), payouts unlock every +$500 after that.
 *
 * Account model (MFF help center, Aug 2026 — see lib/apPlan.ts):
 *   · EVAL: balance starts at $0 (nominal $50k), target +$3,000, MLL
 *     $2,000 END-OF-DAY trailing, floor locks at the STARTING BALANCE
 *     once it reaches it, 4 min trading days, 30% consistency
 *     (best day ≤ 30% of total profit at the moment of passing)
 *   · FUNDED: floor locks at $100 AFTER the first-payout buffer ($2,100)
 *     clears — not before
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs scripts/apChallengeTiming.ts \
 *     [--pool ap|all] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { simulateAccount } from "../lib/propAccount";
import type { MomMinute } from "../lib/momentum";
import { detectPool, runDay, FULL_PLAN, RULES, type Scored, type PoolMode } from "../lib/apPlan";

const CONCURRENCY = 8;
const MC_ITERS = 10_000;
const TARGET = 3000;
const MLL = 2000;
const CONSISTENCY = 0.3;
const MIN_DAYS = 4;
const FUNDED_BUFFER = 2100; // first-payout buffer
const PAYOUT_STEP = 500;

/* ---------------- eval stage (fresh start) ---------------- */

type EvalOutcome = { outcome: "pass" | "blow" | "nopass"; at: number; reqEquity: number | null };

/* ---------------- sim funded stage ---------------- */

type FundedOutcome = { outcome: "blow" | "ok"; at: number; firstPayoutDay: number | null; payouts: number };

function shuffle(seq: number[]): void {
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seq[i], seq[j]] = [seq[j], seq[i]];
  }
}

function mcEval(days: number[], iters = MC_ITERS) {
  const passDays: number[] = [];
  let blown = 0;
  let noPass = 0;
  const seq = Array.from({ length: days.length }, (_, i) => i);
  for (let it = 0; it < iters; it++) {
    shuffle(seq);
    const r = evalFreshIndices(seq, days);
    if (r.outcome === "pass") passDays.push(r.at);
    else if (r.outcome === "blow") blown++;
    else noPass++;
  }
  const s = [...passDays].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.floor((s.length - 1) * p)] : -1);
  return {
    passPct: (100 * s.length) / iters,
    blowPct: (100 * blown) / iters,
    noPassPct: (100 * noPass) / iters,
    medDays: s.length ? s[Math.floor(s.length / 2)] : -1,
    p25: q(0.25),
    p75: q(0.75),
    p90: q(0.9),
    cdf20: s.length ? (100 * s.filter((d) => d <= 20).length) / s.length : 0,
    cdf60: s.length ? (100 * s.filter((d) => d <= 60).length) / s.length : 0,
  };
}

function evalFreshIndices(seq: number[], days: number[]): EvalOutcome {
  let cum = 0;
  let best = 0;
  let floor = -MLL;
  let locked = false;
  for (let i = 0; i < seq.length; i++) {
    cum += days[seq[i]];
    best = Math.max(best, days[seq[i]]);
    if (cum < floor) return { outcome: "blow", at: i + 1, reqEquity: null };
    const req = Math.max(TARGET, best / CONSISTENCY);
    if (cum >= req && i + 1 >= MIN_DAYS) return { outcome: "pass", at: i + 1, reqEquity: req };
    floor = Math.max(floor, cum - MLL);
    if (!locked && floor >= 0) { floor = 0; locked = true; }
  }
  return { outcome: "nopass", at: seq.length, reqEquity: null };
}

function mcFunded(days: number[], iters = MC_ITERS) {
  const firstPayoutDays: number[] = [];
  const payouts: number[] = [];
  let blown = 0;
  let ok = 0;
  const seq = Array.from({ length: days.length }, (_, i) => i);
  for (let it = 0; it < iters; it++) {
    shuffle(seq);
    const r = fundedFreshIndices(seq, days);
    if (r.outcome === "blow") blown++;
    else {
      ok++;
      if (r.firstPayoutDay !== null) firstPayoutDays.push(r.firstPayoutDay);
      payouts.push(r.payouts);
    }
  }
  const s = [...firstPayoutDays].sort((a, b) => a - b);
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  return {
    blowPct: (100 * blown) / iters,
    firstPayoutMed: s.length ? s[Math.floor(s.length / 2)] : -1,
    firstPayoutP25: s.length ? s[Math.floor((s.length - 1) * 0.25)] : -1,
    firstPayoutP75: s.length ? s[Math.floor((s.length - 1) * 0.75)] : -1,
    medPayouts: med(payouts),
  };
}

function fundedFreshIndices(seq: number[], days: number[]): FundedOutcome {
  let cum = 0;
  let floor = -MLL;
  let locked = false;
  let firstPayoutDay: number | null = null;
  let lastPayoutLevel = 0;
  let payouts = 0;
  for (let i = 0; i < seq.length; i++) {
    cum += days[seq[i]];
    if (cum < floor) return { outcome: "blow", at: i + 1, firstPayoutDay, payouts };
    if (firstPayoutDay === null && cum >= FUNDED_BUFFER) {
      firstPayoutDay = i + 1;
      payouts = 1;
      lastPayoutLevel = cum;
    } else if (firstPayoutDay !== null) {
      while (cum - lastPayoutLevel >= PAYOUT_STEP) {
        payouts++;
        lastPayoutLevel += PAYOUT_STEP;
      }
    }
    floor = Math.max(floor, cum - MLL);
    if (!locked && floor >= 100) { floor = 100; locked = true; }
  }
  return { outcome: "ok", at: seq.length, firstPayoutDay, payouts };
}

async function main() {
  const argv = process.argv;
  const pool: PoolMode = argv.includes("--pool") ? (argv[argv.indexOf("--pool") + 1] === "ap" ? "ap" : "all") : "all";
  const offline = argv.includes("--offline");
  const dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  console.log(`plan challenge timing · pool=${pool} · ${dates.length} sessions`);
  const t0 = Date.now();

  const byVariant = new Map<string, Scored[]>();
  for (const rule of RULES) byVariant.set(rule.name, []);
  let loaded = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals = detectPool(minutes as MomMinute[], pool);
      if (!signals.length) continue;
      for (const rule of RULES) {
        byVariant.get(rule.name)!.push(...runDay(rule, date, minutes as MomMinute[], signals).trades);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const dayPnl = (trades: Scored[]) => {
    const m = new Map<string, number>();
    for (const t of trades) m.set(t.date, (m.get(t.date) ?? 0) + t.pnlUsd);
    return m;
  };

  const full = dayPnl(byVariant.get(FULL_PLAN.name)!);
  const base = dayPnl(byVariant.get("base")!);
  const fullDates = [...full.keys()].sort();
  const fullDays = fullDates.map((d) => full.get(d)!);
  const baseDays = [...base.values()];

  // calendar conversion: sessions per calendar day over the archive span
  const span = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86_400_000 + 1;
  const sessPerDay = dates.length / span;
  const sessPerWeek = sessPerDay * 7;
  console.log(`archive span ${dates[0]} → ${dates[dates.length - 1]} (${span.toFixed(0)} calendar days) · ${sessPerWeek.toFixed(1)} sessions/week\n`);

  /* ---- 1. chronological fresh start (eval) ---- */
  const chrono = simulateAccount(byVariant.get(FULL_PLAN.name)!.map((t) => ({ date: t.date, pnl: t.pnlUsd })), "eval");
  const chronoPassIdx = chrono.days.findIndex((d) => d.date === chrono.passDay) + 1;
  const chronoCalendar = chrono.passDay ? (new Date(chrono.passDay).getTime() - new Date(dates[0]).getTime()) / 86_400_000 : 0;
  console.log("CHRONOLOGICAL fresh start (the actual path, full plan):");
  if (chrono.passDay) {
    console.log(`  pass ${chrono.passDay} · ${chronoPassIdx} trading days · ~${Math.round(chronoCalendar)} calendar days (~${(chronoCalendar / 7).toFixed(1)} weeks) · equity $${chrono.passEquity!.toFixed(0)} · consist ${chrono.consistencyOk ? "✓" : "✗"}`);
  } else {
    console.log(`  ${chrono.breachDay ? `breach ${chrono.breachDay}` : "no pass"}`);
  }

  /* ---- 2. eval Monte Carlo ---- */
  console.log(`\nEVAL MONTE CARLO (${MC_ITERS} random day orderings, fresh start, exact gates):`);
  console.log(`series              | P(pass) P(blow) | med days | p25 | p75 | p90 | ≤20d | ≤60d | med calendar`);
  console.log(`--------------------+-----------------+----------+-----+-----+-----+------+------+-------------`);
  const rows: Array<[string, number[]]> = [
    ["full plan", fullDays],
    ["full ×0.5 (live lags)", fullDays.map((d) => d * 0.5)],
    ["full ×0.25 (conservative)", fullDays.map((d) => d * 0.25)],
    ["base, no rules", baseDays],
  ];
  for (const [label, series] of rows) {
    const r = mcEval(series);
    const medWk = r.medDays < 0 ? "—" : `${(r.medDays / sessPerWeek).toFixed(0)}wk`;
    const p25 = r.p25 < 0 ? "—" : String(r.p25);
    const p75 = r.p75 < 0 ? "—" : String(r.p75);
    const p90 = r.p90 < 0 ? "—" : String(r.p90);
    console.log(
      `${label.padEnd(20)} | ${r.passPct.toFixed(0).padStart(4)}% ${r.blowPct.toFixed(0).padStart(5)}% | ${String(r.medDays).padStart(8)} | ${p25.padStart(3)} | ${p75.padStart(3)} | ${p90.padStart(3)} | ${r.cdf20.toFixed(0).padStart(4)}% | ${r.cdf60.toFixed(0).padStart(4)}% | ${medWk.padStart(11)}`,
    );
  }

  /* ---- 3. sim funded Monte Carlo ---- */
  console.log(`\nSIM FUNDED MONTE CARLO (${MC_ITERS} orderings · balance $0 · $2,000 EOD trailing · floor locks at $100 when the $2,100 buffer clears):`);
  const f = mcFunded(fullDays);
  console.log(`  P(blow) ${f.blowPct.toFixed(1).padStart(5)}% | first payout: med ${f.firstPayoutMed} trading days (~${(f.firstPayoutMed / sessPerWeek).toFixed(0)}wk) · p25 ${f.firstPayoutP25} · p75 ${f.firstPayoutP75} | payouts over the sample: med ${f.medPayouts}`);

  /* ---- 4. consistency gate context ---- */
  const bestDay = Math.max(...fullDays);
  console.log(`\nday P&L used: ${fullDays.length} trading days · median ${fullDays.sort((a, b) => a - b)[Math.floor(fullDays.length / 2)] >= 0 ? "+$" : "−$"}${Math.abs(Math.round(fullDays[Math.floor(fullDays.length / 2)]))} · best +$${Math.round(bestDay)} · worst −$${Math.abs(Math.round(Math.min(...fullDays)))}`);
  console.log(`consistency: 30% rule needs $${Math.round(TARGET)} at pass unless the +$${Math.round(bestDay)} best day lands early — then $${Math.round(bestDay / CONSISTENCY)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
