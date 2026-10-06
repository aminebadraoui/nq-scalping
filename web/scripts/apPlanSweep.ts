/* ------------------------------------------------------------------ *
 * Plan — hardening sweep (pools: --pool ap | --pool all [default]).
 * "What can we change so blowing is virtually impossible while the
 *  timeline to pass stays reasonable (~1 month)?"
 *
 * Sweeps the plan's knobs (risk cap, daily stop, profit arm, target R)
 * plus two state-aware protection layers (drawdown-aware and
 * streak-aware half-sizing), over the same archive and the EXACT
 * Rapid EOD 50k gates for BOTH stages (MFF help center, Aug 2026):
 *
 *   EVAL:   balance $0, target +$3,000, MLL $2,000 END-OF-DAY
 *           trailing, floor locks at the STARTING BALANCE once it
 *           reaches it, 4 min trading days, 30% consistency
 *   FUNDED: balance $0, MLL $2,000 EOD trailing, floor locks at
 *           $100 once it reaches there (the $2,100 first-payout
 *           buffer clears at the same moment), payouts every +$500
 *
 * State-aware rules switch at DAY boundaries (the floor itself only
 * trails at closes, so this is exact). Every config runs 10,000
 * random day orderings per stage plus the chronological path.
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs scripts/apPlanSweep.ts \
 *     [--pool ap|all] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import type { MomMinute } from "../lib/momentum";
import {
  detectPool,
  runDay,
  FULL_PLAN,
  type PlanParams,
  type PoolMode,
  type PoolSignal,
} from "../lib/apPlan";

const CONCURRENCY = 8;
const MC_ITERS = 10_000;
const TARGET = 3000;
const MLL = 2000;
const CONSISTENCY = 0.3;
const MIN_DAYS = 4;
const FUNDED_BUFFER = 2100;
const BLOW_WINDOW = 90; // trading days — funded blow inside this window

type Config = {
  label: string;
  params: PlanParams; // full-size params
  half?: number; // half-size risk cap (state-aware only)
  kind?: "dd" | "red2";
  ddHi?: number;
  ddLo?: number;
};

const CONFIGS: Config[] = [
  // --- the plan as stated, plus its own knob variations ---
  { label: "current 100/-300/2R", params: { riskCap: 100, targetR: 2, lossHalt: -300, profitArm: 400 } },
  { label: "100/-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 } },
  { label: "100/-200/2R", params: { riskCap: 100, targetR: 2, lossHalt: -200, profitArm: 400 } },
  { label: "150/-250/2R (speed ref)", params: { riskCap: 150, targetR: 2, lossHalt: -250, profitArm: 400 } },
  // --- lower target R: same setups, less variance, higher WR ---
  { label: "100/-250/1.5R", params: { riskCap: 100, targetR: 1.5, lossHalt: -250, profitArm: 400 } },
  { label: "100/-250/1R", params: { riskCap: 100, targetR: 1, lossHalt: -250, profitArm: 400 } },
  { label: "100/-250/1R RTH0.75", params: { riskCap: 100, targetR: 1, rthTargetR: 0.75, lossHalt: -250, profitArm: 400 } },
  { label: "100/-300/1R", params: { riskCap: 100, targetR: 1, lossHalt: -300, profitArm: 400 } },
  { label: "100/-200/1R", params: { riskCap: 100, targetR: 1, lossHalt: -200, profitArm: 400 } },
  { label: "125/-250/1R", params: { riskCap: 125, targetR: 1, lossHalt: -250, profitArm: 400 } },
  { label: "125/-200/1R", params: { riskCap: 125, targetR: 1, lossHalt: -200, profitArm: 400 } },
  // --- drawdown-aware half/quarter size (aims at the trailing MLL) ---
  { label: "dd800→half /-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 }, half: 50, kind: "dd", ddHi: 800, ddLo: 400 },
  { label: "dd600→half /-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 }, half: 50, kind: "dd", ddHi: 600, ddLo: 300 },
  { label: "dd600→half /-200/2R", params: { riskCap: 100, targetR: 2, lossHalt: -200, profitArm: 400 }, half: 50, kind: "dd", ddHi: 600, ddLo: 300 },
  { label: "dd800→quarter /-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 }, half: 35, kind: "dd", ddHi: 800, ddLo: 400 },
  { label: "dd600→quarter /-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 }, half: 35, kind: "dd", ddHi: 600, ddLo: 300 },
  // --- streak-aware sizing ---
  { label: "red2→half /-250/2R", params: { riskCap: 100, targetR: 2, lossHalt: -250, profitArm: 400 }, half: 50, kind: "red2" },
  // --- combined: drawdown-aware + lower target ---
  { label: "dd600→half /-250/1.5R", params: { riskCap: 100, targetR: 1.5, lossHalt: -250, profitArm: 400 }, half: 50, kind: "dd", ddHi: 600, ddLo: 300 },
  { label: "dd600→half /-250/1R", params: { riskCap: 100, targetR: 1, lossHalt: -250, profitArm: 400 }, half: 50, kind: "dd", ddHi: 600, ddLo: 300 },
  { label: "dd600→half /-250/1R RTH0.75", params: { riskCap: 100, targetR: 1, rthTargetR: 0.75, lossHalt: -250, profitArm: 400 }, half: 50, kind: "dd", ddHi: 600, ddLo: 300 },
];

/* ---------------- day-picking state machine (shared by both stages) ---------------- */

