/* ------------------------------------------------------------------ *
 * WINNER/LOSER ATLAS (SCRATCH — NOT COMMITTED)
 *
 * Replays the three production families over the full archive with the
 * live plan shapes (first-touch, 60-bar time exit, 0.5 pt cost, one
 * position at a time) and splits every trade by the session-context
 * features the journal questions care about:
 *
 *   Q1  session cumulative delta vs trade direction — should an
 *       against-delta trade be gated? (agree/against cells, magnitude
 *       bands, veto effect, train/test)
 *   Q2  target at/beyond the session extreme AT ENTRY — a long whose
 *       target needs a NEW session high to win ("session all-time
 *       high / not defined high"). Management variants compared on
 *       that cell: fixed target, target capped at the extreme,
 *       0.5R / 0.75R early bank, breakeven-at-1R runner, half-run.
 *   Q3  winner vs loser feature atlas + loss anatomy + streaks.
 *
 *   node --import ../scripts/ts-loader.mjs scripts/winnerLoserAtlas.ts \
 *     [--offline] [--max N] [--csv path]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { scoreRunner } from "../lib/runner";
import { hourBucketOf } from "../lib/tradeStats";
import {
  scoreTrade,
  coreStats,
  wilson95,
  propViability,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  type EngineTrade,
} from "../lib/backtestEngine";

const COST = 0.5;
const HOLD_BARS = 60;
const SPLIT = "2026-01-01";
const TOL = 0.25; // pts — "beyond the extreme" tolerance

type Dir = 1 | -1;

type Row = {
  key: string;
  family: string;
  date: string;
  entryIdx: number;
  time: string;
  dow: number; // 0=Sun .. 6=Sat (UTC date of the bar)
  dir: Dir;
  hourET: number;
  mm: number;
  bucket: string;
  entry: number;
  stop: number;
  target: number;
  risk: number;
  cumDelta: number; // session cumulative buy−sell up to AND incl. the entry bar
  agrees: boolean; // direction agrees with the session cum-delta sign
  sessHigh: number; // session high at entry (incl. entry bar)
  sessLow: number; // session low at entry
  rangePos: number; // entry position in the session range (0..1)
  tgtBeyondExt: boolean; // target prints a NEW session extreme by > TOL
  tgtAtExt: boolean; // target at/beyond the extreme (within any distance)
  tgtNearExt: boolean; // |target − extreme| ≤ 0.5
  entryBeyondExt: boolean; // entry itself already beyond the prior extreme
  distToExt: number; // pts from entry to the far extreme (long: sessHigh−entry)
  progressPts: number;
  failDepth: number;
  deltaFromFlush: number;
  atr14: number;
  breakRangeR: number;
  breakFrac: number;
  // baseline outcome (live plan: detector target, 60-bar time exit)
  pnl: number;
  hit: "target" | "stop" | "time";
  held: number;
  maeR: number;
  mfeR: number;
  touched05: boolean; // reached +0.5R on a bar before the exit bar
  touched1: boolean; // reached +1.0R on a bar before the exit bar
  stopRun: boolean; // stop-out where price returned beyond entry within 10 bars
  tradeNo: number; // n-th trade of this family on this calendar day
  firstOfDay: boolean;
  priorWin: boolean | null;
  streak: number; // same-outcome streak incl. current (1-based)
};

/* ---- session prefixes (lookahead-free, incl. the entry bar) ---------- */

function prefixes(minutes: MomMinute[]) {
  const n = minutes.length;
  const cumD: number[] = new Array(n);
  const hi: number[] = new Array(n);
  const lo: number[] = new Array(n);
  let cd = 0;
  let h = -Infinity;
  let l = Infinity;
  for (let i = 0; i < n; i++) {
    const m = minutes[i];
    cd += m.buy - m.sell;
    h = Math.max(h, m.high);
    l = Math.min(l, m.low);
    cumD[i] = cd;
    hi[i] = h;
    lo[i] = l;
  }
  return { cumD, hi, lo };
}

/* ---- baseline replay (live plan, fixed target) ------------------------ */

