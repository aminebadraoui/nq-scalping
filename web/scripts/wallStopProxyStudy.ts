/* ------------------------------------------------------------------ *
 * Wall-aware stop — proxy study.
 *
 * Pulcini: don't let your stop die AT the magnet — put it on the far
 * side. No historical dealer-gamma walls exist for the archive (options
 * collection only started 2026-09), so the magnet is proxied by the
 * tape's own concentration level: the trailing 60-bar HVN/POC at entry
 * time. The question this replay answers is whether the PLACEMENT RULE
 * pays: when a magnet sits within `nearPts` beyond the stop, does
 * widening the stop to its far side (or skipping the trade) beat the
 * production structural stop?
 *
 * Uses the same applyWallStop() shipped for the live gamma-wall feature
 * — the study measures the rule, the live feature applies it to real
 * dealer walls.
 *
 * Replay: prod momentum configs, sequential one-trade-at-a-time,
 * pessimistic same-bar stop-first, 0.5 pt round-trip cost, 60-bar time
 * exit, train/test split 2026-01-01.
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/wallStopProxyStudy.ts [--max N] [--split 2026-01-01] [--offline]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  closeOf,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { applyWallStop, type WallStopConfig } from "../lib/wallStop";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const HOLD_BARS = 60;
const MAGNET_BARS = 60; // trailing window for the HVN/POC magnet

type Scored = {
  date: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
  /** the magnet (trailing POC) at entry, in the adverse direction */
  magnet: number | null;
  /** pts from stop to magnet (adverse) */
  magnetDist: number | null;
  widened: boolean;
};

/** trailing 60-bar HVN/POC — the tape's own concentration magnet */
function magnetAt(minutes: MomMinute[], entryIdx: number): number | null {
  const from = Math.max(0, entryIdx - MAGNET_BARS);
  const volAt = new Map<number, number>();
  for (let k = from; k < entryIdx; k++) {
    for (const l of minutes[k].levels) {
      volAt.set(l.price, (volAt.get(l.price) ?? 0) + l.buy + l.sell);
    }
  }
  let poc = 0;
  let pocVol = -1;
  for (const [p, v] of volAt) {
    if (v > pocVol) {
      pocVol = v;
      poc = p;
    }
  }
  return pocVol >= 0 ? poc : null;
}

function scoreTrade(
  minutes: MomMinute[],
  sig: MomentumSignal,
  date: string,
  wallCfg: WallStopConfig | null,
): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  let { entry, stop, target, risk } = sig;

  const magnet = magnetAt(minutes, sig.entryIdx);
  let widened = false;
  let magnetDist: number | null = null;
  if (magnet !== null) {
    magnetDist = dir > 0 ? stop - magnet : magnet - stop; // >0 = beyond the stop
    if (wallCfg) {
      const r = applyWallStop(
        { dir: sig.dir, stop, entry },
        [{ kind: sig.dir === "long" ? "put" : "call", p: magnet }],
        wallCfg,
      );
      if (r.widened) {
        stop = r.stop;
        widened = true;
      }
    }
  }

  risk = dir > 0 ? entry - stop : stop - entry;
  if (!(risk > 0)) return null;
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
  return { date, dir: sig.dir, entry, stop, risk, pnl, hit, heldBars, magnet, magnetDist, widened };
}

function replay(
  minutes: MomMinute[],
  sigs: MomentumSignal[],
  date: string,
  wallCfg: WallStopConfig | null,
  skipNear: number | null,
): Scored[] {
  const out: Scored[] = [];
  let openUntil = -1;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (skipNear !== null) {
      const mag = magnetAt(minutes, s.entryIdx);
      if (mag !== null) {
        const dist = s.dir === "long" ? s.stop - mag : mag - s.stop;
        if (dist >= 0 && dist <= skipNear) continue; // dying at the magnet — skip it
      }
    }
    const sc = scoreTrade(minutes, s, date, wallCfg);
    if (!sc) continue;
    out.push(sc);
    openUntil = s.entryIdx + sc.heldBars;
  }
  return out;
}

function stats(tt: Scored[]) {
  const n = tt.length;
  const wins = tt.filter((t) => t.pnl > 0).length;
  const gw = tt.reduce((a, t) => a + Math.max(0, t.pnl), 0);
  const gl = tt.reduce((a, t) => a + Math.max(0, -t.pnl), 0);
  const expR = n ? tt.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0;
  return { n, wr: n ? (wins / n) * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, net: gw - gl, expR };
}

