/* ------------------------------------------------------------------ *
 * RTH DRIFT-AWARE OPTIMIZER (research input — uncommitted until
 * promoted). Re-runs the rthOptimizer grid with the DRIFT-FILL scorer
 * instead of the signal-price scorer: market fills at the dispatch
 * price (next-bar mid), absolute brackets, instant OCO beyond the
 * target, $1.90/RT fees, $100-budget sizing, eval account sim — plus
 * the resting-limit entry (fill-or-expire) and the stale-skip gate.
 *
 * The question: does ANY RTH stop/target/entry/gate configuration
 * survive fees under realistic fills?
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --import ../scripts/ts-loader.mjs ./scripts/rthDriftOptimizer.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { stopCrossedAtDispatch } from "../lib/crossTrade";

const CONCURRENCY = 8;
const HORIZON = 60;
const FEE_RT = 1.9;
const RISK_BUDGET = 100;
const K = 0.5;
const FEE_FLOOR = 1.5;
const TTL = 5;
/** crossed-stop dispatch treatments (2026-10-08 naked-position incident).
 *  A limit card whose OSO stop sits on the marketable side of the tape at
 *  dispatch gets its stop rejected by Tradovate (InvalidPrice) and the
 *  entry fills naked. Dispatch tape proxy = the next-bar mid (the study's
 *  own drift measurement bar). The safe treatments:
 *    none     — the old (dangerous) model: the crossed card scores as if
 *               its stop existed (an instant phantom win for shorts).
 *    gate     — the crossed card is skipped at dispatch (no trade).
 *    repair   — the live L2/L3 repair: the crossed card fills at the
 *               dispatch tape and is immediately re-armed with the
 *               emergency stop (1 pt beyond the fill); the target stays
 *               the original structural level.
 *    reanchor — the crossed card fills at the dispatch tape with the
 *               bracket rebuilt from the fill (structural distances).
 */
const XMODES = ["none", "gate", "repair", "reanchor"] as const;
type XMode = (typeof XMODES)[number];
const EMERGENCY_STOP_PTS = 1.0; // the re-arm stop pad (4 ticks)

const STOPS = [0.5, 0.75, 1.0, 1.5];
const TARGETS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0];
const ENTRIES = ["market", "limit"] as const;
const GATED = [false, true];

type Entry = (typeof ENTRIES)[number];
type Config = { s: number; t: number; entry: Entry; gate: boolean; x: XMode };

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

type Geo = { m: number; adv: number; fav: number; fill: number };
function geoOf(minutes: MomMinute[], sig: MomentumSignal): Geo | null {
  const nb = minutes[sig.entryIdx + 1];
  if (!nb) return null;
  const dir = sig.dir === "long" ? 1 : -1;
  const p = midOf(nb);
  const m = (p - sig.entry) * dir;
  return { m, adv: Math.max(0, -m), fav: Math.max(0, m), fill: sig.entry + m * dir };
}

function gateSkip(g: Geo, risk: number, targetDist: number): boolean {
  if (g.adv > K * risk) return true;
  if (g.fav > targetDist - FEE_FLOOR) return true;
  return false;
}

/** first-touch stop/target scan from a fill (dispatch minute excluded) */
function scoreFromFill(minutes: MomMinute[], sig: MomentumSignal, fill: number, startIdx: number, stop: number, target: number): number | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HORIZON);
  let exit = closeOf(minutes[end]);
  for (let j = Math.max(startIdx, sig.entryIdx + 1); j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return (exit - fill) * dir;
}

type Trade = { date: string; pnl: number; risk: number };