type State = { cum: number; peak: number; mode: "full" | "half"; prev: [number, number] };

function pickPnl(cfg: Config, state: State, seqIdx: number, full: number[], half: number[] | null): number {
  if (cfg.kind === "dd" && half) {
    const dd = state.peak - state.cum;
    if (dd >= (cfg.ddHi ?? 0)) state.mode = "half";
    else if (dd <= (cfg.ddLo ?? 0)) state.mode = "full";
    return state.mode === "half" ? half[seqIdx] : full[seqIdx];
  }
  if (cfg.kind === "red2" && half) {
    state.mode = state.prev[0] < 0 && state.prev[1] < 0 ? "half" : "full";
    return state.mode === "half" ? half[seqIdx] : full[seqIdx];
  }
  return full[seqIdx];
}

/* ---------------- EVAL stage ---------------- */

function evalSeq(cfg: Config, seq: number[], full: number[], half: number[] | null): { outcome: "pass" | "blow" | "nopass"; at: number } {
  const st: State = { cum: 0, peak: 0, mode: "full", prev: [0, 0] };
  let best = 0;
  let floor = -MLL;
  let locked = false;
  for (let i = 0; i < seq.length; i++) {
    const pnl = pickPnl(cfg, st, seq[i], full, half);
    st.cum += pnl;
    st.peak = Math.max(st.peak, st.cum);
    best = Math.max(best, pnl);
    if (st.cum < floor) return { outcome: "blow", at: i + 1 };
    const req = Math.max(TARGET, best / CONSISTENCY);
    if (st.cum >= req && i + 1 >= MIN_DAYS) return { outcome: "pass", at: i + 1 };
    floor = Math.max(floor, st.cum - MLL);
    if (!locked && floor >= 0) { floor = 0; locked = true; }
    st.prev = [st.prev[1], pnl];
  }
  return { outcome: "nopass", at: seq.length };
}

/* ---------------- FUNDED stage ---------------- */

function fundedSeq(cfg: Config, seq: number[], full: number[], half: number[] | null): { outcome: "blow" | "ok"; at: number; firstPayoutDay: number | null } {
  const st: State = { cum: 0, peak: 0, mode: "full", prev: [0, 0] };
  let floor = -MLL;
  let locked = false;
  let firstPayoutDay: number | null = null;
  for (let i = 0; i < seq.length; i++) {
    const pnl = pickPnl(cfg, st, seq[i], full, half);
    st.cum += pnl;
    st.peak = Math.max(st.peak, st.cum);
    if (st.cum < floor) return { outcome: "blow", at: i + 1, firstPayoutDay };
    if (firstPayoutDay === null && st.cum >= FUNDED_BUFFER) firstPayoutDay = i + 1;
    floor = Math.max(floor, st.cum - MLL);
    if (!locked && floor >= 100) { floor = 100; locked = true; }
    st.prev = [st.prev[1], pnl];
  }
  return { outcome: "ok", at: seq.length, firstPayoutDay };
}

function shuffle(seq: number[]): void {
  for (let i = seq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seq[i], seq[j]] = [seq[j], seq[i]];
  }
}

const qOf = (s: number[], p: number) => (s.length ? s[Math.floor((s.length - 1) * p)] : -1);

function monteCarlo(cfg: Config, full: number[], half: number[] | null, iters = MC_ITERS) {
  const seq = Array.from({ length: full.length }, (_, i) => i);
  const passDays: number[] = [];
  const payDays: number[] = [];
  let evalBlow = 0;
  let fundedBlow = 0;
  let fundedBlow90 = 0;
  for (let it = 0; it < iters; it++) {
    shuffle(seq);
    const e = evalSeq(cfg, seq, full, half);
    if (e.outcome === "pass") passDays.push(e.at);
    else if (e.outcome === "blow") evalBlow++;
    const f = fundedSeq(cfg, seq, full, half);
    if (f.outcome === "blow") {
      fundedBlow++;
      if (f.at <= BLOW_WINDOW) fundedBlow90++;
    } else if (f.firstPayoutDay !== null) payDays.push(f.firstPayoutDay);
  }
  const ps = [...passDays].sort((a, b) => a - b);
  const pays = [...payDays].sort((a, b) => a - b);
  return {
    passPct: (100 * ps.length) / iters,
    evalBlowPct: (100 * evalBlow) / iters,
    medDays: ps.length ? ps[Math.floor(ps.length / 2)] : -1,
    p25: qOf(ps, 0.25),
    p75: qOf(ps, 0.75),
    p90: qOf(ps, 0.9),
    cdf20: ps.length ? (100 * ps.filter((d) => d <= 20).length) / ps.length : 0,
    fundedBlowPct: (100 * fundedBlow) / iters,
    fundedBlow90Pct: (100 * fundedBlow90) / iters,
    payMed: pays.length ? pays[Math.floor(pays.length / 2)] : -1,
  };
}

