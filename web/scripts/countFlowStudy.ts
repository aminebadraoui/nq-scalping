/* ------------------------------------------------------------------ *
 * Count-flow study — trade-count vs volume order-flow at 1-min (A1/A2)
 *
 * The gap-report question (docs/data/STATISTICAL_DIMENSIONS_GAP_2026-10.md
 * A1/A2): does the per-level TRADE COUNT split (bTrades/sTrades — the
 * archive's unique asset) carry directional information the volume split
 * does not? Two measurements:
 *
 *   PART 1 (global horse race, every bar): for each ETH minute bar,
 *   next-bar direction vs the bar's own order-flow imbalance, three
 *   ways:  ofiV = buy−sell (volume) · ofiC = bTrades−sTrades (counts)
 *          sizeAsym = (avgBuySize − avgSellSize)/(avgBuySize+avgSellSize)
 *   Decile tables (top vs bottom decile up-rate spread + mean next-bar
 *   return), split train/test and by hour group (18–23, 0–2, 3–5, 6–9).
 *
 *   PART 2 (signal level): replay MOM flush + EXP expansion (PROD
 *   configs, sequential, 0.5 pt, 60-bar), attach the trigger bar's
 *   count-frac, volume-frac, divergence (fracC − fracV) and size
 *   asymmetry, print winners-vs-losers means + WR by agreement sign.
 *
 * Pre-registered acceptance (2026-10-16): count-flow is promoted from
 * journal-only to a candidate ingredient only if the ofiC decile spread
 * exceeds the ofiV spread by ≥ 2 pp in BOTH train and test AND in at
 * least two hour groups; size asymmetry likewise on its own spread.
 * Anything less → the features stay STUDY chips (no gate change).
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/countFlowStudy.ts --offline [--max N]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadSessionMinutes, archiveDates, cacheDir } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { scoreTrade, scoreSequential, wilson95 } from "../lib/backtestEngine";

const SPLIT = "2026-01-01";

type RawLevel = [number, number, number, number, number]; // [total,buy,sell,bTrades,sTrades]
type RawCandle = { t: string; high: number; low: number; total: number; buy: number; sell: number; levels: Record<string, RawLevel> };

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

type BarFlow = { ofiV: number; ofiC: number; sizeAsym: number; ret: number; up: boolean; hour: number };

/** one bar's flow stats; ret = next-bar mid change; up = ret > 0 */
function flowOf(candles: RawCandle[], i: number): BarFlow | null {
  if (i + 1 >= candles.length) return null;
  const c = candles[i];
  const n = candles[i + 1];
  let bT = 0;
  let sT = 0;
  for (const v of Object.values(c.levels ?? {})) {
    bT += v[3];
    sT += v[4];
  }
  const buyV = c.buy;
  const sellV = c.sell;
  const avgB = bT > 0 ? buyV / bT : 0;
  const avgS = sT > 0 ? sellV / sT : 0;
  const ret = (n.high + n.low) / 2 - (c.high + c.low) / 2;
  return {
    ofiV: buyV - sellV,
    ofiC: bT - sT,
    sizeAsym: avgB + avgS > 0 ? (avgB - avgS) / (avgB + avgS) : 0,
    ret,
    up: ret > 0,
    hour: Number(c.t.slice(11, 13)), // full ISO → hour ET
  };
}

type DecileStat = { n: number; upPct: number; ci: [number, number]; meanRet: number };

function deciles(rows: BarFlow[], key: "ofiV" | "ofiC" | "sizeAsym"): DecileStat[] {
  const sorted = [...rows].sort((a, b) => a[key] - b[key]);
  const out: DecileStat[] = [];
  const size = Math.floor(sorted.length / 10);
  if (size < 20) return out;
  for (let d = 0; d < 10; d++) {
    const slice = d === 9 ? sorted.slice(d * size) : sorted.slice(d * size, (d + 1) * size);
    const ups = slice.filter((r) => r.up).length;
    const n = slice.length;
    out.push({ n, upPct: (ups / n) * 100, ci: wilson95(ups, n), meanRet: slice.reduce((a, r) => a + r.ret, 0) / n });
  }
  return out;
}

const fmtDec = (d: DecileStat[]): string =>
  d
    .map((x, i) => `d${i + 1}:${x.upPct.toFixed(1).padStart(5)}%(${x.n})`)
    .join(" ");

