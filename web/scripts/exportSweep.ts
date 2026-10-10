/* ------------------------------------------------------------------ *
 * EXPORT SWEEP — runs one family's STOP × TARGET × TIME grid over the
 * full session archive and emits a machine-readable JSON that the
 * Python validation layer consumes:
 *
 *   gcdata/validate_sweep.py  → CPCV / PBO / DSR / PSR / MinTRL
 *   gcdata/optuna_view.py     → Optuna study (viewer-only Dashboard)
 *
 * Every config gets its per-session P&L series (net pts, net USD at one
 * MNQ contract, risk pts, trade counts), so the validator can build the
 * (n_configs × n_sessions) return matrix purgedcv needs. The replay is
 * the SAME detector + bar-scoring code the other studies use — no port.
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/exportSweep.ts \
 *     --family rth --cost 0.95 [--out ../gcdata/data/sweeps]
 *
 * Families: momentum (MOM_PROD) · expansion (EXP_PROD) · rth (SOFT_PROD)
 * ------------------------------------------------------------------ */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
// consolidated engine: canonical scorer + sequential overlay (full-window
// occupancy preserved — the Python validator's input does not change)
import { scoreTrade, scoreSequential } from "../lib/backtestEngine";

const CONCURRENCY = 8;
/** MNQ point value at one contract — the validator's per-session USD series
 *  is a fixed 1-lot line; prop sizing is a separate layer. */
const POINT_VALUE = 2;
const DEFAULT_COST = 0.95; // measured round-trip, per the optimizer docs

const STOPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const TARGETS = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0];
const TIMES = [45, 60, 75, 90];
const BASE = { s: 1.0, t: 1.0, x: 60 };

type Combo = { s: number; t: number; x: number };
type SessionStat = { netPts: number; riskPts: number; trades: number; wins: number };

const FAMILIES = {
  momentum: { detect: (m: MomMinute[]) => detectMomentum(m, MOM_PROD), label: "momentum" },
  expansion: { detect: (m: MomMinute[]) => detectExpansionScalp(m, EXP_PROD), label: "expansion" },
  rth: { detect: (m: MomMinute[]) => detectSoftMomentum(m, SOFT_PROD), label: "rth" },
} as const;
type FamilyKey = keyof typeof FAMILIES;

const comboId = (c: Combo) => `s${c.s}_t${c.t}_x${c.x}`;

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, stopMult: number, targetMult: number, timeExit: number, costPts: number): { risk: number; pnl: number; heldBars: number } | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * targetMult;
  // the consolidated engine's canonical scorer (stop-first, midpoint close,
  // cost inside the P&L) — identical semantics to the former inline loop
  const sc = scoreTrade(minutes, { dir, entry, stop, target, entryIdx: sig.entryIdx, risk }, { costPts, holdBars: timeExit });
  return sc ? { risk, pnl: sc.pnl, heldBars: sc.heldBars } : null;
}

/** one-trade-at-a-time within a session — matches rthOptimizer/walkForward.
 *  Full-window occupancy (openUntil = entryIdx + timeExit), the historical
 *  convention that the Python validator's matrix was built with. */
function scoreSequentialGrid(minutes: MomMinute[], signals: MomentumSignal[], stopMult: number, targetMult: number, timeExit: number, costPts: number): { risk: number; pnl: number }[] {
  return scoreSequential(signals, (sig) => scoreSignal(minutes, sig, stopMult, targetMult, timeExit, costPts), { occupy: "full", window: timeExit });
}

