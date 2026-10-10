/* ------------------------------------------------------------------ *
 * RTH stale-dispatch gate study v2 (research input — uncommitted until
 * promoted with a docs note; not a named validation by itself).
 *
 * Owner rule: safety over participation — if the tape has moved away
 * from the signal by dispatch time, skip rather than risk a scratch or
 * a mis-anchored full stop.
 *
 * Gate (what the live tape ltp sees at card-fire time):
 *   skip when  adverseMove > k × risk            (chased adverse move)
 *         or   favorableMove > targetDist − FEE_FLOOR
 *               (fill would land within the fee floor of / beyond the
 *                absolute take-profit → scratch or guaranteed net loss)
 *
 * Dispatch geometry (archive is 1-minute; the live gate uses the real
 * tape ltp, strictly better than any model here):
 *   open  — next bar's true open (dispatch ≈ bar close)
 *   mid   — next bar mid (dispatch ≈ +30s)
 *   worst — next bar's adverse extreme (dispatch ≈ +60s, pessimistic);
 *           gate also reads the favorable extreme
 *
 * Cells:
 *   A. structural — rthOptimizer first-touch scorer from the SIGNAL
 *      entry. Shows what skipping does to the signal-level edge.
 *   B. drift-fill — market fill at the modeled dispatch price, brackets
 *      at the SIGNAL's absolute levels (live CROSSTRADE_REST=1), instant
 *      OCO when the fill lands beyond the target, fees $1.90/RT contract
 *      (measured live 2026-10-06), $100-budget sizing, eval account sim.
 *
 * Baseline = no gate (k=∞, no beyond-TP skip) under the SAME drift-fill
 * model — the "live as-is" reference. Gate rows are compared to it.
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --import ../scripts/ts-loader.mjs ./scripts/rthStaleGateStudy.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
// consolidated engine: standard T1/T2/T4 + verdict (the local cells are
// gate + drift-fill replays with fees OUTSIDE the pnl, so they are NOT the
// engine scorer; they stay untouched).
import { coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const HORIZON = 60; // bars — rthOptimizer base convention
const TARGET_MULT = 0.75; // native RTH target
const COST_PTS = 0.5; // cell-A convention (rthOptimizer base)
const FEE_RT = 1.9; // $ per contract round trip — measured live 2026-10-06
const RISK_BUDGET = 100; // $100 day-plan budget
const FEE_FLOOR = 1.5; // pts: skip when the fill would leave < this much to the target
const KS = [0.25, 0.33, 0.5, 0.75, 1.0];

type MoveModel = "open" | "mid" | "worst";

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

/** dispatch geometry for one signal under one model */
type Geo = { m: number; adv: number; fav: number; fill: number };
function geoOf(minutes: MomMinute[], sig: MomentumSignal, model: MoveModel): Geo | null {
  const nb = minutes[sig.entryIdx + 1];
  if (!nb) return null;
  const dir = sig.dir === "long" ? 1 : -1;
  if (model === "open" || model === "mid") {
    const p = model === "open" ? openOf(nb) : midOf(nb);
    const m = (p - sig.entry) * dir;
    return { m, adv: Math.max(0, -m), fav: Math.max(0, m), fill: sig.entry + m * dir };
  }
  const favPx = dir > 0 ? nb.high : nb.low;
  const advPx = dir > 0 ? nb.low : nb.high;
  const fav = (favPx - sig.entry) * dir;
  const adv = (advPx - sig.entry) * -dir;
  return { m: fav, adv, fav, fill: sig.entry - dir * adv };
}

/** gate predicate: k finite = adverse skip on; tpGate = beyond/near-TP skip on */
function gateSkips(g: Geo, risk: number, targetDist: number, k: number, tpGate: boolean, feeFloor = FEE_FLOOR): boolean {
  if (Number.isFinite(k) && g.adv > k * risk) return true;
  if (tpGate && g.fav > targetDist - feeFloor) return true;
  return false;
}

