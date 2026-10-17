/* ------------------------------------------------------------------ *
 * Side-veto study — the promotion-contract study for the `side_veto`
 * override gate (lib/strategyOverrides.ts → decideSignal).
 *
 * Replays the production detectors over the archive with their live
 * plan shapes (first-touch, 60-bar time exit, 0.5 pt cost, sequential
 * full-window occupy — hourExpectancyStudy semantics) and measures a
 * pre-registered side veto: skip one side of one family, optionally
 * only inside given ET hours. The veto is applied EXACTLY as the live
 * gate applies it — post-detection, before scoring, fail-open.
 *
 * Pre-registered candidates (2026-10-16, from measured cells):
 *   A. momentum_expansion { side: "short", hours: [15] }
 *      — the ticketVeto close-bucket cell (short +0.75 vs long +2.13
 *        pts/trade), below the ~1.0–1.25 pt live cost bar.
 *
 * Acceptance = the promotion contract (lib/promotionGate.ts):
 *   vetoed test n ≥ 30 AND vetoed test WR < baseline test WR
 *   kept test n ≥ 80, WR lower CI > 50%, PF ≥ 1.1, expR > 0
 *   kept test exp ≥ 0.9 × baseline · vetoed share ≤ 30%
 *   prop sim PASS train + test · (no grid → no DSR/PBO needed)
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/sideVetoStudy.ts --family momentum_expansion \
 *     --veto '{"side":"short","hours":[15]}' [--report-json out.json] \
 *     [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount } from "../lib/propAccount";
import { scoreTrade, scoreSequential, coreStats, propViability, renderT1, renderT2, renderT4, renderVerdict, PRODUCTION_STACK } from "../lib/backtestEngine";
import { buildReport, cohortOf, type CohortStats } from "../lib/promotionGate";

const COST = 0.5;
const HOLD_BARS = 60;
const SPLIT = "2026-01-01";

type Scored = { date: string; pnl: number; risk: number; wr: 1 | 0; expPts: number; key: string; hourET: number; side: "long" | "short" };

function scoreList(minutes: MomMinute[], sigs: MomentumSignal[]): Scored[] {
  return scoreSequential(
    sigs,
    (s) => {
      const dir = s.dir === "long" ? 1 : -1;
      const sc = scoreTrade(
        minutes,
        { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk: Math.abs(s.entry - s.stop) },
        { costPts: COST, holdBars: HOLD_BARS },
      );
      return sc ? { ...sc, s } : null;
    },
    { occupy: "full", window: HOLD_BARS },
  ).map((o) => ({
    date: o.s.d,
    pnl: o.pnl,
    risk: o.risk,
    wr: o.pnl > 0 ? (1 as const) : (0 as const),
    expPts: o.pnl,
    key: `${o.s.d}|${o.s.entryIdx}|${o.s.dir}`,
    hourET: o.s.hourET,
    side: o.s.dir as "long" | "short",
  }));
}

const cohortOfScored = (tt: Scored[]): CohortStats => {
  const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return cohortOf(s);
};

async function main() {
  const argv = process.argv.slice(2);
  const grab = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const family = grab("--family") ?? "momentum_expansion";
  const vetoRaw = grab("--veto");
  const reportJson = grab("--report-json");
  const offline = argv.includes("--offline");
  const scan = argv.includes("--scan");
  const maxArg = grab("--max");
  const max = maxArg !== undefined ? Number(maxArg) : undefined;
  if (!vetoRaw && !scan) {
    console.error("usage: sideVetoStudy.ts --family <family> (--veto '{\"side\":\"short\",\"hours\":[8]}' | --scan) [--report-json out.json] [--offline] [--max N]");
    process.exit(1);
  }
  const veto = vetoRaw ? (JSON.parse(vetoRaw) as { side: "long" | "short"; hours?: number[] }) : null;
  const vetoHours = new Set(veto?.hours ?? []);
  const vetoMatches = (s: MomentumSignal) => veto !== null && s.dir === veto.side && (vetoHours.size === 0 || vetoHours.has(s.hourET));

  const detect: (m: MomMinute[]) => MomentumSignal[] =
    family === "momentum_expansion"
      ? (m) => detectExpansionScalp(m, EXP_PROD)
      : family === "momentum_flush"
        ? (m) => detectMomentum(m, MOM_PROD)
        : family === "rth"
          ? (m) => detectSoftMomentum(m, SOFT_PROD)
          : (() => {
              throw new Error(`unknown family ${family}`);
            })();

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`sideVetoStudy · ${family} · ${veto ? `veto ${JSON.stringify(veto)}` : "SCAN"} · ${dates.length} sessions · first-touch 60-bar 0.5pt`);

  const baseline: Scored[] = [];
  const candidate: Scored[] = [];
  const vetoed: Scored[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { minutes } of sessions) {
      if (!minutes) continue;
      const sigs = detect(minutes);
      const all = scoreList(minutes, sigs);
      baseline.push(...all);
      if (veto) {
        const kept = scoreList(
          minutes,
          sigs.filter((s) => !vetoMatches(s)),
        );
        const keptKeys = new Set(kept.map((t) => t.key));
        candidate.push(...kept);
        vetoed.push(...all.filter((t) => !keptKeys.has(t.key)));
      }
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  /* ---- scan mode: side × hour cells over live hours (train/test) ---- */
  if (scan) {
    const cell = (side: "long" | "short", hour: number) => {
      const tt = baseline.filter((t) => t.side === side && t.hourET === hour);
      const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      const sTr = coreStats(tt.filter((t) => t.date < SPLIT).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      const sTe = coreStats(tt.filter((t) => t.date >= SPLIT).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
      return { n: s.n, trN: sTr.n, teN: sTe.n, wr: s.wr, trWr: sTr.wr, teWr: sTe.wr, pf: s.pf, expPts: s.expPts };
    };
    console.log("side × hour (n = all | train/test WR; all hours — momentum families never fire 09:30–16:00 by detector design):");
    console.log("  side  hour |    n  |  WR all  | train/test WR |  PF  | exp");
    const rows: { side: "long" | "short"; hour: number; n: number; trN: number; teN: number; wr: number; trWr: number; teWr: number; pf: number; expPts: number }[] = [];
    for (const side of ["long", "short"] as const) {
      for (let h = 0; h <= 23; h++) {
        const c = cell(side, h);
        if (c.n === 0) continue;
        rows.push({ side, hour: h, ...c });
      }
    }
    rows.sort((a, b) => a.n - b.n);
    for (const r of rows) {
      const pf = Number.isFinite(r.pf) ? r.pf.toFixed(2) : "inf";
      console.log(
        `  ${r.side.padEnd(5)} ${String(r.hour).padStart(2)}  | ${String(r.n).padStart(5)} | ${r.wr.toFixed(1).padStart(6)}% | ${String(`${r.trWr.toFixed(0)} / ${r.teWr.toFixed(0)}`).padStart(9)}% | ${pf.padStart(4)} | ${r.expPts >= 0 ? "+" : ""}${r.expPts.toFixed(2)}`,
      );
    }
    return;
  }

  const bAll = cohortOfScored(baseline);
  const bTrain = cohortOfScored(baseline.filter((t) => t.date < SPLIT));
  const bTest = cohortOfScored(baseline.filter((t) => t.date >= SPLIT));
  const cAll = cohortOfScored(candidate);
  const cTrain = cohortOfScored(candidate.filter((t) => t.date < SPLIT));
  const cTest = cohortOfScored(candidate.filter((t) => t.date >= SPLIT));
  const vAll = cohortOfScored(vetoed);
  const vTest = cohortOfScored(vetoed.filter((t) => t.date >= SPLIT));
  const vetoedSharePct = baseline.length ? (vetoed.length / baseline.length) * 100 : 0;

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ---- */
  console.log("=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "baseline (no veto)", stats: coreStats(baseline.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))) },
      { label: "kept (veto applied)", stats: coreStats(candidate.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))) },
      { label: "vetoed trades", stats: coreStats(vetoed.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))) },
    ]),
  );
  console.log(
    "\n" +
      renderT2([
        { rule: "kept test", n: cTest.n, wr: cTest.wr, ci: cTest.wrCi, pf: cTest.pf, expPts: cTest.expPts, trainTest: `${cTrain.wr.toFixed(0)}% / ${cTest.wr.toFixed(0)}%`, compare: `baseline ${bTest.wr.toFixed(0)}%` },
        { rule: "vetoed test", n: vTest.n, wr: vTest.wr, ci: vTest.wrCi, pf: vTest.pf, expPts: vTest.expPts, trainTest: "—", compare: `baseline ${bTest.wr.toFixed(0)}%` },
      ]),
  );
  const viability = propViability(candidate.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { splitDate: SPLIT });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: cTest.n > 0 && cTest.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `kept train/test WR gap ${(cTrain.wr - cTest.wr).toFixed(1)} pts · vetoed share ${vetoedSharePct.toFixed(1)}%`,
        holdout: "n/a (validation pipeline)",
        viability: viability.pPass === null ? "n/a" : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );

  /* ---- promotion report (lib/promotionGate.ts) ---- */
  if (reportJson) {
    const theVeto = veto as NonNullable<typeof veto>; // scan mode returned early
    const simToFlags = (d: { date: string; pnl: number; risk: number }[]) => {
      const dd = dollarize(d.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
      const evalAll = simulateAccount(dd, "eval");
      const fundedAll = simulateAccount(dd, "funded");
      const evalTest = simulateAccount(dd.filter((t) => t.date >= SPLIT), "eval");
      const fundedTest = simulateAccount(dd.filter((t) => t.date >= SPLIT), "funded");
      return {
        evalPass: evalAll.breachDay === null && evalAll.passDay !== null,
        fundedPass: fundedAll.breachDay === null,
        evalTestPass: evalTest.breachDay === null && evalTest.passDay !== null,
        fundedTestPass: fundedTest.breachDay === null,
      };
    };
    const report = buildReport({
      script: "scripts/sideVetoStudy.ts",
      cli: argv.join(" "),
      sha: "",
      splitDate: SPLIT,
      stack: `${PRODUCTION_STACK} · varying layer: side_veto gate only (post-detection, fail-open)`,
      family,
      gate: "side_veto",
      value: theVeto,
      note: `side veto ${theVeto.side}${theVeto.hours && theVeto.hours.length ? ` in hours ${theVeto.hours.join(",")} ET` : ""} — measured ${vAll.n} vetoed trades (WR ${vAll.wr.toFixed(1)}% all / ${vTest.wr.toFixed(1)}% test)`,
      baseline: { ...bAll, train: bTrain, test: bTest },
      candidate: { ...cAll, train: cTrain, test: cTest },
      vetoedSharePct,
      vetoed: { ...vAll, test: vTest },
      viability: simToFlags(candidate.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }))),
      grid: { variants: 1 },
    });
    await fs.writeFile(reportJson, JSON.stringify(report, null, 1));
    console.log(`\npromotion report → ${reportJson}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
