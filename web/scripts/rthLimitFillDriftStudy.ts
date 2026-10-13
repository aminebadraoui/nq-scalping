/* ------------------------------------------------------------------ *
 * RTH LIMIT-FILL DRIFT STUDY — the fill-then-instant-stop problem
 * (standalone; 2026-10-13). Replays the RTH detector (SOFT_PROD, frozen)
 * with the LIVE resting-limit entry config (RTH_LIMIT_STOP_MULT 0.5,
 * RTH_LIMIT_TARGET_R 2.5, TTL 9 bars) over the full session archive and
 * varies ONLY the entry-mechanics layer:
 *
 *   live      — resting limit @ signal, crossed-stop + crossed-limit(1pt)
 *               gates, signal-anchored brackets (the live behavior)
 *   gateX{n}  — + approach-side gate: skip dispatch when the tape sits
 *               within n pts of the limit (the fills about to happen)
 *   anchor    — brackets rebuilt from the ACTUAL fill (planned risk kept)
 *   off{n}    — limit placed n pts worse (short: higher), bounce must
 *               prove itself
 *   market    — marketable fill at the dispatch tape (next-bar mid)
 *
 * Fill model: limit fills at limit-or-better (bar open, mid fallback);
 * the drift-sensitivity arms (drift 1 / 2.5 pts adverse) model the live
 * observed fill drift (live 14-trade avg entry-adverse = −2.37 pts;
 * the 3 fresh 2026-10-13 fills = −2.66 avg). Exit scan is pessimistic
 * same-bar INCLUDING the fill bar, stop-first, 0.5 pt cost inside P&L,
 * 60-bar time exit, one-trade-at-a-time (full-window occupancy).
 *
 * Emits: standard T1/T2/T4 + verdict (consolidated engine), a sweep
 * JSON in the exportSweep contract for gcdata/validate_sweep.py (DSR/
 * PBO), and the 3-card 2026-10-13 exhibit replayed on the live session
 * bars from Neon candles_1m.
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/rthLimitFillDriftStudy.ts [--quick]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { stopCrossedAtDispatch } from "../lib/crossTrade";
import { coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const CONCURRENCY = 8;
const HORIZON = 60;
const COST_PTS = 0.5; // round-trip, inside the P&L (house standard)
const STOP_MULT = 0.5; // live RTH_LIMIT_STOP_MULT
const TARGET_R = 2.5; // live RTH_LIMIT_TARGET_R
const SPLIT = "2026-01-01"; // 472 train / 183 test (≈70/30 by date)
const POINT_VALUE = 2;

type Arm = {
  id: string;
  kind: "limit" | "market";
  ttl: number;
  approachX: number; // approach-side gate pts (0 = live)
  anchor: boolean;
  offset: number; // limit offset pts, worse side
  drift: number; // adverse fill-drift model pts
  selectable: boolean; // in the DSR/PBO selection grid
};
type Trade = { date: string; pnl: number; risk: number };

const ARMS: Arm[] = [
  { id: "live", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 0, drift: 0, selectable: true },
  { id: "gateX1", kind: "limit", ttl: 9, approachX: 1, anchor: false, offset: 0, drift: 0, selectable: true },
  { id: "gateX2", kind: "limit", ttl: 9, approachX: 2, anchor: false, offset: 0, drift: 0, selectable: true },
  { id: "gateX3", kind: "limit", ttl: 9, approachX: 3, anchor: false, offset: 0, drift: 0, selectable: true },
  { id: "gateX5", kind: "limit", ttl: 9, approachX: 5, anchor: false, offset: 0, drift: 0, selectable: true },
  { id: "anchor", kind: "limit", ttl: 9, approachX: 0, anchor: true, offset: 0, drift: 0, selectable: true },
  { id: "off0.5", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 0.5, drift: 0, selectable: true },
  { id: "off1", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 1, drift: 0, selectable: true },
  { id: "off2", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 2, drift: 0, selectable: true },
  { id: "off3", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 3, drift: 0, selectable: true },
  { id: "market", kind: "market", ttl: 0, approachX: 0, anchor: false, offset: 0, drift: 0, selectable: true },
  // ---- fill-drift sensitivity (NOT in the selection grid) ----
  { id: "live_d1", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 0, drift: 1, selectable: false },
  { id: "live_d2.5", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 0, drift: 2.5, selectable: false },
  { id: "anchor_d1", kind: "limit", ttl: 9, approachX: 0, anchor: true, offset: 0, drift: 1, selectable: false },
  { id: "anchor_d2.5", kind: "limit", ttl: 9, approachX: 0, anchor: true, offset: 0, drift: 2.5, selectable: false },
  { id: "off1_d1", kind: "limit", ttl: 9, approachX: 0, anchor: false, offset: 1, drift: 1, selectable: false },
  { id: "gateX2_d1", kind: "limit", ttl: 9, approachX: 2, anchor: false, offset: 0, drift: 1, selectable: false },
  { id: "market_d1", kind: "market", ttl: 0, approachX: 0, anchor: false, offset: 0, drift: 1, selectable: false },
  { id: "live_ttl5", kind: "limit", ttl: 5, approachX: 0, anchor: false, offset: 0, drift: 0, selectable: false },
];

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

/** dispatch tape = next-bar mid (the study's drift measurement bar) */
const dispatchTape = (minutes: MomMinute[], sig: MomentumSignal): number | null => {
  const nb = minutes[sig.entryIdx + 1];
  return nb ? midOf(nb) : null;
};

