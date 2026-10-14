/* ------------------------------------------------------------------ *
 * MOMENTUM ENTRY-MECHANICS STUDY — the chase-drift instant-exit problem
 * (standalone; 2026-10-14). Replays the momentum detector (MOM_PROD,
 * frozen; failed-flush breakout cards only — the MARKETABLE family) over
 * the full session archive and varies ONLY the entry-mechanics layer:
 *
 *   live      — marketable fill at the dispatch tape (bar+1 mid),
 *               signal-anchored brackets (the live behavior)
 *   gateX{n}  — chase-over gate: skip dispatch when the tape is already
 *               >= n pts THROUGH the entry level on the trade side (the
 *               replay proxy for the live staleness: in the archive every
 *               bar is fresh, so the freshness veto manifests as the
 *               tape-through condition at dispatch)
 *   anchor    — brackets rebuilt from the ACTUAL fill (planned risk kept)
 *   both      — gateX2 + anchor
 *   *_d{n}    — adverse fill-drift sensitivity (1 / 2.5 pts), inspection
 *               only — NOT in the selection grid
 *
 * The live failure mode (2026-10-13/14): the marketable chase fills 6-12
 * pts past the signal in fast tape (bar->dispatch staleness ~32-57 s at
 * the ETH open), the signal-anchored target ends up on the wrong side of
 * the fill and fires instantly at +/-0.5 pts — a guaranteed fee loss.
 *
 * Fill model: marketable fill at the dispatch tape (next-bar mid) +
 * optional uniform adverse drift; pessimistic same-bar exit INCLUDING the
 * fill bar, stop-first, 0.5 pt cost inside P&L, 60-bar time exit,
 * one-trade-at-a-time (full-window occupancy).
 *
 * Emits: standard T1/T2/T4 + verdict (consolidated engine), a sweep JSON
 * in the exportSweep contract for gcdata/validate_sweep.py (DSR/PBO), and
 * the 4-card 2026-10-13/14 live exhibit replayed on Neon candles_1m bars.
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/momentumEntryMechanicsStudy.ts [--quick]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, MOM_PROD, midOf, closeOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { stopCrossedAtDispatch } from "../lib/crossTrade";
import { coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CONCURRENCY = 8;
const HORIZON = 60;
const COST_PTS = 0.5; // round-trip, inside the P&L (house standard)
const SPLIT = "2026-01-01"; // 472 train / 183 test (≈70/30 by date)
const POINT_VALUE = 2;

type Arm = {
  id: string;
  gateX: number; // chase-over gate pts through the entry (0 = live)
  anchor: boolean;
  drift: number; // adverse fill-drift model pts
  selectable: boolean; // in the DSR/PBO selection grid
  perfect?: boolean; // reference: fill at the entry-bar close (canonical momentumStudy model)
  limit?: boolean; // resting limit at the signal level from bar+1 (the retrace-family entry for flush cards)
  ttl?: number;
};
type Trade = { date: string; pnl: number; risk: number };

const ARMS: Arm[] = [
  // ---- reference: canonical fill model (entry bar close = signal price),
  //      the momentumStudy convention — the chase-free upper bound ----
  { id: "perfect", gateX: 0, anchor: false, drift: 0, selectable: false, perfect: true },
  { id: "live", gateX: 0, anchor: false, drift: 0, selectable: true },
  { id: "flushLimit", gateX: 0, anchor: false, drift: 0, selectable: true, limit: true, ttl: 9 },
  { id: "gateX1", gateX: 1, anchor: false, drift: 0, selectable: true },
  { id: "gateX2", gateX: 2, anchor: false, drift: 0, selectable: true },
  { id: "gateX3", gateX: 3, anchor: false, drift: 0, selectable: true },
  { id: "gateX5", gateX: 5, anchor: false, drift: 0, selectable: true },
  { id: "anchor", gateX: 0, anchor: true, drift: 0, selectable: true },
  { id: "both", gateX: 2, anchor: true, drift: 0, selectable: true },
  // ---- fill-drift sensitivity (NOT in the selection grid) ----
  { id: "live_d1", gateX: 0, anchor: false, drift: 1, selectable: false },
  { id: "live_d2.5", gateX: 0, anchor: false, drift: 2.5, selectable: false },
  { id: "anchor_d1", gateX: 0, anchor: true, drift: 1, selectable: false },
  { id: "anchor_d2.5", gateX: 0, anchor: true, drift: 2.5, selectable: false },
];

/** dispatch tape = next-bar mid (the marketable fill's tape proxy — the
 *  live pipeline adds ~32-57 s of bar→dispatch staleness on top, which is
 *  exactly the gap the gateX arms veto). */