type Trade = {
  date: string;
  idx: number;
  pnlPts: number;
  risk: number;
  kind: "kept" | "skipped";
  why?: "adverse" | "beyond-tp" | "expired";
  scratch?: boolean;
};

function stats(ts: Trade[]) {
  const kept = ts.filter((t) => t.kind === "kept");
  const skipped = ts.filter((t) => t.kind === "skipped");
  // kept-set WR/PF/net fed from the engine's canonical T1 stats — identical
  // formulas (wins = pnlPts > 0 over kept, pf = grossWin/grossLoss, net =
  // ΣpnlPts over kept). The skip ledger stays hand-rolled (engine has no
  // hypothetical-forfeit concept).
  const cs = coreStats(kept.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.risk })));
  const sw = skipped.filter((t) => t.pnlPts > 0);
  const sl = skipped.filter((t) => t.pnlPts <= 0);
  return {
    n: cs.n,
    skipN: skipped.length,
    wr: cs.wr,
    pf: cs.pf,
    net: cs.netPts,
    skipNet: skipped.reduce((a, t) => a + t.pnlPts, 0),
    skipWins: sw.length,
    skipLosses: sl.length,
    scratches: kept.filter((t) => t.scratch).length,
    fullStops: kept.filter((t) => t.pnlPts < 0 && !t.scratch).length,
  };
}