/* ---------------- helpers ---------------- */

const longestRedStreak = (days: number[]): number => {
  let best = 0;
  let run = 0;
  for (const d of days) {
    if (d < 0) run++;
    else run = 0;
    if (run > best) best = run;
  }
  return best;
};

async function main() {
  const argv = process.argv;
  const pool: PoolMode = argv.includes("--pool") ? (argv[argv.indexOf("--pool") + 1] === "ap" ? "ap" : "all") : "all";
  const offline = argv.includes("--offline");
  const dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  console.log(`plan hardening sweep · pool=${pool} · ${dates.length} sessions`);
  const t0 = Date.now();

  /* ---- precompute per-date day P&L for every distinct (cap, targetR, stop, arm) ---- */
  const keyOf = (p: PlanParams) => `${p.riskCap}|${p.targetR}|${p.rthTargetR ?? ""}|${p.lossHalt}|${p.profitArm}`;
  const needed = new Map<string, PlanParams>();
  for (const c of CONFIGS) {
    needed.set(keyOf(c.params), c.params);
    if (c.half !== undefined) needed.set(keyOf({ ...c.params, riskCap: c.half }), { ...c.params, riskCap: c.half });
  }
  const series = new Map<string, Map<string, number>>();
  for (const k of needed.keys()) series.set(k, new Map());

  let loaded = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      loaded++;
      const signals: PoolSignal[] = detectPool(minutes as MomMinute[], pool);
      if (!signals.length) continue;
      for (const [k, params] of needed) {
        const run = runDay(FULL_PLAN, date, minutes as MomMinute[], signals, params);
        series.get(k)!.set(date, run.dayPnl);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded\n`);

  const span = (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86_400_000 + 1;
  const sessPerWeek = (dates.length / span) * 7;

  /* ---- per-config: chronological + MC (eval + funded) + streak anatomy ---- */
  type Row = {
    cfg: Config;
    mc: ReturnType<typeof monteCarlo>;
    chronoLine: string;
    worstDay: number;
    streakToBlow: number;
    longestRed: number;
  };
  const rows: Row[] = [];
  for (const cfg of CONFIGS) {
    const full = [...series.get(keyOf(cfg.params))!.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const fullVals = full.map(([, v]) => v);
    const half = cfg.half !== undefined
      ? [...series.get(keyOf({ ...cfg.params, riskCap: cfg.half }))!.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
      : null;

    const ordered = Array.from({ length: fullVals.length }, (_, idx) => idx);
    const chr = evalSeq(cfg, ordered, fullVals, half);
    const chronoLine =
      chr.outcome === "pass" ? `PASS day ${chr.at}`
      : chr.outcome === "blow" ? `BLOW day ${chr.at}`
      : "no pass";

    const worstDay = Math.min(...fullVals);
    const streakToBlow = Math.ceil(MLL / Math.max(1, Math.abs(worstDay)));
    const longestRed = longestRedStreak(fullVals);
    const mc = monteCarlo(cfg, fullVals, half);
    rows.push({ cfg, mc, chronoLine, worstDay, streakToBlow, longestRed });
  }

  /* ---- ranked table ---- */
  const sorted = [...rows].sort((a, b) => a.mc.fundedBlowPct - b.mc.fundedBlowPct || a.mc.evalBlowPct - b.mc.evalBlowPct || a.mc.medDays - b.mc.medDays);
  console.log(`goal: funded P(blow) ≈ 0 AND eval median ≤ ~22 trading days (≈ 1 calendar month at ${sessPerWeek.toFixed(1)} sessions/week)`);
  console.log(`config                | EVAL P(pass) P(blow) | med  p25  p75  p90 ≤20d | FUNDED P(blow) ≤90d | payout | worstDay streak2blow longestRed | chrono`);
  console.log(`----------------------+-----------------------+-------------------------+---------------------+--------+--------------------------------+-------`);
  for (const r of sorted) {
    const mc = r.mc;
    const hit = mc.fundedBlowPct <= 0.5 && mc.medDays <= 22 ? " ◀ MEETS GOAL" : "";
    console.log(
      `${r.cfg.label.padEnd(21)} | ${mc.passPct.toFixed(0).padStart(4)}% ${mc.evalBlowPct.toFixed(1).padStart(6)}% | ${String(mc.medDays).padStart(3)} ${String(mc.p25).padStart(3)} ${String(mc.p75).padStart(3)} ${String(mc.p90).padStart(3)} ${mc.cdf20.toFixed(0).padStart(4)}% | ${mc.fundedBlowPct.toFixed(1).padStart(5)}% ${mc.fundedBlow90Pct.toFixed(1).padStart(4)}% | ${String(mc.payMed).padStart(6)} | −$${String(Math.abs(Math.round(r.worstDay))).padStart(4)} ${String(r.streakToBlow).padStart(10)} ${String(r.longestRed).padStart(9)} | ${r.chronoLine}${hit}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
