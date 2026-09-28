/* ---------------------------------------------------------------------------
 * AUDIT A — adversarial probe of the refine.ts / study.ts claims.
 * Read-only: writes nothing, changes no existing file.
 *
 *   cd web && node --import ../scripts/ts-loader.mjs ./db/auditA_probe.ts
 *
 * Reproduces refine.ts's sample construction EXACTLY (same engine, same
 * constants) and then adds the diagnostics refine.ts does not print:
 * entry realism, index integrity, lookahead attribution, zone geometry,
 * hour mapping, exclusion composition, walk consistency, ratio confound.
 * ------------------------------------------------------------------------- */
import { analyze, extractFootprint, computeSheet, stats, type AlertEvent, type AbsorbEvent, type FootprintMinute } from "../lib/gcdata.ts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SESSION = "ETH" as const;
const EXPECTED = 1380;
const TICK = 0.25;
const LOOKAHEAD = 60;
const EDGE_TOL = 2.5;
const ABS_BARS = 3;
const ABS_PTS = 3;
const DIV_BARS = 10;
const ROW_TICKS = 4;

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const pct = (a: number[], f: number) => (a.length ? q(a, f).toFixed(2) : "—");
const p1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");

function discoverDates() {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const dir = process.env.GC_DATA_DIR || path.join(root, "gcdata", "data");
  const dates: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})_ETH\.json$/.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if ((j.candles ?? []).length >= EXPECTED) dates.push(m[1]);
    } catch {}
  }
  return dates.sort();
}

// ── same stats()/aggregate() logic as computeSheet, but from FP minutes ──────
function zonesFromMinutes(minutes: FootprintMinute[], upto: number, rowTicks = ROW_TICKS): [number, number][] {
  const rows = new Map<number, { buy: number; sell: number }>();
  for (let i = 0; i <= upto; i++) {
    for (const l of minutes[i].levels) {
      const cents = Math.round(l.price * 100);
      const bucket = Math.round(cents / (25 * rowTicks)) * 25 * rowTicks;
      const r = rows.get(bucket) ?? { buy: 0, sell: 0 };
      r.buy += l.buy;
      r.sell += l.sell;
      rows.set(bucket, r);
    }
  }
  const s = stats(rows);
  if (!s) return [];
  return s.lvns.slice(0, 10).map(([a, b]) => [a / 100, b / 100] as [number, number]);
}

type S = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  win: boolean;
  hourET: number;
  ctHour: number;
  atEdge: boolean;
  hasDiv: boolean;
  hasAbs: boolean;
  absAfter: boolean;
  divLag: number;
  distVwapPts: number;
  distVwapR: number;
  vwapAtEntry: number;
  snapBackPts: number;
  sweepDepthR: number;
  sweepWickPts: number;
  rvol: number;
  rvolCausal: number;
  riskPts: number;
  barRangePts: number;
  atrPts: number;
  atEdgeCausal: boolean;
  atEdgeCausalFull: boolean;
  hasClose: boolean;
  entryVwap: number;
  barHigh: number;
  barLow: number;
  winVwap: boolean;
  winMid: boolean;
  idx: number;
  idxFind: number;
  dupT: number;
  resolved: boolean;
  firstBarDecides: boolean;
  mfeWalkRefine: number;
  mfeWalkStudy: number;
  outcomeStudy: "win" | "loss" | "open";
  atEdgePerProfile: string[];
  nearestZoneDist: number | null;
};

