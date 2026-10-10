/* ------------------------------------------------------------------ *
 * ES feature study — backtest the first three cross-asset priorities:
 *
 *   1. FLUSH AGREEMENT — at the NQ flush bar, did ES also flush the same
 *      side AND hold its own session extreme? (agree / diverge / neutral)
 *   2. BREAKDOWN GATE   — veto NQ longs when ES printed a new session low
 *      in the 5 bars before entry (mirror: new high for shorts).
 *   3. DELTA DIVERGENCE — sign of ES cumulative delta at the flush bar
 *      (cross-market absorption evidence) + RS BAND: z-score of the
 *      NQ−ES points spread over the trailing 60 min at entry.
 *
 * Same replay discipline as momentumStudy: signals detected from completed
 * bars only, scored forward with the pessimistic same-bar rule, 0.5 pt
 * round-trip cost, 60-bar time exit, 2026-01-01 train/test split, Wilson
 * CIs on every bucket. ES features are computed through the entry bar only
 * (see lib/esJoin.ts) — no lookahead by construction.
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/esStudy.ts [--max N] [--split 2026-01-01] [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { loadEsMinutes, buildEsContext, flushAgreement, breakdownVeto, esDeltaSign, rsBand, type EsContext } from "../lib/esJoin";
import { scoreTrade, coreStats, renderT1, renderT2, renderT4, renderVerdict, propViability } from "../lib/backtestEngine";

const CONCURRENCY = 8;

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; dump?: string; offline: boolean; rth: boolean; sequential: boolean } = { offline: false, rth: false, sequential: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--offline") o.offline = true;
    else if (a === "--rth") o.rth = true;
    else if (a === "--sequential") o.sequential = true;
  }
  return o;
}

/* ---------------- scoring (same as momentumStudy) ---------------- */

type Scored = MomentumSignal & {
  date: string;
  pnl: number;
  exit: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
  // ES features (undefined = no ES twin for this session)
  agreement?: "agree" | "diverge" | "neutral";
  veto?: boolean;
  esDelta?: "pos" | "neg" | "flat";
  rs?: "strong" | "weak" | "neutral";
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const sc = scoreTrade(minutes, { dir, entry: sig.entry, stop: sig.stop, target: sig.target, entryIdx: sig.entryIdx, risk: sig.risk });
  if (!sc) return null;
  return { ...sig, date, pnl: sc.pnl, exit: sc.exit, hit: sc.hit, heldBars: sc.heldBars };
}

/** one trade at a time (mirror of momentumStudy.scoreSequential): a signal
 *  whose entry falls inside an open trade is skipped. */
function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of signals) {
    if (s.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, s, date);
    if (!sc) continue;
    out.push(sc);
    openUntil = sc.entryIdx + sc.heldBars;
  }
  return out;
}

/* ---------------- stats ---------------- */

type Stats = { n: number; wins: number; wr: number; pf: number; avgPts: number; netPts: number; lo: number; hi: number; days: number };

/** WR/PF/expectancy/net/Wilson CI all come from the consolidated engine
 *  (identical formulas: wins = pnl>0, pf = grossWin/grossLoss, avgPts =
 *  net/n, Wilson = wilson95). */
function stats(tr: Scored[]): Stats {
  const s = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return {
    n: s.n,
    wins: s.wins,
    wr: s.wr,
    pf: s.pf,
    avgPts: s.expPts,
    netPts: s.netPts,
    lo: s.wrCi[0],
    hi: s.wrCi[1],
    days: s.sessions,
  };
}

function fmt(s: Stats): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return (
    `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}% [${s.lo.toFixed(1)},${s.hi.toFixed(1)}]` +
    `  pf=${pf.padStart(5)}  avgPts=${s.avgPts.toFixed(2).padStart(6)}  net=${s.netPts.toFixed(0).padStart(7)}pts  days=${s.days}`
  );
}

function row(tr: Scored[], splitDate: string): string {
  const all = stats(tr);
  const train = stats(tr.filter((t) => t.date < splitDate));
  const test = stats(tr.filter((t) => t.date >= splitDate));
  return (
    `${fmt(all)}\n` +
    `${"".padEnd(14)}train: ${fmt(train)}\n` +
    `${"".padEnd(14)}test : ${fmt(test)}`
  );
}

