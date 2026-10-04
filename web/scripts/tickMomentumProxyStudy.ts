/* ------------------------------------------------------------------ *
 * Tick-momentum proxy study — can the candle's REJECTION SHAPE predict
 * the next minute when true intra-minute speed is unavailable?
 *
 * The live tick-momentum engine measures the path (velocity, rejection
 * speed, impact asymmetry), but the footprint archive discarded
 * intra-minute time, so none of it backtests on history. This study
 * asks the next-best question on the data that DOES exist: do the OHLC
 * proxies of a rejection — close position in the range and wick
 * asymmetry (the candle's answer to "was the down-poke rejected?") —
 * add predictive power on top of the footprint's delta share?
 *
 * Per bar (true OHLC only — the twins exist for ~12 recent sessions):
 *   closePos — (close − low) / range           (1 = closed at the high)
 *   wickAsym — (lowerWick − upperWick) / range (+ = down-poke rejected)
 *   bodyFrac — |close − open| / range          (0 = doji)
 *   deltaFrac — footprint aggressor split      (the control variable)
 *   rangeR   — range / ATR14                   (size, from the candle study)
 * forward labels: next-close direction/move, 3-bar favorable/adverse
 * excursion, and "a MOM_PROD signal fires within 10 bars".
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/tickMomentumProxyStudy.ts [--recent N] [--rth]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, MOM_PROD, type MomMinute } from "../lib/momentum";

type Cell = { n: number; up1: number; fwd1: number; fav3: number; adv3: number; sig10: number };
const cell = (): Cell => ({ n: 0, up1: 0, fwd1: 0, fav3: 0, adv3: 0, sig10: 0 });

function med(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function bucketOf(v: number, edges: number[], labels: string[]): string {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

const CLOSEPOS = { edges: [0.3, 0.45, 0.55, 0.7], labels: ["<0.3", "0.3-0.45", "0.45-0.55", "0.55-0.7", ">0.7"] };
const WICK = { edges: [-0.4, -0.15, 0.15, 0.4], labels: ["<-0.4", "-0.4--0.15", "-0.15-0.15", "0.15-0.4", ">0.4"] };
const BODY = { edges: [0.3, 0.6], labels: ["<0.3", "0.3-0.6", ">0.6"] };
const DELTA = { edges: [-0.5, -0.2, 0.2, 0.5], labels: ["<-0.5", "-0.5--0.2", "-0.2-0.2", "0.2-0.5", ">0.5"] };

type Feat = { name: string; bucket: (f: BarF) => string };
type BarF = { closePos: number; wickAsym: number; bodyFrac: number; deltaFrac: number; rangeR: number };

const FEATURES: Feat[] = [
  { name: "closePos", bucket: (f) => bucketOf(f.closePos, CLOSEPOS.edges, CLOSEPOS.labels) },
  { name: "wickAsym", bucket: (f) => bucketOf(f.wickAsym, WICK.edges, WICK.labels) },
  { name: "bodyFrac", bucket: (f) => bucketOf(f.bodyFrac, BODY.edges, BODY.labels) },
  { name: "deltaFrac", bucket: (f) => bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels) },
];

const closeOrMid = (m: MomMinute) => (m.c > 0 ? m.c : (m.high + m.low) / 2);

function features(minutes: MomMinute[], i: number, atr14: number): BarF {
  const m = minutes[i];
  const range = m.high - m.low;
  const vol = m.buy + m.sell;
  const o = m.o;
  const c = m.c;
  return {
    closePos: range > 0.25 ? (c - m.low) / range : 0.5,
    wickAsym: range > 0.25 ? (Math.min(o, c) - m.low - (m.high - Math.max(o, c))) / range : 0,
    bodyFrac: range > 0.25 ? Math.abs(c - o) / range : 0,
    deltaFrac: vol > 0 ? (m.buy - m.sell) / vol : 0,
    rangeR: range / Math.max(0.25, atr14),
  };
}

function fmtCell(c: Cell): string {
  if (!c.n) return "—";
  return `n=${String(c.n).padStart(6)} up1=${(100 * c.up1 / c.n).toFixed(0).padStart(3)}% fwd1=${(c.fwd1 / c.n).toFixed(2).padStart(6)} fav3=${(c.fav3 / c.n).toFixed(2).padStart(6)} adv3=${(c.adv3 / c.n).toFixed(2).padStart(6)} sig10=${(100 * c.sig10 / c.n).toFixed(1).padStart(4)}%`;
}

function printTable(title: string, map: Map<string, Cell>) {
  console.log(`\n## ${title}`);
  const keys = [...map.keys()];
  const all = cell();
  for (const k of keys) {
    const c = map.get(k)!;
    all.n += c.n;
    all.up1 += c.up1;
    all.fwd1 += c.fwd1;
    all.fav3 += c.fav3;
    all.adv3 += c.adv3;
    all.sig10 += c.sig10;
  }
  console.log(`ALL  ${fmtCell(all)}`);
  for (const k of keys.sort()) console.log(`  ${k.padEnd(24)} ${fmtCell(map.get(k)!)}`);
}

/** is this feed-clock minute inside RTH (9:30–16:00 ET)? feed clock is CT */
function inRthFeed(t: string): boolean {
  const hh = Number(t.slice(0, 2));
  const mm = Number(t.slice(3, 5));
  const et = (hh + 1) % 24; // CT -> ET
  const mins = et * 60 + mm;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function main() {
  const argv = process.argv.slice(2);
  let maxSessions: number | undefined;
  let recentSessions: number | undefined;
  let rthOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max") maxSessions = Number(argv[++i]);
    if (argv[i] === "--recent") recentSessions = Number(argv[++i]);
    if (argv[i] === "--rth") rthOnly = true;
  }
  const dates = await archiveDates();
  const allDates = recentSessions ? dates.slice(-recentSessions) : maxSessions ? dates.slice(0, maxSessions) : dates;
  console.log(`tick-momentum proxy study over ${allDates.length} sessions (${rthOnly ? "RTH only" : "all hours"}), lookahead-free forward labels…`);
  const t0 = Date.now();

  const single = new Map<string, Map<string, Cell>>();
  for (const f of FEATURES) single.set(f.name, new Map());
  const xWickDelta = new Map<string, Cell>();
  const xCloseDelta = new Map<string, Cell>();
  const xCloseRanger = new Map<string, Cell>();

  let sessionsWithOhlc = 0;
  let bars = 0;
  let skipped = 0;

  for (const date of allDates) {
    const minutes = await loadSessionMinutes(date, { withOhlc: true });
    if (!minutes) continue;
    const withO = minutes.filter((m) => m.o > 0 && m.c > 0 && m.high - m.low > 0.25);
    if (!withO.length) continue;
    sessionsWithOhlc++;
    const n = minutes.length;
    const sigs = detectMomentum(minutes, MOM_PROD);
    const breaks = new Set(sigs.map((s) => s.breakIdx));

    // prefix arrays (trailing, lookahead-free)
    const atr: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const from = Math.max(0, i - 14);
      const arr: number[] = [];
      for (let k = from; k < i; k++) arr.push(minutes[k].high - minutes[k].low);
      atr[i] = med(arr);
    }

    for (let i = 1; i < n - 1; i++) {
      const m = minutes[i];
      if (!(m.o > 0 && m.c > 0 && m.high - m.low > 0.25)) continue;
      if (rthOnly && !inRthFeed(m.t)) continue;
      const f = features(minutes, i, atr[i]);

      // forward labels (next 1 close, next 3 closes)
      const next = minutes[i + 1];
      const fwd1 = closeOrMid(next) - m.c;
      let fav3 = 0;
      let adv3 = 0;
      for (let k = i + 1; k <= Math.min(i + 3, n - 1); k++) {
        const d = closeOrMid(minutes[k]) - m.c;
        fav3 = Math.max(fav3, d);
        adv3 = Math.min(adv3, d);
      }
      const sig10 = [...breaks].some((b) => b > i && b <= i + 10);

      bars++;
      const rec = (c: Cell) => {
        c.n++;
        if (fwd1 > 0) c.up1++;
        c.fwd1 += fwd1;
        c.fav3 += fav3;
        c.adv3 += adv3;
        if (sig10) c.sig10++;
      };
      for (const ft of FEATURES) {
        const map = single.get(ft.name)!;
        const key = ft.bucket(f);
        if (!map.has(key)) map.set(key, cell());
        rec(map.get(key)!);
      }
      const wd = `${bucketOf(f.wickAsym, WICK.edges, WICK.labels)} × ${bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels)}`;
      if (!xWickDelta.has(wd)) xWickDelta.set(wd, cell());
      rec(xWickDelta.get(wd)!);
      const cd = `${bucketOf(f.closePos, CLOSEPOS.edges, CLOSEPOS.labels)} × ${bucketOf(f.deltaFrac, DELTA.edges, DELTA.labels)}`;
      if (!xCloseDelta.has(cd)) xCloseDelta.set(cd, cell());
      rec(xCloseDelta.get(cd)!);
      const cr = `${bucketOf(f.closePos, CLOSEPOS.edges, CLOSEPOS.labels)} × ${bucketOf(f.rangeR, [0.7, 1.1, 1.6], ["<0.7", "0.7-1.1", "1.1-1.6", ">1.6"])}`;
      if (!xCloseRanger.has(cr)) xCloseRanger.set(cr, cell());
      rec(xCloseRanger.get(cr)!);
    }
    if (bars % 4000 < 60) console.log(`  … ${bars} bars (${sessionsWithOhlc} sessions with OHLC)`);
  }

  console.log(`\n=== ${bars} bars across ${sessionsWithOhlc} sessions with OHLC twins (${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
  console.log("(up1 = next-close up rate, fwd1 = mean next-close move in pts, fav3/adv3 = mean best/worst excursion over 3 bars, sig10 = MOM_PROD fires within 10 bars)");
  for (const ft of FEATURES) printTable(ft.name, single.get(ft.name)!);
  printTable("wickAsym × deltaFrac (does rejection SHAPE add to footprint delta?)", xWickDelta);
  printTable("closePos × deltaFrac", xCloseDelta);
  printTable("closePos × rangeR (shape × candle size)", xCloseRanger);
  if (skipped) console.log(`\n${skipped} bars skipped (no OHLC / no next bar)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
