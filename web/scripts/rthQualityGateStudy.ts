/* ------------------------------------------------------------------ *
 * RTH QUALITY-GATE STUDY — should the live first-3-cards-per-day cap
 * (RTH_MAX_CARDS_PER_DAY=3) be replaced or augmented by a setup-quality
 * gate built from the per-card chips?
 *
 * Extension of the named RTH campaign (scripts/rthOptimizer.ts) and the
 * cap studies (scripts/gapOnlyValidation.ts · scripts/rthCapScratch.ts):
 * the same SOFT_PROD detector, the same live-style limit-entry replay
 * (resting limit at the signal price, TTL 9 bars, fill at the touch
 * bar's open clamped to the limit — rthCapScratch's live model), the
 * live rthLimitParams bracket (0.5× stop, 2.5R target), 60-bar horizon,
 * pessimistic stop-first first-touch exit, 0.95 pt measured round-trip
 * cost. NO one-at-a-time block — the live feed dispatches every card
 * independently and the cap counts SENT cards per session day.
 *
 * Policies compared (selection layer ONLY — everything else frozen):
 *   first3   current live baseline: first 3 fired cards per day
 *   top3     top 3 per day by quality score (ties: earlier card wins)
 *   theta_θ  no count cap: every card with score >= θ trades
 *   hyb_θ    cap 3 AND floor score >= θ (below-floor cards are skipped
 *            WITHOUT consuming a cap slot; the cap still bounds risk)
 *   nocap    reference: every card (no selection at all)
 *
 * Quality score (pre-registered component weights from PRIOR studies,
 * every component computable at card time from the archive — no
 * lookahead; live-only chips (esRs, walls, DOM) are excluded by design):
 *   +1  targetCrossRound   (round-number study: 78.8% WR / PF 3.41 vs
 *                           76.5% / 2.80, n=509 — "algos print the number")
 *   −1  entryAtRound       (same study: 76.2% vs 76.7% WR, 10% vs 5%
 *                           stop-run share, n=206 — weak, both negative)
 *   −2  gapInPath          (gap-proximity study: 57.1% WR / PF 1.12, n=35)
 *   nearestUnfilledGap     (gap study buckets): >30 pt or none → +1 ·
 *                           10–30 pt → −1 · ≤10 pt → 0
 *   vol/medVol             (detector's own 0.5× gate): ≥0.8 → +1 ·
 *                           0.65–0.8 → 0 · <0.65 → −1
 *   +1  breakRangeR ≥ 1.5  (quality-filter-sweep: ATR-range is the best
 *                           footprint quality gate for the momentum
 *                           family; SOFT_PROD already requires ≥ 1.0)
 *   stopAtRound            weight 0 ON PURPOSE — the round-number study
 *                           FALSIFIED the stop-hunt claim (74.3% vs 76.8%,
 *                           n=202, "consistent with noise")
 *
 * Study design: train on the first 70% of archive dates, evaluate on the
 * last 30% (frozen rth holdout in holdouts.json is pinned to the
 * exit-config study — single-use, NOT re-declared here). Train-stage
 * selection is constrained (train eval PASS + train PF >= 0.9 × first3
 * train PF; pick = max train net pts). The θ-grid sweep JSON (train
 * sessions only) feeds gcdata/validate_sweep.py for DSR/PBO/PSR/MinTRL.
 *
 * Run from web/:
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/rthQualityGateStudy.ts [--split YYYY-MM-DD] [--max N]
 * ------------------------------------------------------------------ */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount } from "../lib/propAccount";
import { roundNumberChips } from "../lib/roundNumbers";
import { gapChips, type GapBar } from "../lib/gapTracker";
import {
  coreStats,
  propViability,
  wilson95,
  renderT1,
  renderT2,
  renderT4,
  renderVerdict,
  type EngineTrade,
} from "../lib/backtestEngine";

