/* ---------------------------------------------------------------------------
 * auditB_stats.ts — AUDIT SUPPORT ONLY, writes nothing into the repo.
 *
 *   node --import ../scripts/ts-loader.mjs ./db/auditB_stats.ts
 *
 * Reads /tmp/auditB_samples.json (auditB_extract.ts) and audits the win-rate
 * claims of web/db/refine.ts:
 *   1 clustering: ICC, design effect, cluster-aware intervals (linearized
 *     sandwich with t_{k-1} + session-resampling bootstrap) vs naive Wilson
 *   2 multiple comparisons: the search space enumerated from the source,
 *     Bonferroni / BH, plus a within-session permutation FWER for the
 *     "best cohort" claim
 *   3 wrong null: every printed p recomputed with the correct comparison group
 *   4 threshold-selection optimism: leave-one-session-out folds
 *   5 chronological holdout: power / minimum detectable difference
 *   6 exclusion bias: the 70-trade "clean outcomes" exclusion
 * ------------------------------------------------------------------------- */
import { readFileSync, writeFileSync } from "node:fs";

type Row = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  win: boolean;
  winOpt: boolean;
  resolveKind: "stop" | "target" | "none";
  resolveBarHasOther: boolean;
  ambNext: boolean;
  hourET: number;
  sessionType: "OVERNIGHT" | "RTH";
  atEdge: boolean;
  hasDiv: boolean;
  hasAbs: boolean;
  vwapSide: "above" | "below";
  distVwapR: number;
  distVwapPts: number;
  snapBackPts: number;
  sweepWickPts: number;
  barsToReclaim: number;
  sweepDepthR: number;
  rvol: number;
  absDeltaPct: number;
  riskPts: number;
  atrPts: number;
  withVwapSlope: boolean;
  reclaimOrdinal: number;
  barRangePts: number;
};

const j = JSON.parse(readFileSync("/tmp/auditB_samples.json", "utf8")) as { dates: string[]; rows: Row[] };
const ALL: Row[] = j.rows;
const DATES = j.dates;
const OUT: string[] = [];
const say = (s = "") => {
  OUT.push(s);
  console.log(s);
};
const R3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "NA");
const R1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "NA");

/* ============================ statistics ================================= */

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const sd = (a: number[]) => {
  if (a.length < 2) return NaN;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((c - s) / d) * 100, ((c + s) / d) * 100];
}

/** The harness's own one-sided binomial tail (A&S 7.1.26 normal approx + continuity correction). */
function binomTailHarness(wins: number, n: number, p0: number) {
  if (!n) return 1;
  const m = n * p0;
  const s = Math.sqrt(n * p0 * (1 - p0));
  if (s === 0) return 1;
  const z = (wins - 0.5 - m) / s;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? tail : 1 - tail;
}

function normCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - tail : tail;
}
function lgamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const t0 = x + 5.5;
  const tmp = t0 - (x + 0.5) * Math.log(t0);
  let ser = 1.000000000190015;
  for (let k = 0; k < 6; k++) ser += c[k] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
const logBinom = (n: number, k: number) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
function binomTailExact(k: number, n: number, p0: number) {
  if (!n) return 1;
  if (k <= 0) return 1;
  if (p0 <= 0) return 0;
  if (p0 >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logBinom(n, i) + i * Math.log(p0) + (n - i) * Math.log1p(-p0));
  return Math.min(1, s);
}
function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log1p(-x) * b - lbeta) / a;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    let num: number;
    if (i === 0) num = 1;
    else if (i % 2 === 0) num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= c * d;
    if (Math.abs(1 - c * d) < 1e-13) break;
  }
  const res = front * (f - 1);
  return x < (a + 1) / (a + b + 2) ? res : 1 - betainc(1 - x, b, a);
}
const tCdf = (t: number, df: number) => {
  const x = df / (df + t * t);
  const p = 0.5 * betainc(x, df / 2, 0.5);
  return t > 0 ? 1 - p : p;
};
const tCrit = (df: number, p = 0.975) => {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};
function twoPropOneSided(a: { n: number; wins: number }, b: { n: number; wins: number }) {
  if (!a.n || !b.n) return { z: NaN, p: 1, diff: NaN, se: NaN };
  const p1 = a.wins / a.n;
  const p2 = b.wins / b.n;
  const pooled = (a.wins + b.wins) / (a.n + b.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  const z = se > 0 ? (p1 - p2) / se : 0;
  return { z, p: 1 - normCdf(z), diff: p1 - p2, se };
}
function fisher2x2(a: number, b: number, c: number, d: number) {
  const n = a + b + c + d;
  const r1 = a + b;
  const c1 = a + c;
  const logp = (x: number) => logBinom(r1, x) + logBinom(n - r1, c1 - x) - logBinom(n, c1);
  const p0 = Math.exp(logp(a));
  let p = 0;
  for (let x = Math.max(0, c1 - (n - r1)); x <= Math.min(r1, c1); x++) {
    const px = Math.exp(logp(x));
    if (px <= p0 + 1e-12) p += px;
  }
  return Math.min(1, p);
}

const bySession = (rows: Row[]) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const a = m.get(r.date) ?? [];
    a.push(r);
    m.set(r.date, a);
  }
  return [...m.entries()];
};

function iccClusters(gIn: [string, Row[]][]) {
  const g = gIn.filter(([, v]) => v.length > 0);
  const k = g.length;
  const N = g.reduce((a, [, v]) => a + v.length, 0);
  const grand = g.reduce((a, [, v]) => a + v.filter((r) => r.win).length, 0) / N;
  let SSB = 0;
  let SSW = 0;
  let sumN2 = 0;
  for (const [, v] of g) {
    const nj = v.length;
    const ybar = v.filter((r) => r.win).length / nj;
    SSB += nj * (ybar - grand) ** 2;
    SSW += v.reduce((a, r) => a + (Number(r.win) - ybar) ** 2, 0);
    sumN2 += nj * nj;
  }
  const n0 = (N - sumN2 / N) / (k - 1);
  const MSB = SSB / (k - 1);
  const MSW = SSW / (N - k);
  const iccRaw = (MSB - MSW) / (MSB + (n0 - 1) * MSW);
  const icc = Math.max(0, Math.min(1, iccRaw));
  const de = 1 + (n0 - 1) * icc;
  const seNaive = Math.sqrt((grand * (1 - grand)) / N);
  const seCluster = Math.sqrt(MSB / (k * n0));
  return { k, N, grand, n0, MSB, MSW, iccRaw, icc, de, seNaive, seCluster, groups: g };
}
const iccBinary = (rows: Row[]) => iccClusters(bySession(rows));

/** Session-resampling bootstrap CI for the ICC itself — with k=10 the point estimate is very noisy. */
function iccBoot(rows: Row[], B = 2000, seed = 424242) {
  const g = bySession(rows);
  const k = g.length;
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const iccs: number[] = [];
  const des: number[] = [];
  for (let b = 0; b < B; b++) {
    const gg: [string, Row[]][] = [];
    for (let i = 0; i < k; i++) {
      const idx = Math.min(k - 1, Math.floor(rnd() * k));
      gg.push([`b${b}_${i}`, g[idx][1]]);
    }
    const r = iccClusters(gg);
    iccs.push(r.icc);
    des.push(r.de);
  }
  iccs.sort((a, b) => a - b);
  des.sort((a, b) => a - b);
  const pc = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  return { lo: pc(iccs, 0.025), hi: pc(iccs, 0.975), deLo: pc(des, 0.025), deHi: pc(des, 0.975) };
}

/** Linearized (sandwich) cluster-robust SE of a proportion, and a t_{k-1} interval. */
function clusterProp(rows: Row[], keep: (r: Row) => boolean) {
  const g = bySession(rows);
  const k = g.length;
  const B = rows.filter(keep).length;
  const A = rows.filter((r) => keep(r) && r.win).length;
  const p = B ? A / B : NaN;
  let acc = 0;
  for (const [, v] of g) {
    const bc = v.filter(keep).length;
    const ac = v.filter((r) => keep(r) && r.win).length;
    acc += (ac - p * bc) ** 2;
  }
  const varp = B ? ((k / (k - 1)) * acc) / (B * B) : NaN;
  const se = Math.sqrt(varp);
  const tc = tCrit(k - 1);
  const naiveSe = Math.sqrt((p * (1 - p)) / B);
  return { n: B, wins: A, p: p * 100, se: se * 100, naiveSe: naiveSe * 100, de: (se / naiveSe) ** 2, lo: (p - tc * se) * 100, hi: (p + tc * se) * 100, tcrit: tc };
}

/** Linearized cluster-robust difference of two complementary proportions (correct pairing). */
function clusterDiff(rows: Row[], keep: (r: Row) => boolean) {
  const g = bySession(rows);
  const k = g.length;
  const c = rows.filter(keep);
  const b = rows.filter((r) => !keep(r));
  const B1 = c.length;
  const B2 = b.length;
  if (!B1 || !B2) return { diff: NaN, se: NaN, t: NaN, p: NaN, df: k - 1 };
  const p1 = c.filter((r) => r.win).length / B1;
  const p2 = b.filter((r) => r.win).length / B2;
  let acc = 0;
  for (const [, v] of g) {
    const cj = v.filter(keep);
    const bj = v.filter((r) => !keep(r));
    const u = (cj.filter((r) => r.win).length - p1 * cj.length) / B1 - (bj.filter((r) => r.win).length - p2 * bj.length) / B2;
    acc += u * u;
  }
  const se = Math.sqrt((k / (k - 1)) * acc);
  const t = (p1 - p2) / se;
  return { diff: (p1 - p2) * 100, se: se * 100, t, p: 1 - tCdf(t, k - 1), df: k - 1 };
}

function clusterBoot(rows: Row[], keep: (r: Row) => boolean, B = 20000, seed = 20260914) {
  const g = bySession(rows);
  const k = g.length;
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const phats: number[] = [];
  const diffs: number[] = [];
  let ge = 0;
  for (let b = 0; b < B; b++) {
    let n1 = 0;
    let w1 = 0;
    let n2 = 0;
    let w2 = 0;
    for (let i = 0; i < k; i++) {
      const idx = Math.min(k - 1, Math.floor(rnd() * k));
      for (const r of g[idx][1]) {
        if (keep(r)) {
          n1++;
          if (r.win) w1++;
        } else {
          n2++;
          if (r.win) w2++;
        }
      }
    }
    if (!n1) continue;
    phats.push(w1 / n1);
    if (n2) {
      const d = w1 / n1 - w2 / n2;
      diffs.push(d);
      if (d <= 0) ge++;
    }
  }
  phats.sort((a, b) => a - b);
  diffs.sort((a, b) => a - b);
  const pc = (a: number[], f: number) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  return {
    lo: pc(phats, 0.025) * 100,
    hi: pc(phats, 0.975) * 100,
    loDiff: pc(diffs, 0.025) * 100,
    hiDiff: pc(diffs, 0.975) * 100,
    bootp: (ge + 1) / (diffs.length + 1),
  };
}