/** dispatch gates: crossed-stop, crossed-limit (through by ≥1pt), and the
 *  approach-side gate (tape within X pts of the limit on the approach
 *  side — the fills that are about to happen). */
function gatedAtDispatch(dir: "long" | "short", entry: number, stop: number, tape: number, arm: Arm): boolean {
  if (stopCrossedAtDispatch(dir, stop, tape) === true) return true; // naked-fill guard (live)
  if (dir === "long" ? tape < entry - 1 : tape > entry + 1) return true; // crossed-limit (live, 1pt)
  if (arm.approachX > 0) {
    if (dir === "long" ? tape <= entry + arm.approachX : tape >= entry - arm.approachX) return true;
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
    const risk = s.risk * STOP_MULT;
    const tape = dispatchTape(minutes, s);
    if (tape === null) continue;

    if (arm.kind === "market") {
      const stop = s.entry - dir * risk;
      const target = s.entry + dir * risk * TARGET_R;
      const fill = tape - dir * arm.drift; // adverse drift = worse side of the tape
      const pnl = scoreFromFill(minutes, s, dir, fill, s.entryIdx + 1, stop, target);
      out.push({ date, pnl, risk });
      openUntil = s.entryIdx + HORIZON;
      continue;
    }

    // ---- resting limit ----
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * TARGET_R;
    if (gatedAtDispatch(s.dir, s.entry, stop, tape, arm)) continue;
    const limit = s.entry - dir * arm.offset; // worse side: long lower, short higher
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + arm.ttl);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      const touched = dir > 0 ? b.low <= limit : b.high >= limit;
      if (!touched) continue;
      fillBar = j;
      const open = openOf(b);
      fill = dir > 0 ? Math.min(open, limit) : Math.max(open, limit);
      fill += -dir * arm.drift; // adverse drift model (0 for the base arms)
      break;
    }
    if (fillBar < 0) continue; // expired — no trade, no window consumed
    const bstop = arm.anchor ? fill - dir * risk : stop;
    const btarget = arm.anchor ? fill + dir * risk * TARGET_R : target;
    const pnl = scoreFromFill(minutes, s, dir, fill, fillBar, bstop, btarget);
    out.push({ date, pnl, risk });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

/* ---------------- live session exhibit (candles_1m, Tuesday 2026-10-13) ---------------- */

export type ExhibitBar = { t: string; high: number; low: number };
const ET_OFFSET_MS = 4 * 3600_000; // EDT in October

