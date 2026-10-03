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
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { loadEsMinutes, buildEsContext, flushAgreement, breakdownVeto, esDeltaSign, rsBand, type EsContext } from "../lib/esJoin";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;

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
  const { entry, stop, target, risk } = sig;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;
  let hit: Scored["hit"] = "time";
  let exit = closeOf(minutes[end]);
  let heldBars = end - sig.entryIdx;
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      heldBars = j - sig.entryIdx;
      break;
    }
    if (tgtHit) {
      hit = "target";
      exit = target;
      heldBars = j - sig.entryIdx;
      break;
    }
  }
  const pnl = (exit - entry) * dir - COST_PTS;
  return { ...sig, date, pnl, exit, hit, heldBars };
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

function wilson(wins: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((c - s) / d) * 100, ((c + s) / d) * 100];
}

function stats(tr: Scored[]): Stats {
  const n = tr.length;
  const wins = tr.filter((t) => t.pnl > 0).length;
  const gw = tr.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(tr.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  const net = tr.reduce((a, t) => a + t.pnl, 0);
  const [lo, hi] = wilson(wins, n);
  return {
    n,
    wins,
    wr: n ? (wins / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgPts: n ? net / n : 0,
    netPts: net,
    lo,
    hi,
    days: new Set(tr.map((t) => t.date)).size,
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