const dispatchTape = (minutes: MomMinute[], sig: MomentumSignal): number | null => {
  const nb = minutes[sig.entryIdx + 1];
  return nb ? midOf(nb) : null;
};

/** dispatch gates (live fidelity): the crossed-stop veto (naked-fill
 *  guard, live), then the study's chase-over gate. */
function gatedAtDispatch(dir: "long" | "short", entry: number, stop: number, tape: number, arm: Arm): boolean {
  if (stopCrossedAtDispatch(dir, stop, tape) === true) return true; // live
  if (arm.gateX > 0) {
    const through = dir === "long" ? tape - entry : entry - tape; // pts the tape already ran past the entry
    if (through >= arm.gateX) return true; // the chase is over — skip
  }
  return false;
}

/** first-touch exit scan from the FILL bar (inclusive), stop-first,
 *  pessimistic same-bar, 60-bar time exit at closeOf. */
function scoreFromFill(
  minutes: MomMinute[],
  sig: MomentumSignal,
  dir: 1 | -1,
  fill: number,
  fillBar: number,
  stop: number,
  target: number,
): number {
  const end = Math.min(minutes.length - 1, sig.entryIdx + HORIZON);
  let exit = closeOf(minutes[end]);
  for (let j = fillBar; j <= end; j++) {
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
  return (exit - fill) * dir - COST_PTS;
}

function scoreArm(minutes: MomMinute[], sigs: MomentumSignal[], date: string, arm: Arm): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of [...sigs].sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    if (arm.perfect) {
      // reference: fill at the entry bar's close (the canonical momentumStudy
      // fill model — no chase), signal-anchored brackets, scan from bar+1
      const fill = closeOf(minutes[s.entryIdx]);
      const pnl = scoreFromFill(minutes, s, dir, fill, s.entryIdx + 1, s.stop, s.target);
      out.push({ date, pnl, risk: s.risk });
      openUntil = s.entryIdx + HORIZON;
      continue;
    }
    const tape = dispatchTape(minutes, s);
    if (tape === null) continue;
    if (arm.limit) {
      // resting limit AT the signal level from bar+1 (limit-or-better at the
      // bar open) — the chase replaced by a retrace-style entry
      const endTtl = Math.min(minutes.length - 1, s.entryIdx + (arm.ttl ?? 9));
      let fillBar = -1;
      let fill = 0;
      for (let j = s.entryIdx + 1; j <= endTtl; j++) {
        const b = minutes[j];
        const touched = dir > 0 ? b.low <= s.entry : b.high >= s.entry;
        if (!touched) continue;
        fillBar = j;
        const open = b.o > 0 ? b.o : midOf(b);
        fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
        fill += dir * arm.drift; // adverse drift model (0 for the base arms)
        break;
      }
      if (fillBar < 0) continue; // expired — no trade, no window consumed
      const pnl = scoreFromFill(minutes, s, dir, fill, fillBar, s.stop, s.target);
      out.push({ date, pnl, risk: s.risk });
      openUntil = s.entryIdx + HORIZON;
      continue;
    }
    if (gatedAtDispatch(s.dir, s.entry, s.stop, tape, arm)) continue;
    const fill = tape + dir * arm.drift; // adverse drift = worse side of the tape
    const stop = arm.anchor ? fill - dir * s.risk : s.stop;
    const target = arm.anchor ? fill + dir * s.risk : s.target;
    const pnl = scoreFromFill(minutes, s, dir, fill, s.entryIdx + 1, stop, target);
    out.push({ date, pnl, risk: s.risk });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

/* ---------------- live session exhibit (candles_1m, 2026-10-13/14) ---------------- */

export type ExhibitBar = { t: string; high: number; low: number };
const ET_OFFSET_MS = 4 * 3600_000; // EDT in October

export async function loadExhibitBars(): Promise<ExhibitBar[]> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 2 });
  try {
    const rows = (await sql`
      select ts, h, l from candles_1m
      where date = '2026-10-14' and session = 'ETH'
      order by ts`) as { ts: Date; h: number; l: number }[];
    return rows.map((r) => ({ t: new Date(r.ts.getTime() - ET_OFFSET_MS).toISOString().slice(11, 16), high: Number(r.h), low: Number(r.l) }));
  } finally {
    await sql.end();
  }
}