const CONCURRENCY = 8;
const HORIZON = 60; // bars hold cap from the ENTRY bar (rthCapScratch convention)
const TTL = 9; // bars — rthLimitParams ttlMs 9 min
const STOP_MULT = 0.5; // rthLimitParams stopMult
const TARGET_R = 2.5; // rthLimitParams targetR
const COST = 0.95; // measured RTH round-trip (TRADE_REVIEW_2026-10-02)
const CAP = 3; // RTH_MAX_CARDS_PER_DAY
const THETAS = [-1, 0, 1, 2, 3];
const HYB_FLOORS = [0, 1, 2];

type Trade = { date: string; pnl: number; risk: number };
type Card = {
  date: string; // s.d — the feed calendar date of the entry bar (live cap key)
  ord: number; // per-day fired order (1-based)
  t: string;
  hourET: number;
  sig: MomentumSignal;
  score: number;
  comps: Record<string, number>;
  trade: Trade | null;
};

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

/* ---------------- quality score (pre-registered) ---------------- */

function qualityScore(s: MomentumSignal, minutes: MomMinute[]): { score: number; comps: Record<string, number> } {
  const rn = roundNumberChips({ entry: s.entry, stop: s.stop, target: s.target, dir: s.dir });
  const comps: Record<string, number> = {
    targetCrossRound: rn.features.targetCrossRound ? 1 : 0,
    entryAtRound: rn.features.entryAtRound ? -1 : 0,
  };
  // gap chips from the bars known through the card bar (no lookahead)
  const bars: GapBar[] = minutes.slice(0, s.entryIdx + 1).map((m) => ({ t: m.t, high: m.high, low: m.low }));
  const g = gapChips(bars, { entry: s.entry, target: s.target, dir: s.dir });
  comps.gapInPath = g.features.gapInPath ? -2 : 0;
  const nu = g.features.nearestUnfilledGap;
  comps.nearestGap = nu === null || nu === undefined ? 0 : nu > 30 ? 1 : nu > 10 ? -1 : 0;
  const vr = s.medVol > 0 ? s.breakVol / s.medVol : 0.5;
  comps.volMed = vr >= 0.8 ? 1 : vr < 0.65 ? -1 : 0;
  comps.rangeR = s.breakRangeR >= 1.5 ? 1 : 0;
  return { score: comps.targetCrossRound + comps.entryAtRound + comps.gapInPath + comps.nearestGap + comps.volMed + comps.rangeR, comps };
}

/* ---------------- live-style limit-entry card replay ---------------- */

function replayCards(minutes: MomMinute[], sigs: MomentumSignal[], date: string): Card[] {
  const out: Card[] = [];
  let ord = 0;
  for (const s of [...sigs].sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const risk = s.risk * STOP_MULT;
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * TARGET_R;
    if (!(dir > 0 ? stop < s.entry && s.entry < target : target < s.entry && s.entry < stop)) continue;
    ord++;
    const { score, comps } = qualityScore(s, minutes);
    const card: Card = { date, ord, t: s.t, hourET: s.hourET, sig: s, score, comps, trade: null };
    out.push(card);

    // resting limit at the signal price, fill-or-expire within TTL bars
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + TTL);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      if (!(dir > 0 ? b.low <= s.entry : b.high >= s.entry)) continue;
      fillBar = j;
      const open = openOf(b);
      fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
      break;
    }
    if (fillBar < 0) continue;

    // pessimistic stop-first first-touch from the fill bar; time exit at close
    const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
    let exit = closeOf(minutes[end]);
    for (let j = fillBar + 1; j <= end; j++) {
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
    card.trade = { date, pnl: (exit - fill) * dir - COST, risk };
  }
  return out;
}

/* ---------------- policies ---------------- */

type Policy = { id: string; label: string; pick: (cards: Card[]) => Card[] };

