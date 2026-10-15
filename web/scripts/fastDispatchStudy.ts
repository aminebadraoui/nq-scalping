/* ------------------------------------------------------------------ *
 * FAST-DISPATCH GATE STUDY (scratch — research input, the go/no-go
 * gate for the fill-lag fix, docs/research/fill-lag-fix-plan-2026-10-15.md)
 *
 * Quantifies the harvest of confirming the vendor candle ~7.5 s after
 * the bar close (REST poll, CONFIRM_RACE_PROBE observation) instead of
 * 32–57 s (frame channel) — modeled as PLACEMENT LAG in the limit
 * replay: the resting-limit arms' fill window opens N bars after the
 * signal bar.
 *
 *   lag0  — limit exists from the signal bar (the validated studies'
 *           ideal; what fast confirm approximates: ~7.5 s ≈ 0 bars)
 *   lag1  — limit placed ~40 s late = the fill window opens one bar
 *           later (the current live proxy)
 *   lag2  — two bars late (stall-grade confirmation)
 *
 * Families (live brackets, one-position-at-a-time per session):
 *   flush  MOM_PROD → limit at the close, TTL 9, brackets from the fill
 *          (structural risk, 1R), same-bar stop-first, horizon 60
 *   rth    SOFT_PROD → limit at the close, TTL 9, 0.5× stop, 2.5R
 *          target, horizon 60 (exit scan from the fill bar)
 *   d100   first ≥100-pt bar → limit at the close, TTL 9, 1×ATR14
 *          risk, 1R, same-bar stop-first, horizon 60
 *
 * The lag0−lag1 delta (filled cards, pts) = what fast confirm recovers.
 * Stats from lib/backtestEngine only. Cost 0.5 pt inside P&L.
 *
 * Run from web/:
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/fastDispatchStudy.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, MOM_PROD, closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { coreStats, wilson95, propViability, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const SPLIT = "2026-01-01";
const COST = 0.5;
const HOLD = 60;
const TTL = 9;

type Card = { date: string; fam: "flush" | "rth" | "d100"; dir: 1 | -1; entryIdx: number; entry: number; risk: number; stopMult: number; targetR: number };

const mid = (m: MomMinute): number => (m.high + m.low) / 2;

function prefixFeatures(mins: MomMinute[]): { atr: number[] } {
  const n = mins.length;
  const atr = new Array(n).fill(0);
  let rsum = 0;
  const rbuf: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = mins[i].high - mins[i].low;
    rbuf.push(r);
    rsum += r;
    if (rbuf.length > 14) rsum -= rbuf.shift()!;
    atr[i] = rsum / Math.max(1, rbuf.length);
  }
  return { atr };
}

function cardsOf(date: string, mins: MomMinute[]): Card[] {
  const out: Card[] = [];
  for (const s of detectMomentum(mins, MOM_PROD).filter((x) => x.kind === "flush")) {
    out.push({ date, fam: "flush", dir: s.dir === "long" ? 1 : -1, entryIdx: s.entryIdx, entry: s.entry, risk: s.risk, stopMult: 1, targetR: 1 });
  }
  for (const s of detectSoftMomentum(mins, SOFT_PROD)) {
    out.push({ date, fam: "rth", dir: s.dir === "long" ? 1 : -1, entryIdx: s.entryIdx, entry: s.entry, risk: s.risk, stopMult: 0.5, targetR: 2.5 });
  }
  const f = prefixFeatures(mins);
  for (let k = 30; k < mins.length - 1; k++) {
    const m = mins[k];
    if (m.high - m.low < 100) continue;
    const delta = m.buy - m.sell;
    if (delta === 0) continue;
    const dir: 1 | -1 = delta > 0 ? 1 : -1;
    const risk = Math.max(3.5, f.atr[k]);
    out.push({ date, fam: "d100", dir, entryIdx: k, entry: closeOf(m), risk, stopMult: 1, targetR: 1 });
    break;
  }
  return out;
}

/** resting-limit replay with the fill window opened `lag` bars after the
 *  signal bar (placement lag model). */
function limitReplay(mins: MomMinute[], c: Card, lag: number): { pnl: number; risk: number; hit: string } | null {
  const dir = c.dir;
  let fillBar = -1;
  let fill = 0;
  for (let j = c.entryIdx + 1 + lag; j <= Math.min(mins.length - 1, c.entryIdx + lag + TTL); j++) {
    const b = mins[j];
    if (!(dir > 0 ? b.low <= c.entry : b.high >= c.entry)) continue;
    const open = b.o > 0 ? b.o : mid(b);
    fill = dir > 0 ? Math.min(open, c.entry) : Math.max(open, c.entry);
    fillBar = j;
    break;
  }
  if (fillBar < 0) return null;
  const risk = c.risk * c.stopMult;
  const stop = fill - dir * risk;
  const target = fill + dir * risk * c.targetR;
  const end = Math.min(mins.length - 1, c.entryIdx + HOLD);
  let exit = closeOf(mins[end]);
  let hit = "time";
  const start = c.fam === "rth" ? fillBar + 1 : fillBar; // same-bar stop-first for flush/d, next-bar for rth
  for (let j = start; j <= end; j++) {
    const b = mins[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      exit = stop;
      hit = "stop";
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      hit = "target";
      break;
    }
  }
  return { pnl: (exit - fill) * dir - COST, risk, hit };
}

