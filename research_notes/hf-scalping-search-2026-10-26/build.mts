/* Build the HF-scalping research dataset: per-bar footprint features
 * (known at the bar's close) + honest outcomes (lib/honestFill.ts) for a
 * small, fixed set of scalp templates. Output: features.f32 / labels.f32 /
 * meta.json in OUT. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { simulateHonest, type FillBar, type EntryOrder } from "../../web/lib/honestFill.ts";

const ARCH = process.env.ARCHIVE_DIR ?? `${process.env.HOME}/.cache/nq-archive`;
const OUT = process.env.OUT_DIR ?? "hf";

type Bar = FillBar & { high: number; low: number; buy: number; sell: number; t: number; levels: [number, number, number][] };

function loadSession(file: string): Bar[] {
  const j = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  return (j.candles ?? []).map((c: any) => {
    const hh = Number(c.t.slice(11, 13)), mm = Number(c.t.slice(14, 16));
    const levels: [number, number, number][] = Object.entries(c.levels ?? {}).map(([p, v]: [string, any]) => [Number(p) / 100, v[1], v[2]]);
    levels.sort((a, b) => a[0] - b[0]);
    return { high: c.high / 100, low: c.low / 100, buy: c.buy, sell: c.sell, t: ((hh + 1) % 24) * 60 + mm, levels };
  });
}

// ---- templates: [name, dir, entry builder, stopPts, targetPts] ----
type Tpl = { name: string; dir: 1 | -1; entry: (b: Bar[], i: number, poc: number) => EntryOrder; stop: number; tgt: number };
const TICK = 0.25;
const BRACKETS: [number, number][] = JSON.parse(process.env.BRACKETS ?? "[[4,4],[8,8],[12,12],[8,16]]");
const HOLD = Number(process.env.HOLD ?? 30);
const TPLS: Tpl[] = [];
for (const [s, t] of BRACKETS) {
  for (const dir of [1, -1] as const) {
    TPLS.push({ name: `poc_lim_${dir > 0 ? "L" : "S"}_${s}_${t}`, dir, entry: (_b, _i, poc) => ({ kind: "limit", price: poc, ttlBars: 3 }), stop: s, tgt: t });
    TPLS.push({
      name: `ext_lim_${dir > 0 ? "L" : "S"}_${s}_${t}`, dir,
      entry: (b, i) => ({ kind: "limit", price: dir > 0 ? b[i].low - TICK : b[i].high + TICK, ttlBars: 3 }), stop: s, tgt: t,
    });
    TPLS.push({
      name: `brk_stp_${dir > 0 ? "L" : "S"}_${s}_${t}`, dir,
      entry: (b, i) => ({ kind: "stop", price: dir > 0 ? b[i].high + TICK : b[i].low - TICK, ttlBars: 2 }), stop: s, tgt: t,
    });
  }
}

const FEATS = [
  "rng_atr", "vol_med", "bsh", "dlt_v", "d2", "d5", "d15", "cd_slope10",
  "r5", "r15", "r30", "vwap_dist", "shi_dist", "slo_dist", "poc_pos", "top_b", "top_s", "bot_b", "bot_s",
  "stk_buy", "stk_sell", "tod", "dow", "brk30h", "brk30l", "rng15_atr", "atr_pts", "vol_pts_per_rng", "prev_bsh", "prev_rng_atr",
];

/** same rules as simulateHonest, except a bar that contains BOTH the stop
 *  and the target (or the target on a limit/stop fill bar, where the
 *  order is unknown) counts as half a win and half a loss — the
 *  order-neutral estimate; simulateHonest's stop-first is the pessimistic
 *  bound. Returns net points or null (no fill). */
function neutral(b: Bar[], i: number, dir: 1 | -1, order: EntryOrder, sp: number, tp: number, hold = 30): number | null {
  const r = simulateHonest(b, { dir, signalIdx: i, entry: order, stopPts: sp, targetPts: tp, holdBars: hold });
  if (!r || !r.filled) return null;
  if (r.hit !== "stop") return r.netPts;
  const x = b[r.exitIdx];
  const tgtHit = dir > 0 ? x.high >= r.target + TICK : x.low <= r.target - TICK;
  if (!tgtHit) return r.netPts;
  // ambiguous bar: the stop-first loss vs the target win, 50/50
  return 0.5 * r.netPts + 0.5 * (tp - 0.95);
}