function byDay(cards: Card[]): Map<string, Card[]> {
  const m = new Map<string, Card[]>();
  for (const c of cards) {
    const a = m.get(c.date) ?? [];
    a.push(c);
    m.set(c.date, a);
  }
  for (const a of m.values()) a.sort((x, y) => x.ord - y.ord);
  return m;
}

const POLICIES: Policy[] = [
  {
    id: "first3",
    label: "first3 (live baseline)",
    pick: (cards) => [...byDay(cards).values()].flatMap((day) => day.filter((c) => c.ord <= CAP)),
  },
  {
    id: "top3",
    label: "top3 by score",
    pick: (cards) =>
      [...byDay(cards).values()].flatMap((day) =>
        [...day].sort((a, b) => b.score - a.score || a.ord - b.ord).slice(0, CAP),
      ),
  },
  ...THETAS.map((th) => ({
    id: `theta${th}`,
    label: `quality gate θ≥${th} (no cap)`,
    pick: (cards: Card[]) => cards.filter((c) => c.score >= th),
  })),
  ...HYB_FLOORS.map((th) => ({
    id: `hyb${th}`,
    label: `hybrid cap3 + floor θ≥${th}`,
    pick: (cards: Card[]) => {
      const out: Card[] = [];
      for (const day of byDay(cards).values()) {
        let traded = 0;
        for (const c of day) {
          if (c.score < th) continue; // below floor — skipped, no cap slot consumed
          if (traded >= CAP) continue;
          out.push(c);
          traded++;
        }
      }
      return out;
    },
  })),
  { id: "nocap", label: "nocap (reference)", pick: (cards) => cards },
];

const policyById = (id: string): Policy => POLICIES.find((p) => p.id === id)!;
const tradesOf = (cards: Card[], p: Policy): Trade[] => p.pick(cards).map((c) => c.trade).filter((t): t is Trade => t !== null);
const engineOf = (cards: Card[], p: Policy): EngineTrade[] =>
  tradesOf(cards, p).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));

/* ---------------- 2026-10-13 illustration (DB-recorded chips) ---------------- */

async function illustrate(): Promise<string[]> {
  const L: string[] = [];
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL ?? "", { ssl: "require", max: 1 });
    const rows = await sql`
      select time_et, side, price, stop, target, outcome, sent, reason, features
      from signals where day = '2026-10-13' order by ts`;
    await sql.end();
    if (!rows.length) return L;

    const scoreFromFeatures = (f: Record<string, unknown>): { score: number; comps: Record<string, number> } => {
      const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const nu = num(f.nearestUnfilledGap);
      const bv = num(f.breakVol) ?? 0;
      const mv = num(f.medVol) ?? 0;
      const vr = mv > 0 ? bv / mv : 0.5;
      const comps = {
        targetCrossRound: f.targetCrossRound === true ? 1 : 0,
        entryAtRound: f.entryAtRound === true ? -1 : 0,
        gapInPath: f.gapInPath === true ? -2 : 0,
        nearestGap: nu === null ? 0 : nu > 30 ? 1 : nu > 10 ? -1 : 0,
        volMed: vr >= 0.8 ? 1 : vr < 0.65 ? -1 : 0,
        rangeR: num(f.breakRangeR) !== null && (num(f.breakRangeR) as number) >= 1.5 ? 1 : 0,
      };
      return { score: Object.values(comps).reduce((a, b) => a + b, 0), comps };
    };

    L.push("");
    L.push("=== ILLUSTRATION 2026-10-13 (DB chips · observational · NO evidential weight) ===");
    L.push("| ET | side | entry | score | first3 | top3 | θ≥1 | θ≥2 | hyb(θ≥1) | DB outcome |");
    L.push("|---|---|---|---|---|---|---|---|---|---|");
    const scored: { time: string; score: number }[] = rows.map((r) => {
      const raw = r.features as unknown;
      const f = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, unknown>;
      return { time: String(r.time_et), score: scoreFromFeatures(f).score };
    });
    const top3times = new Set([...scored].sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.time));
    let hybTaken = 0;
    const taken = (cond: boolean) => (cond ? "✓" : "·");
    let ord = 0;
    for (const r of rows) {
      ord++;
      const sc = scored[ord - 1].score;
      const hybCond = sc >= 1 && hybTaken < CAP;
      if (hybCond) hybTaken++;
      L.push(
        `| ${r.time_et} | ${r.side} | ${Number(r.price).toFixed(2)} | ${sc >= 0 ? "+" : ""}${sc} | ` +
          `${taken(ord <= CAP)} | ${taken(top3times.has(String(r.time_et)))} | ` +
          `${taken(sc >= 1)} | ${taken(sc >= 2)} | ${taken(hybCond)} | ` +
          `${String(r.outcome ?? "—")} |`,
      );
    }
    L.push("");
    L.push(
      "Live fill facts (verified, operator record): the 3 executed (first-3) were the day's only losers — " +
        "10:16 filled 30787.75, stopped 30792.75 in ~1s (−$83.30); 10:25 filled +3.62 pts adverse, stopped in 3s (−$56.40); " +
        "10:59 filled +2.75 pts adverse, stopped in 1.2s (−$43.20). The 7 cap-skipped cards (11:08–15:35) all reached target observationally (+56.6 pts combined).",
    );
  } catch (e) {
    L.push("");
    L.push(`[illustration skipped — signals DB not reachable: ${(e as Error).message}]`);
  }
  return L;
}