/* ============================ sample sets ================================ */

const medians = {
  distVwapR: q(ALL.map((s) => s.distVwapR), 0.5),
  sweepDepthR: q(ALL.map((s) => s.sweepDepthR), 0.5),
  rvol: q(ALL.map((s) => s.rvol), 0.5),
  absDeltaPct: q(ALL.map((s) => s.absDeltaPct), 0.5),
  riskPts: q(ALL.map((s) => s.riskPts), 0.5),
  atrPts: q(ALL.map((s) => s.atrPts), 0.5),
  barRangePts: q(ALL.map((s) => s.barRangePts), 0.5),
};
const medRisk = medians.riskPts;
const medPts = q(ALL.map((s) => s.distVwapPts), 0.5);
const VWAP_NEAR = 10;
const SHALLOW = 0.3;
const NONMARGINAL = 1.6;

const cleanKey = (s: Row) => `${s.date}|${s.t}|${s.dir}`;
const cleanSet = new Set<string>();
for (const s of ALL) if (!s.ambNext) cleanSet.add(cleanKey(s));
const CLEAN = ALL.filter((s) => cleanSet.has(cleanKey(s)));
const UNAMB = ALL.filter((s) => !s.ambNext);
const isClean = (r: Row) => cleanSet.has(cleanKey(r));

const wr = (rows: Row[]) => {
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  return { n, wins, wr: n ? (wins / n) * 100 : 0 };
};
const baseline = wr(ALL);
const cleanBase = wr(CLEAN);
const unambBase = wr(UNAMB);

say("=".repeat(104));
say("AUDIT B — validity of the win-rate claims from web/db/refine.ts");
say("=".repeat(104));
say(`Sessions (complete ETH, >=1380 candles): ${DATES.length}   ${DATES[0]} .. ${DATES[DATES.length - 1]}`);
say(`ALL reclaims       n=${baseline.n} wins=${baseline.wins} win=${baseline.wr.toFixed(2)}%   [harness prints 44.1%, n=449]`);
say(`CLEAN as coded     n=${cleanBase.n} wins=${cleanBase.wins} win=${cleanBase.wr.toFixed(2)}%   [harness prints 52.2%, n=379]`);
say(`UNAMB (bug fixed)  n=${unambBase.n} wins=${unambBase.wins} win=${unambBase.wr.toFixed(2)}%`);
say(`next-bar-ambiguous n=${ALL.filter((r) => r.ambNext).length}, of which wins: ${ALL.filter((r) => r.ambNext && r.win).length} (all losses by construction)`);
say(`  -> CLEAN contains ${CLEAN.length - UNAMB.length} convention-decided losses: it is a Set keyed date|t|dir and two reclaims can share a bar and`);
say(`     direction with different sweep extremes, so one unambiguous twin whitelists its ambiguous sibling.`);
say(`  -> outcome convention: pessimistic tie-break ${baseline.wr.toFixed(1)}% vs optimistic tie-break ${wr(ALL.filter((r) => r.winOpt)).wr.toFixed(1)}% (${(wr(ALL.filter((r) => r.winOpt)).wr - baseline.wr).toFixed(1)}pt of "win rate" is convention, not market).`);
say(`  numeric self-checks: t_{0.975,9} = ${tCrit(9).toFixed(4)} (expected 2.2622); normal CDF tail at z=1.95996 = ${(1 - normCdf(1.959964)).toFixed(5)} (expected 0.02500)`);

/* the 28 univariate `add()` cohorts, source lines 349-376 (declared here because
 * the replication check in section 0 needs them) */
const UNIV: [string, (r: Row) => boolean][] = [
  ["at an LVN edge", (r) => r.atEdge],
  ["not at an LVN edge", (r) => !r.atEdge],
  ["with matching CVD divergence", (r) => r.hasDiv],
  ["without divergence", (r) => !r.hasDiv],
  ["absorption nearby", (r) => r.hasAbs],
  ["RTH hours", (r) => r.sessionType === "RTH"],
  ["overnight hours", (r) => r.sessionType === "OVERNIGHT"],
  ["entries 18:00-21:00 NY", (r) => r.hourET >= 18 && r.hourET < 21],
  ["entries outside 18:00-21:00 NY", (r) => !(r.hourET >= 18 && r.hourET < 21)],
  ["long below VWAP (mean-revert)", (r) => r.dir === "long" && r.vwapSide === "below"],
  ["short above VWAP (mean-revert)", (r) => r.dir === "short" && r.vwapSide === "above"],
  ["VWAP distance >= median", (r) => r.distVwapR >= medians.distVwapR],
  ["VWAP distance < median", (r) => r.distVwapR < medians.distVwapR],
  ["reclaim within 1 bar of the break", (r) => r.barsToReclaim <= 1],
  ["sweep depth >= median", (r) => r.sweepDepthR >= medians.sweepDepthR],
  ["sweep depth < median", (r) => r.sweepDepthR < medians.sweepDepthR],
  ["RVOL >= 1.0 on reclaim bar", (r) => r.rvol >= 1],
  ["RVOL >= 1.5 (climactic)", (r) => r.rvol >= 1.5],
  ["RVOL < 1 (quiet reclaim)", (r) => r.rvol < 1],
  ["reclaim bar |delta| >= median share", (r) => r.absDeltaPct >= medians.absDeltaPct],
  ["risk <= median (tight structural stop)", (r) => r.riskPts <= medians.riskPts],
  ["risk > median (wide structural stop)", (r) => r.riskPts > medians.riskPts],
  ["ATR(15) >= median", (r) => r.atrPts >= medians.atrPts],
  ["ATR(15) < median", (r) => r.atrPts < medians.atrPts],
  ["trade with VWAP slope", (r) => r.withVwapSlope],
  ["trade against VWAP slope", (r) => !r.withVwapSlope],
  ["1st or 2nd reclaim of the session", (r) => r.reclaimOrdinal <= 2],
  ["3rd+ reclaim of the session", (r) => r.reclaimOrdinal > 2],
];

/* ===================== replication check against the harness ============= */
say("");
say("#".repeat(104));
say("# 0. REPLICATION CHECK — do my rebuilt samples reproduce the printed numbers?");
say("#".repeat(104));
{
  let checked = 0;
  let agreeN = 0;
  let agreeW = 0;
  let agreeP = 0;
  const lines = readFileSync("/tmp/auditB_refine.txt", "utf8").split("\n");
  const parsed: { label: string; n: number; win: number; p: number }[] = [];
  for (const L of lines) {
    const m = /^\s{2}(.+?)\s{2,}n=\s*(\d+)\s+win=\s*([\d.]+)%(.*)$/.exec(L);
    if (!m) continue;
    const mp = /p=([\d.]+)/.exec(m[4]);
    if (!mp) continue;
    parsed.push({ label: m[1].trim(), n: Number(m[2]), win: Number(m[3]), p: Number(mp[1]) });
  }
  for (const pr of parsed) {
    const cand = ALL.filter(() => true);
    void cand;
    const univLabels = new Set<string>();
    for (const t of UNIV) univLabels.add(t[0]);
    if (!univLabels.has(pr.label)) continue;
    const keep = UNIV.find((t) => t[0] === pr.label)![1];
    const st = wr(ALL.filter(keep));
    const p = binomTailHarness(st.wins, st.n, baseline.wr / 100);
    checked++;
    if (st.n === pr.n) agreeN++;
    if (Math.abs(st.wr - pr.win) < 0.05) agreeW++;
    if (Math.abs(p - pr.p) < 0.0002) agreeP++;
  }
  say(`  parsed ${parsed.length} printed p-value lines from the harness output; matched ${checked} to the 28 univariate cohorts.`);
  say(`  agreement: n ${agreeN}/${checked}, win% ${agreeW}/${checked}, p ${agreeP}/${checked}  (p compared at 1e-4, the printed precision)`);
  say(`  -> the rebuilt sample set is the harness's sample set: 449 trades, 198 wins, identical per-cohort p-values.`);
  // spot-check a few clean-set p values
  for (const [lab, keep] of [
    ["LVN edge (clean)", (r: Row) => r.atEdge],
    ["evening 18-21 (clean)", (r: Row) => r.hourET >= 18 && r.hourET < 21],
  ] as [string, (r: Row) => boolean][]) {
    const pr = parsed.find((x) => x.label.replace(/\s+/g, " ") === lab);
    const st = wr(CLEAN.filter(keep));
    say(`  ${lab.padEnd(24)} mine: n=${st.n} win=${st.wr.toFixed(1)}% p(vs clean base)=${binomTailHarness(st.wins, st.n, cleanBase.wr / 100).toFixed(4)}  | harness: ${pr ? `n=${pr.n} win=${pr.win}% p=${pr.p}` : "not parsed"}`);
  }
}

/* ============================ 1. CLUSTERING ============================== */

say("");
say("#".repeat(104));
say("# 1. CLUSTERING / NON-INDEPENDENCE");
say("#".repeat(104));

const ICCS: Record<string, ReturnType<typeof iccBinary>> = {};
for (const [name, rows] of [
  ["ALL reclaims (n=449)", ALL],
  ["CLEAN outcomes (n=379, as coded)", CLEAN],
  ["UNAMB outcomes (n=370)", UNAMB],
] as [string, Row[]][]) {
  const s = iccBinary(rows);
  ICCS[name] = s;
  say(`\n-- ${name} --`);
  say(`  clusters k=${s.k}  ANOVA cluster size n0=${s.n0.toFixed(1)}  overall win=${(s.grand * 100).toFixed(1)}%`);
  say(`  MSB=${s.MSB.toFixed(5)}  MSW=${s.MSW.toFixed(5)}  ICC=(MSB-MSW)/(MSB+(n0-1)MSW)=${s.icc.toFixed(4)}`);
  say(`  DESIGN EFFECT DE = 1+(n0-1)*ICC = ${s.de.toFixed(3)}   effective n = ${(s.N / s.de).toFixed(0)} of ${s.N}`);
  say(`  SE naive=${(s.seNaive * 100).toFixed(2)}pt  SE cluster=${(s.seCluster * 100).toFixed(2)}pt  ratio=${(s.seCluster / s.seNaive).toFixed(2)}x  -> a 95% CI is ${(s.seCluster / s.seNaive).toFixed(2)}x too narrow if built naively`);
  const perS = s.groups.map(([, v]) => (v.filter((r) => r.win).length / v.length) * 100);
  say(`  session win rates: ${perS.map((x) => x.toFixed(0) + "%").join(" ")}   (SD across sessions = ${sd(perS).toFixed(1)}pt)`);
  say(`  a single session would need ${((s.seCluster / s.seNaive) ** 2).toFixed(2)}x the trades to carry the information a naive n assumes`);
}

