/* ------------------------------------------------------------------ *
 * Expectancy-by-hour study — is the globex session structurally worse
 * than RTH for the three live families, or was the 2026-10-01
 * session's globex bleed (all three globex buckets net negative,
 * RTH +$168) just variance?
 *
 * Replays the three production detectors over the full archive with
 * their live plan shapes (first-touch, 60-bar time exit, 0.5 pt cost,
 * one position at a time) and buckets each trade by its entry hour:
 *   SOFT   detectSoftMomentum(SOFT_PROD)   — RTH soft-continuation 0.75R
 *   MOM    detectMomentum(MOM_PROD)        — globex failed-flush 1R
 *   EXP    detectExpansionScalp(EXP_PROD)  — huge-bar expansion 1R
 *
 *   node --import ../scripts/ts-loader.mjs scripts/hourExpectancyStudy.ts \
 *     [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { hourBucketOf } from "../lib/tradeStats";
import { scoreTrade, scoreSequential, coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";

const COST = 0.5;
const HOLD_BARS = 60;
const SPLIT = "2026-01-01";

type T = { date: string; bucket: string; pnlPts: number; riskPts: number };

function replay(minutes: MomMinute[], sigs: MomentumSignal[]): T[] {
  /* canonical engine scorers: pessimistic stop-first, closeOf time exit,
   * 0.5 pt cost, 60-bar window, last-bar signals dropped, and the full
   * window occupied between entries — identical to the previous local
   * loop for every valid detector signal */
  return scoreSequential(
    sigs,
    (s) => {
      const dir = s.dir === "long" ? 1 : -1;
      const sc = scoreTrade(minutes, {
        dir,
        entry: s.entry,
        stop: s.stop,
        target: s.target,
        entryIdx: s.entryIdx,
        risk: Math.abs(s.entry - s.stop),
      }, { costPts: COST, holdBars: HOLD_BARS });
      return sc ? { ...sc, s } : null;
    },
    { occupy: "full", window: HOLD_BARS },
  ).map((o) => {
    const mm = Number(o.s.t.slice(3, 5));
    return {
      date: o.s.d,
      bucket: hourBucketOf(`${String(o.s.hourET).padStart(2, "0")}:${String(mm).padStart(2, "0")}`),
      pnlPts: o.pnl,
      riskPts: o.risk,
    };
  });
}

function stats(tt: T[]) {
  const wins = tt.filter((t) => t.pnlPts > 0);
  const losses = tt.filter((t) => t.pnlPts < 0);
  const gw = wins.reduce((a, t) => a + t.pnlPts, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlPts, 0));
  const net = tt.reduce((a, t) => a + t.pnlPts, 0);
  const decided = wins.length + losses.length;
  return {
    n: tt.length,
    wr: decided ? (wins.length / decided) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net,
    exp: tt.length ? net / tt.length : 0,
  };
}

function fmtRow(label: string, s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : " inf";
  return `${label.padEnd(16)} | n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} net=${s.net.toFixed(0).padStart(8)} exp=${s.exp >= 0 ? "+" : ""}${s.exp.toFixed(2).padStart(5)}`;
}

const BUCKET_ORDER = ["globex_early", "globex_core", "globex_late", "globex_dawn", "premkt", "rth", "close", "unknown"];

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : undefined;

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`expectancy-by-hour · ${dates.length} sessions · first-touch 60-bar 0.5pt`);

  const families: { name: string; detect: (m: MomMinute[]) => MomentumSignal[] }[] = [
    { name: "SOFT (RTH 0.75R)", detect: (m) => detectSoftMomentum(m, SOFT_PROD) },
    { name: "MOM (flush 1R)", detect: (m) => detectMomentum(m, MOM_PROD) },
    { name: "EXP (expansion 1R)", detect: (m) => detectExpansionScalp(m, EXP_PROD) },
  ];

  const results = families.map((f) => ({ name: f.name, trades: [] as T[] }));
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { minutes } of sessions) {
      if (!minutes) continue;
      for (let k = 0; k < families.length; k++) {
        results[k].trades.push(...replay(minutes, families[k].detect(minutes)));
      }
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  for (const r of results) {
    console.log(`=== ${r.name} (${r.trades.length} trades) ===`);
    console.log(`  ${fmtRow("ALL", stats(r.trades))}`);
    for (const b of BUCKET_ORDER) {
      const tt = r.trades.filter((t) => t.bucket === b);
      if (tt.length) console.log(`  ${fmtRow(b, stats(tt))}`);
    }
    const tr = stats(r.trades.filter((t) => t.date < SPLIT));
    const te = stats(r.trades.filter((t) => t.date >= SPLIT));
    console.log(`  ${fmtRow("TRAIN <2026", tr)}`);
    console.log(`  ${fmtRow("TEST ≥2026", te)}`);
    console.log("");
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * The legacy stats() above stays untouched: its WR is decided-only
   * W/(W+L) and its losses exclude scratch, both intentionally different
   * from the engine's wins = pnl>0 over all n. Primary cohort = the MOM
   * (flush 1R) family; T2 carries every family × hour-bucket cell. ---- */
  const splitDate = SPLIT;
  const momTrades = results.find((r) => r.name.startsWith("MOM"))!.trades;
  const engineTrades = momTrades.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
  const eAll = coreStats(engineTrades);
  const eTrain = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const eTest = coreStats(engineTrades.filter((t) => t.date >= splitDate));
  console.log("\n=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "all", stats: eAll },
      { label: "train", stats: eTrain },
      { label: "test", stats: eTest },
    ]),
  );
  const t2rows: { rule: string; n: number; wr: number; ci: [number, number]; pf: number; expPts: number; trainTest: string; compare: string }[] = [];
  for (const r of results) {
    const toEngine = (ts: T[]) => ts.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
    const famAll = coreStats(toEngine(r.trades));
    for (const b of BUCKET_ORDER) {
      const tt = r.trades.filter((t) => t.bucket === b);
      if (!tt.length) continue;
      const s = coreStats(toEngine(tt));
      const sTr = coreStats(toEngine(tt.filter((t) => t.date < splitDate)));
      const sTe = coreStats(toEngine(tt.filter((t) => t.date >= splitDate)));
      t2rows.push({
        rule: `${r.name} · ${b}`,
        n: s.n,
        wr: s.wr,
        ci: wilson95(s.wins, s.n),
        pf: s.pf,
        expPts: s.expPts,
        trainTest: `${sTr.wr.toFixed(0)}% / ${sTe.wr.toFixed(0)}%`,
        compare: `ALL ${famAll.wr.toFixed(0)}% WR`,
      });
    }
  }
  console.log("\n" + renderT2(t2rows));
  const viability = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: eTest.netPts > 0 && eTest.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(eTrain.wr - eTest.wr).toFixed(1)} pts`,
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