const files = readdirSync(ARCH).filter((f) => /^\d{4}-\d\d-\d\d_ETH\.json\.gz$/.test(f)).sort();
const X: number[] = [];
const Y: number[] = [];
const F: number[] = []; // fill flag per template (1 filled, 0 not)
const H: number[] = []; // bars from the signal to the exit (0 = no fill)
const N: number[] = []; // order-neutral net per template
const meta: { date: string; i: number }[] = [];
for (const f of files) {
  const date = f.slice(0, 10);
  const b = loadSession(path.join(ARCH, f));
  const n = b.length;
  if (n < 120) continue;
  const vol = b.map((x) => x.buy + x.sell);
  const rng = b.map((x) => x.high - x.low);
  const mid = b.map((x) => (x.high + x.low) / 2);
  const dl = b.map((x) => x.buy - x.sell);
  const poc = b.map((x) => {
    let best = (x.high + x.low) / 2, bv = -1;
    for (const [p, bb, ss] of x.levels) if (bb + ss > bv) { bv = bb + ss; best = p; }
    return best;
  });
  let cv = 0, cpv = 0, cd = 0, shi = -Infinity, slo = Infinity;
  const cdArr: number[] = [];
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  for (let i = 0; i < n - 1; i++) {
    cv += vol[i]; cpv += poc[i] * vol[i]; cd += dl[i]; cdArr.push(cd);
    const vwap = cv > 0 ? cpv / cv : mid[i];
    const prevShi = shi, prevSlo = slo;
    shi = Math.max(shi, b[i].high); slo = Math.min(slo, b[i].low);
    if (i < 60) continue;
    let atr = 0; for (let k = i - 13; k <= i; k++) atr += rng[k]; atr /= 14;
    const med = [...vol.slice(i - 60, i)].sort((a, c) => a - c)[30];
    if (!(atr > 0) || !(med > 0) || vol[i] <= 0) continue;
    const sum = (a: number[], lo: number, hi: number) => { let s = 0; for (let k = lo; k <= hi; k++) s += a[k]; return s; };
    let hh30 = -Infinity, ll30 = Infinity, hh15 = -Infinity, ll15 = Infinity;
    for (let k = i - 30; k < i; k++) { hh30 = Math.max(hh30, b[k].high); ll30 = Math.min(ll30, b[k].low); }
    for (let k = i - 15; k <= i; k++) { hh15 = Math.max(hh15, b[k].high); ll15 = Math.min(ll15, b[k].low); }
    // stacked diagonal imbalances: buy at p vs sell at p−tick ≥ 3:1 (and mirror)
    let stkB = 0, stkS = 0;
    const lv = b[i].levels;
    for (let k = 1; k < lv.length; k++) {
      const buyHere = lv[k][1], sellBelow = lv[k - 1][2];
      if (buyHere >= 3 * Math.max(1, sellBelow) && buyHere >= 3) stkB++;
      const sellHere = lv[k - 1][2], buyAbove = lv[k][1];
      if (sellHere >= 3 * Math.max(1, buyAbove) && sellHere >= 3) stkS++;
    }
    let topB = 0, topS = 0, botB = 0, botS = 0;
    for (const [p, bb, ss] of lv) {
      if (p >= b[i].high - 0.5) { topB += bb; topS += ss; }
      if (p <= b[i].low + 0.5) { botB += bb; botS += ss; }
    }
    const feat = [
      rng[i] / atr, vol[i] / med, b[i].buy / vol[i], dl[i] / vol[i],
      sum(dl, i - 1, i) / Math.max(1, sum(vol, i - 1, i)), sum(dl, i - 4, i) / Math.max(1, sum(vol, i - 4, i)), sum(dl, i - 14, i) / Math.max(1, sum(vol, i - 14, i)),
      (cdArr[i] - cdArr[i - 10]) / Math.max(1, sum(vol, i - 9, i)),
      (mid[i] - mid[i - 5]) / atr, (mid[i] - mid[i - 15]) / atr, (mid[i] - mid[i - 30]) / atr,
      (mid[i] - vwap) / atr, (prevShi - b[i].high) / atr, (b[i].low - prevSlo) / atr,
      rng[i] > 0 ? (poc[i] - b[i].low) / rng[i] : 0.5,
      topB / vol[i], topS / vol[i], botB / vol[i], botS / vol[i],
      stkB, stkS, b[i].t, dow, b[i].high > hh30 ? 1 : 0, b[i].low < ll30 ? 1 : 0, (hh15 - ll15) / atr, atr,
      vol[i] / Math.max(TICK, rng[i]), b[i - 1].buy / Math.max(1, vol[i - 1]), rng[i - 1] / atr,
    ];
    const ys: number[] = [];
    const fs: number[] = [];
    const hs: number[] = [];
    const ns: number[] = [];
    for (const tp of TPLS) {
      const r = simulateHonest(b, { dir: tp.dir, signalIdx: i, entry: tp.entry(b, i, poc[i]), stopPts: tp.stop, targetPts: tp.tgt, holdBars: HOLD });
      if (!r || !r.filled) { ys.push(0); fs.push(0); hs.push(0); ns.push(0); } else { ys.push(r.netPts); fs.push(1); hs.push(Math.min(255, r.exitIdx - i)); ns.push(neutral(b, i, tp.dir, tp.entry(b, i, poc[i]), tp.stop, tp.tgt, HOLD) ?? 0); }
    }
    X.push(...feat); Y.push(...ys); F.push(...fs); H.push(...hs); N.push(...ns); meta.push({ date, i });
  }
}
writeFileSync(path.join(OUT, "X.f32"), Buffer.from(new Float32Array(X).buffer));
writeFileSync(path.join(OUT, "Y.f32"), Buffer.from(new Float32Array(Y).buffer));
writeFileSync(path.join(OUT, "F.u8"), Buffer.from(new Uint8Array(F).buffer));
writeFileSync(path.join(OUT, "H.u8"), Buffer.from(new Uint8Array(H).buffer));
writeFileSync(path.join(OUT, "N.f32"), Buffer.from(new Float32Array(N).buffer));
writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ feats: FEATS, tpls: TPLS.map((t) => t.name), rows: meta.length, dates: meta.map((m) => m.date), idx: meta.map((m) => m.i) }));
console.log("rows", meta.length, "templates", TPLS.length);