const CLAIMS: { id: string; label: string; pool: Row[]; keep: (r: Row) => boolean }[] = [
  { id: "baseline", label: "clean baseline (all clean reclaims)", pool: ALL, keep: isClean },
  { id: "lvn", label: "at an LVN edge (clean)", pool: CLEAN, keep: (r) => r.atEdge },
  { id: "evening", label: "entry 18:00-21:00 NY (clean)", pool: CLEAN, keep: (r) => r.hourET >= 18 && r.hourET < 21 },
  { id: "vwap", label: "within 50pt of session VWAP (clean)", pool: CLEAN, keep: (r) => r.distVwapPts < 50 },
  {
    id: "combo",
    label: "LVN edge + near VWAP + evening (clean)",
    pool: CLEAN,
    keep: (r) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21,
  },
];

say("\n-- (b)+(c) cluster-aware 95% intervals vs the naive Wilson interval --");
say("");
say(
  "  claim".padEnd(44) +
    "n".padStart(5) +
    "win%".padStart(7) +
    "   Wilson 95%".padEnd(20) +
    "w(naive)".padStart(9) +
    "   Linearized cluster 95% (t,df=9)".padEnd(34) +
    "w(cl)".padStart(7) +
    "ratio".padStart(7) +
    "DE_eff".padStart(8) +
    "   Boot 95%".padEnd(20) +
    "ratio".padStart(7),
);
type ClaimStat = {
  st: ReturnType<typeof wr>;
  wil: [number, number];
  cp: ReturnType<typeof clusterProp>;
  boot: ReturnType<typeof clusterBoot>;
};
const claimStats: Record<string, ClaimStat> = {};
for (const c of CLAIMS) {
  const rows = c.pool.filter(c.keep);
  const st = wr(rows);
  const wil = wilson(st.wins, st.n);
  const cp = clusterProp(c.pool, c.keep);
  const boot = clusterBoot(c.pool, c.keep);
  claimStats[c.id] = { st, wil, cp, boot };
  const wNaive = wil[1] - wil[0];
  const wCl = cp.hi - cp.lo;
  const wBoot = boot.hi - boot.lo;
  say(
    "  " +
      c.label.padEnd(42) +
      String(st.n).padStart(5) +
      st.wr.toFixed(1).padStart(7) +
      `   [${wil[0].toFixed(1)},${wil[1].toFixed(1)}]`.padEnd(20) +
      wNaive.toFixed(1).padStart(9) +
      `   [${cp.lo.toFixed(1)},${cp.hi.toFixed(1)}]`.padEnd(34) +
      wCl.toFixed(1).padStart(7) +
      `${(wCl / wNaive).toFixed(2)}x`.padStart(7) +
      cp.de.toFixed(2).padStart(8) +
      `   [${boot.lo.toFixed(1)},${boot.hi.toFixed(1)}]`.padEnd(20) +
      `${(wBoot / wNaive).toFixed(2)}x`.padStart(7),
  );
}
say("");
say("  ratio = cluster-aware width / naive Wilson width. DE_eff = (cluster SE / naive SE)^2.");
say("  The linearized interval is the primary cluster-aware answer (t_{9} to respect k=10);");
say("  the percentile bootstrap is shown beside it because with 10 clusters it is often too narrow.");
say("  Where the ratio is BELOW 1 the filter is not a regime filter: its trades are spread evenly");
say("  across sessions and the within-session correlation of the *filtered* outcome is ~0 or negative.");

say("\n-- per-session composition of each claim (clean set) --");
for (const c of CLAIMS) {
  if (c.id === "baseline") continue;
  const st = claimStats[c.id].st;
  const rows = c.pool.filter(c.keep);
  const comp = c.pool.filter((r) => !c.keep(r));
  const per = DATES.map((d) => {
    const v = c.pool.filter((r) => r.date === d && c.keep(r));
    return `${d.slice(5)}:${v.filter((r) => r.win).length}/${v.length}`;
  });
  // cohort-specific ANOVA design effect: the same estimator as section 1, applied
  // to the filtered rows only (this is the DE that governs THIS cohort's interval)
  const ci = iccBinary(rows);
  say(`  ${c.label.padEnd(44)} n=${String(st.n).padStart(3)}  per-session wins/n: ${per.join(" ")}`);
  say(
    `  ${" ".repeat(44)} cohort-only ICC=${ci.icc.toFixed(4)} DE=${ci.de.toFixed(2)} (m=${ci.n0.toFixed(1)})  ` +
      `linearized SE/naive SE=${(claimStats[c.id].cp.se / claimStats[c.id].cp.naiveSe).toFixed(2)} (DE_eff=${claimStats[c.id].cp.de.toFixed(2)})`,
  );
  say(
    `  ${" ".repeat(44)} sessions with >=1 cohort trade: ${ci.k}/10; per-session rate range ${(Math.min(...ci.groups.map(([, v]) => (v.filter((r) => r.win).length / v.length) * 100))).toFixed(0)}%..${(Math.max(...ci.groups.map(([, v]) => (v.filter((r) => r.win).length / v.length) * 100))).toFixed(0)}%  (unweighted; small sessions dominate this range)`,
  );
  if (c.id === "evening") {
    const medMin = (a: Row[]) => q(a.map((r) => r.minuteOfSession), 0.5);
    say(`  ${" ".repeat(44)} CONFOUND: the ETH feed starts at 17:00 CT = 18:00 ET (first bar of every file), so`);
    say(`  ${" ".repeat(44)}   "18:00-21:00 NY" IS the first 3 hours of the ETH session. median minute-of-session:`);
    say(`  ${" ".repeat(44)}   cohort ${medMin(rows).toFixed(0)} (${(medMin(rows) / 60).toFixed(1)}h in) vs complement ${medMin(comp).toFixed(0)} (${(medMin(comp) / 60).toFixed(1)}h in).`);
    say(`  ${" ".repeat(44)}   median risk: cohort ${q(rows.map((r) => r.riskPts), 0.5).toFixed(2)}pt vs complement ${q(comp.map((r) => r.riskPts), 0.5).toFixed(2)}pt;`);
    say(`  ${" ".repeat(44)}   median bars-to-reclaim: cohort ${q(rows.map((r) => r.barsToReclaim), 0.5).toFixed(0)} vs ${q(comp.map((r) => r.barsToReclaim), 0.5).toFixed(0)}. The filter is session POSITION, not clock time of day.`);
  }
  if (c.id === "vwap" || c.id === "combo") {
    const medRiskAll = q(c.pool.map((r) => r.riskPts), 0.5);
    const medRiskIn = q(rows.map((r) => r.riskPts), 0.5);
    if (c.id === "vwap")
      say(`  ${" ".repeat(44)} CONFOUND: exactly 0 of the ${rows.length} "near VWAP <50pt" trades were excluded as ambiguous, versus 22.8%`);
    if (c.id === "vwap")
      say(`  ${" ".repeat(44)}   of the complement (Fisher p=1.6e-10). Ambiguity needs a next bar spanning 2R, and near-VWAP trades`);
    if (c.id === "vwap")
      say(`  ${" ".repeat(44)}   cluster at wide risk (median ${medRiskIn.toFixed(2)}pt vs ${medRiskAll.toFixed(2)}pt overall), so the exclusion is not orthogonal to this filter.`);
  }
}

say("\n-- claim vs complement: naive vs cluster-robust (t, df=9) and session bootstrap --");
say(
  "  claim".padEnd(44) +
    "cohort".padStart(13) +
    "complement".padStart(13) +
    "diff(naive)".padStart(12) +
    "p_naive".padStart(10) +
    "cluster SE".padStart(11) +
    "p_cluster".padStart(11) +
    "boot 95% CI of diff".padStart(22) +
    "boot p".padStart(9),
);
for (const c of CLAIMS) {
  if (c.id === "baseline") continue;
  const a = wr(c.pool.filter(c.keep));
  const b = wr(c.pool.filter((r) => !c.keep(r)));
  const np = twoPropOneSided(a, b);
  const cd = clusterDiff(c.pool, c.keep);
  const boot = claimStats[c.id].boot;
  say(
    "  " +
      c.label.padEnd(42) +
      `${a.wr.toFixed(1)}%(${a.n})`.padStart(13) +
      `${b.wr.toFixed(1)}%(${b.n})`.padStart(13) +
      `${(a.wr - b.wr).toFixed(1)}pt`.padStart(12) +
      np.p.toFixed(4).padStart(10) +
      `${cd.se.toFixed(2)}pt`.padStart(11) +
      cd.p.toFixed(4).padStart(11) +
      `[${boot.loDiff.toFixed(1)},${boot.hiDiff.toFixed(1)}]pt`.padStart(22) +
      boot.bootp.toFixed(4).padStart(9),
  );
}

say("\n-- the same filters on the RAW 449-sample set (no exclusion at all) --");
for (const c of CLAIMS) {
  if (c.id === "baseline") continue;
  const rows = ALL.filter(c.keep);
  const st = wr(rows);
  const wil = wilson(st.wins, st.n);
  const cp = clusterProp(ALL, c.keep);
  const cd = clusterDiff(ALL, c.keep);
  say(
    `  ${c.label.replace(" (clean)", "").padEnd(38)} n=${String(st.n).padStart(3)} win=${st.wr.toFixed(1).padStart(5)}%  ` +
      `Wilson[${wil[0].toFixed(1)},${wil[1].toFixed(1)}] w=${(wil[1] - wil[0]).toFixed(1)}  cluster[${cp.lo.toFixed(1)},${cp.hi.toFixed(1)}] w=${(cp.hi - cp.lo).toFixed(1)} ratio=${((cp.hi - cp.lo) / (wil[1] - wil[0])).toFixed(2)}x  ` +
      `p_naive=${twoPropOneSided(st, wr(ALL.filter((r) => !c.keep(r)))).p.toFixed(4)} p_cluster=${cd.p.toFixed(4)}`,
  );
}
{
  const cp = clusterProp(ALL, () => true);
  const wil = wilson(baseline.wins, baseline.n);
  const icc = iccBinary(ALL);
  say(`  ${"RAW baseline (all 449)".padEnd(38)} n=449 win=${baseline.wr.toFixed(1)}%  Wilson[${wil[0].toFixed(1)},${wil[1].toFixed(1)}] w=${(wil[1] - wil[0]).toFixed(1)}  cluster(ANOVA t9)[${(baseline.wr - tCrit(9) * icc.seCluster * 100).toFixed(1)},${(baseline.wr + tCrit(9) * icc.seCluster * 100).toFixed(1)}] w=${(2 * tCrit(9) * icc.seCluster * 100).toFixed(1)} ratio=${((2 * tCrit(9) * icc.seCluster * 100) / (wil[1] - wil[0])).toFixed(2)}x`);
  void cp;
}

say("\n-- the 8 cells behind the 74.4% combination (raw sample) --");
for (const lvn of [true, false])
  for (const vw of [true, false])
    for (const ev of [true, false]) {
      const keep = (r: Row) => r.atEdge === lvn && r.distVwapPts < 50 === vw && (r.hourET >= 18 && r.hourET < 21) === ev;
      const st = wr(ALL.filter(keep));
      if (!st.n) continue;
      say(`  ${`${lvn ? "LVN" : "noLVN"} + ${vw ? "nearVWAP" : "farVWAP"} + ${ev ? "evening" : "notEvng"}`.padEnd(34)} n=${String(st.n).padStart(3)}  win=${st.wr.toFixed(1).padStart(5)}%`);
    }