function scoreConfig(minutes: MomMinute[], sigs: MomentumSignal[], date: string, c: Config): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const risk = s.risk * c.s;
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * c.t;
    if (!(dir > 0 ? stop < s.entry && s.entry < target : target < s.entry && s.entry < stop)) continue;
    const g = geoOf(minutes, s);
    if (!g) continue;
    const targetDist = Math.abs(target - s.entry);
    if (c.gate && gateSkip(g, risk, targetDist)) continue;

    let pnl: number | null = null;
    let closeIdx = s.entryIdx + HORIZON;
    if (c.entry === "market") {
      if (g.fav > targetDist - 0.25) {
        pnl = -0.5; // fill beyond the absolute target → instant OCO
        closeIdx = s.entryIdx + HORIZON;
      } else {
        pnl = scoreFromFill(minutes, s, g.fill, s.entryIdx + 2, stop, target);
      }
    } else {
      // crossed-stop dispatch: the OSO stop is on the marketable side of
      // the dispatch tape → Tradovate rejects it and the entry fills naked
      const crossed = stopCrossedAtDispatch(s.dir, stop, g.fill) === true;
      if (crossed) {
        if (c.x === "gate") continue; // skipped at dispatch — no trade
        if (c.x === "repair") {
          // the live L2/L3 repair: fills at the dispatch tape, immediately
          // re-armed with the emergency stop 1 pt beyond the fill; the
          // target stays the original structural level
          const estop = s.dir === "long" ? g.fill - EMERGENCY_STOP_PTS : g.fill + EMERGENCY_STOP_PTS;
          pnl = scoreFromFill(minutes, s, g.fill, s.entryIdx + 2, estop, target);
        } else if (c.x === "reanchor") {
          // bracket rebuilt from the fill (structural distances)
          const estop = g.fill - dir * risk;
          const etarget = g.fill + dir * risk * c.t;
          pnl = scoreFromFill(minutes, s, g.fill, s.entryIdx + 2, estop, etarget);
        } else {
          // "none": the old model — score as if the rejected stop existed
          pnl = scoreFromFill(minutes, s, g.fill, s.entryIdx + 2, stop, target);
        }
      } else {
        // resting limit at the signal entry, fill-or-expire within TTL bars
        const endTtl = Math.min(minutes.length - 1, s.entryIdx + TTL);
        let fillBar = -1;
        let fill = 0;
        for (let j = s.entryIdx + 1; j <= endTtl; j++) {
          const b = minutes[j];
          const touched = dir > 0 ? b.low <= s.entry : b.high >= s.entry;
          if (!touched) continue;
          fillBar = j;
          const open = openOf(b);
          fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
          break;
        }
        if (fillBar >= 0) pnl = scoreFromFill(minutes, s, fill, fillBar + 1, stop, target);
        else continue; // expired — no trade, no window consumed
      }
    }
    if (pnl === null) continue;
    out.push({ date, pnl, risk });
    openUntil = Math.max(openUntil, closeIdx);
  }
  return out;
}