function replayBase(
  minutes: MomMinute[],
  sigs: MomentumSignal[],
  family: string,
  pre: { cumD: number[]; hi: number[]; lo: number[] },
): Row[] {
  const out: Row[] = [];
  let openUntil = -1;
  const tradeNo: Record<string, number> = {};
  const prior: Record<string, boolean> = {};
  const streakRun: Record<string, number> = {};
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const dir: Dir = s.dir === "long" ? 1 : -1;
    const entry = s.entry;
    const stop = s.stop;
    const target = s.target;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const idx = s.entryIdx;
    const sessHigh = pre.hi[idx];
    const sessLow = pre.lo[idx];
    const cumDelta = pre.cumD[idx];
    const end = Math.min(minutes.length - 1, idx + HOLD_BARS);
    const sc = scoreTrade(minutes, { dir, entry, stop, target, entryIdx: idx, risk });
    if (!sc) continue; // risk>0 / valid bracket / forward bars (drop)
    const hit = sc.hit;
    // legacy held: time exits always report the full window, not the
    // actual bars to the session end — preserved exactly
    const held = hit === "time" ? HOLD_BARS : sc.heldBars;
    const pnl = sc.pnl;

    // path features over bars strictly BEFORE the exit bar (pessimistic)
    let maeR = 0;
    let mfeR = 0;
    let touched05 = false;
    let touched1 = false;
    const exitBar = hit === "time" ? end : idx + held;
    const start = idx + 1;
    for (let j = start; j < exitBar; j++) {
      const b = minutes[j];
      const fav = (dir > 0 ? b.high - entry : entry - b.low) / risk;
      const adv = (dir > 0 ? entry - b.low : b.high - entry) / risk;
      mfeR = Math.max(mfeR, fav);
      maeR = Math.max(maeR, adv);
      if (fav >= 0.5) touched05 = true;
      if (fav >= 1) touched1 = true;
    }
    if (hit === "target") {
      mfeR = Math.max(mfeR, (target - entry) * dir / risk);
      touched05 = true;
      touched1 = touched1 || (target - entry) * dir / risk >= 1 - 1e-9;
    }

    let stopRun = false;
    if (hit === "stop") {
      for (let j = exitBar + 1; j <= Math.min(minutes.length - 1, exitBar + 10); j++) {
        if (dir > 0 ? minutes[j].high >= entry : minutes[j].low <= entry) {
          stopRun = true;
          break;
        }
      }
    }

    const day = s.d;
    tradeNo[day] = (tradeNo[day] ?? 0) + 1;
    const won = pnl > 0;
    const pw = prior[day] ?? null;
    prior[day] = won;
    streakRun[day] = streakRun[day] === undefined || (pw !== null && won === pw) ? (streakRun[day] ?? 0) + 1 : 1;

    const range = Math.max(0.25, sessHigh - sessLow);
    const isLong = dir === 1;
    const extTarget = isLong ? target : -target;
    const ext = isLong ? sessHigh : -sessLow;
    const extEntry = isLong ? entry : -entry;

    out.push({
      key: `${family}|${s.d}|${idx}`,
      family,
      date: s.d,
      entryIdx: idx,
      time: s.t,
      dow: new Date(`${s.d}T12:00:00Z`).getUTCDay(),
      dir,
      hourET: s.hourET,
      mm: Number(s.t.slice(3, 5)),
      bucket: hourBucketOf(`${String(s.hourET).padStart(2, "0")}:${s.t.slice(3, 5)}`),
      entry,
      stop,
      target,
      risk,
      cumDelta,
      agrees: dir > 0 ? cumDelta > 0 : cumDelta < 0,
      sessHigh,
      sessLow,
      rangePos: isLong ? (entry - sessLow) / range : (sessHigh - entry) / range,
      tgtBeyondExt: extTarget > ext + TOL,
      tgtAtExt: extTarget >= ext - TOL,
      tgtNearExt: Math.abs(target - (isLong ? sessHigh : sessLow)) <= 0.5,
      entryBeyondExt: extEntry > ext + TOL,
      distToExt: (isLong ? sessHigh - entry : entry - sessLow),
      progressPts: s.progressPts,
      failDepth: s.failDepth,
      deltaFromFlush: s.deltaFromFlush,
      atr14: s.atr14,
      breakRangeR: s.breakRangeR,
      breakFrac: s.breakFrac,
      pnl,
      hit,
      held,
      maeR,
      mfeR,
      touched05,
      touched1,
      stopRun,
      tradeNo: tradeNo[day],
      firstOfDay: tradeNo[day] === 1,
      priorWin: pw,
      streak: streakRun[day],
    });
    openUntil = idx + HOLD_BARS;
  }
  return out;
}