function simCellB(ts: Trade[]) {
  const kept = ts.filter((t) => t.kind === "kept");
  const rows = kept.map((t) => {
    const contracts = Math.max(1, Math.min(30, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnlPts, riskPts: t.risk, pnlUsd: t.pnlPts * contracts * 2 - contracts * FEE_RT };
  });
  const d = dollarize(rows.map((r) => ({ date: r.date, pnlPts: r.pnlPts, riskPts: r.riskPts })));
  const acc = simulateAccount(d, "eval");
  const netUsd = rows.reduce((a, r) => a + r.pnlUsd, 0);
  let peak = 0;
  let maxDD = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  return { netUsd, maxDD, passed: acc.breachDay === null, line: accountLine(acc) };
}

/** structural score from the signal entry (rthOptimizer convention) */
function structuralExit(minutes: MomMinute[], s: MomentumSignal, startIdx: number): number {
  const dir = s.dir === "long" ? 1 : -1;
  const target = s.entry + dir * s.risk * TARGET_MULT;
  const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
  let exit = closeOf(minutes[end]);
  for (let j = startIdx; j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= s.stop : b.high >= s.stop) {
      exit = s.stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return exit;
}

/** cell A: gate on the structural edge */
function cellA(minutes: MomMinute[], sigs: MomentumSignal[], date: string, k: number, model: MoveModel, tpGate: boolean): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const g = geoOf(minutes, s, model);
    if (!g) continue;
    const targetDist = Math.abs(s.target - s.entry);
    const skipped = gateSkips(g, s.risk, targetDist, k, tpGate);
    if (skipped) {
      out.push({
        date,
        idx: s.entryIdx,
        pnlPts: (structuralExit(minutes, s, s.entryIdx + 1) - s.entry) * (s.dir === "long" ? 1 : -1) - COST_PTS,
        risk: s.risk,
        kind: "skipped",
        why: Number.isFinite(k) && g.adv > k * s.risk ? "adverse" : "beyond-tp",
      });
      continue;
    }
    out.push({
      date,
      idx: s.entryIdx,
      pnlPts: (structuralExit(minutes, s, s.entryIdx + 1) - s.entry) * (s.dir === "long" ? 1 : -1) - COST_PTS,
      risk: s.risk,
      kind: "kept",
    });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

/** cell B: drift-fill mechanics — fill at the modeled dispatch price, absolute brackets */
function cellB(minutes: MomMinute[], sigs: MomentumSignal[], date: string, k: number, model: MoveModel, tpGate: boolean, feeFloor = FEE_FLOOR): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const g = geoOf(minutes, s, model);
    if (!g) continue;
    const targetDist = Math.abs(s.target - s.entry);
    const skipped = gateSkips(g, s.risk, targetDist, k, tpGate, feeFloor);
    if (skipped) {
      // hypothetical: what the drifted fill would have produced
      if (g.fav > targetDist - 0.25) {
        out.push({ date, idx: s.entryIdx, pnlPts: -0.5, risk: s.risk, kind: "skipped", why: "beyond-tp", scratch: true });
      } else {
        out.push({
          date,
          idx: s.entryIdx,
          pnlPts: (structuralExitFrom(minutes, s, g.fill, s.entryIdx + 2) - g.fill) * dir,
          risk: s.risk,
          kind: "skipped",
          why: Number.isFinite(k) && g.adv > k * s.risk ? "adverse" : "beyond-tp",
        });
      }
      continue;
    }
    if (g.fav > targetDist - 0.25) {
      // fill beyond the absolute target → instant OCO close, 0.5pt cross
      out.push({ date, idx: s.entryIdx, pnlPts: -0.5, risk: s.risk, kind: "kept", scratch: true });
      openUntil = Math.max(openUntil, s.entryIdx + HORIZON); // the card is consumed — no re-entry in the window
      continue;
    }
    out.push({ date, idx: s.entryIdx, pnlPts: (structuralExitFrom(minutes, s, g.fill, s.entryIdx + 2) - g.fill) * dir, risk: s.risk, kind: "kept" });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

/** bracket scan from a fill price using the SIGNAL's absolute stop/target */
function structuralExitFrom(minutes: MomMinute[], s: MomentumSignal, fill: number, startIdx: number): number {
  const dir = s.dir === "long" ? 1 : -1;
  const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
  let exit = closeOf(minutes[end]);
  for (let j = Math.max(startIdx, s.entryIdx + 1); j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= s.stop : b.high >= s.stop) {
      exit = s.stop;
      break;
    }
    if (dir > 0 ? b.high >= s.target : b.low <= s.target) {
      exit = s.target;
      break;
    }
  }
  return exit;
}

/** cell C: gate + RESTING LIMIT at the signal entry (fill-or-expire — the
 *  momentum retrace pattern). The limit can only fill AT the signal price
 *  or better, so the absolute brackets are correct relative to the fill.
 *  No touch within TTL bars = expired (skipped, zero P&L). */
function cellC(minutes: MomMinute[], sigs: MomentumSignal[], date: string, k: number, tpGate: boolean, ttlBars: number): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const g = geoOf(minutes, s, "mid");
    if (!g) continue;
    const targetDist = Math.abs(s.target - s.entry);
    if (gateSkips(g, s.risk, targetDist, k, tpGate)) {
      out.push({ date, idx: s.entryIdx, pnlPts: 0, risk: s.risk, kind: "skipped", why: Number.isFinite(k) && g.adv > k * s.risk ? "adverse" : "beyond-tp" });
      continue;
    }
    // resting limit at the signal entry: first touch fills (gap-through at
    // the bar open), expiry skips
    const start = s.entryIdx + 1;
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + ttlBars);
    let fillBar = -1;
    let fill = 0;
    for (let j = start; j <= endTtl; j++) {
      const b = minutes[j];
      const touched = dir > 0 ? b.low <= s.entry : b.high >= s.entry;
      if (!touched) continue;
      fillBar = j;
      const open = openOf(b);
      fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
      break;
    }
    if (fillBar < 0) {
      out.push({ date, idx: s.entryIdx, pnlPts: 0, risk: s.risk, kind: "skipped", why: "expired" }); // limit never touched — no P&L
      continue;
    }
    const exit = structuralExitFrom(minutes, s, fill, fillBar + 1);
    out.push({ date, idx: s.entryIdx, pnlPts: (exit - fill) * dir, risk: s.risk, kind: "kept" });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