/* ---------------- main ---------------- */

async function main() {
  const args = process.argv.slice(2);
  const maxN = args.includes("--max") ? parseInt(args[args.indexOf("--max") + 1], 10) : 0;

  const dates = (await archiveDates()).slice(0, maxN || undefined);
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const splitArg = args.includes("--split") ? args[args.indexOf("--split") + 1] : undefined;
  const splitDate = splitArg ?? dates[Math.floor(dates.length * 0.7)];
  const trainDates = dates.filter((d) => d < splitDate);
  const testDates = dates.filter((d) => d >= splitDate);
  console.log(
    `rth quality-gate study · ${dates.length} sessions (${dates[0]} → ${dates[dates.length - 1]}) · ` +
      `split ${splitDate} (train ${trainDates.length} ≈ ${((100 * trainDates.length) / dates.length).toFixed(0)}% · OOS ${testDates.length})`,
  );
  console.log(
    `replay: live-style NO-BLOCK · limit TTL ${TTL} · ${STOP_MULT}× stop · ${TARGET_R}R target · HORIZON ${HORIZON} · ${COST}pt RT cost · cap ${CAP}/day`,
  );
  console.log(
    `score: targetCrossRound +1 · entryAtRound −1 · gapInPath −2 · nearestGap(>30/none +1, 10–30 −1) · volMed(≥0.8 +1, <0.65 −1) · rangeR(≥1.5 +1) · stopAtRound 0 (falsified)`,
  );

  const cards: Card[] = [];
  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      cards.push(...replayCards(minutes, detectSoftMomentum(minutes, SOFT_PROD), date));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const filled = cards.filter((c) => c.trade !== null);
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · cards fired ${cards.length} · filled ${filled.length}`);

  /* ---- per-policy stats ---- */
  type Row = { policy: Policy; trades: Trade[]; all: ReturnType<typeof coreStats>; train: ReturnType<typeof coreStats>; test: ReturnType<typeof coreStats> };
  const rows: Row[] = POLICIES.map((p) => {
    const trades = tradesOf(cards, p);
    return {
      policy: p,
      trades,
      all: coreStats(trades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { sessionUniverse: dates }),
      train: coreStats(trades.filter((t) => t.date < splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { sessionUniverse: trainDates }),
      test: coreStats(trades.filter((t) => t.date >= splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { sessionUniverse: testDates }),
    };
  });
  const first3 = rows.find((r) => r.policy.id === "first3")!;

  /* ---- train-stage constrained selection (mirrors rthOptimizer's) ---- */
  console.log("\n=== TRAIN-STAGE SELECTION (constrained: train eval PASS + train PF ≥ 0.9 × first3) ===");
  const sel: { row: Row; pass: boolean; net: number; evalOk: boolean }[] = [];
  for (const r of rows) {
    const d = dollarize(r.trades.filter((t) => t.date < splitDate).map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
    const acc = simulateAccount(d, "eval");
    const evalOk = acc.breachDay === null;
    const ok = evalOk && r.train.pf >= first3.train.pf * 0.9;
    const net = d.reduce((a, t) => a + t.pnl, 0);
    sel.push({ row: r, pass: ok, net, evalOk });
    console.log(
      `  ${r.policy.id.padEnd(8)} | train n=${String(r.train.n).padStart(5)} wr=${r.train.wr.toFixed(1).padStart(5)}% pf=${r.train.pf.toFixed(2).padStart(5)} net=${r.train.netPts.toFixed(0).padStart(7)}pts | $${net.toFixed(0).padStart(8)} ${evalOk ? "PASS" : "BREACH"} ${ok ? "✓" : "✗"}`,
    );
  }
  const survivors = sel.filter((s) => s.pass);
  const pick = survivors.length
    ? survivors.sort((a, b) => b.net - a.net)[0].row
    : first3; // nothing passes the train constraint → the baseline stands
  console.log(`PICK: ${pick.policy.id} (${pick.policy.label})${survivors.length ? "" : " — NO candidate passed; baseline retained"}`);

  /* ---- OOS + cost ladder ---- */
  console.log("\n=== OOS (test window) ===");
  for (const r of rows) {
    console.log(`  ${r.policy.id.padEnd(8)} | test n=${String(r.test.n).padStart(4)} wr=${r.test.wr.toFixed(1).padStart(5)}% pf=${r.test.pf.toFixed(2).padStart(5)} exp=${r.test.expPts >= 0 ? "+" : ""}${r.test.expPts.toFixed(2)} net=${r.test.netPts.toFixed(0).padStart(6)}pts | maxDD ${r.test.maxDdPts.toFixed(1)}`);
  }

  console.log("\n=== COST LADDER (pick vs baseline, all sessions) ===");
  for (const cost of [0.5, 0.95, 1.0]) {
    for (const id of [...new Set(["first3", pick.policy.id])]) {
      const p = policyById(id);
      const ts = tradesOf(cards, p).map((t) => ({ date: t.date, pnl: t.pnl + (COST - cost), risk: t.risk }));
      const cs = coreStats(ts);
      console.log(`  ${id.padEnd(8)} @${cost.toFixed(2)}pt | n=${String(cs.n).padStart(5)} wr=${cs.wr.toFixed(1).padStart(5)}% pf=${cs.pf.toFixed(2).padStart(5)} exp=${cs.expPts >= 0 ? "+" : ""}${cs.expPts.toFixed(2)} net=${cs.netPts.toFixed(0).padStart(7)}pts`);
    }
  }

  /* ---- hour-of-day diagnostic (nocap filled trades — descriptive, NOT a score component) ---- */
  console.log("\n=== HOUR-OF-DAY DIAGNOSTIC (filled cards, all policies' trades · descriptive only) ===");
  for (const h of [9, 10, 11, 12, 13, 14, 15]) {
    const hTrades = filled.filter((c) => c.hourET === h && c.trade !== null).map((c) => c.trade as Trade);
    const cs = coreStats(hTrades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    if (!cs.n) continue;
    console.log(`  hour ${h}: n=${String(cs.n).padStart(5)} wr=${cs.wr.toFixed(1).padStart(5)}% pf=${cs.pf.toFixed(2).padStart(5)} exp=${cs.expPts >= 0 ? "+" : ""}${cs.expPts.toFixed(2)}`);
  }

  /* ---- sweep JSON (train sessions only) for validate_sweep.py ---- */
  const sweepConfigs = ["first3", "top3", ...THETAS.map((th) => `theta${th}`), ...HYB_FLOORS.map((th) => `hyb${th}`)];
  const sweepDates = trainDates.slice().sort();
  const configs = sweepConfigs.map((id) => {
    const p = policyById(id);
    const perSession: Record<string, { netPts: number; riskPts: number; trades: number; wins: number; netUsd: number; riskUsd: number }> = {};
    const bucket = new Map<string, { netPts: number; riskPts: number; trades: number; wins: number }>();
    for (const t of tradesOf(cards, p).filter((t) => t.date < splitDate)) {
      const e = bucket.get(t.date) ?? { netPts: 0, riskPts: 0, trades: 0, wins: 0 };
      e.netPts += t.pnl;
      e.riskPts += t.risk;
      e.trades++;
      if (t.pnl > 0) e.wins++;
      bucket.set(t.date, e);
    }
    let n = 0, wins = 0, netPts = 0, riskPts = 0;
    for (const d of sweepDates) {
      const st = bucket.get(d) ?? { netPts: 0, riskPts: 0, trades: 0, wins: 0 };
      perSession[d] = { ...st, netUsd: st.netPts * 2, riskUsd: st.riskPts * 2 };
      n += st.trades;
      wins += st.wins;
      netPts += st.netPts;
      riskPts += st.riskPts;
    }
    const isThreshold = id.startsWith("theta");
    const capN = id === "first3" || id === "top3" ? CAP : id.startsWith("hyb") ? CAP : 0;
    const theta = id === "first3" || id === "top3" ? -9 : parseInt(id.replace(/[^0-9-]/g, ""), 10);
    return {
      id,
      params: { s: capN, t: theta, x: 60, label: p.label, note: isThreshold ? "no count cap; score >= t" : "see label" },
      perSession,
      totals: { n, wins, wr: n ? wins / n : 0, netPts, netUsd: netPts * 2, riskPts, riskUsd: riskPts * 2 },
    };
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outDir = join(process.cwd(), "../gcdata/data/sweeps");
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `rthqg-${stamp}.json`);
  await writeFile(
    outFile,
    JSON.stringify({
      family: "rth-quality-gate",
      generatedAt: new Date().toISOString(),
      script: "web/scripts/rthQualityGateStudy.ts",
      costPts: COST,
      pointValue: 2,
      splitDate,
      note:
        "perSession netUsd/riskUsd = 1 MNQ contract ($2/pt). TRAIN-WINDOW sessions only (dates < splitDate) — OOS is handled by the study script. " +
        "Live-style no-block limit-entry replay (TTL 9, 0.5x stop, 2.5R target, 60-bar horizon, 0.95pt cost). " +
        "params: s = per-day cap (0 = no cap), t = quality floor θ (−9 sentinel for first3/top3), x unused.",
      grid: { caps: [0, CAP], thetas: THETAS, hybFloors: HYB_FLOORS },
      sessions: sweepDates,
      nSessions: sweepDates.length,
      nConfigs: configs.length,
      configs,
    }),
  );
  console.log(`sweep JSON: ${outFile} (${configs.length} configs × ${sweepDates.length} train sessions)`);

  /* ---- STANDARD REPORT (consolidated engine) ---- */
  const order = ["first3", pick.policy.id, "top3", ...THETAS.map((th) => `theta${th}`), ...HYB_FLOORS.map((th) => `hyb${th}`), "nocap"];
  const unique = [...new Set(order)];
  const t1rows = unique.flatMap((id) => {
    const r = rows.find((x) => x.policy.id === id)!;
    const mark = id === "first3" ? " (baseline)" : id === pick.policy.id ? " (PICK)" : "";
    return [
      { label: `${id}${mark} — all`, stats: r.all },
      { label: `${id}${mark} — train`, stats: r.train },
      { label: `${id}${mark} — test`, stats: r.test },
    ];
  });
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1(t1rows));

  const t2rows = unique.map((id) => {
    const r = rows.find((x) => x.policy.id === id)!;
    return {
      rule: `${id}${id === pick.policy.id ? " (PICK)" : ""}`,
      n: r.all.n,
      wr: r.all.wr,
      ci: wilson95(r.all.wins, r.all.n),
      pf: r.all.pf,
      expPts: r.all.expPts,
      trainTest: `${r.train.wr.toFixed(0)}% / ${r.test.wr.toFixed(0)}%`,
      compare: id === "first3" ? "—" : `first3 all WR ${first3.all.wr.toFixed(0)}% · exp ${first3.all.expPts >= 0 ? "+" : ""}${first3.all.expPts.toFixed(2)}`,
    };
  });
  console.log("\n" + renderT2(t2rows));

  const pickTrades = engineOf(cards, pick.policy);
  const baseTrades = engineOf(cards, policyById("first3"));
  const vPick = propViability(pickTrades, { splitDate });
  const vBase = propViability(baseTrades, { splitDate });
  console.log(`\nT4 — PICK ${pick.policy.id}${pick.policy.id === "first3" ? " (baseline)" : ""}:`);
  console.log(renderT4(vPick));
  console.log(`\nT4 — baseline first3:`);
  console.log(renderT4(vBase));
  // the best OOS candidate (highest test exp among non-baseline policies) —
  // the report's "best policy vs baseline" T4 pair
  const bestOos = rows
    .filter((r) => r.policy.id !== "first3")
    .sort((a, b) => b.test.expPts - a.test.expPts)[0];
  if (bestOos && bestOos.policy.id !== pick.policy.id) {
    const vOos = propViability(engineOf(cards, bestOos.policy), { splitDate });
    console.log(`\nT4 — best-OOS candidate ${bestOos.policy.id} (test exp ${bestOos.test.expPts >= 0 ? "+" : ""}${bestOos.test.expPts.toFixed(2)}):`);
    console.log(renderT4(vOos));
  }

  const pickAll = rows.find((r) => r.policy.id === pick.policy.id)!.all;
  const pickTrain = rows.find((r) => r.policy.id === pick.policy.id)!.train;
  const pickTest = rows.find((r) => r.policy.id === pick.policy.id)!.test;
  const lift = pickTest.expPts - first3.test.expPts;
  console.log(
    "\n" +
      renderVerdict({
        edge: pickTest.expR > 0 && pickTest.n >= 30 ? "real" : pickTest.expR > 0 ? "unproven (thin OOS n)" : "absent",
        significance: "see T3 (validate_sweep.py on the θ-grid)",
        stability: `train/test WR ${pickTrain.wr.toFixed(1)}/${pickTest.wr.toFixed(1)} · OOS lift vs first3 ${lift >= 0 ? "+" : ""}${lift.toFixed(2)} pts/trade`,
        holdout: "n/a (frozen rth holdout is pinned to the exit-config study; OOS = last 30% by date)",
        viability:
          vPick.pPass === null
            ? "n/a"
            : `${vPick.pPass >= 0.9 ? "PASS" : vPick.pPass >= 0.7 ? "weak" : "FAIL"} (P=${vPick.pPass.toFixed(2)})`,
      }),
  );
  console.log(
    `\npick all-history: n=${pickAll.n} wr=${pickAll.wr.toFixed(1)}% pf=${pickAll.pf.toFixed(2)} exp=${pickAll.expPts >= 0 ? "+" : ""}${pickAll.expPts.toFixed(2)} pts · ` +
      `baseline all-history: n=${first3.all.n} wr=${first3.all.wr.toFixed(1)}% pf=${first3.all.pf.toFixed(2)} exp=${first3.all.expPts >= 0 ? "+" : ""}${first3.all.expPts.toFixed(2)} pts`,
  );

  for (const line of await illustrate()) console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
