/* ------------------------------------------------------------------ *
 * Count-frac gate study — can a count-based one-sidedness filter
 * improve the flush/expansion cards? (follow-up to countFlowStudy)
 *
 * The count-flow horse race found count-based OFI beats volume-based
 * for next-bar direction. This study measures the SIGNAL-level version:
 * a post-detection gate on the trigger bar's aligned TRADE-COUNT
 * fraction (bT/(bT+sT) for longs, mirror for shorts), applied exactly
 * like the live override gates (post-detection, fail-open, sequential
 * re-scoring). The detector's breakFrac (volume) gate is untouched —
 * this measures what count-frac ADDS on top.
 *
 * Sweep θ ∈ {0.55, 0.60, 0.65, 0.70, 0.75} per family, with the
 * promotion-contract standard per cell (vetoed trades must fail the
 * cost bar, veto budget ≤ 30%, kept cohort unhurt, prop sim PASS).
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/countFracGateStudy.ts --offline [--max N] \
 *     [--family huge_bar_expansion] [--theta 0.65 --report-json out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadSessionMinutes, archiveDates, cacheDir } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { dollarize, simulateAccount } from "../lib/propAccount";
import { scoreTrade, scoreSequential, coreStats, propViability, renderT1, renderT2, renderT4, renderVerdict, PRODUCTION_STACK } from "../lib/backtestEngine";
import { buildReport, cohortOf, type CohortStats } from "../lib/promotionGate";
import { canonicalFamily } from "../lib/strategies/aliases";const SPLIT = "2026-01-01";
const COST = 0.5;
const HOLD = 60;
const THETAS = [0.55, 0.6, 0.65, 0.7, 0.75];

type RawCandle = { t: string; high: number; low: number; total: number; buy: number; sell: number; levels: Record<string, [number, number, number, number, number]> };

async function loadRaw(date: string): Promise<RawCandle[] | null> {
  const gz = path.join(cacheDir(), `${date}_ETH.json.gz`);
  try {
    const raw = gunzipSync(await fs.readFile(gz));
    const j = JSON.parse(raw.toString("utf8")) as { candles?: RawCandle[] };
    return (j.candles ?? []).length >= 60 ? j.candles! : null;
  } catch {
    return null;
  }
}

type Scored = { date: string; pnl: number; risk: number; key: string };

function scoreList(minutes: MomMinute[], sigs: MomentumSignal[]): Scored[] {
  return scoreSequential(
    sigs,
    (s) => {
      const dir = s.dir === "long" ? 1 : -1;
      const sc = scoreTrade(
        minutes,
        { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk: Math.abs(s.entry - s.stop) },
        { costPts: COST, holdBars: HOLD },
      );
      return sc ? { ...sc, s } : null;
    },
    { occupy: "full", window: HOLD },
  ).map((o) => ({ date: o.s.d, pnl: o.pnl, risk: o.risk, key: `${o.s.d}|${o.s.entryIdx}|${o.s.dir}` }));
}

function alignedCountFrac(c: RawCandle | undefined, dir: "long" | "short"): number {
  if (!c) return 0;
  let bT = 0;
  let sT = 0;
  for (const v of Object.values(c.levels ?? {})) {
    bT += v[3];
    sT += v[4];
  }
  const tc = bT + sT;
  if (tc === 0) return 0;
  return dir === "long" ? bT / tc : sT / tc;
}

const cell = (tt: Scored[]): CohortStats => cohortOf(coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))));
const testOf = (tt: Scored[]) => cell(tt.filter((t) => t.date >= SPLIT));

async function main() {
  const argv = process.argv.slice(2);
  const grab = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const family = canonicalFamily(grab("--family") ?? "huge_bar_expansion");
  const thetaArg = grab("--theta");
  const reportJson = grab("--report-json");
  const sweepOut = grab("--sweep-out");
  const offline = argv.includes("--offline");
  const maxArg = grab("--max");
  const max = maxArg !== undefined ? Number(maxArg) : undefined;
  const detect = family === "huge_bar_expansion" ? (m: MomMinute[]) => detectExpansionScalp(m, EXP_PROD) : (m: MomMinute[]) => detectMomentum(m, MOM_PROD);

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`countFracGateStudy · ${family} · ${dates.length} sessions`);

  const base: Scored[] = [];
  const byTheta = new Map<number, { kept: Scored[]; vetoed: Scored[] }>();
  for (const th of THETAS) byTheta.set(th, { kept: [], vetoed: [] });
  /** per-θ per-session aggregates — the validator's (n_configs × n_sessions) matrix */
  const perSession = new Map<number, Map<string, { netPts: number; riskPts: number; trades: number; wins: number }>>();
  const loadedSessions: string[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date), raw: await loadRaw(date) })));
    for (const { date, minutes, raw } of sessions) {
      if (!minutes || !raw) continue;
      loadedSessions.push(date);
      const sigs = detect(minutes);
      const all = scoreList(minutes, sigs);
      base.push(...all);
      const fracAt = new Map(sigs.map((s) => [s.entryIdx, alignedCountFrac(raw[s.entryIdx], s.dir)]));
      for (const th of THETAS) {
        const kept = scoreList(minutes, sigs.filter((s) => (fracAt.get(s.entryIdx) ?? 0) >= th));
        const keptKeys = new Set(kept.map((t) => t.key));
        const cellRow = byTheta.get(th)!;
        cellRow.kept.push(...kept);
        cellRow.vetoed.push(...all.filter((t) => !keptKeys.has(t.key)));
        const dayKept = kept.filter((t) => t.date === date);
        if (!perSession.has(th)) perSession.set(th, new Map());
        perSession.get(th)!.set(date, {
          netPts: dayKept.reduce((a, t) => a + t.pnl, 0),
          riskPts: dayKept.reduce((a, t) => a + t.risk, 0),
          trades: dayKept.length,
          wins: dayKept.filter((t) => t.pnl > 0).length,
        });
      }
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  const bCell = cell(base);
  const bTest = testOf(base);
  const sweepRows: { rule: string; n: number; wr: number; ci: [number, number]; pf: number; expPts: number; trainTest: string; compare: string }[] = [];
  for (const th of THETAS) {
    const { kept, vetoed } = byTheta.get(th)!;
    const k = cell(kept);
    const kTest = testOf(kept);
    const vTest = testOf(vetoed);
    const share = (vetoed.length / Math.max(1, base.length)) * 100;
    sweepRows.push({
      rule: `θ=${th.toFixed(2)} kept`,
      n: k.n,
      wr: k.wr,
      ci: k.wrCi,
      pf: k.pf,
      expPts: k.expPts,
      trainTest: `${cell(kept.filter((t) => t.date < SPLIT)).wr.toFixed(0)}% / ${kTest.wr.toFixed(0)}%`,
      compare: `baseline ${bTest.wr.toFixed(0)}%`,
    });
    sweepRows.push({
      rule: `θ=${th.toFixed(2)} vetoed`,
      n: vetoed.length,
      wr: cell(vetoed).wr,
      ci: cell(vetoed).wrCi,
      pf: cell(vetoed).pf,
      expPts: cell(vetoed).expPts,
      trainTest: `test WR ${vTest.wr.toFixed(0)}% · exp ${vTest.expPts.toFixed(2)}`,
      compare: `share ${share.toFixed(1)}%`,
    });
  }

  console.log("=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "baseline", stats: coreStats(base.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))) },
      ...THETAS.map((th) => {
        const kept = byTheta.get(th)!.kept;
        return { label: `θ=${th.toFixed(2)} kept`, stats: coreStats(kept.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))) };
      }),
    ]),
  );
  console.log("\n" + renderT2(sweepRows));
  const viability = propViability(base.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { splitDate: SPLIT });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: "—",
        significance: "—",
        stability: "—",
        holdout: "n/a",
        viability: "n/a (no layer varied)",
      }),
  );

  /* ---- validator sweep export (gcdata/validate_sweep.py format) ---- */
  if (sweepOut) {
    await fs.mkdir(sweepOut, { recursive: true });
    const sessions = loadedSessions.slice().sort();
    const configs = THETAS.map((th) => {
      const bucket = perSession.get(th)!;
      const perSessionRec: Record<string, { netPts: number; riskPts: number; trades: number; wins: number; netUsd: number; riskUsd: number }> = {};
      let n = 0;
      let wins = 0;
      let netPts = 0;
      let riskPts = 0;
      for (const date of sessions) {
        const st = bucket.get(date) ?? { netPts: 0, riskPts: 0, trades: 0, wins: 0 };
        n += st.trades;
        wins += st.wins;
        netPts += st.netPts;
        riskPts += st.riskPts;
        perSessionRec[date] = { ...st, netUsd: st.netPts * 2, riskUsd: st.riskPts * 2 };
      }
      return {
        id: `cf${th.toFixed(2).replace(".", "")}`,
        params: { s: 1, t: 1, x: 60, minCountFrac: th }, // s/t/x = the shared plan shape (1R · 60-bar); the swept dimension rides as minCountFrac
        perSession: perSessionRec,
        totals: { n, wins, wr: n ? wins / n : 0, netPts, netUsd: netPts * 2, riskPts, riskUsd: riskPts * 2 },
      };
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const outFile = path.join(sweepOut, `${family}-cf-${stamp}.json`);
    const payload = {
      family: `${family}-cf`,
      generatedAt: new Date().toISOString(),
      script: "web/scripts/countFracGateStudy.ts",
      costPts: COST,
      pointValue: 2,
      note: "post-detection count-frac gate sweep (promotion-contract study); perSession = kept-cohort series, 1 MNQ contract; sequential full-window replay of the PROD detector.",
      grid: { thetas: THETAS },
      sessions,
      nSessions: sessions.length,
      nConfigs: configs.length,
      configs,
    };
    await fs.writeFile(outFile, JSON.stringify(payload));
    console.log(`\nsweep export → ${outFile}`);
  }

  /* ---- promotion report for one θ (gate = min_count_frac, contract-checkable) ---- */
  if (reportJson && thetaArg !== undefined) {
    const th = Number(thetaArg);
    const { kept, vetoed } = byTheta.get(th) ?? { kept: [], vetoed: [] };
    const simToFlags = (d: { date: string; pnl: number; risk: number }[]) => {
      const dd = dollarize(d.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
      const ev = simulateAccount(dd, "eval");
      const fu = simulateAccount(dd, "funded");
      const evT = simulateAccount(dd.filter((t) => t.date >= SPLIT), "eval");
      const fuT = simulateAccount(dd.filter((t) => t.date >= SPLIT), "funded");
      return {
        evalPass: ev.breachDay === null && ev.passDay !== null,
        fundedPass: fu.breachDay === null,
        evalTestPass: evT.breachDay === null && evT.passDay !== null,
        fundedTestPass: fuT.breachDay === null,
      };
    };
    const report = buildReport({
      script: "scripts/countFracGateStudy.ts",
      cli: argv.join(" "),
      sha: "",
      splitDate: SPLIT,
      stack: `${PRODUCTION_STACK} · varying layer: min_count_frac gate only (post-detection, fail-open)`,
      family,
      gate: "min_count_frac",
      value: { min: th, on: "count" },
      note: `trigger-bar aligned count-frac ≥ ${th} — vetoed ${vetoed.length} trades (share ${((vetoed.length / Math.max(1, base.length)) * 100).toFixed(1)}%)`,
      baseline: { ...bCell, test: bTest },
      candidate: { ...cell(kept), test: testOf(kept) },
      vetoedSharePct: (vetoed.length / Math.max(1, base.length)) * 100,
      vetoed: { ...cell(vetoed), test: testOf(vetoed) },
      viability: simToFlags(kept),
      grid: { variants: THETAS.length },
    });
    await fs.writeFile(reportJson, JSON.stringify(report, null, 1));
    console.log(`\npromotion report → ${reportJson} (grid DSR/PBO patch via promoteFromBacktest --grid '{"variants":5,"dsr":..,"pbo":..}')`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