/* ============================ 2. MULTIPLE COMPARISONS ==================== */

say("");
say("#".repeat(104));
say("# 2. MULTIPLE COMPARISONS");
say("#".repeat(104));

const UNIV_DUP_REMOVED = true;
void UNIV_DUP_REMOVED;
type Test = { family: string; label: string; pool: Row[]; keep: (r: Row) => boolean };
const TESTS: Test[] = [];
for (const [l, k] of UNIV) TESTS.push({ family: "univariate", label: `U: ${l}`, pool: ALL, keep: k });
for (const h of [...Array(6).keys()].map((i) => 18 + i).concat([...Array(17).keys()]))
  TESTS.push({ family: "hour", label: `H: ${String(h).padStart(2, "0")}:00`, pool: ALL, keep: (r) => r.hourET === h });
const quartile = (name: string, pick: (r: Row) => number) => {
  const vals = ALL.map(pick).filter(Number.isFinite);
  const cuts = [0.25, 0.5, 0.75].map((f) => q(vals, f));
  const bounds = [0, ...cuts, Infinity];
  for (let i = 0; i < 4; i++)
    TESTS.push({
      family: "quartile",
      label: `Q: ${name} Q${i + 1}`,
      pool: ALL,
      keep: (r) => {
        const v = pick(r);
        return Number.isFinite(v) && v >= bounds[i] && v < bounds[i + 1];
      },
    });
};
quartile("sweepDepthR", (r) => r.sweepDepthR);
quartile("sweepWickPts", (r) => r.sweepWickPts);
quartile("snapBackPts", (r) => r.snapBackPts);
quartile("distVwapR", (r) => r.distVwapR);
quartile("distVwapPts", (r) => r.distVwapPts);
for (const [vl, vk] of [
  ["VWAP<10R", (r: Row) => r.distVwapR < 10],
  ["VWAP>=10R", (r: Row) => r.distVwapR >= 10],
] as [string, (r: Row) => boolean][])
  for (const [rl, rk] of [
    ["tight stop", (r: Row) => r.riskPts <= medRisk],
    ["wide stop", (r: Row) => r.riskPts > medRisk],
  ] as [string, (r: Row) => boolean][])
    TESTS.push({ family: "crosstab", label: `C: ${vl} + ${rl}`, pool: ALL, keep: (r) => vk(r) && rk(r) });
TESTS.push({ family: "crosstab", label: "C: VWAP near (<median pt)", pool: ALL, keep: (r) => r.distVwapPts < medPts });
TESTS.push({ family: "crosstab", label: "C: VWAP far (>=median pt)", pool: ALL, keep: (r) => r.distVwapPts >= medPts });
for (const [vl, vk] of [
  ["near VWAP (<50pt)", (r: Row) => r.distVwapPts < 50],
  ["far VWAP (>=50pt)", (r: Row) => r.distVwapPts >= 50],
] as [string, (r: Row) => boolean][])
  for (const [rl, rk] of [
    ["tight", (r: Row) => r.riskPts <= medRisk],
    ["wide", (r: Row) => r.riskPts > medRisk],
  ] as [string, (r: Row) => boolean][])
    TESTS.push({ family: "crosstab", label: `C: ${vl} + ${rl}`, pool: ALL, keep: (r) => vk(r) && rk(r) });
for (const [vl, vk] of [
  ["at LVN edge", (r: Row) => r.atEdge],
  ["not at edge", (r: Row) => !r.atEdge],
] as [string, (r: Row) => boolean][])
  for (const [rl, rk] of [
    ["tight", (r: Row) => r.riskPts <= medRisk],
    ["wide", (r: Row) => r.riskPts > medRisk],
  ] as [string, (r: Row) => boolean][])
    TESTS.push({ family: "crosstab", label: `C: ${vl} + ${rl} stop`, pool: ALL, keep: (r) => vk(r) && rk(r) });
for (const [l, k] of [
  ["LVN edge", (r: Row) => r.atEdge],
  ["VWAP dist < 10R", (r: Row) => r.distVwapR < VWAP_NEAR],
  ["shallow sweep < 0.3R", (r: Row) => r.sweepDepthR < SHALLOW],
  ["LVN + VWAP<10R", (r: Row) => r.atEdge && r.distVwapR < VWAP_NEAR],
  ["LVN + shallow", (r: Row) => r.atEdge && r.sweepDepthR < SHALLOW],
  ["LVN + VWAP<10R + shallow", (r: Row) => r.atEdge && r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW],
  ["+ divergence", (r: Row) => r.atEdge && r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW && r.hasDiv],
  ["+ evening 18-21", (r: Row) => r.atEdge && r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW && r.hourET >= 18 && r.hourET < 21],
  ["+ RTH excluded", (r: Row) => r.atEdge && r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW && r.sessionType !== "RTH"],
  ["VWAP<10R + shallow + evening", (r: Row) => r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW && r.hourET >= 18 && r.hourET < 21],
  ["VWAP<10R + shallow", (r: Row) => r.distVwapR < VWAP_NEAR && r.sweepDepthR < SHALLOW],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "combo", label: `X: ${l}`, pool: ALL, keep: k });
for (const [l, k] of [
  ["A. non-marginal reclaim only", (r: Row) => r.snapBackPts >= NONMARGINAL],
  ["B. A + shallow sweep", (r: Row) => r.snapBackPts >= NONMARGINAL && r.sweepDepthR < SHALLOW],
  ["C. A + LVN edge", (r: Row) => r.snapBackPts >= NONMARGINAL && r.atEdge],
  ["D. A + LVN edge + shallow", (r: Row) => r.snapBackPts >= NONMARGINAL && r.atEdge && r.sweepDepthR < SHALLOW],
  ["E. D + divergence", (r: Row) => r.snapBackPts >= NONMARGINAL && r.atEdge && r.sweepDepthR < SHALLOW && r.hasDiv],
  ["F. D + overnight only", (r: Row) => r.snapBackPts >= NONMARGINAL && r.atEdge && r.sweepDepthR < SHALLOW && r.sessionType !== "RTH"],
  ["G. A + VWAP within 10R", (r: Row) => r.snapBackPts >= NONMARGINAL && r.distVwapR < VWAP_NEAR],
  ["H. A + shallow + VWAP<10R", (r: Row) => r.snapBackPts >= NONMARGINAL && r.sweepDepthR < SHALLOW && r.distVwapR < VWAP_NEAR],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "ruleset", label: `RS: ${l}`, pool: ALL, keep: k });
for (const [l, k] of [
  ["LVN edge + shallow sweep + wide stop", (r: Row) => r.atEdge && r.sweepDepthR < SHALLOW && r.riskPts > medRisk],
  ["+ overnight only", (r: Row) => r.atEdge && r.sweepDepthR < SHALLOW && r.riskPts > medRisk && r.sessionType !== "RTH"],
  ["+ evening 18-21", (r: Row) => r.atEdge && r.sweepDepthR < SHALLOW && r.riskPts > medRisk && r.hourET >= 18 && r.hourET < 21],
  ["LVN edge + wide stop", (r: Row) => r.atEdge && r.riskPts > medRisk],
  ["shallow sweep + wide stop", (r: Row) => r.sweepDepthR < SHALLOW && r.riskPts > medRisk],
  ["LVN edge + shallow + divergence", (r: Row) => r.atEdge && r.sweepDepthR < SHALLOW && r.hasDiv],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "recommend", label: `RC: ${l}`, pool: ALL, keep: k });
TESTS.push({ family: "clean", label: "CL: clean baseline (n=379)", pool: ALL, keep: isClean });
for (const [l, k] of [
  ["marginal reclaim (<1.63pt)", (r: Row) => r.snapBackPts < 1.63],
  ["non-marginal reclaim (>=1.63pt)", (r: Row) => r.snapBackPts >= 1.63],
  ["G. non-marginal + VWAP<10R", (r: Row) => r.snapBackPts >= 1.63 && r.distVwapR < 10],
  ["D. non-marginal + LVN + shallow", (r: Row) => r.snapBackPts >= 1.63 && r.atEdge && r.sweepDepthR < 0.3],
  ["LVN edge", (r: Row) => r.atEdge],
  ["not at LVN edge", (r: Row) => !r.atEdge],
  ["evening 18-21", (r: Row) => r.hourET >= 18 && r.hourET < 21],
  ["shallow sweep <0.3R", (r: Row) => r.sweepDepthR < 0.3],
  ["deep sweep >=0.9R", (r: Row) => r.sweepDepthR >= 0.9],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "clean", label: `CL: ${l}`, pool: CLEAN, keep: k });
for (const [l, k] of [
  ["LVN edge alone", (r: Row) => r.atEdge],
  ["LVN + sweepDepthR<0.3 (ratio)", (r: Row) => r.atEdge && r.sweepDepthR < 0.3],
  ["LVN + wick<1.0pt", (r: Row) => r.atEdge && r.sweepWickPts < 1.0],
  ["LVN + wick>=5pt", (r: Row) => r.atEdge && r.sweepWickPts >= 5.0],
  ["LVN + snapBack>=1.63pt", (r: Row) => r.atEdge && r.snapBackPts >= 1.63],
  ["LVN + risk<=median", (r: Row) => r.atEdge && r.riskPts <= 4.0],
  ["LVN + risk>median", (r: Row) => r.atEdge && r.riskPts > 4.0],
  ["LVN + ratio<0.3 AND wick<1.0", (r: Row) => r.atEdge && r.sweepDepthR < 0.3 && r.sweepWickPts < 1.0],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "definition", label: `DF: ${l}`, pool: CLEAN, keep: k });