export async function loadExhibitBars(): Promise<ExhibitBar[]> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 2 });
  try {
    const rows = (await sql`
      select ts, h, l from candles_1m
      where date = '2026-10-13' and session = 'ETH'
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

  if (arm.kind === "market") {
    const fill = tape - dir * arm.drift;
    const stop = arm.anchor ? fill - dir * card.risk : card.stop;
    const target = arm.anchor ? fill + dir * card.risk * TARGET_R : card.target;
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

  if (gatedAtDispatch(card.dir, card.entry, card.stop, tape, arm)) return { fill: 0, fillBar: -1, exit: 0, hit: "gated", pnl: 0 };
  const limit = card.entry - dir * arm.offset; // worse side: long lower, short higher
  const endTtl = Math.min(bars.length - 1, idx + arm.ttl);
  let fillBar = -1;
  let fill = 0;
  for (let j = idx + 1; j <= endTtl; j++) {
    const touched = dir > 0 ? bars[j].low <= limit : bars[j].high >= limit;
    if (!touched) continue;
    fillBar = j;
    const open = (bars[j].high + bars[j].low) / 2;
    fill = dir > 0 ? Math.min(open, limit) : Math.max(open, limit);
    fill += -dir * arm.drift;
    break;
  }
  if (fillBar < 0) return { fill: 0, fillBar: -1, exit: 0, hit: "expired", pnl: 0 };
  const stop = arm.anchor ? fill - dir * card.risk : card.stop;
  const target = arm.anchor ? fill + dir * card.risk * TARGET_R : card.target;
  const end = Math.min(bars.length - 1, idx + HORIZON);
  let exit = (bars[end].high + bars[end].low) / 2;
  let hit: "stop" | "target" | "time" = "time";
  for (let j = fillBar; j <= end; j++) {
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
  return { fill, fillBar, exit, hit, pnl: (exit - fill) * dir - COST_PTS };
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
  console.log(`RTH limit-fill drift study · ${dates.length} sessions · split ${SPLIT} · ${ARMS.length} arms`);

  const perArm: Trade[][] = ARMS.map(() => []);
  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs = detectSoftMomentum(minutes, SOFT_PROD);
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
  console.log(`\nwalk-forward winner: ${winner.id}\n`);

  /* ---- T1: primary (winner) + baseline ----
   * NOTE: this scorer keeps the fill model inside the pnl and applies the
   * 0.5 pt cost per trade — engine stats run on NET points. */
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
    ARMS.filter((a) => a.selectable || a.id === "live_ttl5").map((arm) => {
      const all = eng(tradesOf(arm.id));
      const tr = coreStats(all.filter((t) => t.date < SPLIT));
      const te = coreStats(all.filter((t) => t.date >= SPLIT));
      return {
        rule: `${arm.id}${arm.id === "live" ? " (live behavior)" : ""}`,
        n: all.length >= 0 ? te.n : 0,
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
    { stage: "eval (baseline live)", sim: vLive.evalSim, note: "live limit-entry behavior" },
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

  /* ---- fill-drift sensitivity (the drift-model re-fit inspection) ---- */
  console.log("\n=== FILL-DRIFT SENSITIVITY (adverse fill drift 0 → 2.5 pts) ===");
  for (const id of ["live", "live_d1", "live_d2.5", "anchor", "anchor_d1", "anchor_d2.5", "off1", "off1_d1", "gateX2", "gateX2_d1", "market", "market_d1"]) {
    const all = eng(tradesOf(id));
    const cs = coreStats(all);
    console.log(
      `${id.padEnd(11)} | n=${String(cs.n).padStart(5)} wr=${cs.wr.toFixed(1).padStart(5)}% pf=${Number.isFinite(cs.pf) ? cs.pf.toFixed(2) : "inf"} exp=${cs.expPts.toFixed(2).padStart(6)}pts expR=${cs.expR.toFixed(2).padStart(5)} maxDD=${cs.maxDdPts.toFixed(0).padStart(5)}pts`,
    );
  }

  /* ---- export sweep JSON for gcdata/validate_sweep.py ---- */
  const sessions = dates.slice().sort();
  const configs = ARMS.filter((a) => a.selectable || a.id === "live_ttl5").map((arm) => {
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
      params: { s: STOP_MULT, t: TARGET_R, x: HORIZON, entry: arm.kind, approachGatePts: arm.approachX, anchor: arm.anchor, offset: arm.offset, drift: arm.drift, ttl: arm.ttl },
      perSession,
      totals: { n, wins, wr: n ? wins / n : 0, netPts, netUsd: netPts * POINT_VALUE, riskPts, riskUsd: riskPts * POINT_VALUE },
    };
  });
  const outDir = join("..", "gcdata", "data", "sweeps");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outFile = join(outDir, `rthlimitfill-${stamp}.json`);
  await writeFile(
    outFile,
    JSON.stringify({
      family: "rthlimitfill",
      generatedAt: new Date().toISOString(),
      script: "web/scripts/rthLimitFillDriftStudy.ts",
      costPts: COST_PTS,
      pointValue: POINT_VALUE,
      note: "RTH resting-limit entry-mechanics sweep: detector SOFT_PROD frozen, bracket s0.5/t2.5 frozen, only the entry layer varies. perSession netUsd/riskUsd = 1 MNQ ($2/pt), net of 0.5pt RT cost. Selection on train < 2026-01-01.",
      grid: { arms: ARMS.filter((a) => a.selectable || a.id === "live_ttl5").map((a) => a.id), split: SPLIT },
      sessions,
      nSessions: sessions.length,
      nConfigs: configs.length,
      configs,
    }),
  );
  console.log(`\nsweep exported: ${outFile}`);
  console.log(`validate: ../gcdata/.venv/bin/python ../gcdata/validate_sweep.py ${outFile} --pick ${winner.id}`);

  /* ---- 2026-10-13 live-session exhibit (3 cards on candles_1m bars) ---- */
  if (process.env.DATABASE_URL) {
    console.log("\n=== EXHIBIT: 2026-10-13 live session (candles_1m bars) ===");
    const bars = await loadExhibitBars();
    console.log(`bars: ${bars.length} · ${bars[0].t} → ${bars[bars.length - 1].t}`);
    const cards = [
      { t: "10:16", dir: "short" as const, entry: 30786.13, stop: 30792.44, target: 30770.34, risk: 6.3125 },
      { t: "10:25", dir: "short" as const, entry: 30773.63, stop: 30780.94, target: 30755.34, risk: 7.3125 },
      { t: "10:59", dir: "short" as const, entry: 30704.75, stop: 30709.00, target: 30694.13, risk: 4.25 },
    ];
    const armIds = ["live", "gateX1", "gateX2", "gateX3", "gateX5", "anchor", "off0.5", "off1", "off2", "off3", "market", "live_ttl5"];
    console.log(
      "(replay convention: the limit is live from bar+1 and the dispatch tape is the bar+1 mid — the live pipeline adds 24-55 s of latency, so bar+1 touches that precede the order do not fill live; the OBSERVED row is the truth for the live arm)",
    );
    for (const c of cards) {
      const obs = c.t === "10:16" ? { fill: 30787.75, exit: 30792.75, pnl: -5.0 } : c.t === "10:25" ? { fill: 30777.25, exit: 30781.0, pnl: -3.75 } : { fill: 30707.5, exit: 30709.25, pnl: -1.75 };
      console.log(
        `\ncard ${c.t} short entry=${c.entry} stop=${c.stop} target=${c.target} · planned stop ${c.risk.toFixed(2)} pts`,
      );
      console.log(
        `  OBSERVED  | stop    fill=${obs.fill.toFixed(2)} exit=${obs.exit.toFixed(2)} | pnl ${obs.pnl.toFixed(2).padStart(6)} pts · effective stop ${(Math.abs(obs.fill - c.stop)).toFixed(2)} pts (${(100 - (Math.abs(obs.fill - c.stop) / c.risk) * 100).toFixed(0)}% of planned) · held ${c.t === "10:16" ? "1 s" : c.t === "10:25" ? "3 s" : "1.2 s"}`,
      );
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