async function main() {
  const dates = (await archiveDates()).sort();
  const trainDates = dates.filter((d) => d < SPLIT);
  const testDates = dates.filter((d) => d >= SPLIT);
  console.log(`fastDispatch gate study · ${dates.length} sessions · train ${trainDates.length} / test ${testDates.length}`);
  console.log(`arms: lag0 (fast-confirm target) · lag1 (~40s late, live proxy) · lag2 (stall-grade) · TTL ${TTL} · cost ${COST} pt`);

  const byFam: Record<string, EngineTrade[]> = { flush0: [], flush1: [], flush2: [], rth0: [], rth1: [], rth2: [], d1000: [], d1001: [], d1002: [] };
  let i = 0;
  const t0 = Date.now();
  for (const date of dates) {
    const mins = await loadSessionMinutes(date, { withOhlc: true });
    if (!mins) continue;
    const cards = cardsOf(date, mins).sort((a, b) => a.entryIdx - b.entryIdx);
    let openUntil = -1;
    for (const c of cards) {
      if (c.entryIdx < openUntil) continue;
      let anyFill = false;
      for (const lag of [0, 1, 2]) {
        const r = limitReplay(mins, c, lag);
        if (r) {
          byFam[`${c.fam}${lag}`].push({ date, pnl: r.pnl, risk: r.risk });
          if (lag === 0) anyFill = true;
        }
      }
      if (anyFill) openUntil = c.entryIdx + HOLD;
    }
    if (++i % 200 === 0) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · replay done`);

  for (const fam of ["flush", "rth", "d100"]) {
    console.log(`\n################ ${fam} ################`);
    const rows = [0, 1, 2].map((lag) => {
      const tr = byFam[`${fam}${lag}`];
      return { label: `${fam} lag${lag}${lag === 0 ? " (fast-confirm target)" : lag === 1 ? " (live proxy)" : " (stall)"}`, stats: coreStats(tr, { sessionUniverse: dates }) };
    });
    console.log(renderT1(rows));
    console.log(
      renderT2(
        [0, 1, 2].map((lag) => {
          const tr = byFam[`${fam}${lag}`];
          const s = coreStats(tr, { sessionUniverse: dates });
          const st = coreStats(tr.filter((t) => t.date < SPLIT), { sessionUniverse: trainDates });
          const se = coreStats(tr.filter((t) => t.date >= SPLIT), { sessionUniverse: testDates });
          const b0 = coreStats(byFam[`${fam}0`], { sessionUniverse: dates });
          return {
            rule: `${fam} lag${lag}`,
            n: s.n,
            wr: s.wr,
            ci: s.wrCi,
            pf: s.pf,
            expPts: s.expPts,
            trainTest: `${st.wr.toFixed(0)}% / ${se.wr.toFixed(0)}%`,
            compare: lag === 0 ? "—" : `lag0 n=${b0.n} exp ${b0.expPts >= 0 ? "+" : ""}${b0.expPts.toFixed(2)} · lost ${b0.n - s.n} fills`,
          };
        }),
      ),
    );
    const v = propViability(byFam[`${fam}0`], { splitDate: SPLIT });
    console.log("\n" + renderT4(v));
    const trS = coreStats(byFam[`${fam}0`].filter((t) => t.date < SPLIT), { sessionUniverse: trainDates });
    const teS = coreStats(byFam[`${fam}0`].filter((t) => t.date >= SPLIT), { sessionUniverse: testDates });
    const lag1 = coreStats(byFam[`${fam}1`], { sessionUniverse: dates });
    const harvest = byFam[`${fam}0`].reduce((a, t) => a + t.pnl, 0) - byFam[`${fam}1`].reduce((a, t) => a + t.pnl, 0);
    console.log(`harvest (lag0−lag1 total net pts): ${harvest >= 0 ? "+" : ""}${harvest.toFixed(1)} · lag0 net ${byFam[`${fam}0`].reduce((a, t) => a + t.pnl, 0).toFixed(0)} vs lag1 net ${byFam[`${fam}1`].reduce((a, t) => a + t.pnl, 0).toFixed(0)}`);
    console.log(
      renderVerdict({
        edge: teS.n >= 100 ? (teS.netPts > 0 && teS.expR > 0 ? "real" : "absent") : "unproven",
        significance: teS.n >= 100 ? (teS.wrCi[0] > 0.5 ? "PASS" : "weak") : "—",
        stability: `train/test WR ${trS.wr.toFixed(1)}/${teS.wr.toFixed(1)} · lag1 ${lag1.wr.toFixed(1)}%`,
        holdout: "n/a (70/30 OOS)",
        viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
      }),
    );
  }
}

main().catch((e) => {
  console.error("fastDispatchStudy failed:", e);
  process.exit(1);
});