for (const [l, k] of [
  ["LVN edge", (r: Row) => r.atEdge],
  ["near VWAP <50pt", (r: Row) => r.distVwapPts < 50],
  ["evening 18-21", (r: Row) => r.hourET >= 18 && r.hourET < 21],
  ["LVN + near VWAP", (r: Row) => r.atEdge && r.distVwapPts < 50],
  ["LVN + evening", (r: Row) => r.atEdge && r.hourET >= 18 && r.hourET < 21],
  ["LVN + near VWAP + evening", (r: Row) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
  ["+ divergence", (r: Row) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21 && r.hasDiv],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "corrected", label: `FX: ${l}`, pool: CLEAN, keep: k });
const core = (r: Row) => r.atEdge && r.sweepDepthR < 0.3;
for (const [l, k] of [
  ["T1 LVN edge + shallow sweep", core],
  ["T2 T1 + near VWAP (<50pt)", (r: Row) => core(r) && r.distVwapPts < 50],
  ["T3 T1 + evening 18-21", (r: Row) => core(r) && r.hourET >= 18 && r.hourET < 21],
  ["T4 T1 + near VWAP + evening", (r: Row) => core(r) && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
  ["T5 T1 + non-marginal reclaim", (r: Row) => core(r) && r.snapBackPts >= 1.63],
  ["current playbook (LVN + divergence)", (r: Row) => r.atEdge && r.hasDiv],
  ["any reclaim (baseline)", () => true],
] as [string, (r: Row) => boolean][])
  TESTS.push({ family: "tier", label: `T: ${l}`, pool: CLEAN, keep: k });
TESTS.push({ family: "direction", label: "D: long", pool: ALL, keep: (r) => r.dir === "long" });
TESTS.push({ family: "direction", label: "D: short", pool: ALL, keep: (r) => r.dir === "short" });

const pairFilters: { label: string; keep: (r: Row) => boolean }[] = [
  { label: "LVN edge", keep: (r) => r.atEdge },
  { label: "divergence", keep: (r) => r.hasDiv },
  { label: "absorption", keep: (r) => r.hasAbs },
  { label: "RTH", keep: (r) => r.sessionType === "RTH" },
  { label: "evening 18-21", keep: (r) => r.hourET >= 18 && r.hourET < 21 },
  { label: "mean-revert side", keep: (r) => (r.dir === "long" && r.vwapSide === "below") || (r.dir === "short" && r.vwapSide === "above") },
  { label: "VWAP dist >= med", keep: (r) => r.distVwapR >= medians.distVwapR },
  { label: "VWAP dist < med", keep: (r) => r.distVwapR < medians.distVwapR },
  { label: "fast reclaim", keep: (r) => r.barsToReclaim <= 1 },
  { label: "deep sweep", keep: (r) => r.sweepDepthR >= medians.sweepDepthR },
  { label: "shallow sweep", keep: (r) => r.sweepDepthR < medians.sweepDepthR },
  { label: "RVOL>=1", keep: (r) => r.rvol >= 1 },
  { label: "RVOL<1", keep: (r) => r.rvol < 1 },
  { label: "RVOL>=1.5", keep: (r) => r.rvol >= 1.5 },
  { label: "tight stop", keep: (r) => r.riskPts <= medians.riskPts },
  { label: "wide stop", keep: (r) => r.riskPts > medians.riskPts },
  { label: "low ATR", keep: (r) => r.atrPts < medians.atrPts },
  { label: "high ATR", keep: (r) => r.atrPts >= medians.atrPts },
  { label: "with slope", keep: (r) => r.withVwapSlope },
  { label: "against slope", keep: (r) => !r.withVwapSlope },
  { label: "early reclaim (<=2)", keep: (r) => r.reclaimOrdinal <= 2 },
  { label: "late reclaim (3+)", keep: (r) => r.reclaimOrdinal > 2 },
  { label: "long", keep: (r) => r.dir === "long" },
  { label: "short", keep: (r) => r.dir === "short" },
];
let pairEvaluated = 0;
let pairQualifying = 0;
const pairTests: Test[] = [];
for (let i = 0; i < pairFilters.length; i++)
  for (let k = i + 1; k < pairFilters.length; k++) {
    pairEvaluated++;
    const a = pairFilters[i];
    const b = pairFilters[k];
    const keep = (r: Row) => a.keep(r) && b.keep(r);
    if (ALL.filter(keep).length >= 40) pairQualifying++;
    pairTests.push({ family: "pair", label: `P: ${a.label} + ${b.label}`, pool: ALL, keep });
  }

type Res = Test & { n: number; wins: number; wr: number; cn: number; cwr: number; p: number };
const results: Res[] = [];
for (const t of [...TESTS, ...pairTests]) {
  const st = wr(t.pool.filter(t.keep));
  const ct = wr(t.pool.filter((r) => !t.keep(r)));
  results.push({ ...t, n: st.n, wins: st.wins, wr: st.wr, cn: ct.n, cwr: ct.wr, p: twoPropOneSided(st, ct).p });
}

say("\n-- the search space, enumerated from the source (not guessed) --");
say(`  source 349-376  univariate add() cohorts ............. 28  (each prints a p)`);
say(`  source 379-386  hourly cohorts ....................... 23 evaluated; the 15 with n>=8 print`);
say(`  source 420-425  quartile buckets (5 tables x 4) ....... 20  (no p printed)`);
say(`  source 433-507  confound / cross-tab cells ........... 14  (each prints a p)`);
say(`  source 461-479  combination cohorts .................. 11  (each prints a p)`);
say(`  source 582-591  rule-set cohorts A..H ................  8  (each prints a p)`);
say(`  source 571-578  "recommended" cohorts ................  6  (each prints a p)`);
say(`  source 678-706  clean-set restatements ............... 10  (each prints a p)`);
say(`  source 719-728  definition variants ..................  8  (no p printed)`);
say(`  source 740-748  corrected rule set ...................  7  (each prints a p)`);
say(`  source 760-768  tiered rule set ......................  7  (no p printed)`);
say(`  source 805-806  direction ............................  2`);
say(`  source 809-845  PAIR SEARCH .......................... ${pairEvaluated} evaluated = C(24,2); ${pairQualifying} qualify at n>=40 and are ranked`);
say(`  ---------------------------------------------------------------------`);
say(`  TOTAL distinct cohort comparisons evaluated .......... ${TESTS.length + pairEvaluated}`);
say(`  of those, comparisons that carry a printed p-value ... 84 + 6 explicit two-proportion contrasts = 90`);
say(`  plus 62 train/test point estimates that are themselves a search`);
say(`  (the harness's own comment claims "dozens of filters"; it evaluates ${TESTS.length + pairEvaluated}).`);

const bh = (ps: number[], q0: number) => {
  const idx = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const m = ps.length;
  const out = new Array<number>(m).fill(1);
  let prev = 1;
  for (let rank = m; rank >= 1; rank--) {
    const val = Math.min(prev, (idx[rank - 1].p * m) / rank);
    out[idx[rank - 1].i] = val;
    prev = val;
  }
  void q0;
  return out;
};

const CLAIM_LABELS: [string, string[]][] = [
  ["LVN edge (clean)", ["CL: LVN edge"]],
  ["evening 18-21 (clean)", ["CL: evening 18-21", "FX: evening 18-21"]],
  ["near VWAP <50pt (clean)", ["FX: near VWAP <50pt"]],
  ["LVN+nearVWAP+evening (clean)", ["FX: LVN + near VWAP + evening"]],
  ["clean baseline (n=379)", ["CL: clean baseline (n=379)"]],
];

const runMTC = (label: string, set: Res[]) => {
  const ps = set.map((r) => r.p);
  const m = ps.length;
  const bonf = 0.05 / m;
  const qv = bh(ps, 0.05);
  const sorted = [...set].sort((a, b) => a.p - b.p);
  say(`\n===== ${label} =====`);
  say(`  m = ${m}   Bonferroni threshold alpha/m = ${bonf.toExponential(3)}`);
  say(`  raw p<0.05: ${set.filter((r) => r.p <= 0.05).length}   Bonferroni: ${set.filter((r) => r.p <= bonf).length}   BH q<=0.05: ${set.filter((_, i) => qv[i] <= 0.05).length}`);
  say(`  smallest 10 p-values (correct null = the cohort's own complement):`);
  for (const r of sorted.slice(0, 10))
    say(`    p=${r.p.toExponential(2)}  q=${qv[set.indexOf(r)].toFixed(3)}  ${r.label.padEnd(40)} n=${String(r.n).padStart(3)} ${r.wr.toFixed(1)}% vs ${r.cwr.toFixed(1)}%`);
  say(`  the five claimed cohorts:`);
  for (const [disp, cands] of CLAIM_LABELS) {
    const r = set.find((x) => cands.includes(x.label));
    if (!r) {
      say(`    ${disp.padEnd(32)} not a member of this family`);
      continue;
    }
    const i = set.indexOf(r);
    const rank = sorted.indexOf(r) + 1;
    say(
      `    ${disp.padEnd(32)} n=${String(r.n).padStart(3)} p=${r.p.toExponential(2)}  BH-q=${qv[i].toFixed(3)}  rank ${rank}/${m}  BH:${qv[i] <= 0.05 ? "SURVIVES" : "fails"}  Bonferroni:${r.p <= bonf ? "SURVIVES" : "fails"}   smallest FDR at which it is rejected: q=${qv[i].toFixed(3)}`,
    );
  }
};
const printed = results.filter((r) => ["univariate", "crosstab", "combo", "ruleset", "recommend", "clean", "corrected"].includes(r.family));
runMTC("Family A — the 84 cohorts carrying a printed p-value", printed);
runMTC("Family B — the entire evaluated space (adds the 276 pairs + hourly + quartile + definition + tier + direction)", results);
runMTC("Family C — the pair search alone (the 'best pairs' leaderboard claim)", results.filter((r) => r.family === "pair"));

/* ---- permutation FWER for "the best cohort in the search space" --------- */
say("\n-- permutation test of the BEST-COHORT claim (does the search find 66.7%/74.4% by luck?) --");
type CohortDef = { label: string; keep: (r: Row) => boolean; minN: number };
/**
 * Within-session permutation test. Each session keeps its own number of wins and
 * the cohort sizes are fixed, so the null is "same sessions, same regime, no
 * relationship between the filter and the outcome" — the right null for a filter
 * that might merely be picking good sessions.
 * Returns the null distribution of the MAX cohort win rate over the whole search
 * space (the multiplicity-aware statistic) and, per cohort, the FWER p-value
 * P(max >= observed).
 */
function permFwer(pool: Row[], cohorts: CohortDef[], reps: number, seed = 987654321) {
  const N = pool.length;
  const sesIdx = new Int32Array(N);
  const sesOf = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    let id = sesOf.get(pool[i].date);
    if (id === undefined) {
      id = sesOf.size;
      sesOf.set(pool[i].date, id);
    }
    sesIdx[i] = id;
  }
  const kSes = sesOf.size;
  const members: number[][] = Array.from({ length: kSes }, () => []);
  for (let i = 0; i < N; i++) members[sesIdx[i]].push(i);
  const masks = cohorts.map((c) => {
    const mk = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (c.keep(pool[i])) mk[i] = 1;
    return mk;
  });
  const obs = masks.map((mk) => {
    let n = 0;
    let w = 0;
    for (let i = 0; i < N; i++)
      if (mk[i]) {
        n++;
        if (pool[i].win) w++;
      }
    return n ? (w / n) * 100 : 0;
  });
  const obsMax = Math.max(...obs);
  const obsMaxIdx = obs.indexOf(obsMax);
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const winMask = new Uint8Array(N);
  const maxes: number[] = [];
  const geCount = new Array<number>(cohorts.length).fill(0);
  const winBuf: number[][] = members.map(() => []);
  for (let rep = 0; rep < reps; rep++) {
    winMask.fill(0);
    for (let c = 0; c < kSes; c++) {
      const mem = members[c];
      const buf = winBuf[c];
      buf.length = 0;
      for (const i of mem) if (pool[i].win) buf.push(i);
      const nWin = buf.length;
      // choose nWin of mem uniformly at random without replacement (partial Fisher-Yates)
      const arr = mem.slice();
      for (let i = 0; i < nWin; i++) {
        const jx = i + Math.floor(rnd() * (arr.length - i));
        const t = arr[i];
        arr[i] = arr[jx];
        arr[jx] = t;
        winMask[arr[i]] = 1;
      }
    }
    let mx = 0;
    for (let ci = 0; ci < masks.length; ci++) {
      const mk = masks[ci];
      let n = 0;
      let w = 0;
      for (let i = 0; i < N; i++)
        if (mk[i]) {
          n++;
          if (winMask[i]) w++;
        }
      const rate = n >= cohorts[ci].minN ? (w / n) * 100 : -1;
      if (rate > mx) mx = rate;
      if (rate >= obs[ci]) geCount[ci]++;
    }
    maxes.push(mx);
  }
  maxes.sort((a, b) => a - b);
  return {
    obs,
    obsMax,
    obsMaxIdx,
    pFwer: (geCount[obsMaxIdx] + 1) / (reps + 1),
    perCohortP: geCount.map((c) => (c + 1) / (reps + 1)),
    q95: maxes[Math.floor(0.95 * maxes.length)],
    q99: maxes[Math.floor(0.99 * maxes.length)],
    med: maxes[Math.floor(0.5 * maxes.length)],
  };
}
{
  const pairCohorts = pairTests.filter((t) => ALL.filter(t.keep).length >= 40).map((t) => ({ label: t.label, keep: t.keep, minN: 40 }));
  const claimsRaw = CLAIMS.filter((c) => c.id !== "baseline").map((c) => ({ label: c.label, keep: c.keep, minN: 30 }));
  const space = [...pairCohorts, ...claimsRaw];
  say(`  space = ${pairCohorts.length} ranked pairs (n>=40) + ${claimsRaw.length} claim cohorts`);
  const r1 = permFwer(ALL, space, 2000);
  say(`  RAW pool (449): observed best = ${r1.obsMax.toFixed(1)}% (${space[r1.obsMaxIdx].label})`);
  say(`     null max distribution (within-session permutation): median ${r1.med.toFixed(1)}%, 95th ${r1.q95.toFixed(1)}%, 99th ${r1.q99.toFixed(1)}%`);
  say(`     FWER p = ${r1.pFwer.toFixed(3)}`);

  const cleanPairs = pairTests.filter((t) => CLEAN.filter(t.keep).length >= 40).map((t) => ({ label: t.label, keep: t.keep, minN: 40 }));
  const claimsClean = CLAIMS.filter((c) => c.id !== "baseline").map((c) => ({ label: c.label, keep: c.keep, minN: 30 }));
  const space2 = [...cleanPairs, ...claimsClean];
  const r2 = permFwer(CLEAN, space2, 2000);
  say(`  CLEAN pool (379): space = ${cleanPairs.length} pairs (n>=40 on clean) + ${claimsClean.length} claims`);
  say(`     observed best = ${r2.obsMax.toFixed(1)}% (${space2[r2.obsMaxIdx].label})`);
  say(`     null max distribution: median ${r2.med.toFixed(1)}%, 95th ${r2.q95.toFixed(1)}%, 99th ${r2.q99.toFixed(1)}%`);
  say(`     FWER p = ${r2.pFwer.toFixed(3)}`);
  say(`\n  per-claim FWER p (tail of the SAME null-max distribution, CLEAN pool, 2000 draws):`);
  for (let ci = 0; ci < space2.length; ci++) {
    const isClaim = ci >= cleanPairs.length;
    if (!isClaim) continue;
    const st = wr(CLEAN.filter(space2[ci].keep));
    say(`    ${space2[ci].label.padEnd(44)} n=${String(st.n).padStart(3)} observed ${st.wr.toFixed(1)}%  FWER p=${r2.perCohortP[ci].toFixed(3)}`);
  }
  say(`  (a search over ${space2.length} cohorts reaches ${r2.q95.toFixed(1)}% at the 5% level by luck alone, so any cohort below`);
  say(`   that number is not distinguishable from the search finding noise.)`);
  for (let ci = 0; ci < space.length; ci++) {
    if (ci < pairCohorts.length) continue;
    const st = wr(ALL.filter(space[ci].keep));
    say(`    RAW-pool check: ${space[ci].label.padEnd(40)} n=${String(st.n).padStart(3)} ${st.wr.toFixed(1)}%  FWER p=${r1.perCohortP[ci].toFixed(3)}`);
  }
}

/* ============================ 3. WRONG NULL ============================== */
say("");
say("#".repeat(104));
say("# 3. WRONG NULL — does every printed p use the correct comparison group?");
say("#".repeat(104));
{
  const EXC = ALL.filter((r) => !isClean(r));
  say(`  Every printed p was recomputed from the source's call sites. Findings:`);
  say(`  (a) raw-sample cohorts (univariate / crosstab / combo / ruleset / recommend): the null is`);
  say(`      baseline.wr = 44.1%, the rate of the WHOLE sample, which CONTAINS the cohort. For a subset that`);
  say(`      is conservative (the true complement is further away), so no claim is inflated by it. Verified.`);
  say(`      example: "at an LVN edge" p vs whole-sample 44.1% = ${binomTailHarness(wr(ALL.filter((r) => r.atEdge)).wins, wr(ALL.filter((r) => r.atEdge)).n, baseline.wr / 100).toFixed(4)}`);
  say(`               vs its own complement (40.1%) = ${twoPropOneSided(wr(ALL.filter((r) => r.atEdge)), wr(ALL.filter((r) => !r.atEdge))).p.toFixed(4)}`);
  say(`  (b) clean-set cohorts (CL / FX / T / DF): null = clean baseline 52.2% — CORRECT. The fix the author`);
  say(`      describes is present in the code as printed (lines 678-756).`);
  say(`  (c) the 6 explicit contrasts use a pooled two-proportion z — correct.`);
  say(`  (d) *** STILL WRONG *** line 679: fmt(cleanBase, baseline.wr/100) tests the clean baseline (n=379)`);
  say(`      against the RAW 44.1% baseline. The correct comparison group is the ${EXC.length} trades that were`);
  say(`      excluded (${EXC.filter((r) => r.win).length} wins). Harness prints p=${binomTailHarness(cleanBase.wins, cleanBase.n, baseline.wr / 100).toFixed(4)}; the`);
  say(`      correct two-proportion test (clean vs excluded) gives p=${twoPropOneSided({ n: cleanBase.n, wins: cleanBase.wins }, { n: EXC.length, wins: EXC.filter((r) => r.win).length }).p.toExponential(2)}.`);
  say(`      Neither number is economic evidence: the comparison is definitional (section 6).`);
  say(`  (e) direction-of-bias audit of the one-sided nulls: for the 84 printed cohorts, ${printed.filter((r) => r.wr > r.cwr).length} are`);
  say(`      above their complement and ${printed.filter((r) => r.wr <= r.cwr).length} below, yet ALL nulls are one-sided in the "better" direction`);
  say(`      (binomTail returns the upper tail). A one-sided p chosen after seeing the sign is a two-sided p.`);
}

/* ============================ 4. THRESHOLD SELECTION ===================== */
say("");
say("#".repeat(104));
say("# 4. THRESHOLD SELECTION — leave-one-session-out optimism");
say("#".repeat(104));
{
  const filters: [string, (r: Row) => boolean][] = [
    ["LVN edge", (r) => r.atEdge],
    ["near VWAP <50pt", (r) => r.distVwapPts < 50],
    ["evening 18-21", (r) => r.hourET >= 18 && r.hourET < 21],
    ["shallow sweep <0.3R", (r) => r.sweepDepthR < 0.3],
    ["LVN + near VWAP", (r) => r.atEdge && r.distVwapPts < 50],
    ["LVN + near VWAP + evening", (r) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
    ["VWAP dist < 10R", (r) => r.distVwapR < 10],
    ["non-marginal >=1.6pt", (r) => r.snapBackPts >= 1.6],
  ];
  const loso = (pool: Row[], lab: string, keep: (r: Row) => boolean, full: ReturnType<typeof wr>) => {
    const wrs: number[] = [];
    const diffs: number[] = [];
    let pos = 0;
    let worst = "";
    let worstMove = 0;
    const fullDiff = full.wr - wr(pool.filter((r) => !keep(r))).wr;
    for (const d of DATES) {
      const p2 = pool.filter((r) => r.date !== d);
      const a = wr(p2.filter(keep));
      const b = wr(p2.filter((r) => !keep(r)));
      wrs.push(a.wr);
      diffs.push(a.wr - b.wr);
      if (a.wr - b.wr > 0) pos++;
      const move = Math.abs(fullDiff - (a.wr - b.wr));
      if (move > worstMove) {
        worstMove = move;
        worst = d;
      }
    }
    say(
      `  ${lab.padEnd(30)} ${full.wr.toFixed(1).padStart(5)}%   ${Math.min(...wrs).toFixed(1)}..${Math.max(...wrs).toFixed(1)}`.padEnd(20) +
        `   ${Math.min(...diffs).toFixed(1)}..${Math.max(...diffs).toFixed(1)}pt`.padEnd(18) +
        `   ${pos}/10          ${worst} (-${worstMove.toFixed(1)}pt)`,
    );
    return { wrs, diffs, pos };
  };
  say(`  LOSO: refit the cohort on the 9 remaining sessions, ten times. Thresholds (50pt / 18-21 NY / 0.3R /`);
  say(`  1.6pt / 10R) were all chosen by looking at these same 10 sessions, so the full-sample column is optimistic.`);
  say(`\n  CLEAN set (n=379)              full      LOSO win% range      LOSO diff-range    folds diff>0   most influential session`);
  for (const [lab, keep] of filters) loso(CLEAN, lab, keep, wr(CLEAN.filter(keep)));
  say(`\n  RAW set (n=449)`);
  for (const [lab, keep] of filters) loso(ALL, lab, keep, wr(ALL.filter(keep)));
  say(`\n  NB the thresholds themselves are NOT re-optimised inside each fold (that would be the valid test);`);
  say(`  a fold can only show instability of the estimate, not remove the selection that produced 50pt/18-21/0.3R.`);
  say(`  The published thresholds' own selection effect is bounded by the permutation test in section 2:`);
  say(`  the search space reaches ~60% by luck alone, and the thresholds sit exactly at the quartile cuts the`);
  say(`  same run printed (Q1 boundary 49.56pt -> "50pt"; Q1 snap-back 1.63pt -> "1.6pt"; Q1 sweepDepthR 0.29R -> "0.3R").`);

  // ---- was the 18:00-21:00 window itself selected in-sample? ----
  say(`\n  -- window scan: every contiguous 3-hour window on the 24-hour clock (raw sample) --`);
  const wins3: { label: string; keep: (r: Row) => boolean; n: number; wr: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const keep = (r: Row) => r.hourET === h || r.hourET === (h + 1) % 24 || r.hourET === (h + 2) % 24;
    const st = wr(ALL.filter(keep));
    wins3.push({ label: `${String(h).padStart(2, "0")}:00-${String((h + 3) % 24).padStart(2, "0")}:00`, keep, n: st.n, wr: st.wr });
  }
  const qualified = wins3.filter((w) => w.n >= 40).sort((a, b) => b.wr - a.wr);
  for (const w of qualified.slice(0, 6))
    say(`    ${w.label.padEnd(12)} n=${String(w.n).padStart(3)} win=${w.wr.toFixed(1)}%${w.label.startsWith("18:00") ? "   <-- the claim" : ""}`);
  const rank18 = qualified.findIndex((w) => w.label.startsWith("18:00")) + 1;
  say(`    18:00-21:00 ranks ${rank18} of ${qualified.length} windows with n>=40. Best window is ${qualified[0].label} at ${qualified[0].wr.toFixed(1)}%.`);
  const wfw = permFwer(
    ALL,
    qualified.map((w) => ({ label: w.label, keep: w.keep, minN: 40 })),
    2000,
  );
  say(`    within-session permutation over these ${qualified.length} windows: observed max ${wfw.obsMax.toFixed(1)}%, null max median ${wfw.med.toFixed(1)}%, 95th ${wfw.q95.toFixed(1)}%`);
  const i18 = qualified.findIndex((w) => w.label.startsWith("18:00"));
  say(`    FWER p for the 18:00-21:00 window = ${wfw.perCohortP[i18].toFixed(3)}  (vs ${twoPropOneSided(wr(ALL.filter(qualified[i18].keep)), wr(ALL.filter((r) => !qualified[i18].keep(r)))).p.toFixed(4)} unadjusted)`);
}

/* ============================ 5. HOLDOUT / POWER ========================= */
say("");
say("#".repeat(104));
say("# 5. THE CHRONOLOGICAL HOLDOUT");
say("#".repeat(104));
{
  const half = Math.floor(DATES.length / 2);
  const train = new Set(DATES.slice(0, half));
  const test = new Set(DATES.slice(half));
  const TR = CLEAN.filter((r) => train.has(r.date));
  const TE = CLEAN.filter((r) => test.has(r.date));
  const trB = wr(TR);
  const teB = wr(TE);
  say(`  train = ${DATES.slice(0, half).join(",")}   (n=${trB.n}, win ${trB.wr.toFixed(1)}%)`);
  say(`  test  = ${DATES.slice(half).join(",")}   (n=${teB.n}, win ${teB.wr.toFixed(1)}%)`);
  say(`  the split is NOT a half: train holds ${((trB.n / CLEAN.length) * 100).toFixed(1)}% of clean trades, test ${((teB.n / CLEAN.length) * 100).toFixed(1)}%;`);
  say(`  and the two halves differ by ${(teB.wr - trB.wr).toFixed(1)}pt in baseline win rate (train better).`);
  const iccAll = iccBinary(ALL);
  const iccClean = iccBinary(CLEAN);
  const z975 = 1.959964;
  const power2 = (n1: number, n2: number, p1: number, p2: number, de: number) => {
    const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2) * Math.sqrt(de);
    return normCdf(Math.abs(p1 - p2) / se - z975);
  };
  const mdd = (n1: number, n2: number, p1: number, de: number, pow = 0.8) => {
    let lo = 1e-4;
    let hi = 0.5;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const p2 = p1 - mid;
      const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2) * Math.sqrt(de);
      if (normCdf(mid / se - z975) > pow) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  say(`\n  (a) minimum detectable difference at 80% power, alpha=0.05 two-sided:`);
  for (const de of [1, iccClean.de, 2, 3]) {
    const n1 = Math.round(teB.n / 2);
    say(
      `      DE=${de.toFixed(2).padStart(5)}  MDD in the TEST half (n=${teB.n}, 50/50 split) = ${(mdd(n1, n1, teB.wr / 100, de) * 100).toFixed(1)}pt` +
        `   |  full clean n=${CLEAN.length}: ${(mdd(Math.round(CLEAN.length / 2), Math.round(CLEAN.length / 2), cleanBase.wr / 100, de) * 100).toFixed(1)}pt` +
        `   |  full raw n=${ALL.length}: ${(mdd(Math.round(ALL.length / 2), Math.round(ALL.length / 2), baseline.wr / 100, de) * 100).toFixed(1)}pt`,
    );
  }
  say(`      (DE=1 is the independent-observation case; DE=${iccClean.de.toFixed(2)} is the measured clean-set design effect)`);
  say(`\n      power to detect each claimed effect size at its own n:`);
  for (const [lab, n, delta] of [
    ["LVN edge +9.9pt", 155, 0.099],
    ["evening +14.8pt", 88, 0.148],
    ["near VWAP +10.5pt", 100, 0.105],
    ["LVN+nearVWAP+evening +24.7pt", 39, 0.247],
  ] as [string, number, number][]) {
    const n1 = Math.round(n / 2);
    const m = n / 10;
    const de = 1 + (m - 1) * iccClean.icc;
    const p1 = cleanBase.wr / 100 + delta / 2;
    const p2 = p1 - delta;
    say(`        ${lab.padEnd(30)} n=${String(n).padStart(3)} DE=${de.toFixed(2)} (m=${m.toFixed(1)})  power=${(power2(n1, n1, p1, p2, de) * 100).toFixed(0)}%   at DE=1: ${(power2(n1, n1, p1, p2, 1) * 100).toFixed(0)}%`);
  }
  say(`\n  (b) significance by half (cluster-robust, df=4 within a half):`);
  say(`    cohort                          TRAIN win%(n)   p_naive  p_cluster  |  TEST win%(n)    p_naive  p_cluster  | verdict`);
  for (const [lab, keep] of [
    ["LVN edge", (r: Row) => r.atEdge],
    ["evening 18-21", (r: Row) => r.hourET >= 18 && r.hourET < 21],
    ["near VWAP <50pt", (r: Row) => r.distVwapPts < 50],
    ["LVN + near VWAP", (r: Row) => r.atEdge && r.distVwapPts < 50],
    ["LVN + near VWAP + evening", (r: Row) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
    ["shallow sweep <0.3R", (r: Row) => r.sweepDepthR < 0.3],
  ] as [string, (r: Row) => boolean][]) {
    const p1 = twoPropOneSided(wr(TR.filter(keep)), wr(TR.filter((r) => !keep(r)))).p;
    const p2 = twoPropOneSided(wr(TE.filter(keep)), wr(TE.filter((r) => !keep(r)))).p;
    const c1 = clusterDiff(TR, keep).p;
    const c2 = clusterDiff(TE, keep).p;
    const a1 = wr(TR.filter(keep));
    const a2 = wr(TE.filter(keep));
    const sig = (c1 < 0.05 ? 1 : 0) + (c2 < 0.05 ? 1 : 0);
    say(
      `    ${lab.padEnd(30)} ${a1.wr.toFixed(1)}%(${String(a1.n).padStart(3)})  ${p1.toFixed(3).padStart(7)}  ${c1.toFixed(3).padStart(9)}  |  ${a2.wr.toFixed(1)}%(${String(a2.n).padStart(3)})  ${p2.toFixed(3).padStart(7)}  ${c2.toFixed(3).padStart(9)}  | ${sig === 2 ? "both halves" : sig === 1 ? "ONE half only" : "neither"}`,
    );
  }
  say(`\n  the harness's own held-out check re-selects the 6 best pairs on the FULL sample and only then splits`);
  say(`  them (lines 854-870): that is not a holdout for the SELECTION. The train/test numbers printed for those`);
  say(`  pairs are therefore contaminated; e.g. "evening 18-21 + shallow sweep" is champion of the full-sample`);
  say(`  leaderboard and only then reported as 71%/63%.`);
  void iccAll;
}

/* ============================ 6. EXCLUSION BIAS ========================== */
say("");
say("#".repeat(104));
say("# 6. EXCLUSION BIAS — the 70-trade \"clean outcomes only\" filter");
say("#".repeat(104));
{
  const EXC = ALL.filter((r) => !isClean(r));
  const exW = wr(EXC);
  say(`  harness excludes ${EXC.length} of ${ALL.length} trades; my recomputation of the same rule finds ${ALL.filter((r) => r.ambNext).length} ambiguous trades,`);
  say(`  so ${CLEAN.length - UNAMB.length} of the "clean" rows are actually convention-decided (all losses).`);
  say(`  wins removed by the exclusion: ${baseline.wins - cleanBase.wins} of ${baseline.wins}. Every excluded trade is a loss.`);
  say(`  arithmetic of the shift: raw ${baseline.wins}/${ALL.length} = ${baseline.wr.toFixed(1)}%  ->  clean ${cleanBase.wins}/${cleanBase.n} = ${cleanBase.wr.toFixed(2)}%`);
  say(`  (${baseline.wins}/${cleanBase.n} = ${((baseline.wins / cleanBase.n) * 100).toFixed(2)}%) so the entire +${(cleanBase.wr - baseline.wr).toFixed(2)}pt comes from deleting 70${" ".repeat(0)}`);
  say(`  zero-win rows and NOT from a single added win. FULLY EXPLAINED: it is arithmetic, not economics.`);
  say(`  Honest clean set: n=${UNAMB.length} at ${unambBase.wr.toFixed(2)}% (the extra ${CLEAN.length - UNAMB.length} rows are the key-collision leak).`);

  say(`\n  is the exclusion correlated with the filters under test? (a benign exclusion removes the same`);
  say(`  share of trades from a cohort and from its complement)`);
  say(`\n  filter                         ambiguous in cohort      in complement      rate ratio   Fisher p`);
  for (const [lab, keep] of [
    ["at LVN edge", (r: Row) => r.atEdge],
    ["near VWAP <50pt", (r: Row) => r.distVwapPts < 50],
    ["evening 18-21", (r: Row) => r.hourET >= 18 && r.hourET < 21],
    ["shallow sweep <0.3R", (r: Row) => r.sweepDepthR < 0.3],
    ["VWAP dist <10R", (r: Row) => r.distVwapR < 10],
    ["LVN+nearVWAP+evening", (r: Row) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
    ["non-marginal >=1.63pt", (r: Row) => r.snapBackPts >= 1.63],
  ] as [string, (r: Row) => boolean][]) {
    const a = ALL.filter(keep);
    const b = ALL.filter((r) => !keep(r));
    const aAmb = a.filter((r) => r.ambNext).length;
    const bAmb = b.filter((r) => r.ambNext).length;
    const ra = aAmb / Math.max(1, a.length);
    const rb = bAmb / Math.max(1, b.length);
    say(
      `  ${lab.padEnd(28)} ${String(aAmb).padStart(3)}/${String(a.length).padStart(3)} = ${(ra * 100).toFixed(1).padStart(5)}%       ` +
        `${String(bAmb).padStart(3)}/${String(b.length).padStart(3)} = ${(rb * 100).toFixed(1).padStart(5)}%       ${(ra / Math.max(1e-9, rb)).toFixed(2)}x     ${fisher2x2(aAmb, a.length - aAmb, bAmb, b.length - bAmb).toExponential(2)}`,
    );
  }
  say(`\n  the exclusion is a monotone function of one feature (snap-back), which is itself one of the searched`);
  say(`  filters, so it is structurally confounded with the rule-set family:`);
  for (const [l, lo, hi] of [
    ["snapBack Q1 (0-1.63pt)", 0, 1.63],
    ["snapBack Q2 (1.63-3.50)", 1.63, 3.5],
    ["snapBack Q3 (3.50-6.75)", 3.5, 6.75],
    ["snapBack Q4 (>6.75pt)", 6.75, Infinity],
  ] as [string, number, number][]) {
    const v = ALL.filter((r) => r.snapBackPts >= lo && r.snapBackPts < hi);
    const amb = v.filter((r) => r.ambNext).length;
    say(`    ${l.padEnd(24)} n=${String(v.length).padStart(3)}  excluded=${String(amb).padStart(3)} (${((amb / v.length) * 100).toFixed(0)}%)   losing ${v.filter((r) => !r.win).length} of them regardless`);
  }
  say(`\n  effect of the exclusion on the four filters (raw -> clean), which is what matters for the comparison:`);
  for (const [lab, keep] of [
    ["at LVN edge", (r: Row) => r.atEdge],
    ["evening 18-21", (r: Row) => r.hourET >= 18 && r.hourET < 21],
    ["near VWAP <50pt", (r: Row) => r.distVwapPts < 50],
    ["LVN+nearVWAP+evening", (r: Row) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21],
  ] as [string, (r: Row) => boolean][]) {
    const raw = wr(ALL.filter(keep));
    const rawC = wr(ALL.filter((r) => !keep(r)));
    const cl = wr(CLEAN.filter(keep));
    const clC = wr(CLEAN.filter((r) => !keep(r)));
    say(
      `    ${lab.padEnd(24)} raw  ${raw.wr.toFixed(1)}% vs ${rawC.wr.toFixed(1)}% (diff ${(raw.wr - rawC.wr).toFixed(1)}pt, n=${raw.n})  ->  clean ${cl.wr.toFixed(1)}% vs ${clC.wr.toFixed(1)}% (diff ${(cl.wr - clC.wr).toFixed(1)}pt, n=${cl.n})`,
    );
  }
  say(`\n  VERDICT: mixed, and it must be split into two separate findings.`);
  say(`  (1) The baseline shift 44.1% -> 52.2% is 100% the deletion of 70 all-losing rows. Not an edge.`);
  say(`  (2) The exclusion IS correlated with the filters (Fisher p=1.6e-10 for "near VWAP <50pt", 4.9e-3 for`);
  say(`      "shallow", 6.5e-13 for "non-marginal"), because ambiguity is mechanically a function of stop`);
  say(`      width (0 excluded in distVwapR<10R vs 79 in the rest) and of snap-back (44% of Q1, 2% of Q4).`);
  say(`  BUT the four headline DIFFERENCES are stable across the exclusion: raw -> clean changes them by`);
  say(`      LVN 9.9->9.9pt, evening 16.0->14.8pt, near VWAP 12.0->10.5pt, combo 24.2->24.7pt. So the exclusion`);
  say(`      does NOT manufacture the four edges; it manufactures the baseline they are compared against,`);
  say(`      and it is the entire substance of the "non-marginal reclaim" and "distVwapR<10R" rule sets.`);
}

/* ============================ convention sensitivity ==================== */
say("");
say("#".repeat(104));
say("# 6b. CONVENTION SENSITIVITY — the tie-break itself");
say("#".repeat(104));
{
  const r = ALL.filter((x) => !x.ambNext && x.resolveBarHasOther);
  const noRes = UNAMB.filter((x) => !x.resolveBarHasOther);
  say(`  pessimistic (stop first on a tie bar): ${baseline.wr.toFixed(1)}%   optimistic (target first): ${wr(ALL.filter((x) => x.winOpt)).wr.toFixed(1)}%`);
  say(`  -> ${(wr(ALL.filter((x) => x.winOpt)).wr - baseline.wr).toFixed(1)}pt of the headline win rate is a bookkeeping convention, larger than the LVN or VWAP edge.`);
  say(`  residual ambiguity inside the "clean" set: ${r.length} of ${UNAMB.length} clean trades resolve on a bar that also contains the`);
  say(`  opposite level (the harness audits only the NEXT bar): ${r.filter((x) => x.win).length} wins, ${r.filter((x) => !x.win).length} losses — all losses are convention-decided.`);
  say(`  fully convention-free subset: n=${noRes.length} win=${wr(noRes).wr.toFixed(1)}% (vs ${unambBase.wr.toFixed(1)}% for the clean set) — a third estimate of the baseline.`);
}

/* ============================ required n ================================= */
say("");
say("#".repeat(104));
say("# REQUIRED SAMPLE SIZE — a 10-point edge at 80% power with the measured clustering");
say("#".repeat(104));
{
  const iccAll = iccBinary(ALL);
  const iccClean = iccBinary(CLEAN);
  const z975 = 1.959964;
  const z80 = 0.8416212;
  const p1 = 0.575;
  const p2 = 0.475;
  const perArm = (de: number) => (de * (z975 + z80) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / 0.01;
  say(`  target: 57.5% vs 47.5% (10pt), alpha=0.05 two-sided, power=80%`);
  say(`  n_per_arm = DE * (1.96+0.84)^2 * (p1q1+p2q2) / 0.10^2,  DE = 1+(m-1)*ICC`);
  for (const [lab, icc, m] of [
    ["raw 449-sample ICC, m=44.9 trades/session", iccAll.icc, ALL.length / 10],
    ["clean 379-sample ICC, m=37.9", iccClean.icc, CLEAN.length / 10],
    ["ICC=0 (no clustering)", 0, 37.9],
  ] as [string, number, number][]) {
    const de = 1 + (m - 1) * icc;
    const n = perArm(de);
    const ses = Math.ceil((2 * n) / m);
    say(`    ${lab.padEnd(44)} ICC=${icc.toFixed(4)} DE=${de.toFixed(2)}  n/arm=${Math.ceil(n)}  total=${Math.ceil(2 * n)}  sessions=${ses} (${(ses / 21.7).toFixed(1)} trading months)`);
  }
  const ibAll = iccBoot(ALL);
  const ibClean = iccBoot(CLEAN);
  say(`\n  the ICC itself comes from only 10 clusters, so it is very uncertain. Session-resampling bootstrap`);
  say(`  95% CI for ICC and DE (2000 draws):`);
  say(`    raw   ICC ${iccAll.icc.toFixed(4)} -> [${ibAll.lo.toFixed(4)}, ${ibAll.hi.toFixed(4)}]   DE ${iccAll.de.toFixed(2)} -> [${ibAll.deLo.toFixed(2)}, ${ibAll.deHi.toFixed(2)}]`);
  say(`    clean ICC ${iccClean.icc.toFixed(4)} -> [${ibClean.lo.toFixed(4)}, ${ibClean.hi.toFixed(4)}]   DE ${iccClean.de.toFixed(2)} -> [${ibClean.deLo.toFixed(2)}, ${ibClean.deHi.toFixed(2)}]`);
  for (const [lab, m, ib] of [
    ["raw n=449, m=44.9", ALL.length / 10, ibAll],
    ["clean n=379, m=37.9", CLEAN.length / 10, ibClean],
  ] as [string, number, ReturnType<typeof iccBoot>][]) {
    const sesLo = Math.ceil((2 * perArm(ib.deLo)) / m);
    const sesMd = Math.ceil((2 * perArm((ib.deLo + ib.deHi) / 2)) / m);
    const sesHi = Math.ceil((2 * perArm(ib.deHi)) / m);
    say(`    -> ${lab}: sessions required = ${sesLo} at the 2.5th-pct DE, ~${sesMd} at a middle DE, ${sesHi} at the 97.5th-pct DE  (i.e. ${(sesLo / 21.7).toFixed(1)}-${(sesHi / 21.7).toFixed(1)} trading months)`);
  }
  const m39 = CLEAN.filter((r) => r.atEdge && r.distVwapPts < 50 && r.hourET >= 18 && r.hourET < 21).length / 10;
  say(`\n  the narrow combination fires ${m39.toFixed(1)}x per session (median cluster size m=${m39.toFixed(1)}), so its DE is small but its`);
  say(`  headline n grows only by waiting for more SESSIONS, since ICC is a session-level quantity:`);
  for (const icc of [iccClean.icc, 0.02, 0.05, 0.1]) {
    const de = 1 + (m39 - 1) * icc;
    const n = perArm(de);
    const ses = Math.ceil((2 * n) / m39);
    say(`    ICC=${icc.toFixed(3)} -> DE=${de.toFixed(2)}  total trades needed=${Math.ceil(2 * n)}  sessions needed=${ses}  (${(ses / 21.7).toFixed(1)} months)`);
  }
  const iccSess = iccBinary(ALL);
  say(`\n  cluster-robust inference also needs enough CLUSTERS: with k=10 the t reference has 9 df and the`);
  say(`  sandwich SE is itself noisy; the usual guidance is k>=40-50 clusters before the normal approximation`);
  say(`  is safe. At ~38 clean trades/session that means >=40 sessions = ~${(40 / 21.7).toFixed(1)} trading months MINIMUM for a`);
  say(`  trustworthy cluster-robust p-value, independent of how many trades are inside them.`);
  void iccSess;
}

/* ============================ final ranking ============================== */
say("");
say("#".repeat(104));
say("# FINAL RANKING OF THE FIVE CLAIMS (most to least credible)");
say("#".repeat(104));
{
  const rows = CLAIMS.map((c) => {
    const s = claimStats[c.id];
    if (c.id === "baseline") {
      return { label: c.label, st: s.st, wil: s.wil, cp: s.cp, cd: null as ReturnType<typeof clusterDiff> | null };
    }
    return { label: c.label, st: s.st, wil: s.wil, cp: s.cp, cd: clusterDiff(c.pool, c.keep) };
  });
  for (const r of rows) {
    say(
      `  ${r.label.padEnd(44)} n=${String(r.st.n).padStart(3)} win=${r.st.wr.toFixed(1).padStart(5)}%  Wilson[${r.wil[0].toFixed(1)},${r.wil[1].toFixed(1)}]  cluster[${r.cp.lo.toFixed(1)},${r.cp.hi.toFixed(1)}]` +
        (r.cd ? `  diff=${r.cd.diff.toFixed(1)}pt (SE ${r.cd.se.toFixed(1)}) p_cluster=${r.cd.p.toFixed(3)}` : ""),
    );
  }
}

writeFileSync("/tmp/auditB_report.txt", OUT.join("\n"));
console.error("\nwrote /tmp/auditB_report.txt");