/* ---- variant replays (same signal set, alternate management) ---------- */

type VR = { pnl: number; hit: string; held: number; exitR: number };

function replayVariant(minutes: MomMinute[], sigs: MomentumSignal[], pre: { cumD: number[]; hi: number[]; lo: number[] }, kind: "cap" | "t05" | "t075" | "run" | "halfrun"): Map<string, VR> {
  const out = new Map<string, VR>();
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    const dir: Dir = s.dir === "long" ? 1 : -1;
    const entry = s.entry;
    const stop = s.stop;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) continue;
    const idx = s.entryIdx;
    const key = `${s.d}|${idx}`;

    if (kind === "run" || kind === "halfrun") {
      const r = scoreRunner(minutes, entry, stop, dir, idx, { maxBars: HOLD_BARS, cost: COST });
      if (r) {
        if (kind === "run") {
          out.set(key, { pnl: r.pnl, hit: r.hit, held: r.heldBars, exitR: r.exitR });
        } else {
          // half at the fixed target, half on the runner
          let exit = s.target;
          let hit = "target";
          let held = HOLD_BARS;
          for (let j = idx + 1; j <= Math.min(minutes.length - 1, idx + HOLD_BARS); j++) {
            const b = minutes[j];
            if (dir > 0 ? b.low <= stop : b.high >= stop) {
              exit = stop;
              hit = "stop";
              held = j - idx;
              break;
            }
            if (dir > 0 ? b.high >= s.target : b.low <= s.target) {
              exit = s.target;
              hit = "target";
              held = j - idx;
              break;
            }
          }
          if (hit !== "stop" && hit !== "target") {
            exit = closeOf(minutes[Math.min(minutes.length - 1, idx + HOLD_BARS)]);
            hit = "time";
          }
          const fixedPnl = (exit - entry) * dir - COST;
          out.set(key, {
            pnl: 0.5 * fixedPnl + 0.5 * r.pnl,
            hit: "mixed",
            held: Math.max(held, r.heldBars),
            exitR: (exit - entry) * dir / risk,
          });
        }
      }
      openUntil = idx + HOLD_BARS;
      continue;
    }

    let target = s.target;
    if (kind === "t05") target = entry + dir * risk * 0.5;
    else if (kind === "t075") target = entry + dir * risk * 0.75;
    else if (kind === "cap") {
      const sessHi = pre.hi[idx];
      const sessLo = pre.lo[idx];
      if (dir > 0) target = Math.min(target, sessHi);
      else target = Math.max(target, sessLo);
    }
    if (kind === "cap" && !((dir > 0 && target > entry) || (dir < 0 && target < entry))) {
      out.set(key, { pnl: 0, hit: "cap-zero", held: 0, exitR: 0 });
      openUntil = idx + HOLD_BARS;
      continue;
    }
    let exit = closeOf(minutes[Math.min(minutes.length - 1, idx + HOLD_BARS)]);
    let hit = "time";
    let held = HOLD_BARS;
    for (let j = idx + 1; j <= Math.min(minutes.length - 1, idx + HOLD_BARS); j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) {
        hit = "stop";
        exit = stop;
        held = j - idx;
        break;
      }
      if (dir > 0 ? b.high >= target : b.low <= target) {
        hit = "target";
        exit = target;
        held = j - idx;
        break;
      }
    }
    out.set(key, { pnl: (exit - entry) * dir - COST, hit, held, exitR: (exit - entry) * dir / risk });
    openUntil = idx + HOLD_BARS;
  }
  return out;
}

/* ---- stats ------------------------------------------------------------ */

type Stats = { n: number; wr: number; pf: number; net: number; exp: number };