const spread = (d: DecileStat[]): number => (d.length ? d[9].upPct - d[0].upPct : 0);

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
  console.log(`countFlowStudy · ${dates.length} sessions`);

  /* ---- PART 1: global bar-level horse race ---- */
  const hourGroups: { name: string; test: (h: number) => boolean }[] = [
    { name: "all", test: () => true },
    { name: "18–23", test: (h) => h >= 18 && h <= 23 },
    { name: "0–2", test: (h) => h >= 0 && h <= 2 },
    { name: "3–5", test: (h) => h >= 3 && h <= 5 },
    { name: "6–9", test: (h) => h >= 6 && h <= 9 },
  ];
  const buckets = new Map<string, { train: BarFlow[]; test: BarFlow[] }>();
  for (const g of hourGroups) buckets.set(g.name, { train: [], test: [] });

  /* ---- PART 2: signal-level features ---- */
  type SigRow = { fam: string; date: string; wr: 1 | 0; pnl: number; fracV: number; fracC: number; div: number; sizeAsym: number };
  const sigRows: SigRow[] = [];

  const t0 = Date.now();
  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(
      chunk.map(async (date) => {
        const [minutes, raw] = await Promise.all([loadSessionMinutes(date), loadRaw(date)]);
        return { date, minutes, raw };
      }),
    );
    for (const { date, minutes, raw } of sessions) {
      if (!minutes || !raw) continue;
      loaded++;

      // PART 1 — bar-level flow vs next-bar direction
      for (let b = 0; b < raw.length; b++) {
        const f = flowOf(raw, b);
        if (!f) continue;
        for (const g of hourGroups) {
          if (!g.test(f.hour)) continue;
          const cell = buckets.get(g.name)!;
          (date < SPLIT ? cell.train : cell.test).push(f);
        }
      }

      // PART 2 — trigger-bar features on PROD signals
      const byIdx = new Map(raw.map((c, idx) => [c.t.slice(11, 16), idx]));
      const run = (fam: string, detect: (m: MomMinute[]) => MomentumSignal[]) => {
        const scored = scoreSequential(
          detect(minutes),
          (s) => {
            const dir = s.dir === "long" ? 1 : -1;
            const sc = scoreTrade(
              minutes,
              { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk: Math.abs(s.entry - s.stop) },
              { costPts: 0.5, holdBars: 60 },
            );
            return sc ? { ...sc, s } : null;
          },
          { occupy: "full", window: 60 },
        );
        for (const o of scored) {
          const c = raw[o.s.entryIdx];
          if (!c) continue;
          let bT = 0;
          let sT = 0;
          for (const v of Object.values(c.levels ?? {})) {
            bT += v[3];
            sT += v[4];
          }
          const tv = c.buy + c.sell;
          const tc = bT + sT;
          const fracV = tv > 0 ? c.buy / tv : 0.5;
          const fracC = tc > 0 ? bT / tc : 0.5;
          const avgB = bT > 0 ? c.buy / bT : 0;
          const avgS = sT > 0 ? c.sell / sT : 0;
          const sizeAsym = avgB + avgS > 0 ? (avgB - avgS) / (avgB + avgS) : 0;
          const aligned = o.s.dir === "long" ? fracV : 1 - fracV;
          const alignedC = o.s.dir === "long" ? fracC : 1 - fracC;
          sigRows.push({ fam, date, wr: o.pnl > 0 ? 1 : 0, pnl: o.pnl, fracV: aligned, fracC: alignedC, div: alignedC - aligned, sizeAsym: o.s.dir === "long" ? sizeAsym : -sizeAsym });
        }
      };
      run("flush", (m) => detectMomentum(m, MOM_PROD));
      run("expansion", (m) => detectExpansionScalp(m, EXP_PROD));
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions\n`);

  /* ---- PART 1 output ---- */
  console.log("=== PART 1 — next-bar direction by order-flow decile (up% [Wilson CI], n) ===");
  for (const g of hourGroups) {
    const cell = buckets.get(g.name)!;
    for (const k of ["ofiV", "ofiC", "sizeAsym"] as const) {
      const tr = deciles(cell.train, k);
      const te = deciles(cell.test, k);
      console.log(`\n${g.name.padEnd(6)} ${k.padEnd(9)} | spread train ${tr.length ? spread(tr).toFixed(1) : "—"}% · test ${te.length ? spread(te).toFixed(1) : "—"}%`);
      if (tr.length) console.log(`  train ${fmtDec(tr)}`);
      if (te.length) console.log(`  test  ${fmtDec(te)}`);
    }
  }

  /* ---- PART 2 output ---- */
  console.log("\n=== PART 2 — trigger-bar flow vs trade outcome (MOM flush + EXP expansion) ===");
  const fams = ["flush", "expansion"];
  for (const fam of fams) {
    const rows = sigRows.filter((r) => r.fam === fam);
    if (!rows.length) continue;
    const wins = rows.filter((r) => r.wr === 1);
    const losses = rows.filter((r) => r.wr === 0);
    const mean = (arr: SigRow[], k: keyof SigRow) => (arr.length ? arr.reduce((a, r) => a + (r[k] as number), 0) / arr.length : 0);
    const wr = (arr: SigRow[]) => (arr.length ? (arr.filter((r) => r.wr === 1).length / arr.length) * 100 : 0);
    console.log(`\n${fam} (n=${rows.length}, WR ${wr(rows).toFixed(1)}%)`);
    console.log(`  aligned vol-frac  winners ${mean(wins, "fracV").toFixed(3)} · losers ${mean(losses, "fracV").toFixed(3)}`);
    console.log(`  aligned cnt-frac  winners ${mean(wins, "fracC").toFixed(3)} · losers ${mean(losses, "fracC").toFixed(3)}`);
    console.log(`  cnt−vol divergence winners ${mean(wins, "div").toFixed(3)} · losers ${mean(losses, "div").toFixed(3)}`);
    console.log(`  aligned sizeAsym  winners ${mean(wins, "sizeAsym").toFixed(3)} · losers ${mean(losses, "sizeAsym").toFixed(3)}`);
    const posDiv = rows.filter((r) => r.div > 0);
    const negDiv = rows.filter((r) => r.div <= 0);
    if (posDiv.length && negDiv.length) {
      const wrs = (arr: SigRow[]) => (arr.length ? (arr.filter((r) => r.wr === 1).length / arr.length) * 100 : 0);
      console.log(`  WR div>0 ${wrs(posDiv).toFixed(1)}% (n=${posDiv.length}) vs div≤0 ${wrs(negDiv).toFixed(1)}% (n=${negDiv.length})`);
      const posTr = posDiv.filter((r) => r.date < SPLIT);
      const posTe = posDiv.filter((r) => r.date >= SPLIT);
      console.log(`    div>0 train/test WR ${wrs(posTr).toFixed(1)}% (n=${posTr.length}) / ${wrs(posTe).toFixed(1)}% (n=${posTe.length})`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