function usdSim(trades: Trade[]) {
  const rows = trades.map((t) => {
    const contracts = Math.max(1, Math.min(30, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnl, riskPts: t.risk, pnlUsd: t.pnl * contracts * 2 - contracts * FEE_RT };
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

async function main() {
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const combos: Config[] = [];
  for (const s of STOPS)
    for (const t of TARGETS)
      for (const entry of ENTRIES)
        for (const gate of GATED)
          for (const x of XMODES) {
            if (entry === "market" && x !== "none") continue; // x-treatments are limit-only
            combos.push({ s, t, entry, gate, x });
          }
  const perCombo: Trade[][] = combos.map(() => []);
  console.log(`replaying ${dates.length} sessions × ${combos.length} configs…`);

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs = detectSoftMomentum(minutes, SOFT_PROD);
      for (let c = 0; c < combos.length; c++) perCombo[c].push(...scoreConfig(minutes, sigs, date, combos[c]));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  type Row = { c: Config; n: number; wr: number; pf: number; netUsd: number; dd: number; passed: boolean };
  const rows: Row[] = [];
  for (let c = 0; c < combos.length; c++) {
    const ts = perCombo[c];
    if (!ts.length) continue;
    const wins = ts.filter((t) => t.pnl > 0);
    const losses = ts.filter((t) => t.pnl <= 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0);
    const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const sm = usdSim(ts);
    rows.push({
      c: combos[c],
      n: ts.length,
      wr: (wins.length / ts.length) * 100,
      pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
      netUsd: sm.netUsd,
      dd: sm.maxDD,
      passed: sm.passed,
    });
  }
  rows.sort((a, b) => b.netUsd - a.netUsd);

  console.log("=== LIMIT CONFIGS BY NET $ (drift-aware fills, $1.90/RT) — top 30 ===");
  for (const r of rows.filter((r) => r.c.entry === "limit").slice(0, 30)) {
    console.log(
      `s${r.c.s.toFixed(2).padStart(4)} t${r.c.t.toFixed(2).padStart(4)} x-${r.c.x.padEnd(8)} ${r.c.gate ? "gate" : "no-g"} | n=${String(r.n).padStart(5)} wr=${r.wr.toFixed(1).padStart(5)}% pf=${r.pf.toFixed(2).padStart(5)} | $${r.netUsd.toFixed(0).padStart(8)} dd $${r.dd.toFixed(0).padStart(7)} ${r.passed ? "PASS" : "BREACH"}`,
    );
  }

  const passing = rows.filter((r) => r.passed && r.netUsd > 0);
  console.log(`\npassing-and-positive configs: ${passing.length} / ${rows.length}`);
  for (const r of passing.slice(0, 12)) {
    console.log(`  s${r.c.s} t${r.c.t} ${r.c.entry} x-${r.c.x} ${r.c.gate ? "gate" : "no-g"} | $${r.netUsd.toFixed(0)} dd $${r.dd.toFixed(0)} wr ${r.wr.toFixed(1)}% pf ${r.pf.toFixed(2)}`);
  }

  console.log("\n=== LIVE RTH LIMIT CONFIG (s0.5 t2.5) × crossed-stop treatment ===");
  for (const x of XMODES) {
    const r = rows.find((rr) => rr.c.entry === "limit" && rr.c.s === 0.5 && rr.c.t === 2.5 && rr.c.x === x && !rr.c.gate);
    if (r) console.log(`  x-${x.padEnd(8)} | n=${String(r.n).padStart(5)} wr=${r.wr.toFixed(1).padStart(5)}% pf=${r.pf.toFixed(2).padStart(5)} | $${r.netUsd.toFixed(0).padStart(8)} dd $${r.dd.toFixed(0).padStart(7)} ${r.passed ? "PASS" : "BREACH"}`);
  }

  console.log("\n=== BEST PER ENTRY×GATE CATEGORY ===");
  for (const entry of ENTRIES) for (const gate of GATED) {
    const rs = rows.filter((r) => r.c.entry === entry && r.c.gate === gate);
    if (!rs.length) continue;
    const b = rs[0];
    console.log(
      `${entry.padEnd(6)} ${gate ? "gate" : "no-g"} best: s${b.c.s} t${b.c.t} x-${b.c.x} | n=${b.n} wr=${b.wr.toFixed(1)}% pf=${b.pf.toFixed(2)} | $${b.netUsd.toFixed(0)} dd $${b.dd.toFixed(0)} ${b.passed ? "PASS" : "BREACH"}`,
    );
  }

  console.log("\n=== CURRENT LIVE CONFIG (s1.0 t0.75 market no-gate) for reference ===");
  const live = rows.find((r) => r.c.s === 1.0 && r.c.t === 0.75 && r.c.entry === "market" && !r.c.gate);
  if (live) console.log(`  n=${live.n} wr=${live.wr.toFixed(1)}% pf=${live.pf.toFixed(2)} | $${live.netUsd.toFixed(0)} dd $${live.dd.toFixed(0)} ${live.passed ? "PASS" : "BREACH"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