function stats(tt: { pnl: number }[]): Stats {
  const wins = tt.filter((t) => t.pnl > 0);
  const losses = tt.filter((t) => t.pnl < 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = tt.reduce((a, t) => a + t.pnl, 0);
  const decided = wins.length + losses.length;
  return { n: tt.length, wr: decided ? (wins.length / decided) * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, net, exp: tt.length ? net / tt.length : 0 };
}

function row(label: string, s: Stats, expBase?: number): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : " inf";
  const d = expBase === undefined ? "" : ` (Δexp ${s.exp - expBase >= 0 ? "+" : ""}${(s.exp - expBase).toFixed(2)})`;
  return `${label.padEnd(30)} | n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(6)} net=${s.net.toFixed(0).padStart(8)} exp=${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(5)}${d}`;
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/* ---- panels ------------------------------------------------------------ */

function q1Panel(name: string, rows: Row[]) {
  console.log(`\n=== Q1 cum-delta gate — ${name} ===`);
  console.log(`  ${row("ALL", stats(rows))}`);
  const agree = rows.filter((r) => r.agrees);
  const against = rows.filter((r) => !r.agrees);
  console.log(`  ${row("direction AGREES w/ cumΔ", stats(agree))}`);
  console.log(`  ${row("direction AGAINST cumΔ", stats(against))}`);
  const bands: [string, (r: Row) => boolean][] = [
    ["Δ ≤ −800 (vs dir)", (r) => r.cumDelta * r.dir <= -800],
    ["−800 < Δ ≤ −400", (r) => { const d = r.cumDelta * r.dir; return d > -800 && d <= -400; }],
    ["−400 < Δ < 0", (r) => { const d = r.cumDelta * r.dir; return d > -400 && d < 0; }],
    ["0 < Δ < 400", (r) => { const d = r.cumDelta * r.dir; return d > 0 && d < 400; }],
    ["400 ≤ Δ < 800", (r) => { const d = r.cumDelta * r.dir; return d >= 400 && d < 800; }],
    ["Δ ≥ 800 (with dir)", (r) => r.cumDelta * r.dir >= 800],
  ];
  for (const [label, f] of bands) {
    const tt = rows.filter(f);
    if (tt.length) console.log(`  ${row(label, stats(tt))}`);
  }
  for (const T of [0, 200, 400, 800]) {
    const skipped = rows.filter((r) => !r.agrees && r.cumDelta * r.dir <= -T);
    const kept = rows.filter((r) => !(!r.agrees && r.cumDelta * r.dir <= -T));
    console.log(`  ${row(`veto against & |Δ|≥${T}`, stats(kept), stats(rows).exp)}`);
    console.log(`  ${row(`  └ skipped cell`, stats(skipped))}`);
  }
  const tr = stats(rows.filter((r) => r.date < SPLIT));
  const te = stats(rows.filter((r) => r.date >= SPLIT));
  const trA = stats(rows.filter((r) => r.date < SPLIT && !(!r.agrees && r.cumDelta * r.dir <= -400)));
  const teA = stats(rows.filter((r) => r.date >= SPLIT && !(!r.agrees && r.cumDelta * r.dir <= -400)));
  const trS = stats(rows.filter((r) => r.date < SPLIT && !r.agrees && r.cumDelta * r.dir <= -400));
  const teS = stats(rows.filter((r) => r.date >= SPLIT && !r.agrees && r.cumDelta * r.dir <= -400));
  console.log(`  train/test (veto@400): TRAIN exp ${tr.exp >= 0 ? "+" : ""}${tr.exp.toFixed(2)} → ${trA.exp >= 0 ? "+" : ""}${trA.exp.toFixed(2)} (skip ${trS.n}) | TEST exp ${te.exp >= 0 ? "+" : ""}${te.exp.toFixed(2)} → ${teA.exp >= 0 ? "+" : ""}${teA.exp.toFixed(2)} (skip ${teS.n})`);
}

function q2Panel(name: string, rows: Row[], variants: Record<string, Map<string, VR>>) {
  console.log(`\n=== Q2 target at session extreme — ${name} ===`);
  const inCell = rows.filter((r) => r.tgtAtExt);
  const outCell = rows.filter((r) => !r.tgtAtExt);
  const beyond = rows.filter((r) => r.tgtBeyondExt);
  const near = rows.filter((r) => r.tgtNearExt && !r.tgtBeyondExt);
  const entryBeyond = rows.filter((r) => r.entryBeyondExt);
  console.log(`  ${row("target @/beyond extreme", stats(inCell))}`);
  console.log(`  ${row("  └ beyond by >0.25", stats(beyond))}`);
  console.log(`  ${row("  └ at the extreme (±0.5)", stats(near))}`);
  console.log(`  ${row("target inside range", stats(outCell))}`);
  console.log(`  ${row("entry beyond extreme", stats(entryBeyond))}`);
  const trIn = stats(inCell.filter((r) => r.date < SPLIT));
  const teIn = stats(inCell.filter((r) => r.date >= SPLIT));
  const trOut = stats(outCell.filter((r) => r.date < SPLIT));
  const teOut = stats(outCell.filter((r) => r.date >= SPLIT));
  console.log(`  train/test: IN exp ${trIn.exp >= 0 ? "+" : ""}${trIn.exp.toFixed(2)} (n=${trIn.n}) → ${teIn.exp >= 0 ? "+" : ""}${teIn.exp.toFixed(2)} (n=${teIn.n}) | OUT exp ${trOut.exp >= 0 ? "+" : ""}${trOut.exp.toFixed(2)} → ${teOut.exp >= 0 ? "+" : ""}${teOut.exp.toFixed(2)}`);

  const policies: [string, string][] = [
    ["base", "fixed target (live)"],
    ["cap", "target capped @extreme"],
    ["t05", "early bank 0.5R"],
    ["t075", "early bank 0.75R"],
    ["run", "runner BE@1R ladder"],
    ["halfrun", "½ fixed + ½ runner"],
  ];
  console.log(`  management variants (IN cell, n=${inCell.length}):`);
  for (const [v, label] of policies) {
    const m = variants[v];
    if (!m) continue;
    const tt = inCell.map((r) => m.get(`${r.date}|${r.entryIdx}`)).filter((x): x is VR => !!x).map((x) => ({ pnl: x.pnl }));
    console.log(`  ${row(`  ${label}`, stats(tt), stats(inCell).exp)}`);
  }
  console.log(`  management variants (OUT cell, n=${outCell.length}):`);
  for (const [v, label] of policies) {
    const m = variants[v];
    if (!m) continue;
    const tt = outCell.map((r) => m.get(`${r.date}|${r.entryIdx}`)).filter((x): x is VR => !!x).map((x) => ({ pnl: x.pnl }));
    console.log(`  ${row(`  ${label}`, stats(tt), stats(outCell).exp)}`);
  }
  // loss anatomy in the beyond cell: touched +1R before stopping (would BE@1R have saved?)
  const stops = beyond.filter((r) => r.hit === "stop");
  const t1 = stops.filter((r) => r.touched1).length;
  const t05 = stops.filter((r) => r.touched05).length;
  console.log(`  beyond-cell stop anatomy: ${stops.length} stop-outs · touched +0.5R first: ${t05} (${stops.length ? ((t05 / stops.length) * 100).toFixed(0) : 0}%) · touched +1R first: ${t1} (${stops.length ? ((t1 / stops.length) * 100).toFixed(0) : 0}%) · stop-runs: ${stops.filter((r) => r.stopRun).length}`);
}

function q3Panel(name: string, rows: Row[]) {
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl <= 0);
  console.log(`\n=== Q3 atlas — ${name} (wins ${wins.length} / losses ${losses.length}) ===`);
  const feats: [string, (r: Row) => number][] = [
    ["riskPts", (r) => r.risk],
    ["cumDelta", (r) => r.cumDelta],
    ["deltaFromFlush", (r) => r.deltaFromFlush],
    ["failDepth", (r) => r.failDepth],
    ["progressPts", (r) => r.progressPts],
    ["distToExt", (r) => r.distToExt],
    ["rangePos", (r) => r.rangePos],
    ["atr14", (r) => r.atr14],
    ["breakRangeR", (r) => r.breakRangeR],
    ["breakFrac", (r) => r.breakFrac],
    ["maeR", (r) => r.maeR],
    ["mfeR", (r) => r.mfeR],
    ["held(bars)", (r) => r.held],
  ];
  console.log(`  ${"feature".padEnd(14)} ${"win-med".padStart(9)} ${"loss-med".padStart(9)}`);
  for (const [label, f] of feats) {
    const w = median(wins.map(f));
    const l = median(losses.map(f));
    console.log(`  ${label.padEnd(14)} ${w.toFixed(2).padStart(9)} ${l.toFixed(2).padStart(9)}`);
  }
  console.log(`  ${"".padEnd(14)} ${"W".padStart(9)} ${"L".padStart(9)} ${"WR%".padStart(7)} ${"exp".padStart(7)}`);
  const cells: [string, (r: Row) => boolean][] = [
    ["agrees w/ cumΔ", (r) => r.agrees],
    ["against cumΔ", (r) => !r.agrees],
    ["tgt @/beyond ext", (r) => r.tgtAtExt],
    ["tgt inside", (r) => !r.tgtAtExt],
    ["long", (r) => r.dir === 1],
    ["short", (r) => r.dir === -1],
    ["first of day", (r) => r.firstOfDay],
    ["after win", (r) => r.priorWin === true],
    ["after loss", (r) => r.priorWin === false],
  ];
  for (const [label, f] of cells) {
    const tt = rows.filter(f);
    const s = stats(tt);
    if (!tt.length) continue;
    console.log(`  ${label.padEnd(14)} ${String(tt.filter((r) => r.pnl > 0).length).padStart(9)} ${String(tt.filter((r) => r.pnl <= 0).length).padStart(9)} ${s.wr.toFixed(1).padStart(6)}% ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(6)}`);
  }
  for (const b of ["globex_early", "globex_core", "globex_late", "globex_dawn", "premkt", "rth", "close"]) {
    const tt = rows.filter((r) => r.bucket === b);
    if (!tt.length) continue;
    const s = stats(tt);
    console.log(`  ${("bucket " + b).padEnd(14)} ${String(tt.filter((r) => r.pnl > 0).length).padStart(9)} ${String(tt.filter((r) => r.pnl <= 0).length).padStart(9)} ${s.wr.toFixed(1).padStart(6)}% ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(6)}`);
  }
  const stops = losses.filter((r) => r.hit === "stop");
  const times = losses.filter((r) => r.hit === "time");
  const runs = stops.filter((r) => r.stopRun).length;
  const t05 = stops.filter((r) => r.touched05).length;
  const t1 = stops.filter((r) => r.touched1).length;
  console.log(`  loss anatomy: stop ${stops.length} (run-back ${runs}, ${stops.length ? ((runs / stops.length) * 100).toFixed(0) : 0}%) · time ${times.length} · touched +0.5R first ${t05} (${stops.length ? ((t05 / stops.length) * 100).toFixed(0) : 0}%) · touched +1R first ${t1} (${stops.length ? ((t1 / stops.length) * 100).toFixed(0) : 0}%)`);
  const tw = wins.filter((r) => r.mfeR >= 1 && r.hit !== "target").length;
  console.log(`  winners: ${wins.length} · hit target ${wins.filter((r) => r.hit === "target").length} · time-wins ${wins.filter((r) => r.hit === "time").length} · non-target wins w/ MFE≥1R: ${tw}`);
  const maxStreak = Math.max(0, ...rows.filter((r) => r.pnl <= 0).map((r) => r.streak));
  console.log(`  longest losing streak (same-day, per family): ${maxStreak}`);
  for (const d of [1, 2, 3, 4, 5, 6]) {
    const tt = rows.filter((r) => r.dow === d);
    if (!tt.length) continue;
    const s = stats(tt);
    console.log(`  ${("dow " + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).padEnd(14)} ${String(tt.filter((r) => r.pnl > 0).length).padStart(9)} ${String(tt.filter((r) => r.pnl <= 0).length).padStart(9)} ${s.wr.toFixed(1).padStart(6)}% ${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(6)}`);
  }
}