async function main() {
  const args = process.argv.slice(2);
  const famArg = args.includes("--family") ? args[args.indexOf("--family") + 1] : "";
  const family = FAMILIES[famArg as FamilyKey];
  if (!family) {
    console.error(`usage: exportSweep.ts --family momentum|expansion|rth [--cost 0.95] [--out ../gcdata/data/sweeps]`);
    process.exit(1);
  }
  const costPts = args.includes("--cost") ? parseFloat(args[args.indexOf("--cost") + 1]) : DEFAULT_COST;
  // scripts run from web/ (see header) — default relative to that cwd
  const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(process.cwd(), "../gcdata/data/sweeps");

  const dates = await archiveDates();
  const combos: Combo[] = [...STOPS.flatMap((s) => TARGETS.flatMap((t) => TIMES.map((x) => ({ s, t, x })))), BASE];
  const perCombo = new Map<string, Map<string, SessionStat>>(combos.map((c) => [comboId(c), new Map()]));
  const loaded: string[] = [];

  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const signals = family.detect(minutes);
      loaded.push(date);
      for (const c of combos) {
        const trades = scoreSequentialGrid(minutes, signals, c.s, c.t, c.x, costPts);
        const bucket = perCombo.get(comboId(c))!;
        const netPts = trades.reduce((a, tr) => a + tr.pnl, 0);
        const riskPts = trades.reduce((a, tr) => a + tr.risk, 0);
        const wins = trades.filter((tr) => tr.pnl > 0).length;
        bucket.set(date, { netPts, riskPts, trades: trades.length, wins });
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`replay done: ${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded.length}/${dates.length} sessions · ${combos.length} combos · ${costPts}pt cost`);

  const sessions = loaded.slice().sort();
  const configs = combos.map((c) => {
    const bucket = perCombo.get(comboId(c))!;
    const perSession: Record<string, SessionStat & { netUsd: number; riskUsd: number }> = {};
    let n = 0, wins = 0, netPts = 0, riskPts = 0;
    for (const date of sessions) {
      const st = bucket.get(date);
      if (!st) {
        perSession[date] = { netPts: 0, riskPts: 0, trades: 0, wins: 0, netUsd: 0, riskUsd: 0 };
        continue;
      }
      n += st.trades;
      wins += st.wins;
      netPts += st.netPts;
      riskPts += st.riskPts;
      perSession[date] = { ...st, netUsd: st.netPts * POINT_VALUE, riskUsd: st.riskPts * POINT_VALUE };
    }
    const gw = netPts > 0 ? netPts : 0; // rough PF from summed points (win/loss split not exported per-trade)
    return {
      id: comboId(c),
      params: c,
      perSession,
      totals: { n, wins, wr: n ? wins / n : 0, netPts, netUsd: netPts * POINT_VALUE, riskPts, riskUsd: riskPts * POINT_VALUE },
    };
  });

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outFile = join(outDir, `${family.label}-${stamp}.json`);
  const payload = {
    family: family.label,
    generatedAt: new Date().toISOString(),
    script: "web/scripts/exportSweep.ts",
    costPts,
    pointValue: POINT_VALUE,
    note: "perSession netUsd/riskUsd = 1 MNQ contract ($2/pt). Sequential one-trade-at-a-time replay; detector = live production config.",
    grid: { stops: STOPS, targets: TARGETS, times: TIMES, base: BASE },
    sessions,
    nSessions: sessions.length,
    nConfigs: configs.length,
    configs,
  };
  await writeFile(outFile, JSON.stringify(payload));

  /* ---- trial ledger: every config ever tried, per family.
   *  Lives inside the validation route's folder (committed) so the ledger
   *  ships inside the deployed server bundle — the only mechanism the
   *  deployed image provably updates (see commit 62c9cad). ---- */
  const ledgerPath = join(process.cwd(), "app/api/backtest/validation/reports/trials.json");
  const ledger = existsSync(ledgerPath) ? JSON.parse(await readFile(ledgerPath, "utf8")) : { entries: [] };
  ledger.entries.push({
    family: family.label,
    generatedAt: new Date().toISOString(),
    file: outFile.split("/").slice(-1)[0],
    script: "web/scripts/exportSweep.ts",
    nConfigs: configs.length,
    nSessions: sessions.length,
    costPts,
    grid: { stops: STOPS, targets: TARGETS, times: TIMES, base: BASE },
  });
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 1));

  console.log(`wrote ${outFile}`);
  console.log(`ledger ${ledgerPath} · ${ledger.entries.length} entries`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