async function main() {
  const DATES = discoverDates();
  console.log(`AUDIT A — sessions: ${DATES.length} (${DATES[0]} .. ${DATES[DATES.length - 1]})`);

  const samples: S[] = [];
  const integrity: string[] = [];
  const zoneStats: { date: string; zones: number; widths: number[] }[] = [];

  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    const an = await analyze(date, SESSION, undefined, undefined, 4);
    if (!fp || !an) continue;
    const sheet = await computeSheet(date);
    const m = fp.minutes;

    // ── index integrity of the session itself ──────────────────────────────
    const seen = new Set<string>();
    let dups = 0;
    let nonMono = 0;
    for (let i = 0; i < m.length; i++) {
      if (seen.has(m[i].t)) dups++;
      seen.add(m[i].t);
      if (i && m[i].t <= m[i - 1].t) nonMono++;
    }
    const nOhlc = m.filter((x) => x.c > 0).length;
    integrity.push(
      `  ${date}  bars=${m.length}  ${m[0].t}..${m[m.length - 1].t}  dupHHMM=${dups}  nonMonotonic=${nonMono}  barsWithOHLCclose(c>0)=${nOhlc}`,
    );

    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);
    const vol = m.map((x) => (x.buy ?? 0) + (x.sell ?? 0));
    const medVolSession = q(vol, 0.5) || 1;

    const vwap: number[] = [];
    {
      let num = 0;
      let den = 0;
      for (let i = 0; i < m.length; i++) {
        const b = m[i];
        const v = (b.buy ?? 0) + (b.sell ?? 0);
        num += ((b.high + b.low + (b.c > 0 ? b.c : (b.high + b.low) / 2)) / 3) * v;
        den += v;
        vwap.push(den > 0 ? num / den : 0);
      }
    }

    // zones, tagged by which profile supplied them
    const byProfile = new Map<string, [number, number][]>();
    for (const [k, p] of Object.entries(sheet.profiles)) {
      const zs: [number, number][] = [];
      if (p) {
        for (const z of (p as { LVNs?: string[] }).LVNs ?? []) {
          const [a, b] = String(z).split("–").map((x) => parseFloat(x.replace(/,/g, "")));
          if (Number.isFinite(a) && Number.isFinite(b)) zs.push([Math.min(a, b), Math.max(a, b)]);
        }
      }
      byProfile.set(k, zs);
    }
    const zones = [...byProfile.values()].flat();
    zoneStats.push({ date, zones: zones.length, widths: zones.map(([a, b]) => b - a) });

    const absorption = (an.absorption ?? []) as AbsorbEvent[];
    const divs = (an.alerts ?? []).filter((a: AlertEvent) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
    const minuteOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

    // ── reclaim detection, byte-identical to refine.ts ─────────────────────
    let runLo = Infinity;
    let runHi = -Infinity;
    const reclaims: { i: number; dir: "low" | "high"; extreme: number; breakBar: number }[] = [];
    for (let i = 1; i < m.length; i++) {
      const pl = Math.min(runLo, lo[i - 1]);
      const ph = Math.max(runHi, hi[i - 1]);
      runLo = pl;
      runHi = ph;
      if (lo[i] <= pl - TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] > pl) { reclaims.push({ i: j, dir: "low", extreme: pl, breakBar: i }); break; }
        }
      }
      if (hi[i] >= ph + TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] < ph) { reclaims.push({ i: j, dir: "high", extreme: ph, breakBar: i }); break; }
        }
      }
    }

    let ordinal = 0;
    for (const r of reclaims) {
      const bar = m[r.i];
      const entry = bar.c > 0 ? bar.c : mid[r.i];
      const dir: "long" | "short" = r.dir === "low" ? "long" : "short";
      const stop = dir === "long" ? r.extreme - 2 * TICK : r.extreme + 2 * TICK;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      ordinal++;
      const long = dir === "long";

      // refine.ts walk (stop BEFORE crediting the bar's excursion)
      let win = false;
      let mfeRefine = 0;
      let resolved = false;
      let firstBarDecides = false;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        if (long ? lo[k] <= stop : hi[k] >= stop) { resolved = true; if (k === r.i + 1) firstBarDecides = true; break; }
        mfeRefine = Math.max(mfeRefine, (long ? hi[k] - entry : entry - lo[k]) / risk);
        if (long ? hi[k] >= entry + risk : lo[k] <= entry - risk) { win = true; resolved = true; if (k === r.i + 1) firstBarDecides = true; break; }
      }
      // study.ts walk: credit excursion BEFORE the stop check on the same bar
      let outcomeStudy: "win" | "loss" | "open" = "open";
      let mfeStudy = 0;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        mfeStudy = Math.max(mfeStudy, (long ? hi[k] - entry : entry - lo[k]) / risk);
        if (long ? lo[k] <= stop : hi[k] >= stop) { outcomeStudy = "loss"; break; }
        if (long ? hi[k] >= entry + risk : lo[k] <= entry - risk) { outcomeStudy = "win"; break; }
      }

      const matchProfiles = [...byProfile.entries()]
        .filter(([, zs]) => zs.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL))
        .map(([k]) => k.split("_")[0]);
      const atEdge = matchProfiles.length > 0;
      const nearest = zones.length
        ? Math.min(...zones.map(([a, b]) => (entry < a ? a - entry : entry > b ? entry - b : 0)))
        : null;

      const wantKind = dir === "long" ? "DIVERGENCE_D2" : "DIVERGENCE_D4";
      let divLag = -1;
      const divHit = divs.some((d) => {
        if (d.kind !== wantKind) return false;
        const dm = minuteOf(d.t);
        const bm = minuteOf(bar.t);
        const lag = bm - dm;
        if (lag >= 0 && lag <= DIV_BARS) { if (divLag < 0 || lag < divLag) divLag = lag; return true; }
        return false;
      });
      const absHit = absorption.some((a) => Math.abs(minuteOf(a.t) - minuteOf(bar.t)) <= ABS_BARS && Math.abs(a.price - entry) <= ABS_PTS);
      const absAfterHit = absorption.some((a) => {
        const lag = minuteOf(a.t) - minuteOf(bar.t);
        return lag > 0 && Math.abs(a.price - entry) <= ABS_PTS;
      });

      const w = vwap[r.i] || entry;
      const atr = q(m.slice(Math.max(0, r.i - 15), r.i).map((x) => x.high - x.low), 0.5);
      const causalZones = zonesFromMinutes(m, r.i);
      const atEdgeCausal = causalZones.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      // causal + everything fully in the past (whole session so far). "Full"
      // adds nothing here but keeps the name honest: prior days are handled in
      // section E of the report, not per sample.
      const idxFind = m.findIndex((x) => x.t === bar.t);

      samples.push({
        date, t: bar.t, dir, entry, stop, risk, win,
        hourET: (Number(bar.t.slice(0, 2)) + 1) % 24,
        ctHour: Number(bar.t.slice(0, 2)),
        atEdge, hasDiv: divHit, hasAbs: absHit, absAfter: absAfterHit, divLag,
        distVwapPts: Math.abs(entry - w), distVwapR: Math.abs(entry - w) / risk, vwapAtEntry: w,
        snapBackPts: Math.abs(entry - r.extreme),
        sweepDepthR: Math.abs(mid[r.breakBar] - r.extreme) / risk,
        sweepWickPts: r.dir === "low" ? r.extreme - lo[r.breakBar] : hi[r.breakBar] - r.extreme,
        rvol: vol[r.i] / medVolSession,
        rvolCausal: vol[r.i] / (q(vol.slice(0, r.i + 1), 0.5) || 1),
        riskPts: risk, barRangePts: bar.high - bar.low, atrPts: atr,
        atEdgeCausal, atEdgeCausalFull: atEdgeCausal,
        hasClose: bar.c > 0, entryVwap: bar.vwap,
        idx: r.i, idxFind, dupT: m.filter((x) => x.t === bar.t).length,
        resolved, firstBarDecides, mfeWalkRefine: mfeRefine, mfeWalkStudy: mfeStudy,
        outcomeStudy, atEdgePerProfile: matchProfiles, nearestZoneDist: nearest,
      });
    }
  }

  const cohort = (rows: S[], keep: (s: S) => boolean) => {
    const r = rows.filter(keep);
    const wins = r.filter((s) => s.win).length;
    return { n: r.length, wins, wr: r.length ? (wins / r.length) * 100 : 0 };
  };
  const line = (label: string, c: { n: number; wins: number; wr: number }) =>
    `  ${label.padEnd(40)} n=${String(c.n).padStart(4)}  win=${p1(c.wr).padStart(5)}%`;

  // ── index / data integrity ───────────────────────────────────────────────
  console.log("\n=== B1. Session geometry & timestamps ===");
  integrity.forEach((l) => console.log(l));
  console.log(`  duplicate HH:mm inside any session: ${integrity.some((l) => !l.includes("dupHHMM=0")) ? "YES" : "NO"}`);
  console.log(`  samples where findIndex(t) !== the bar the trade was built from: ${samples.filter((s) => s.idxFind !== s.idx).length}/${samples.length}`);
  console.log(`  samples whose HH:mm occurs more than once in the session: ${samples.filter((s) => s.dupT > 1).length}/${samples.length}`);

  // ── B2. entry realism ────────────────────────────────────────────────────
  console.log("\n=== B2. What price is the 'entry'? (claim: the confirmation bar's CLOSE) ===");
  const withC = samples.filter((s) => s.hasClose);
  const noC = samples.filter((s) => !s.hasClose);
  console.log(`  entry = real OHLC close:      ${withC.length} samples (${((withC.length / samples.length) * 100).toFixed(1)}%)`);
  console.log(`  entry = (high+low)/2 MIDPOINT: ${noC.length} samples (${((noC.length / samples.length) * 100).toFixed(1)}%)`);
  const midGap = noC.map((s) => Math.abs(s.entry - s.entryVwap));
  console.log(`  |midpoint - barVWAP| where no OHLC: p25=${pct(midGap, 0.25)} med=${pct(midGap, 0.5)} p75=${pct(midGap, 0.75)} p90=${pct(midGap, 0.9)} pt  (bar VWAP is the best close proxy)`);
  // entry (OHLC close, a DIFFERENT vendor file) outside the footprint bar range
  const outside = samples.filter((s) => s.hasClose && (s.entry > s.barHigh || s.entry < s.barLow));
  console.log(`  entry (OHLC close) OUTSIDE the footprint bar's own [low,high]: ${outside.length}/${withC.length} (${((outside.length / Math.max(1, withC.length)) * 100).toFixed(1)}%) -> for these the stop/target sit inside the entry bar itself`);
  console.log(`  evening(18-21 ET) samples that use a MIDPOINT entry: ${samples.filter((s) => s.hourET >= 18 && s.hourET < 21 && !s.hasClose).length}/${samples.filter((s) => s.hourET >= 18 && s.hourET < 21).length}`);
  console.log(`  RTH samples that use a MIDPOINT entry: ${samples.filter((s) => s.hourET >= 9 && s.hourET < 16 && !s.hasClose).length}/${samples.filter((s) => s.hourET >= 9 && s.hourET < 16).length}`);
  console.log("  CT hour histogram of entry-bar timestamp (feed clock) vs hasClose:");
  const cth = [...new Set(samples.map((s) => s.ctHour))].sort((a, b) => a - b);
  for (const h of cth) {
    const r = samples.filter((s) => s.ctHour === h);
    const c = r.filter((s) => s.hasClose).length;
    console.log(`    CT ${String(h).padStart(2, "0")}:00  ET ${String((h + 1) % 24).padStart(2, "0")}:00  n=${String(r.length).padStart(3)}  withClose=${String(c).padStart(3)}`);
  }

  // ── headline reproduction ────────────────────────────────────────────────
  console.log("\n=== C. Reproduction of the headline numbers ===");
  console.log(line("RAW all reclaims (refine baseline)", cohort(samples, () => true)));
  const fpByDate = new Map<string, FootprintMinute[]>();
  for (const d of DATES) {
    const f = await extractFootprint(d, SESSION);
    if (f) fpByDate.set(d, f.minutes);
  }
  const ambOf = (s: S, mode: "refine" | "vwap" | "mid", barOffset = 1): boolean | null => {
    const mm = fpByDate.get(s.date);
    if (!mm) return null;
    const idx = mm.findIndex((x) => x.t === s.t);
    if (idx < 0 || idx + barOffset >= mm.length) return null;
    const nb = mm[idx + barOffset];
    const long = s.dir === "long";
    let entry = s.entry;
    if (mode === "vwap") entry = s.hasClose ? s.entry : s.entryVwap;
    if (mode === "mid") entry = (mm[idx].high + mm[idx].low) / 2;
    const stop = long ? s.stop : s.stop;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    const tgt = long ? entry + risk : entry - risk;
    const cs = long ? nb.low <= stop : nb.high >= stop;
    const ct = long ? nb.high >= tgt : nb.low <= tgt;
    return cs && ct;
  };
  const walkMode = (s: S, mode: "refine" | "vwap" | "mid") => {
    const mm = fpByDate.get(s.date);
    if (!mm) return false;
    const idx = mm.findIndex((x) => x.t === s.t);
    if (idx < 0) return false;
    const long = s.dir === "long";
    let entry = s.entry;
    if (mode === "vwap") entry = s.hasClose ? s.entry : s.entryVwap;
    if (mode === "mid") entry = (mm[idx].high + mm[idx].low) / 2;
    const risk = Math.abs(entry - s.stop);
    if (!(risk > 0)) return false;
    for (let k = idx + 1; k < Math.min(mm.length, idx + 1 + LOOKAHEAD); k++) {
      if (long ? mm[k].low <= s.stop : mm[k].high >= s.stop) return false;
      if (long ? mm[k].high >= entry + risk : mm[k].low <= entry - risk) return true;
    }
    return false;
  };
  const cleanKey = new Set<string>();
  const ambKey = new Set<string>();
  const key = (s: S) => `${s.date}|${s.t}|${s.dir}`;
  for (const s of samples) {
    const a = ambOf(s, "refine", 1);
    if (a === null) continue;
    if (a) ambKey.add(key(s)); else cleanKey.add(key(s));
  }
  const CLEAN = samples.filter((s) => cleanKey.has(key(s)));
  const AMB = samples.filter((s) => ambKey.has(key(s)));
  console.log(line("CLEAN (unambiguous) — claim 1", cohort(CLEAN, () => true)));
  console.log(line("AMBIGUOUS excluded", cohort(AMB, () => true)));
  console.log(line("raw LVN edge", cohort(samples, (s) => s.atEdge)));
  console.log(line("raw not LVN edge", cohort(samples, (s) => !s.atEdge)));
  console.log(line("clean LVN edge — claim 2", cohort(CLEAN, (s) => s.atEdge)));
  console.log(line("clean not LVN edge — claim 2", cohort(CLEAN, (s) => !s.atEdge)));
  console.log(line("clean evening 18-21 — claim 3", cohort(CLEAN, (s) => s.hourET >= 18 && s.hourET < 21)));
  console.log(line("clean outside evening — claim 3", cohort(CLEAN, (s) => !(s.hourET >= 18 && s.hourET < 21))));
  console.log(line("clean near VWAP <50pt — claim 4", cohort(CLEAN, (s) => s.distVwapPts < 50)));
  console.log(line("clean far VWAP >=50pt — claim 4", cohort(CLEAN, (s) => s.distVwapPts >= 50)));
  console.log(line("clean LVN+nearVWAP+evening — claim 5", cohort(CLEAN, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));
  console.log(line("RAW LVN+nearVWAP+evening (claim 5, no exclusion)", cohort(samples, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));

  // ── D. exclusion composition ─────────────────────────────────────────────
  console.log("\n=== D. Is the 'clean outcome' exclusion unbiased? ===");
  console.log(`  excluded ${AMB.length} of ${samples.length} (${((AMB.length / samples.length) * 100).toFixed(1)}%)`);
  const frac = (rows: S[], keep: (s: S) => boolean, label: string) => {
    const r = rows.filter(keep);
    const nRaw = r.length;
    const nClean = r.filter((s) => cleanKey.has(key(s))).length;
    const rawWr = nRaw ? (r.filter((s) => s.win).length / nRaw) * 100 : 0;
    const cl = r.filter((s) => cleanKey.has(key(s)));
    const cleanWr = cl.length ? (cl.filter((s) => s.win).length / cl.length) * 100 : 0;
    console.log(
      `  ${label.padEnd(34)} raw n=${String(nRaw).padStart(4)} wr=${p1(rawWr).padStart(5)}%   excluded ${(((nRaw - nClean) / Math.max(1, nRaw)) * 100).toFixed(1).padStart(5)}%   clean n=${String(nClean).padStart(4)} wr=${p1(cleanWr).padStart(5)}%   shift=${(cleanWr - rawWr >= 0 ? "+" : "") + (cleanWr - rawWr).toFixed(1)}pt`,
    );
  };
  frac(samples, () => true, "ALL");
  frac(samples, (s) => s.atEdge, "at LVN edge");
  frac(samples, (s) => !s.atEdge, "not at edge");
  frac(samples, (s) => s.hourET >= 18 && s.hourET < 21, "evening 18-21 ET");
  frac(samples, (s) => !(s.hourET >= 18 && s.hourET < 21), "rest of day");
  frac(samples, (s) => s.distVwapPts < 50, "near VWAP <50pt");
  frac(samples, (s) => s.distVwapPts >= 50, "far VWAP >=50pt");
  frac(samples, (s) => s.dir === "long", "long");
  frac(samples, (s) => s.dir === "short", "short");
  frac(samples, (s) => s.hourET >= 9 && s.hourET < 16, "RTH hours");
  frac(samples, (s) => !(s.hourET >= 9 && s.hourET < 16), "overnight hours");
  const medRiskAll = q(samples.map((s) => s.riskPts), 0.5);
  frac(samples, (s) => s.riskPts <= medRiskAll, `risk <= median (${medRiskAll.toFixed(2)}pt)`);
  frac(samples, (s) => s.riskPts > medRiskAll, "risk > median");
  const cuts = [0.25, 0.5, 0.75].map((f) => q(samples.map((s) => s.riskPts), f));
  const bounds = [0, ...cuts, Infinity];
  for (let i = 0; i < 4; i++) {
    frac(samples, (s) => s.riskPts >= bounds[i] && s.riskPts < bounds[i + 1], `risk Q${i + 1} [${bounds[i].toFixed(2)}..${bounds[i + 1] === Infinity ? "inf" : bounds[i + 1].toFixed(2)}]`);
  }
  console.log("  per-session exclusion rate:");
  for (const d of DATES) {
    const r = samples.filter((s) => s.date === d);
    const a = r.filter((s) => ambKey.has(key(s))).length;
    console.log(`    ${d}  n=${String(r.length).padStart(3)}  excluded=${String(a).padStart(3)} (${((a / Math.max(1, r.length)) * 100).toFixed(0)}%)  rawWr=${p1(r.length ? (r.filter((s) => s.win).length / r.length) * 100 : 0)}%`);
  }
  // composition of clean vs ambiguous on features known AT entry
  const comp = (label: string, f: (s: S) => number) => {
    const a = AMB.map(f).filter(Number.isFinite);
    const c = CLEAN.map(f).filter(Number.isFinite);
    console.log(`  ${label.padEnd(30)} median: ambiguous=${pct(a, 0.5).padStart(7)}  clean=${pct(c, 0.5).padStart(7)}`);
  };
  comp("risk (pt)", (s) => s.riskPts);
  comp("snapBack (pt)", (s) => s.snapBackPts);
  comp("distVwapPts", (s) => s.distVwapPts);
  comp("sweepDepthR", (s) => s.sweepDepthR);
  comp("barRange (pt)", (s) => s.barRangePts);
  comp("ATR(15) pt", (s) => s.atrPts);
  console.log(`  atEdge rate: ambiguous=${((AMB.filter((s) => s.atEdge).length / Math.max(1, AMB.length)) * 100).toFixed(1)}%  clean=${((CLEAN.filter((s) => s.atEdge).length / Math.max(1, CLEAN.length)) * 100).toFixed(1)}%`);
  console.log(`  evening rate: ambiguous=${((AMB.filter((s) => s.hourET >= 18 && s.hourET < 21).length / Math.max(1, AMB.length)) * 100).toFixed(1)}%  clean=${((CLEAN.filter((s) => s.hourET >= 18 && s.hourET < 21).length / Math.max(1, CLEAN.length)) * 100).toFixed(1)}%`);
  console.log(`  long rate: ambiguous=${((AMB.filter((s) => s.dir === "long").length / Math.max(1, AMB.length)) * 100).toFixed(1)}%  clean=${((CLEAN.filter((s) => s.dir === "long").length / Math.max(1, CLEAN.length)) * 100).toFixed(1)}%`);
  console.log(`  midpoint-entry rate: ambiguous=${((AMB.filter((s) => !s.hasClose).length / Math.max(1, AMB.length)) * 100).toFixed(1)}%  clean=${((CLEAN.filter((s) => !s.hasClose).length / Math.max(1, CLEAN.length)) * 100).toFixed(1)}%`);
  console.log(`  trades whose outcome is decided by the FIRST forward bar: ${samples.filter((s) => s.firstBarDecides).length}/${samples.length} (${((samples.filter((s) => s.firstBarDecides).length / samples.length) * 100).toFixed(1)}%)`);
  console.log(`  trades NOT resolved inside the 60-bar window (counted as LOSS by refine): ${samples.filter((s) => !s.resolved).length}/${samples.length}`);
  const unres = samples.filter((s) => !s.resolved);
  if (unres.length) console.log(line("  unresolved cohort's own win=false contribution", { n: unres.length, wins: 0, wr: 0 }));
  // placebo: same exclusion applied to bars idx+2 instead of idx+1
  const placeboKey = new Set<string>();
  for (const s of samples) if (ambOf(s, "refine", 2) === true) placeboKey.add(key(s));
  const PLACEBO = samples.filter((s) => !placeboKey.has(key(s)));
  console.log(line("PLACEBO clean (exclude idx+2 ambiguity)", cohort(PLACEBO, () => true)));
  console.log(line("  placebo LVN edge", cohort(PLACEBO, (s) => s.atEdge)));
  console.log(line("  placebo not LVN edge", cohort(PLACEBO, (s) => !s.atEdge)));
  console.log(line("  placebo evening", cohort(PLACEBO, (s) => s.hourET >= 18 && s.hourET < 21)));
  console.log(line("  placebo rest of day", cohort(PLACEBO, (s) => !(s.hourET >= 18 && s.hourET < 21))));

  // ── B3. entry-price definition sensitivity ───────────────────────────────
  console.log("\n=== B3. Same claims under three entry-price definitions (raw and ambiguity-excluded) ===");
  for (const mode of ["refine", "vwap", "mid"] as const) {
    const rows = samples.map((s) => {
      const a = ambOf(s, mode, 1);
      const long = s.dir === "long";
      const mm = fpByDate.get(s.date);
      const idx = mm ? mm.findIndex((x) => x.t === s.t) : -1;
      let entry = s.entry;
      if (mode === "vwap") entry = s.hasClose ? s.entry : s.entryVwap;
      if (mode === "mid") entry = idx >= 0 ? (mm![idx].high + mm![idx].low) / 2 : s.entry;
      const risk = Math.abs(entry - s.stop);
      return { s, win: walkMode(s, mode), amb: a === true, dist: risk > 0 ? Math.abs(entry - s.vwapAtEntry) : NaN, long };
    });
    const live = rows.filter((r) => r.amb === false);
    const desc = mode === "refine" ? "refine (close, else midpoint)" : mode === "vwap" ? "bar VWAP when no close" : "midpoint always";
    console.log(`  -- entry = ${desc} --`);
    console.log(`     raw: n=${rows.length} win=${p1((rows.filter((r) => r.win).length / rows.length) * 100)}%   ambiguity-excluded n=${live.length} win=${p1((live.filter((r) => r.win).length / live.length) * 100)}%`);
    const sub = (label: string, keep: (r: (typeof rows)[number]) => boolean) => {
      const r = live.filter(keep);
      const w = r.filter((x) => x.win).length;
      console.log(`       ${label.padEnd(34)} n=${String(r.length).padStart(4)}  win=${p1(r.length ? (w / r.length) * 100 : 0).padStart(5)}%`);
    };
    sub("baseline (clean)", () => true);
    sub("LVN edge", (r) => r.s.atEdge);
    sub("not LVN edge", (r) => !r.s.atEdge);
    sub("evening 18-21", (r) => r.s.hourET >= 18 && r.s.hourET < 21);
    sub("outside evening", (r) => !(r.s.hourET >= 18 && r.s.hourET < 21));
    sub("near VWAP <50pt (as-is dist)", (r) => r.s.distVwapPts < 50);
    sub("far VWAP >=50pt (as-is dist)", (r) => r.s.distVwapPts >= 50);
    sub("LVN + nearVWAP + evening", (r) => r.s.atEdge && r.s.distVwapPts < 50 && r.s.hourET >= 18 && r.s.hourET < 21);
  }

  // ── E. LVN zone geometry ─────────────────────────────────────────────────
  console.log("\n=== E. LVN zone extraction & tolerance ===");
  console.log("  zones per session (string parse of computeSheet().profiles[*].LVNs):");
  for (const z of zoneStats) console.log(`    ${z.date}  zones=${String(z.zones).padStart(3)}  width p25=${pct(z.widths, 0.25)} med=${pct(z.widths, 0.5)} p75=${pct(z.widths, 0.75)} pt`);
  const allW = zoneStats.flatMap((z) => z.widths);
  console.log(`  zone width overall: p10=${pct(allW, 0.1)} p25=${pct(allW, 0.25)} med=${pct(allW, 0.5)} p75=${pct(allW, 0.75)} p90=${pct(allW, 0.9)} pt`);
  const nd = samples.map((s) => s.nearestZoneDist ?? NaN).filter(Number.isFinite);
  console.log(`  distance from entry to NEAREST zone: p25=${pct(nd, 0.25)} med=${pct(nd, 0.5)} p75=${pct(nd, 0.75)} p90=${pct(nd, 0.9)} pt`);
  for (const tol of [0, 0.5, 1, 2.5, 5, 10]) {
    const hit = samples.filter((s) => s.nearestZoneDist !== null && s.nearestZoneDist <= tol).length;
    console.log(`  tolerance ${String(tol).padStart(4)} pt -> atEdge on ${String(hit).padStart(3)}/${samples.length} samples (${((hit / samples.length) * 100).toFixed(1)}%)`);
  }
  const profCounts = new Map<string, number>();
  for (const s of samples) for (const p of s.atEdgePerProfile) profCounts.set(p, (profCounts.get(p) ?? 0) + 1);
  console.log("  which sheet profile supplied the matching zone (a sample can match several):");
  for (const [k, v] of [...profCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k}  ${v} samples`);
  const onlyFuture = samples.filter((s) => s.atEdgePerProfile.length > 0 && !s.atEdgePerProfile.includes("P4")).length;
  console.log(`  atEdge samples with NO match from P4_prev_day_rth (i.e. only from today's/forward profiles): ${onlyFuture}/${samples.filter((s) => s.atEdge).length}`);
  // causal (developing) zones
  console.log("\n=== E2. CAUSAL LVN zones (profile built from bars 0..entry only) ===");
  const causalRate = (samples.filter((s) => s.atEdgeCausal).length / samples.length) * 100;
  console.log(`  atEdgeCausal base rate: ${((samples.filter((s) => s.atEdgeCausal).length / samples.length) * 100).toFixed(1)}%  (leaky atEdge base rate: ${((samples.filter((s) => s.atEdge).length / samples.length) * 100).toFixed(1)}%)`);
  void causalRate;
  console.log(line("CAUSAL at-edge: raw", cohort(samples, (s) => s.atEdgeCausal)));
  console.log(line("CAUSAL not-at-edge: raw", cohort(samples, (s) => !s.atEdgeCausal)));
  console.log(line("CAUSAL at-edge: clean", cohort(CLEAN, (s) => s.atEdgeCausal)));
  console.log(line("CAUSAL not-at-edge: clean", cohort(CLEAN, (s) => !s.atEdgeCausal)));
  const agree = samples.filter((s) => s.atEdge === s.atEdgeCausal).length;
  console.log(`  agreement between leaky atEdge and causal atEdge: ${agree}/${samples.length} (${((agree / samples.length) * 100).toFixed(1)}%)`);
  console.log(line("LEAKY at-edge but NOT causal", cohort(CLEAN, (s) => s.atEdge && !s.atEdgeCausal)));
  console.log(line("CAUSAL at-edge but NOT leaky", cohort(CLEAN, (s) => !s.atEdge && s.atEdgeCausal)));

  // ── F. hour conversion ───────────────────────────────────────────────────
  console.log("\n=== F. Clock conversion (feed clock US Central -> New York) ===");
  const eve = samples.filter((s) => s.hourET >= 18 && s.hourET < 21);
  const ctSet = [...new Set(eve.map((s) => s.ctHour))].sort((a, b) => a - b);
  console.log(`  evening cohort n=${eve.length}; CT hours present: ${ctSet.map((h) => String(h).padStart(2, "0")).join(",")}  (ET = CT+1)`);
  console.log(`  ET hours present: ${[...new Set(eve.map((s) => s.hourET))].sort((a, b) => a - b).join(",")}`);
  const et21 = samples.filter((s) => s.hourET === 21).length;
  const et17 = samples.filter((s) => s.hourET === 17).length;
  console.log(`  samples at ET 21:00-21:59 = ${et21} (must be OUTSIDE the bucket); ET 17:00-17:59 = ${et17} (outside)`);
  const firstBar = samples.filter((s) => s.ctHour === 17).length;
  console.log(`  CT 17:00-17:59 (=ET 18:00-18:59) samples = ${firstBar}: the ETH file's first hour, so the evening bucket is the session's FIRST 3 hours`);
  const dup = samples.filter((s) => s.hourET === 21 && s.atEdge).length;
  void dup;

  // ── G. walk consistency & unresolved handling ───────────────────────────
  console.log("\n=== G. Walk consistency (refine vs study ordering) ===");
  let disagree = 0;
  let mfeDiff = 0;
  for (const s of samples) {
    const a = s.win ? "win" : "loss";
    const b = s.outcomeStudy === "open" ? "open" : s.outcomeStudy;
    if (a !== b) disagree++;
    if (Math.abs(s.mfeWalkRefine - s.mfeWalkStudy) > 1e-9) mfeDiff++;
  }
  console.log(`  outcome differs between the two walks: ${disagree}/${samples.length}`);
  console.log(`  MFE differs (study credits the stopping bar's excursion): ${mfeDiff}/${samples.length}`);
  const openAsLoss = samples.filter((s) => s.outcomeStudy === "open").length;
  console.log(`  study.ts leaves ${openAsLoss} trades "open" (excluded from ITS stats); refine.ts scores them as losses`);

  // ── H. the ratio confound (claim 6 retraction) ──────────────────────────
  console.log("\n=== H. 'Shallow sweep' retraction: is the ratio's effect only the denominator? ===");
  const medRisk = q(samples.map((s) => s.riskPts), 0.5);
  console.log(`  identity check: riskPts - snapBackPts  min=${Math.min(...samples.map((s) => s.riskPts - s.snapBackPts)).toFixed(3)} max=${Math.max(...samples.map((s) => s.riskPts - s.snapBackPts)).toFixed(3)} (2 ticks = 0.50)`);
  const idA = samples.filter((s) => s.riskPts > medRisk).length;
  const idB = samples.filter((s) => s.snapBackPts > medRisk - 0.5).length;
  const setA = new Set(samples.filter((s) => s.riskPts > medRisk).map(key));
  const setB = new Set(samples.filter((s) => s.snapBackPts > medRisk - 0.5).map(key));
  let inter = 0;
  for (const k of setA) if (setB.has(k)) inter++;
  console.log(`  cohort "risk > median" n=${idA} vs cohort "snapBack > median-0.5" n=${idB}; overlap=${inter}`);
  console.log("  wick (absolute penetration) vs win rate, deciles:");
  const wcuts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((f) => q(samples.map((s) => s.sweepWickPts), f));
  let wb = [0, ...wcuts, Infinity];
  for (let i = 0; i < 10; i++) {
    const c = cohort(samples, (s) => s.sweepWickPts >= wb[i] && s.sweepWickPts < wb[i + 1]);
    if (c.n) console.log(`    wick D${i + 1} [${wb[i].toFixed(2)}..${wb[i + 1] === Infinity ? "inf" : wb[i + 1].toFixed(2)}] ${line("", c)}`);
  }
  console.log("  sweepDepthR (ratio) vs win rate, WITHIN risk bands:");
  const rcuts = [0.25, 0.5, 0.75].map((f) => q(samples.map((s) => s.riskPts), f));
  const rb = [0, ...rcuts, Infinity];
  for (let i = 0; i < 4; i++) {
    const band = samples.filter((s) => s.riskPts >= rb[i] && s.riskPts < rb[i + 1]);
    const sr = q(band.map((s) => s.sweepDepthR), 0.5);
    const lo = cohort(band, (s) => s.sweepDepthR < sr);
    const hi = cohort(band, (s) => s.sweepDepthR >= sr);
    console.log(`    risk band Q${i + 1} [${rb[i].toFixed(2)}..${rb[i + 1] === Infinity ? "inf" : rb[i + 1].toFixed(2)}] n=${band.length}  ratio<med ${p1(lo.wr)}% (n=${lo.n})  ratio>=med ${p1(hi.wr)}% (n=${hi.n})`);
  }
  console.log("  risk (denominator) vs win rate, deciles:");
  const kcuts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((f) => q(samples.map((s) => s.riskPts), f));
  const kb = [0, ...kcuts, Infinity];
  for (let i = 0; i < 10; i++) {
    const c = cohort(samples, (s) => s.riskPts >= kb[i] && s.riskPts < kb[i + 1]);
    if (c.n) console.log(`    risk D${i + 1} [${kb[i].toFixed(2)}..${kb[i + 1] === Infinity ? "inf" : kb[i + 1].toFixed(2)}] ${line("", c)}`);
  }
  console.log("  correlation(risk, -sweepDepthR):");
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const rk = samples.map((s) => s.riskPts);
  const rs = samples.map((s) => s.sweepDepthR);
  const mr = mean(rk);
  const ms = mean(rs);
  const num = samples.reduce((a, s, i) => a + (rk[i] - mr) * (rs[i] - ms), 0);
  const den = Math.sqrt(samples.reduce((a, _, i) => a + (rk[i] - mr) ** 2, 0) * samples.reduce((a, _, i) => a + (rs[i] - ms) ** 2, 0));
  console.log(`    pearson r = ${(num / den).toFixed(3)}`);

  // ── I. lookahead specifics ──────────────────────────────────────────────
  console.log("\n=== I. Lookahead / leakage inventory ===");
  const lagHist = new Map<number, number>();
  for (const s of samples.filter((x) => x.hasDiv)) lagHist.set(s.divLag, (lagHist.get(s.divLag) ?? 0) + 1);
  console.log("  hasDiv: lag (entry minute - divergence minute) histogram:");
  for (const [k, v] of [...lagHist.entries()].sort((a, b) => a[0] - b[0])) console.log(`    lag=${String(k).padStart(2)} min -> ${v} samples`);
  const pivotLeak = samples.filter((s) => s.hasDiv && s.divLag <= 1).length;
  console.log(`  hasDiv samples whose pivot is only confirmable ${pivotLeak} (lag<=1; the pivot test needs 2 bars AFTER the pivot) -> usable only with hindsight`);
  console.log(`  hasAbs samples where the matched absorption event is AFTER the entry bar: ${samples.filter((s) => s.hasAbs && s.absAfter).length}/${samples.filter((s) => s.hasAbs).length}`);
  const rvolShift = samples.filter((s) => (s.rvol >= 1) !== (s.rvolCausal >= 1)).length;
  console.log(`  RVOL>=1 classification changes when the median is the WHOLE-session median (refine) vs bars<=entry: ${rvolShift}/${samples.length}`);
  console.log(`  RVOL median used by refine covers the entire session: entry bars sit at median index ${pct(samples.map((s) => s.idx), 0.5)} of 1380, so the divisor sees the future by construction`);
  console.log(`  ATR(15) window used by refine = bars [idx-15, idx-1] (excludes the entry bar): no leak`);
  console.log(`  cumulative VWAP at idx includes the entry bar's own close: knowable at that close, no leak`);
  console.log(`  VWAP slope = vwap[idx]-vwap[idx-30]: no leak`);

  // ── J. per-session robustness of claims 2/3/4 ───────────────────────────
  console.log("\n=== J. Per-session stability of the three univariate claims (on CLEAN) ===");
  for (const d of DATES) {
    const r = CLEAN.filter((s) => s.date === d);
    const a = cohort(r, (s) => s.atEdge);
    const e = cohort(r, (s) => s.hourET >= 18 && s.hourET < 21);
    const v = cohort(r, (s) => s.distVwapPts < 50);
    console.log(
      `  ${d} n=${String(r.length).padStart(3)}  all=${p1(cohort(r, () => true).wr).padStart(5)}%  LVN=${p1(a.wr).padStart(5)}% (${a.n})  eve=${p1(e.wr).padStart(5)}% (${e.n})  nearVWAP=${p1(v.wr).padStart(5)}% (${v.n})`,
    );
  }
}

await main();