/* ---------------- main ---------------- */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const splitDate = o.split ?? "2026-01-01";
  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions · split ${splitDate}…`);

  const flushTrades: Scored[] = [];
  const allTrades: Scored[] = [];
  let sessions = 0;
  let esSessions = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(
      chunk.map(async (date) => {
        const minutes = await loadSessionMinutes(date);
        const es = await loadEsMinutes(date);
        return { date, minutes, es };
      }),
    );
    for (const { date, minutes, es } of loaded) {
      if (!minutes) {
        failed++;
        continue;
      }
      sessions++;
      const ctx: EsContext | null = es ? buildEsContext(minutes, es) : null;
      if (ctx?.has) esSessions++;

      const mom = detectMomentum(minutes, MOM_PROD);
      const exp = detectExpansionScalp(minutes, EXP_PROD);
      const soft = o.rth ? detectSoftMomentum(minutes, SOFT_PROD) : [];
      const flushSigs = mom.filter((s) => s.kind === "flush");
      const seen = new Set([...flushSigs, ...soft].map((s) => `${s.entryIdx}|${s.dir}`));
      const merged = [...flushSigs, ...soft, ...exp.filter((s) => !seen.has(`${s.entryIdx}|${s.dir}`))];

      const nqMid = minutes.map((m) => (m.high + m.low) / 2);
      const src = new Map<MomentumSignal, "flush" | "soft" | "exp">();
      for (const s of flushSigs) src.set(s, "flush");
      for (const s of soft) src.set(s, "soft");

      const scored: Scored[] = o.sequential ? scoreSequential(minutes, merged, date) : merged.map((s) => scoreSignal(minutes, s, date)).filter((s): s is Scored => s !== null);

      for (const sc of scored) {
        const origin = src.get(merged.find((s) => s.entryIdx === sc.entryIdx && s.dir === sc.dir) as MomentumSignal) ?? "exp";
        if (ctx?.has) {
          sc.veto = breakdownVeto(ctx, sc.entryIdx, sc.dir);
          sc.rs = rsBand(ctx, nqMid, sc.entryIdx);
          if (origin === "flush") {
            sc.agreement = flushAgreement(ctx, sc.flushIdx, sc.dir);
            sc.esDelta = esDeltaSign(ctx, sc.flushIdx);
          }
        }
        allTrades.push(sc);
        if (origin === "flush") flushTrades.push(sc);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }

  const fes = flushTrades.filter((t) => t.agreement !== undefined);
  const aes = allTrades.filter((t) => t.rs !== undefined || t.veto !== undefined);
  console.log(
    `\ncoverage: ${sessions} sessions loaded · ${esSessions} with ES twin · ` +
      `${flushTrades.length} flush trades (${fes.length} ES-covered) · ${allTrades.length} all-card trades (${aes.length} ES-covered) · ${failed} failed`,
  );

  console.log("\n=== 1. FLUSH AGREEMENT — at the NQ flush bar (flush cards, ES-covered) ===");
  for (const b of ["agree", "diverge", "neutral"] as const) {
    console.log(`\n${b.toUpperCase()}`);
    console.log(row(fes.filter((t) => t.agreement === b), splitDate));
  }
  console.log(`\nall ES-covered flush cards`);
  console.log(row(fes, splitDate));
  if (flushTrades.length > fes.length) {
    console.log(`\nno ES twin (${flushTrades.length - fes.length} trades)`);
    console.log(row(flushTrades.filter((t) => t.agreement === undefined), splitDate));
  }

  console.log("\n=== 2. BREAKDOWN GATE — ES session extreme in the 5 bars before entry (all cards) ===");
  const covered = allTrades.filter((t) => t.veto !== undefined);
  const kept = covered.filter((t) => !t.veto);
  const vetoed = covered.filter((t) => t.veto);
  console.log(`\nbaseline (ES-covered, gate off)`);
  console.log(row(covered, splitDate));
  console.log(`\nkept (gate on)`);
  console.log(row(kept, splitDate));
  console.log(`\nvetoed (suppressed by the gate) — the gate is right when this group is bad`);
  console.log(row(vetoed, splitDate));

  console.log("\n=== 3. ES DELTA SIGN at the flush bar (flush cards, ES-covered) ===");
  for (const b of ["pos", "neg", "flat"] as const) {
    console.log(`\n${b.toUpperCase()}`);
    console.log(row(fes.filter((t) => t.esDelta === b), splitDate));
  }

  console.log("\n=== 4. RS BAND at entry — NQ−ES spread z-score, trailing 60 min (all cards) ===");
  for (const b of ["strong", "weak", "neutral"] as const) {
    console.log(`\n${b.toUpperCase()}`);
    console.log(row(aes.filter((t) => t.rs === b), splitDate));
  }

  /* ---- direction interactions: features can flip sign by side ---- */
  console.log("\n=== 5. RS BAND × DIRECTION (all cards) ===");
  for (const b of ["strong", "weak", "neutral"] as const) {
    for (const dir of ["long", "short"] as const) {
      const tr = aes.filter((t) => t.rs === b && t.dir === dir);
      if (tr.length) console.log(`\n${b} ${dir}` + "\n" + row(tr, splitDate));
    }
  }

  console.log("\n=== 6. FLUSH AGREEMENT × DIRECTION (flush cards) ===");
  for (const b of ["agree", "diverge", "neutral"] as const) {
    for (const dir of ["long", "short"] as const) {
      const tr = fes.filter((t) => t.agreement === b && t.dir === dir);
      if (tr.length) console.log(`\n${b} ${dir}` + "\n" + row(tr, splitDate));
    }
  }

  console.log("\n=== 7. BREAKDOWN VETO × DIRECTION (all cards, vetoed subset) ===");
  for (const dir of ["long", "short"] as const) {
    const tr = covered.filter((t) => t.veto && t.dir === dir);
    if (tr.length) console.log(`\nvetoed ${dir}` + "\n" + row(tr, splitDate));
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify({ generated: new Date().toISOString(), splitDate, sessions, esSessions, flushTrades, allTrades }, null, 1),
    );
    console.log(`\nsignals dumped → ${o.dump}`);
  }

  /* ==== STANDARD REPORT (consolidated engine) ==== */
  const engineTrades = allTrades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  const etAll = coreStats(engineTrades);
  const etTrain = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const etTest = coreStats(engineTrades.filter((t) => t.date >= splitDate));
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([
    { label: "all (all cards)", stats: etAll },
    { label: "train", stats: etTrain },
    { label: "test", stats: etTest },
  ]));

  const cell = (name: string, tr: Scored[], baseline: Scored[], baselineName: string) => {
    const s = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    const b = coreStats(baseline.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    const train = coreStats(tr.filter((t) => t.date < splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    const test = coreStats(tr.filter((t) => t.date >= splitDate).map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
    return {
      rule: name,
      n: s.n,
      wr: s.wr,
      ci: s.wrCi,
      pf: s.pf,
      expPts: s.expPts,
      trainTest: `${train.wr.toFixed(0)}% / ${test.wr.toFixed(0)}%`,
      compare: `${baselineName}: wr ${b.wr.toFixed(1)}% pf ${Number.isFinite(b.pf) ? b.pf.toFixed(2) : "inf"}`,
    };
  };
  const t2rows = [
    cell("agree (flush ES)", fes.filter((t) => t.agreement === "agree"), fes, "baseline all ES flush"),
    cell("diverge (flush ES)", fes.filter((t) => t.agreement === "diverge"), fes, "baseline all ES flush"),
    cell("neutral (flush ES)", fes.filter((t) => t.agreement === "neutral"), fes, "baseline all ES flush"),
    cell("no ES twin (flush)", flushTrades.filter((t) => t.agreement === undefined), flushTrades, "baseline all flush"),
    cell("delta pos (flush ES)", fes.filter((t) => t.esDelta === "pos"), fes, "baseline all ES flush"),
    cell("delta neg (flush ES)", fes.filter((t) => t.esDelta === "neg"), fes, "baseline all ES flush"),
    cell("delta flat (flush ES)", fes.filter((t) => t.esDelta === "flat"), fes, "baseline all ES flush"),
    cell("veto kept (gate on)", kept, covered, "baseline covered"),
    cell("vetoed (gate suppressed)", vetoed, covered, "baseline covered"),
    cell("rs strong (all cards)", aes.filter((t) => t.rs === "strong"), aes, "baseline ES-covered all"),
    cell("rs weak (all cards)", aes.filter((t) => t.rs === "weak"), aes, "baseline ES-covered all"),
    cell("rs neutral (all cards)", aes.filter((t) => t.rs === "neutral"), aes, "baseline ES-covered all"),
  ];
  console.log("\n" + renderT2(t2rows));

  const v = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(v));
  console.log(renderVerdict({
    edge: etTest.netPts > 0 && etTest.expR > 0 ? "real" : "absent",
    significance: "—",
    stability: `train/test WR gap ${Math.abs(etTrain.wr - etTest.wr).toFixed(1)} pts`,
    holdout: "n/a (validation pipeline)",
    viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