/** replay one hard-coded card through an arm on the exhibit bars */
export function exhibitReplay(
  bars: ExhibitBar[],
  card: { t: string; dir: "long" | "short"; entry: number; stop: number; target: number; risk: number },
  arm: Arm,
): { fill: number; fillBar: number; exit: number; hit: "stop" | "target" | "time" | "expired" | "gated"; pnl: number } {
  const dir = card.dir === "long" ? 1 : -1;
  const idx = bars.findIndex((b) => b.t === card.t);
  if (idx < 0 || idx + 1 >= bars.length) return { fill: 0, fillBar: -1, exit: 0, hit: "expired", pnl: 0 };
  const tape = (bars[idx + 1].high + bars[idx + 1].low) / 2;
  if (arm.limit) {
    const endTtl = Math.min(bars.length - 1, idx + (arm.ttl ?? 9));
    let fillBar = -1;
    let fill = 0;
    for (let j = idx + 1; j <= endTtl; j++) {
      const touched = dir > 0 ? bars[j].low <= card.entry : bars[j].high >= card.entry;
      if (!touched) continue;
      fillBar = j;
      const open = (bars[j].high + bars[j].low) / 2;
      fill = dir > 0 ? Math.min(open, card.entry) : Math.max(open, card.entry);
      fill += dir * arm.drift;
      break;
    }
    if (fillBar < 0) return { fill: 0, fillBar: -1, exit: 0, hit: "expired", pnl: 0 };
    const end = Math.min(bars.length - 1, idx + HORIZON);
    let exit = (bars[end].high + bars[end].low) / 2;
    let hit: "stop" | "target" | "time" = "time";
    for (let j = fillBar; j <= end; j++) {
      if (dir > 0 ? bars[j].low <= card.stop : bars[j].high >= card.stop) {
        exit = card.stop;
        hit = "stop";
        break;
      }
      if (dir > 0 ? bars[j].high >= card.target : bars[j].low <= card.target) {
        exit = card.target;
        hit = "target";
        break;
      }
    }
    return { fill, fillBar, exit, hit, pnl: (exit - fill) * dir - COST_PTS };
  }
  if (gatedAtDispatch(card.dir, card.entry, card.stop, tape, arm)) return { fill: 0, fillBar: -1, exit: 0, hit: "gated", pnl: 0 };
  const fill = tape + dir * arm.drift;
  const stop = arm.anchor ? fill - dir * card.risk : card.stop;
  const target = arm.anchor ? fill + dir * card.risk : card.target;
  const end = Math.min(bars.length - 1, idx + HORIZON);
  let exit = (bars[end].high + bars[end].low) / 2;
  let hit: "stop" | "target" | "time" = "time";
  for (let j = idx + 1; j <= end; j++) {
    if (dir > 0 ? bars[j].low <= stop : bars[j].high >= stop) {
      exit = stop;
      hit = "stop";
      break;
    }
    if (dir > 0 ? bars[j].high >= target : bars[j].low <= target) {
      exit = target;
      hit = "target";
      break;
    }
  }
  return { fill, fillBar: idx + 1, exit, hit, pnl: (exit - fill) * dir - COST_PTS };
}

