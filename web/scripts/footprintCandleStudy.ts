/* ------------------------------------------------------------------ *
 * Footprint × candle-size feature study.
 *
 * For every 1-minute bar of every archived session, compute:
 *   candle size   — range/ATR14, expansion vs prior bar, volume-weighted
 *                   price position, top/bottom-quartile volume share
 *   footprint     — delta share, volume-per-point efficiency (vs its own
 *                   60-bar norm), diagonal + horizontal imbalance rows,
 *                   stack side/length, unfinished auctions, dominant clusters
 *   forward labels— next-bar move, 3-bar favorable/adverse excursion,
 *                   and "a MOM_PROD momentum signal fires within 10 bars"
 *
 * and print bucket tables + the interaction matrices that matter
 * (size × delta, efficiency × delta, position × delta, size × stack).
 *
 *   GC_REMOTE_URL=... node --import ../scripts/ts-loader.mjs \
 *     scripts/footprintCandleStudy.ts [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, MOM_PROD, type MomMinute } from "../lib/momentum";
import { imbalanceFor } from "../lib/imbalance";

type Cell = { n: number; sumFwd1: number; up1: number; sumFav3: number; sumAdv3: number; sig10: number };
const cell = (): Cell => ({ n: 0, sumFwd1: 0, up1: 0, sumFav3: 0, sumAdv3: 0, sig10: 0 });

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function bucketOf(v: number, edges: number[], labels: string[]): string {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

const RANGER = { edges: [0.4, 0.7, 1.1, 1.6], labels: ["<0.4", "0.4-0.7", "0.7-1.1", "1.1-1.6", ">1.6"] };
const DELTA = { edges: [-0.5, -0.2, 0.2, 0.5], labels: ["<-0.5", "-0.5--0.2", "-0.2-0.2", "0.2-0.5", ">0.5"] };
const ABSDELTA = { edges: [0.2, 0.4, 0.6], labels: ["<0.2", "0.2-0.4", "0.4-0.6", ">0.6"] };
const EFF = { edges: [0.5, 1, 2], labels: ["<0.5", "0.5-1", "1-2", ">2"] };
const VWAPPOS = { edges: [0.3, 0.45, 0.55, 0.7], labels: ["0-0.3", "0.3-0.45", "0.45-0.55", "0.55-0.7", "0.7-1"] };
const EXPANSION = { edges: [0.6, 1, 2], labels: ["<0.6", "0.6-1", "1-2", ">2"] };

type Feature = { name: string; bucket: (f: BarFeatures) => string };

type BarFeatures = {
  rangeR: number;
  expansion: number;
  deltaFrac: number;
  absDeltaFrac: number;
  effRel: number;
  vwapPos: number;
  imb: "dBuyOnly" | "dSellOnly" | "both" | "none";
  stack: "buy" | "sell" | "none";
  unf: "buyHeavy" | "sellHeavy" | "mixed" | "quiet";
  topQ: number;
  botQ: number;
};

const FEATURES: Feature[] = [
  { name: "rangeR", bucket: (f) => bucketOf(f.rangeR, RANGER.edges, RANGER.labels) },
  { name: "expansion", bucket: (f) => bucketOf(f.expansion, EXPANSION.edges, EXPANSION.labels) },
  { name: "deltaFrac", bucket: (f) => bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels) },
  { name: "absDeltaFrac", bucket: (f) => bucketOf(f.absDeltaFrac, ABSDELTA.edges, ABSDELTA.labels) },
  { name: "effRel", bucket: (f) => bucketOf(f.effRel, EFF.edges, EFF.labels) },
  { name: "vwapPos", bucket: (f) => bucketOf(f.vwapPos, VWAPPOS.edges, VWAPPOS.labels) },
  { name: "imb", bucket: (f) => f.imb },
  { name: "stack", bucket: (f) => f.stack },
  { name: "unf", bucket: (f) => f.unf },
];

function barFeatures(minutes: MomMinute[], i: number, atr14: number, medEff: number): BarFeatures {
  const m = minutes[i];
  const range = m.high - m.low;
  const vol = m.buy + m.sell;
  const levels = imbalanceFor(m.levels);
  let dBuy = 0;
  let dSell = 0;
  let hBuy = 0;
  let hSell = 0;
  let unfBuy = 0;
  let unfSell = 0;
  let domBuy = 0;
  let domSell = 0;
  let vnum = 0;
  let vden = 0;
  let topV = 0;
  let botV = 0;
  for (const l of levels) {
    if (l.dBuy) dBuy++;
    if (l.dSell) dSell++;
    if (l.hBuy) hBuy++;
    if (l.hSell) hSell++;
    if (l.buy > 0 && l.sell === 0) unfBuy++;
    if (l.sell > 0 && l.buy === 0) unfSell++;
    if (l.buy >= 3 && l.buy >= 2 * l.sell) domBuy++;
    if (l.sell >= 3 && l.sell >= 2 * l.buy) domSell++;
    const v = l.buy + l.sell;
    vnum += l.price * v;
    vden += v;
    const pos = range > 0.25 ? (l.price - m.low) / range : 0.5;
    if (pos >= 0.75) topV += v;
    if (pos <= 0.25) botV += v;
  }
  const stackSide = levels.some((l) => l.dBuy || l.hBuy) && levels.some((l) => l.dSell || l.hSell) ? "both" : "none";
  void stackSide;
  const vwapPos = range > 0.25 ? (vden > 0 ? (vnum / vden - m.low) / range : 0.5) : 0.5;
  return {
    rangeR: range / Math.max(0.25, atr14),
    expansion: range / Math.max(0.5, minutes[i - 1] ? minutes[i - 1].high - minutes[i - 1].low : range),
    deltaFrac: vol > 0 ? (m.buy - m.sell) / vol : 0,
    absDeltaFrac: vol > 0 ? Math.abs(m.buy - m.sell) / vol : 0,
    effRel: medEff > 0 ? vol / Math.max(0.5, range) / medEff : 0,
    vwapPos,
    imb: dBuy > 0 && dSell === 0 ? "dBuyOnly" : dSell > 0 && dBuy === 0 ? "dSellOnly" : dBuy > 0 || dSell > 0 ? "both" : "none",
    stack: domBuy >= 3 && domBuy > domSell ? "buy" : domSell >= 3 && domSell > domBuy ? "sell" : "none",
    unf: unfBuy >= 3 && unfBuy > unfSell ? "buyHeavy" : unfSell >= 3 && unfSell > unfBuy ? "sellHeavy" : unfBuy + unfSell >= 4 ? "mixed" : "quiet",
    topQ: vden > 0 ? topV / vden : 0,
    botQ: vden > 0 ? botV / vden : 0,
  };
}

function fmtCell(c: Cell): string {
  if (!c.n) return "—";
  return `n=${String(c.n).padStart(6)} up1=${(100 * c.up1 / c.n).toFixed(0).padStart(3)}% fwd1=${(c.sumFwd1 / c.n).toFixed(2).padStart(6)} fav3=${(c.sumFav3 / c.n).toFixed(2).padStart(6)} adv3=${(c.sumAdv3 / c.n).toFixed(2).padStart(6)} sig10=${(100 * c.sig10 / c.n).toFixed(1).padStart(4)}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  let maxSessions: number | undefined;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--max") maxSessions = Number(argv[++i]);
  let dates = await archiveDates();
  if (maxSessions) dates = dates.slice(0, maxSessions);
  console.log(`feature study over ${dates.length} sessions…`);
  const t0 = Date.now();

  // single-feature tables + interaction matrices, accumulated across sessions
  const single = new Map<string, Map<string, Cell>>();
  for (const f of FEATURES) single.set(f.name, new Map());
  const xrDelta = new Map<string, Cell>(); // rangeR × deltaFrac
  const xeffDelta = new Map<string, Cell>(); // effRel × deltaFrac
  const xposDelta = new Map<string, Cell>(); // vwapPos × deltaFrac
  const xrStack = new Map<string, Cell>(); // rangeR × stack

  let totalBars = 0;
  const sigRateTot = { n: 0, sig: 0 };
  const all = cell();

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    const n = minutes.length;
    const sigs = detectMomentum(minutes, MOM_PROD);
    const breaks = new Set(sigs.map((s) => s.breakIdx));

    // prefix arrays
    const atr: number[] = new Array(n);
    const medEff: number[] = new Array(n);
    const effs: number[] = [];
    for (let i = 0; i < n; i++) {
      const m = minutes[i];
      const range = m.high - m.low;
      const eff = (m.buy + m.sell) / Math.max(0.5, range);
      effs.push(eff);
      const fromA = Math.max(0, i - 14);
      const fromE = Math.max(0, i - 60);
      atr[i] = med(minutes.slice(fromA, i).map((x) => x.high - x.low));
      medEff[i] = med(effs.slice(fromE, i));
    }

    for (let i = 1; i < n - 3; i++) {
      const m = minutes[i];
      const mid = (m.high + m.low) / 2;
      const f = barFeatures(minutes, i, atr[i], medEff[i]);
      const fwd1 = (minutes[i + 1].high + minutes[i + 1].low) / 2 - mid;
      let fav3 = 0;
      let adv3 = 0;
      for (let k = i + 1; k <= i + 3; k++) {
        fav3 = Math.max(fav3, minutes[k].high - mid);
        adv3 = Math.max(adv3, mid - minutes[k].low);
      }
      let sig10 = false;
      for (let k = i + 1; k <= i + 10; k++) if (breaks.has(k)) sig10 = true;

      totalBars++;
      all.n++;
      all.sumFwd1 += fwd1;
      if (fwd1 > 0) all.up1++;
      all.sumFav3 += fav3;
      all.sumAdv3 += adv3;
      if (sig10) all.sig10++;

      const add = (map: Map<string, Cell>, key: string, c: Cell) => {
        const e = map.get(key) ?? cell();
        e.n += c.n;
        e.sumFwd1 += c.sumFwd1;
        e.up1 += c.up1;
        e.sumFav3 += c.sumFav3;
        e.sumAdv3 += c.sumAdv3;
        e.sig10 += c.sig10;
        map.set(key, e);
      };
      const one: Cell = { n: 1, sumFwd1: fwd1, up1: fwd1 > 0 ? 1 : 0, sumFav3: fav3, sumAdv3: adv3, sig10: sig10 ? 1 : 0 };

      for (const feat of FEATURES) {
        const b = feat.bucket(f);
        add(single.get(feat.name)!, b, one);
      }
      add(xrDelta, `${bucketOf(f.rangeR, RANGER.edges, RANGER.labels)} × ${bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels)}`, one);
      add(xeffDelta, `${bucketOf(f.effRel, EFF.edges, EFF.labels)} × ${bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels)}`, one);
      add(xposDelta, `${bucketOf(f.vwapPos, VWAPPOS.edges, VWAPPOS.labels)} × ${bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels)}`, one);
      add(xrStack, `${bucketOf(f.rangeR, RANGER.edges, RANGER.labels)} × ${f.stack}`, one);
    }
  }

  console.log(`\n${(Date.now() - t0) / 1000}s · ${totalBars.toLocaleString()} bars\n`);
  console.log("BASELINE:", fmtCell(all));
  console.log("(up1 = next bar up, fwd1 = next-bar move pts, fav3/adv3 = 3-bar excursion, sig10 = momentum signal within 10 bars)\n");

  for (const feat of FEATURES) {
    console.log(`== ${feat.name} ==`);
    const map = single.get(feat.name)!;
    const keys = [...map.keys()].sort();
    for (const k of keys) console.log(`  ${k.padEnd(12)} ${fmtCell(map.get(k)!)}`);
    console.log();
  }

  const printMatrix = (title: string, map: Map<string, Cell>) => {
    console.log(`== ${title} ==  (row × col → up1% | sig10%)`);
    console.log(`  ${map.size} cells`);
    const keys = [...map.keys()];
    for (const k of keys.sort()) {
      const c = map.get(k)!;
      console.log(`  ${k.padEnd(28)} ${fmtCell(c)}`);
    }
    console.log();
  };
  printMatrix("rangeR × deltaFrac", xrDelta);
  printMatrix("effRel × deltaFrac", xeffDelta);
  printMatrix("vwapPos × deltaFrac", xposDelta);
  printMatrix("rangeR × stack", xrStack);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