/* ---- today's live calibration (2026-10-06 RTH fills, real broker data) ---- */
const TODAY = [
  { et: "10:30", entry: 31512.5, stop: 31526.0, target: 31502.38, risk: 13.5, dir: -1 as const, fill: 31493.25, actualNet: -8.7 },
  { et: "11:30", entry: 31592.25, stop: 31600.5, target: 31586.06, risk: 8.25, dir: -1 as const, fill: 31581.75, actualNet: -14.4 },
  { et: "15:35", entry: 31515.0, stop: 31519.0, target: 31512.0, risk: 4.0, dir: -1 as const, fill: 31512.75, actualNet: -4.8 },
];

function calibration() {
  console.log("=== TODAY CALIBRATION (2026-10-06 live RTH fills) ===");
  console.log(`gate = skip when adverse move > k×risk OR favorable move > targetDist − ${FEE_FLOOR}pt fee floor`);
  for (const t of TODAY) {
    const m = (t.fill - t.entry) * t.dir;
    const tDist = Math.abs(t.target - t.entry);
    const verdicts = KS.map((k) => (gateSkips({ m, adv: Math.max(0, -m), fav: Math.max(0, m), fill: t.fill }, t.risk, tDist, k, true) ? `k${k}:SKIP` : `k${k}:take`));
    console.log(`${t.et} risk ${t.risk} move ${m >= 0 ? "+" : ""}${m.toFixed(2)} → [${verdicts.join(" ")}] · actual net $${t.actualNet}`);
  }
  console.log("");
}