function q2NearPanel(name: string, rows: Row[], variants: Record<string, Map<string, VR>>): Stats {
  const near = rows.filter((r) => r.tgtNearExt && !r.tgtBeyondExt); // the pure ATH-retest cell
  const s = stats(near);
  console.log(`\n=== Q2b ATH-retest cell (|tgt−ext|≤0.5, not beyond) — ${name} (n=${near.length}) ===`);
  console.log(`  ${row("base (fixed target)", s)}`);
  const policies: [string, string][] = [
    ["cap", "target capped @extreme"],
    ["t05", "early bank 0.5R"],
    ["t075", "early bank 0.75R"],
    ["run", "runner BE@1R ladder"],
    ["halfrun", "½ fixed + ½ runner"],
  ];
  for (const [v, label] of policies) {
    const m = variants[v];
    if (!m) continue;
    const tt = near.map((r) => m.get(`${r.date}|${r.entryIdx}`)).filter((x): x is VR => !!x).map((x) => ({ pnl: x.pnl }));
    console.log(`  ${row(label, stats(tt), s.exp)}`);
  }
  const stops = near.filter((r) => r.hit === "stop");
  const t05 = stops.filter((r) => r.touched05).length;
  console.log(`  stop-outs ${stops.length} · touched +0.5R first ${t05} (${stops.length ? ((t05 / stops.length) * 100).toFixed(0) : 0}%) · stop-runs ${stops.filter((r) => r.stopRun).length}`);
  return s;
}