function fmt(s: ReturnType<typeof stats>): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}%  pf=${pf.padStart(5)}  net=${s.net.toFixed(0).padStart(8)}  expR=${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(3)}`;
}

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; offline: boolean } = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const splitDate = o.split ?? "2026-01-01";

  let dates = await archiveDates(o.offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`replaying ${dates.length} sessions (sequential, first-touch, ${COST_PTS}pt cost, ${HOLD_BARS}-bar exit)`);

  type Variant = {
    label: string;
    wall: WallStopConfig | null;
    skipNear: number | null;
  };
  const variants: Variant[] = [
    { label: "baseline (prod stops)", wall: null, skipNear: null },
    { label: "widen beyond magnet ≤5pt", wall: { nearPts: 5, pad: 0.5 }, skipNear: null },
    { label: "widen beyond magnet ≤10pt", wall: { nearPts: 10, pad: 0.5 }, skipNear: null },
    { label: "widen beyond magnet ≤15pt", wall: { nearPts: 15, pad: 0.5 }, skipNear: null },
    { label: "skip when magnet ≤5pt", wall: null, skipNear: 5 },
    { label: "skip when magnet ≤10pt", wall: null, skipNear: 10 },
  ];
  const results = variants.map((v) => ({ label: v.label, mom: [] as Scored[], exp: [] as Scored[] }));

  const t0 = Date.now();
  let loaded = 0;
  let failed = 0;
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      const momSigs = detectMomentum(minutes, MOM_PROD);
      const expSigs = detectExpansionScalp(minutes, EXP_PROD);
      for (let p = 0; p < variants.length; p++) {
        results[p].mom.push(...replay(minutes, momSigs, date, variants[p].wall, variants[p].skipNear));
        results[p].exp.push(...replay(minutes, expSigs, date, variants[p].wall, variants[p].skipNear));
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions loaded · ${failed} failed\n`);

  const base = results[0];
  const baseAll = [...base.mom, ...base.exp];

  /* ---- anatomy: how often does a stop sit at the magnet? ---- */
  const nearMagnet = (tt: Scored[], near: number) =>
    tt.filter((t) => t.magnetDist !== null && t.magnetDist >= 0 && t.magnetDist <= near);
  console.log("ANATOMY — share of trades with a trailing-POC magnet within N pts beyond the stop:");
  for (const near of [5, 10, 15]) {
    const all = nearMagnet(baseAll, near);
    const stopped = all.filter((t) => t.hit === "stop");
    console.log(
      `  ≤${near}pt: ${all.length}/${baseAll.length} trades (${((all.length / Math.max(1, baseAll.length)) * 100).toFixed(1)}%) | ` +
        `of those stopped: ${stopped.length} (${all.length ? ((stopped.length / all.length) * 100).toFixed(0) : 0}%) | ` +
        `baseline stop-rate overall: ${((baseAll.filter((t) => t.hit === "stop").length / Math.max(1, baseAll.length)) * 100).toFixed(1)}%`,
    );
  }
  console.log();

  /* ---- variant table ---- */
  console.log(`VARIANTS (all archive vs test ≥ ${splitDate}):`);
  for (const r of results) {
    for (const fam of [
      { name: "mom", tr: r.mom },
      { name: "exp", tr: r.exp },
    ]) {
      const all = fam.tr;
      const test = all.filter((t) => t.date >= splitDate);
      const s = stats(all);
      const st = stats(test);
      const d = dollarize(all.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
      const evAll = simulateAccount(d, "eval");
      const worst = evAll.days.reduce((a, x) => Math.min(a, x.pnl), 0);
      console.log(
        `${r.label.padEnd(26)} ${fam.name.padEnd(3)} | ${fmt(s)} | test: n=${String(st.n).padStart(4)} wr=${st.wr.toFixed(1).padStart(5)}% expR=${st.expR >= 0 ? "+" : ""}${st.expR.toFixed(3)} | $${d.reduce((a, t) => a + t.pnl, 0).toFixed(0).padStart(7)} worst $${worst.toFixed(0).padStart(5)} | eval ${accountLine(evAll)}`,
      );
    }
    console.log();
  }

  /* ---- widened-stop outcome anatomy ---- */
  const w5 = results[1];
  console.log("WIDEN ≤5pt — what happened to the widened trades (mom+exp):");
  for (const [name, tt] of [
    ["baseline", baseAll],
    ["widen≤5", [...w5.mom, ...w5.exp]],
  ] as const) {
    const widened = name === "widen≤5" ? tt.filter((t) => t.widened) : [];
    const saved = widened.filter((t) => t.pnl > 0);
    const stillStopped = widened.filter((t) => t.hit === "stop");
    console.log(
      `  ${name}: widened=${widened.length} | winners after widen=${saved.length} (${widened.length ? ((saved.length / widened.length) * 100).toFixed(0) : 0}%) | still stopped=${stillStopped.length}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