async function main() {
  calibration();
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  console.log(`replaying ${dates.length} sessions…`);

  type Cell = { A: Trade[]; B: Trade[] };
  const baseline: Cell = { A: [], B: [] };
  const perK: Record<string, Cell> = {};
  for (const k of KS) perK[String(k)] = { A: [], B: [] };
  const perModel: Record<string, Cell> = {};
  for (const model of ["open", "mid", "worst"] as MoveModel[]) perModel[model] = { A: [], B: [] };
  const perFloor: Record<string, Cell> = {};
  for (const f of [1.0, 2.0]) perFloor[`floor${f}`] = { A: [], B: [] };
  const cBaseline: Trade[] = [];
  const cK: Record<string, Trade[]> = {};
  for (const k of [0.5, 1.0]) cK[String(k)] = [];
  const cTtl3: Trade[] = [];

  // single pass: load + score inline (bounded memory — the session cache on
  // disk makes reloads cheap, so every config scores during the one pass)
  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs = detectSoftMomentum(minutes, SOFT_PROD);
      baseline.A.push(...cellA(minutes, sigs, date, Infinity, "mid", false));
      baseline.B.push(...cellB(minutes, sigs, date, Infinity, "mid", false));
      for (const k of KS) {
        perK[String(k)].A.push(...cellA(minutes, sigs, date, k, "mid", true));
        perK[String(k)].B.push(...cellB(minutes, sigs, date, k, "mid", true));
      }
      for (const model of ["open", "mid", "worst"] as MoveModel[]) {
        perModel[model].A.push(...cellA(minutes, sigs, date, 0.5, model, true));
        perModel[model].B.push(...cellB(minutes, sigs, date, 0.5, model, true));
      }
      for (const f of [1.0, 2.0]) {
        perFloor[`floor${f}`].B.push(...cellB(minutes, sigs, date, 0.5, "mid", true, f));
      }
      cBaseline.push(...cellC(minutes, sigs, date, Infinity, false, 5));
      for (const k of [0.5, 1.0]) cK[String(k)].push(...cellC(minutes, sigs, date, k, true, 5));
      cTtl3.push(...cellC(minutes, sigs, date, 0.5, true, 3));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${dates.length} sessions\n`);

  const fmt = (label: string, cell: Cell, cellId: "A" | "B") => {
    const st = stats(cell[cellId]);
    const usd = cellId === "B" ? simCellB(cell[cellId]) : null;
    const skipWr = st.skipN ? ((st.skipWins / st.skipN) * 100).toFixed(0) : "—";
    const usdStr = usd ? ` | $${usd.netUsd.toFixed(0).padStart(8)} dd $${usd.maxDD.toFixed(0).padStart(7)} ${usd.passed ? "PASS" : "BREACH"}` : "";
    return (
      `${label.padEnd(9)} | kept ${st.n.toString().padStart(5)} wr ${st.wr.toFixed(1).padStart(5)}% pf ${st.pf.toFixed(2).padStart(5)} net ${st.net.toFixed(0).padStart(7)}pts` +
      ` | skip ${st.skipN.toString().padStart(5)} (forfeit ${st.skipNet.toFixed(0).padStart(6)}pts · ${skipWr}% WR · W${st.skipWins}/L${st.skipLosses})` +
      (cellId === "B" ? ` | scratch ${st.scratches} · stopouts ${st.fullStops}` : "") +
      usdStr
    );
  };

  console.log("=== CELL A — gate on the structural edge (score from signal entry, mid model) ===");
  console.log(fmt("no-gate", baseline, "A"));
  for (const k of KS) console.log(fmt(`k=${k}`, perK[String(k)], "A"));

  console.log("\n=== CELL B — drift-aware fills (fill at dispatch price, absolute brackets, $1.90/RT) ===");
  console.log(fmt("no-gate", baseline, "B"));
  for (const k of KS) console.log(fmt(`k=${k}`, perK[String(k)], "B"));

  console.log("\n=== SENSITIVITY k=0.5 — dispatch-price model (open=optimistic · mid=expected · worst=pessimistic) ===");
  for (const model of ["open", "mid", "worst"] as MoveModel[]) {
    const stA = stats(perModel[model].A);
    const stB = stats(perModel[model].B);
    const usd = simCellB(perModel[model].B);
    console.log(
      `-- ${model.padEnd(5)} -- A: kept ${stA.n} wr ${stA.wr.toFixed(1)}% net ${stA.net.toFixed(0)}pts | skip ${stA.skipN} forfeit ${stA.skipNet.toFixed(0)}pts · ` +
        `B: kept ${stB.n} wr ${stB.wr.toFixed(1)}% net ${stB.net.toFixed(0)}pts | skip ${stB.skipN} forfeit ${stB.skipNet.toFixed(0)}pts | scratch ${stB.scratches} stopouts ${stB.fullStops} | $${usd.netUsd.toFixed(0)} dd $${usd.maxDD.toFixed(0)} ${usd.passed ? "PASS" : "BREACH"}`,
    );
  }

  console.log("\n=== SKIPPED-SET COMPOSITION @k=0.5 (mid model, cell B) ===");
  const skippedB = perK["0.5"].B.filter((t) => t.kind === "skipped");
  const sw = skippedB.filter((t) => t.pnlPts > 0);
  const sl = skippedB.filter((t) => t.pnlPts <= 0);
  console.log(`skipped ${skippedB.length}: winners ${sw.length} (+${sw.reduce((a, t) => a + t.pnlPts, 0).toFixed(0)}pts) · losers ${sl.length} (${sl.reduce((a, t) => a + t.pnlPts, 0).toFixed(0)}pts) · net forfeited ${skippedB.reduce((a, t) => a + t.pnlPts, 0).toFixed(0)}pts`);
  const adv = skippedB.filter((t) => t.why === "adverse");
  const btp = skippedB.filter((t) => t.why === "beyond-tp");
  console.log(`reason split: adverse-move ${adv.length} · beyond-target ${btp.length}`);

  console.log("\n=== FEE-FLOOR SWEEP @k=0.5 (mid model, cell B) — near-TP skip threshold ===");
  for (const f of [1.0, 1.5, 2.0]) {
    const cell = f === 1.5 ? perK["0.5"] : perFloor[`floor${f}`];
    const stB = stats(cell.B);
    const usd = simCellB(cell.B);
    console.log(
      `floor ${f.toFixed(1)}pt | kept ${stB.n} wr ${stB.wr.toFixed(1)}% pf ${stB.pf.toFixed(2)} net ${stB.net.toFixed(0)}pts | skip ${stB.skipN} forfeit ${stB.skipNet.toFixed(0)}pts | scratch ${stB.scratches} stopouts ${stB.fullStops} | $${usd.netUsd.toFixed(0)} dd $${usd.maxDD.toFixed(0)} ${usd.passed ? "PASS" : "BREACH"}`,
    );
  }

  console.log("\n=== CELL C — gate + RESTING LIMIT at the signal entry (fill-or-expire; the momentum pattern) ===");
  for (const label of ["no-gate", "k=0.5", "k=1.0"]) {
    const ts = label === "no-gate" ? cBaseline : cK[String(parseFloat(label.slice(2)))];
    const st = stats(ts);
    const usd = simCellB(ts);
    const expired = ts.filter((t) => t.why === "expired").length;
    const gateSkip = st.skipN - expired;
    console.log(
      `${label.padEnd(8)} | kept ${st.n} wr ${st.wr.toFixed(1)}% pf ${st.pf.toFixed(2)} net ${st.net.toFixed(0)}pts` +
        ` | gate-skip ${gateSkip} · expired ${expired} | scratch ${st.scratches} stopouts ${st.fullStops} | $${usd.netUsd.toFixed(0)} dd $${usd.maxDD.toFixed(0)} ${usd.passed ? "PASS" : "BREACH"}`,
    );
  }
  const st3 = stats(cTtl3);
  const usd3 = simCellB(cTtl3);
  const exp3 = cTtl3.filter((t) => t.why === "expired").length;
  console.log(
    `TTL 3    @k=0.5: kept ${st3.n} wr ${st3.wr.toFixed(1)}% pf ${st3.pf.toFixed(2)} net ${st3.net.toFixed(0)}pts` +
      ` | gate-skip ${st3.skipN - exp3} · expired ${exp3} | scratch ${st3.scratches} stopouts ${st3.fullStops} | $${usd3.netUsd.toFixed(0)} dd $${usd3.maxDD.toFixed(0)} ${usd3.passed ? "PASS" : "BREACH"}`,
  );

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * Primary cohort = the no-gate baseline (live as-is) cell-B kept trades.
   * Cell-B pnl is gross of fees (the $1.90/RT ladder lives in simCellB),
   * so the engine block reads the same unit as the legacy tables. No
   * train/test split here → T1 prints the "all" row only; T2 compares the
   * gate k-sweep per cell against the no-gate baseline; T4 + verdict. ---- */
  const engineTrades: EngineTrade[] = baseline.B.filter((t) => t.kind === "kept").map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.risk }));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "baseline no-gate cell B kept (all)", stats: coreStats(engineTrades) }]));
  const cellRow = (cellId: "A" | "B", label: string, cell: Cell) => {
    const kept = cell[cellId].filter((t) => t.kind === "kept").map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.risk }));
    const cs = coreStats(kept);
    const baseKept = baseline[cellId].filter((t) => t.kind === "kept").map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.risk }));
    const baseCs = coreStats(baseKept);
    return {
      rule: `${cellId} ${label}`,
      n: cs.n,
      wr: cs.wr,
      ci: wilson95(cs.wins, cs.n),
      pf: cs.pf,
      expPts: cs.expPts,
      compare: `${cellId} no-gate wr ${baseCs.wr.toFixed(0)}% · net ${baseCs.netPts.toFixed(0)}pts`,
    };
  };
  console.log("\n" + renderT2([
    cellRow("A", "no-gate", baseline),
    ...KS.map((k) => cellRow("A", `k=${k}`, perK[String(k)])),
    cellRow("B", "no-gate", baseline),
    ...KS.map((k) => cellRow("B", `k=${k}`, perK[String(k)])),
  ]));
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  const allCs = coreStats(engineTrades);
  console.log(
    "\n" +
      renderVerdict({
        edge: allCs.netPts > 0 && allCs.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: "—",
        holdout: "n/a (validation pipeline)",
        viability:
          viability.pPass === null
            ? "n/a"
            : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