/* ---------------- main ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes("--quick");
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  if (quick) {
    console.log(`--quick: sampling 60 sessions (30 train / 30 test)`);
    const train = dates.filter((d) => d < SPLIT).slice(-30);
    const test = dates.filter((d) => d >= SPLIT).slice(-30);
    dates.length = 0;
    dates.push(...train, ...test);
  }
  console.log(`momentum entry-mechanics study · ${dates.length} sessions · split ${SPLIT} · ${ARMS.length} arms`);

  const perArm: Trade[][] = ARMS.map(() => []);
  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      // failed-flush breakout cards only — the MARKETABLE family (the live
      // chase drift hits these; the expansion-retrace kind rests a limit)
      const sigs = detectMomentum(minutes, MOM_PROD).filter((s) => s.kind === "flush");
      for (let a = 0; a < ARMS.length; a++) perArm[a].push(...scoreArm(minutes, sigs, date, ARMS[a]));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY || i >= dates.length) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`replay done: ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  const armIdx = (id: string): number => ARMS.findIndex((a) => a.id === id);
  const tradesOf = (id: string): Trade[] => perArm[armIdx(id)];
  const eng = (ts: Trade[]): EngineTrade[] => ts.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));

  /* ---- selection on TRAIN (rthLimitValidation protocol: eval PASS +
   *       PF ≥ 1.2 + dd ≥ −$1900 on the dollarized sim) ---- */
  type SelRow = { id: string; trainN: number; trainWr: number; trainPf: number; trainNet: number; trainDd: number; pass: boolean; oos: ReturnType<typeof propViability> };
  const sel: SelRow[] = [];
  for (const arm of ARMS) {
    if (!arm.selectable) continue;
    const train = tradesOf(arm.id).filter((t) => t.date < SPLIT);
    if (!train.length) continue;
    const oos = propViability(eng(tradesOf(arm.id).filter((t) => t.date >= SPLIT)), { splitDate: SPLIT });
    const v = propViability(eng(train), {});
    const cs = coreStats(eng(train));
    const dd = v.maxDdUsd;
    const pass = v.evalSim.breachDay === null && cs.pf >= 1.2 && dd >= -1900;
    sel.push({ id: arm.id, trainN: cs.n, trainWr: cs.wr, trainPf: cs.pf, trainNet: cs.netPts, trainDd: dd, pass, oos });
  }
  sel.sort((a, b) => (b.pass ? b.trainNet : -Infinity) - (a.pass ? a.trainNet : -Infinity));
  console.log("=== TRAIN SELECTION (train < 2026-01-01 · eval PASS + PF≥1.2 + dd≥−$1900) ===");
  for (const r of sel) {
    console.log(
      `${r.id.padEnd(10)} | train n=${String(r.trainN).padStart(5)} wr=${r.trainWr.toFixed(1).padStart(5)}% pf=${r.trainPf.toFixed(2).padStart(5)} net=${r.trainNet.toFixed(0).padStart(7)}pts dd=$${r.trainDd.toFixed(0).padStart(7)} ${r.pass ? "QUALIFIED" : "rejected"}`,
    );
  }

  const winner = sel[0];
  const qualified = sel.filter((r) => r.pass);
  if (qualified.length === 0) {
    const nearest = [...sel].sort((a, b) => Math.abs(b.trainPf - 1.2) - Math.abs(a.trainPf - 1.2))[0];
    console.log(`\nNO ARM QUALIFIED on the train gate (eval PASS + PF≥1.2 + dd≥−$1900) — nearest: ${nearest.id} (PF ${nearest.trainPf.toFixed(2)}, dd $${nearest.trainDd.toFixed(0)})`);
    console.log(`walk-forward pick (protocol fallback): ${winner.id}\n`);
  } else {
    console.log(`\nwalk-forward winner: ${winner.id}\n`);
  }

  /* ---- T1: primary (winner) + baseline ---- */
  const liveAll = eng(tradesOf("live"));
  console.log("=== STANDARD REPORT (consolidated engine) ===");
  console.log(renderT1([
    { label: `primary ${winner.id} (all)`, stats: coreStats(eng(tradesOf(winner.id))) },
    { label: `primary ${winner.id} train`, stats: coreStats(eng(tradesOf(winner.id)).filter((t) => t.date < SPLIT)) },
    { label: `primary ${winner.id} test`, stats: coreStats(eng(tradesOf(winner.id)).filter((t) => t.date >= SPLIT)) },
    { label: "baseline live (all)", stats: coreStats(liveAll) },
    { label: "baseline live train", stats: coreStats(liveAll.filter((t) => t.date < SPLIT)) },
    { label: "baseline live test", stats: coreStats(liveAll.filter((t) => t.date >= SPLIT)) },
  ]));

  /* ---- T2: all arms, test window ---- */
  console.log("\n" + renderT2(
    ARMS.filter((a) => a.selectable).map((arm) => {
      const all = eng(tradesOf(arm.id));
      const tr = coreStats(all.filter((t) => t.date < SPLIT));
      const te = coreStats(all.filter((t) => t.date >= SPLIT));
      return {
        rule: `${arm.id}${arm.id === "live" ? " (live behavior)" : arm.id === "both" ? " (gateX2 + anchor)" : ""}`,
        n: te.n,
        wr: te.wr,
        ci: wilson95(te.wins, te.n),
        pf: te.pf,
        expPts: te.expPts,
        trainTest: `${tr.wr.toFixed(0)}% / ${te.wr.toFixed(0)}%`,
        compare: arm.id === "live" ? "—" : `live test WR ${coreStats(eng(tradesOf("live")).filter((t) => t.date >= SPLIT)).wr.toFixed(0)}%`,
      };
    }),
  ));

  /* ---- T4: winner + baseline ---- */
  const vWin = propViability(eng(tradesOf(winner.id)), { splitDate: SPLIT });
  const vLive = propViability(liveAll, { splitDate: SPLIT });
  console.log("\n" + renderT4(vWin, [
    { stage: "eval (baseline live)", sim: vLive.evalSim, note: "live marketable-chase behavior" },
  ]));

  const teWin = coreStats(eng(tradesOf(winner.id)).filter((t) => t.date >= SPLIT));
  const trWin = coreStats(eng(tradesOf(winner.id)).filter((t) => t.date < SPLIT));
  const teLive = coreStats(liveAll.filter((t) => t.date >= SPLIT));
  console.log(
    "\n" +
      renderVerdict({
        edge: teWin.netPts > 0 && teWin.expR > 0 ? "real" : teWin.netPts > 0 ? "unproven" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(trWin.wr - teWin.wr).toFixed(1)} pts`,
        holdout: "n/a (validation pipeline)",
        viability:
          vWin.pPass === null
            ? "n/a"
            : `${vWin.pPass >= 0.9 ? "PASS" : vWin.pPass >= 0.7 ? "weak" : "FAIL"} (P=${vWin.pPass.toFixed(2)})`,
      }),
  );

  /* ---- best intervention (flushLimit) — the report's primary ---- */
  const flAll = eng(tradesOf("flushLimit"));
  console.log("\n=== BEST INTERVENTION (flushLimit — resting limit at the signal, TTL 9) ===");
  console.log(renderT1([
    { label: "flushLimit (all)", stats: coreStats(flAll) },
    { label: "flushLimit train", stats: coreStats(flAll.filter((t) => t.date < SPLIT)) },
    { label: "flushLimit test", stats: coreStats(flAll.filter((t) => t.date >= SPLIT)) },
  ]));
  const vFl = propViability(flAll, { splitDate: SPLIT });
  console.log("\n" + renderT4(vFl, []));
  const teFl = coreStats(flAll.filter((t) => t.date >= SPLIT));
  const trFl = coreStats(flAll.filter((t) => t.date < SPLIT));
  console.log(
    "\n" +
      renderVerdict({
        edge: teFl.netPts > 0 && teFl.expR > 0 ? "real" : teFl.netPts > 0 ? "unproven" : "absent",
        significance: "—",
        stability: `train/test WR ${trFl.wr.toFixed(0)}% / ${teFl.wr.toFixed(0)}%`,
        holdout: "n/a (validation pipeline)",
        viability:
          vFl.pPass === null
            ? "n/a"
            : `${vFl.pPass >= 0.9 ? "PASS" : vFl.pPass >= 0.7 ? "weak" : "FAIL"} (P=${vFl.pPass.toFixed(2)})`,
      }),
  );

  /* ---- reference + fill-drift sensitivity ---- */
  console.log("\n=== REFERENCE + FILL-DRIFT SENSITIVITY (perfect fill = entry-bar close · adverse drift 0 → 2.5 pts) ===");
  for (const id of ["perfect", "live", "flushLimit", "live_d1", "live_d2.5", "anchor", "anchor_d1", "anchor_d2.5", "gateX2", "both"]) {
    const all = eng(tradesOf(id));
    const cs = coreStats(all);
    console.log(
      `${id.padEnd(11)} | n=${String(cs.n).padStart(5)} wr=${cs.wr.toFixed(1).padStart(5)}% pf=${Number.isFinite(cs.pf) ? cs.pf.toFixed(2) : "inf"} exp=${cs.expPts.toFixed(2).padStart(6)}pts expR=${cs.expR.toFixed(2).padStart(5)} maxDD=${cs.maxDdPts.toFixed(0).padStart(5)}pts`,
    );
  }

  /* ---- export sweep JSON for gcdata/validate_sweep.py ---- */
  const sessions = dates.slice().sort();
  const configs = ARMS.filter((a) => a.selectable).map((arm) => {
    const perSession: Record<string, { netPts: number; riskPts: number; trades: number; wins: number; netUsd: number; riskUsd: number }> = {};
    let n = 0;
    let wins = 0;
    let netPts = 0;
    let riskPts = 0;
    for (const date of sessions) {
      const st = { netPts: 0, riskPts: 0, trades: 0, wins: 0, netUsd: 0, riskUsd: 0 };
      for (const t of tradesOf(arm.id)) if (t.date === date) {
        st.netPts += t.pnl;
        st.riskPts += t.risk;
        st.trades++;
        if (t.pnl > 0) st.wins++;
      }
      n += st.trades;
      wins += st.wins;
      netPts += st.netPts;
      riskPts += st.riskPts;
      perSession[date] = { ...st, netUsd: st.netPts * POINT_VALUE, riskUsd: st.riskPts * POINT_VALUE };
    }
    return {
      id: arm.id,
      params: { s: 1, t: 1, entry: arm.limit ? "limit@signal" : "marketable", chaseGatePts: arm.gateX, anchor: arm.anchor, drift: arm.drift, ttl: arm.limit ? arm.ttl : 0, tgtR: 1, x: HORIZON },
      perSession,
      totals: { n, wins, wr: n ? wins / n : 0, netPts, netUsd: netPts * POINT_VALUE, riskPts, riskUsd: riskPts * POINT_VALUE },
    };
  });
  const outDir = join("..", "gcdata", "data", "sweeps");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outFile = join(outDir, `momentumem-${stamp}.json`);
  await writeFile(
    outFile,
    JSON.stringify({
      family: "momentumem",
      generatedAt: new Date().toISOString(),
      script: "web/scripts/momentumEntryMechanicsStudy.ts",
      costPts: COST_PTS,
      pointValue: POINT_VALUE,
      note: "Momentum failed-flush (marketable) entry-mechanics sweep: detector MOM_PROD frozen, kind=flush only, bracket s/t from the detector (1R), only the entry layer varies. perSession netUsd/riskUsd = 1 MNQ ($2/pt), net of 0.5pt RT cost. Selection on train < 2026-01-01.",
      grid: { arms: ARMS.filter((a) => a.selectable).map((a) => a.id), split: SPLIT },
      sessions,
      nSessions: sessions.length,
      nConfigs: configs.length,
      configs,
    }),
  );
  console.log(`\nsweep exported: ${outFile}`);
  console.log(`validate: ../gcdata/.venv/bin/python ../gcdata/validate_sweep.py ${outFile} --pick ${winner.id}`);

  /* ---- 2026-10-13/14 live-session exhibit (4 cards on candles_1m bars) ---- */
  if (process.env.DATABASE_URL) {
    console.log("\n=== EXHIBIT: 2026-10-13/14 live session (candles_1m bars) ===");
    const bars = await loadExhibitBars();
    console.log(`bars: ${bars.length} · ${bars[0].t} → ${bars[bars.length - 1].t}`);
    const cards = [
      { t: "18:20", dir: "long" as const, entry: 30780.375, stop: 30773.5, target: 30787.25, risk: 6.875 },
      { t: "18:36", dir: "long" as const, entry: 30801.625, stop: 30796.0, target: 30807.25, risk: 5.625 },
      { t: "19:00", dir: "short" as const, entry: 30807.875, stop: 30812.25, target: 30803.5, risk: 4.375 },
      { t: "01:45", dir: "short" as const, entry: 30784.75, stop: 30791.25, target: 30778.25, risk: 6.5 },
    ];
    const armIds = ["live", "flushLimit", "gateX1", "gateX2", "gateX3", "gateX5", "anchor", "both"];
    console.log(
      "(replay convention: the marketable fill is the bar+1 mid — the live pipeline adds ~32-57 s of bar→dispatch staleness, so the real fills drift past bar+1; the OBSERVED row is the truth for the live arm)",
    );
    for (const c of cards) {
      const obs =
        c.t === "18:20" ? { fill: 30791.25, exit: 30790.75, pnl: -0.5 } :
        c.t === "18:36" ? { fill: 30810.25, exit: 30809.75, pnl: -0.5 } :
        c.t === "19:00" ? { fill: 30796.0, exit: 30796.5, pnl: -0.5 } :
        { fill: 30778.75, exit: 30778.25, pnl: 0.5 };
      console.log(
        `\ncard ${c.t} ${c.dir} entry=${c.entry} stop=${c.stop} target=${c.target} · planned risk ${c.risk.toFixed(2)} pts`,
      );
      console.log(`  OBSERVED  | fill=${obs.fill.toFixed(2)} exit=${obs.exit.toFixed(2)} | pnl ${obs.pnl.toFixed(2).padStart(6)} pts (gross) · held ${c.t === "18:20" ? "93 s" : c.t === "18:36" ? "<1 s" : c.t === "19:00" ? "~1 s" : "47 ms"}`);
      for (const id of armIds) {
        const arm = ARMS[armIdx(id)];
        const r = exhibitReplay(bars, c, arm);
        console.log(
          `  ${id.padEnd(9)} | ${r.hit.padEnd(7)} fill=${r.fillBar >= 0 ? r.fill.toFixed(2) : "—".padEnd(8)} @bar+${r.fillBar >= 0 ? String(r.fillBar - bars.findIndex((b) => b.t === c.t)) : "—"} | pnl ${r.pnl.toFixed(2).padStart(6)} pts`,
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