function q2BeyondPanel(name: string, rows: Row[], variants: Record<string, Map<string, VR>>): Stats {
  const beyond = rows.filter((r) => r.tgtBeyondExt); // target prints fresh air beyond the extreme
  const s = stats(beyond);
  console.log(`\n=== Q2c fresh-air cell (target beyond ext by >0.25) — ${name} (n=${beyond.length}) ===`);
  console.log(`  ${row("base (fixed target)", s)}`);
  const policies: [string, string][] = [
    ["cap", "target capped @extreme"],
    ["t05", "early bank 0.5R"],
    ["t075", "early bank 0.75R"],
    ["run", "runner BE@1R ladder"],
    ["halfrun", "½ fixed + ½ runner"],
  ];
  for (const [v, label] of policies) {
    const m = variants[v];
    if (!m) continue;
    const tt = beyond.map((r) => m.get(`${r.date}|${r.entryIdx}`)).filter((x): x is VR => !!x).map((x) => ({ pnl: x.pnl }));
    console.log(`  ${row(label, stats(tt), s.exp)}`);
  }
  return s;
}

/* ---- main --------------------------------------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : undefined;
  const csvArg = argv.indexOf("--csv");
  const csvPath = csvArg >= 0 ? argv[csvArg + 1] : undefined;

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`winner/loser atlas · ${dates.length} sessions · first-touch 60-bar 0.5pt cost`);

  const families: { name: string; detect: (m: MomMinute[]) => MomentumSignal[] }[] = [
    { name: "MOM flush 1R", detect: (m) => detectMomentum(m, MOM_PROD) },
    { name: "EXP expansion 1R", detect: (m) => detectExpansionScalp(m, EXP_PROD) },
    { name: "RTH soft 0.75R", detect: (m) => detectSoftMomentum(m, SOFT_PROD) },
  ];

  const all: Record<string, Row[]> = { "MOM flush 1R": [], "EXP expansion 1R": [], "RTH soft 0.75R": [] };
  const variantMaps: Record<string, Record<string, Map<string, VR>>> = {
    "MOM flush 1R": { cap: new Map(), t05: new Map(), t075: new Map(), run: new Map(), halfrun: new Map() },
    "EXP expansion 1R": { cap: new Map(), t05: new Map(), t075: new Map(), run: new Map(), halfrun: new Map() },
    "RTH soft 0.75R": { cap: new Map(), t05: new Map(), t075: new Map(), run: new Map(), halfrun: new Map() },
  };

  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { minutes } of sessions) {
      if (!minutes) continue;
      const pre = prefixes(minutes);
      for (const f of families) {
        const sigs = f.detect(minutes);
        all[f.name].push(...replayBase(minutes, sigs, f.name, pre));
        for (const kind of ["cap", "t05", "t075", "run", "halfrun"] as const) {
          const m = replayVariant(minutes, sigs, pre, kind);
          const dst = variantMaps[f.name][kind];
          for (const [k, v] of m) dst.set(k, v);
        }
      }
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${all["MOM flush 1R"].length}/${all["EXP expansion 1R"].length}/${all["RTH soft 0.75R"].length} trades\n`);

  const nearPools: { name: string; s: Stats; n: number }[] = [];
  const beyondPools: { name: string; s: Stats; n: number }[] = [];
  for (const f of families) {
    const rows = all[f.name];
    const variants = variantMaps[f.name];
    q1Panel(f.name, rows);
    q2Panel(f.name, rows, variants);
    const nearS = q2NearPanel(f.name, rows, variants);
    nearPools.push({ name: f.name, s: nearS, n: rows.filter((r) => r.tgtNearExt && !r.tgtBeyondExt).length });
    const beyondS = q2BeyondPanel(f.name, rows, variants);
    beyondPools.push({ name: f.name, s: beyondS, n: rows.filter((r) => r.tgtBeyondExt).length });
    q3Panel(f.name, rows);
  }
  const pool = (ps: { s: Stats; n: number }[]) => {
    const net = ps.reduce((a, p) => a + p.s.net, 0);
    const n = ps.reduce((a, p) => a + p.n, 0);
    return { net, n, exp: n ? net / n : 0 };
  };
  const np = pool(nearPools);
  const bp = pool(beyondPools);
  console.log(`\n=== Q2d pooled cells (all families) ===`);
  console.log(`  ${"ATH-retest pooled".padEnd(30)} | n=${String(np.n).padStart(5)} net=${np.net.toFixed(0).padStart(8)} exp=${np.exp >= 0 ? "+" : ""}${np.exp.toFixed(2).padStart(5)}`);
  console.log(`  ${"fresh-air pooled".padEnd(30)} | n=${String(bp.n).padStart(5)} net=${bp.net.toFixed(0).padStart(8)} exp=${bp.exp >= 0 ? "+" : ""}${bp.exp.toFixed(2).padStart(5)}`);

  if (csvPath) {
    const hdr = ["family", "date", "time", "dow", "dir", "risk", "cumDelta", "agrees", "sessHigh", "sessLow", "entry", "target", "tgtBeyondExt", "tgtNearExt", "entryBeyondExt", "rangePos", "pnl", "hit", "held", "maeR", "mfeR", "touched05", "touched1", "stopRun", "tradeNo", "firstOfDay", "priorWin", "streak"];
    const lines = [hdr.join(",")];
    for (const f of families) {
      for (const r of all[f.name]) {
        lines.push([r.family, r.date, r.time, r.dow, r.dir, r.risk.toFixed(2), r.cumDelta.toFixed(0), r.agrees ? 1 : 0, r.sessHigh.toFixed(2), r.sessLow.toFixed(2), r.entry.toFixed(2), r.target.toFixed(2), r.tgtBeyondExt ? 1 : 0, r.tgtNearExt ? 1 : 0, r.entryBeyondExt ? 1 : 0, r.rangePos.toFixed(3), r.pnl.toFixed(2), r.hit, r.held, r.maeR.toFixed(2), r.mfeR.toFixed(2), r.touched05 ? 1 : 0, r.touched1 ? 1 : 0, r.stopRun ? 1 : 0, r.tradeNo, r.firstOfDay ? 1 : 0, r.priorWin === null ? "" : r.priorWin ? 1 : 0, r.streak].join(","));
      }
    }
    await fs.writeFile(csvPath, lines.join("\n"));
    console.log(`\ncsv → ${csvPath}`);
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * primary cohort = MOM flush 1R baseline rows; T1 all/train/test
   * (split 2026-01-01), T2 management variants (base/cap/t05/t075/run/
   * halfrun), T4 prop viability, five-slot verdict. ---- */
  const primaryRows = all["MOM flush 1R"];
  const engineTrades = primaryRows.map((r) => ({ date: r.date, pnl: r.pnl, risk: r.risk }));
  const allStats = coreStats(engineTrades);
  const trainStats = coreStats(engineTrades.filter((t) => t.date < SPLIT));
  const testStats = coreStats(engineTrades.filter((t) => t.date >= SPLIT));
  console.log("\n=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "all", stats: allStats },
      { label: "train", stats: trainStats },
      { label: "test", stats: testStats },
    ]),
  );
  const variantTrades = (kind: string): EngineTrade[] => {
    if (kind === "base") return engineTrades;
    const m = variantMaps["MOM flush 1R"][kind];
    return primaryRows
      .map((r) => {
        const v = m.get(`${r.date}|${r.entryIdx}`);
        return v ? { date: r.date, pnl: v.pnl, risk: r.risk } : null;
      })
      .filter((x): x is EngineTrade => !!x);
  };
  const baseStats = coreStats(engineTrades);
  console.log(
    "\n" +
      renderT2(
        (["base", "cap", "t05", "t075", "run", "halfrun"] as const).map((kind) => {
          const tt = variantTrades(kind);
          const st = coreStats(tt);
          const tr = coreStats(tt.filter((t) => t.date < SPLIT));
          const te = coreStats(tt.filter((t) => t.date >= SPLIT));
          return {
            rule: kind === "base" ? "base (fixed target, live)" : kind,
            n: st.n,
            wr: st.wr,
            ci: wilson95(st.wins, st.n),
            pf: st.pf,
            expPts: st.expPts,
            trainTest: `${tr.wr.toFixed(0)}% / ${te.wr.toFixed(0)}%`,
            compare: kind === "base" ? undefined : `base WR ${baseStats.wr.toFixed(0)}%`,
          };
        }),
      ),
  );
  const viability = propViability(engineTrades, { splitDate: SPLIT });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: testStats.netPts > 0 && testStats.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(trainStats.wr - testStats.wr).toFixed(1)} pts`,
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
