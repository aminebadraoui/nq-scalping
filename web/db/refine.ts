/* ---------------------------------------------------------------------------
 * Refinement sweep — analysis only, writes nothing, app code untouched.
 *
 *   node --import ../scripts/ts-loader.mjs ./db/refine.ts
 *
 * Question: which entry conditions available AT THE ENTRY BAR raise the win rate
 * of the reclaim trigger, and which are noise?
 *
 * Method, and why it is built this way:
 *   - Same engine as the dashboard, same complete-only session filter as
 *     study.ts, so the signals measured are the ones the checklist shows.
 *   - Every feature is computed from bars up to and including the reclaim bar.
 *     Nothing reads the future, because a filter you cannot evaluate in real
 *     time is not a filter, it is hindsight.
 *   - Fixed exit for comparability: structural stop (2 ticks beyond the failed
 *     extreme) with a 1R target, pessimistic same-bar ordering. Win rate alone
 *     is not the objective — a 0.5R target would raise it while losing money —
 *     so expectancy is printed beside every cohort.
 *   - Testing dozens of filters on a few hundred samples guarantees that some
 *     look brilliant by luck. So every cohort carries n, a 95% Wilson interval,
 *     and a per-session breakdown, and the headline candidates are re-checked
 *     on a held-out half of the sessions.
 * ------------------------------------------------------------------------- */
import { analyze, extractFootprint, computeSheet, type AlertEvent, type AbsorbEvent } from "../lib/gcdata.ts";
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
const BASE_R = 1;

type Sample = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  risk: number;
  win: boolean;
  mfeR: number;
  maeR: number;
  hourET: number;
  minuteOfSession: number;
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

function out_zones_push(zones: [number, number][], a: number, b: number) {
  zones.push([Math.min(a, b), Math.max(a, b)]);
}

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
    } catch {
      /* unreadable dataset */
    }
  }
  return dates.sort();
}

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

/** Wilson score interval — honest about small n, unlike a raw percentage. */
function wilson(wins: number, n: number) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((c - s) / d) * 100, ((c + s) / d) * 100];
}

function cohort(samples: Sample[], label: string, keep: (s: Sample) => boolean) {
  const rows = samples.filter(keep);
  const n = rows.length;
  const wins = rows.filter((s) => s.win).length;
  const wr = n ? (wins / n) * 100 : 0;
  const exp = n ? rows.reduce((a, s) => a + (s.win ? BASE_R : -1), 0) / n : 0;
  const [lo, hi] = wilson(wins, n);
  const days = [...new Set(rows.map((s) => s.date))];
  const perDay = days.map((d) => {
    const r = rows.filter((s) => s.date === d);
    return r.filter((s) => s.win).length / r.length;
  });
  const daysAbove = perDay.filter((p) => p > 0.5).length;
  return { label, n, wins, wr, exp, lo, hi, days: days.length, daysAbove };
}

/** One-sided binomial tail P(X >= wins | n, p0) — is this cohort better than baseline? */
function binomTail(wins: number, n: number, p0: number) {
  if (!n) return 1;
  const mean = n * p0;
  const sd = Math.sqrt(n * p0 * (1 - p0));
  if (sd === 0) return 1;
  const z = (wins - 0.5 - mean) / sd;
  // Abramowitz-Stegun 7.1.26 erfc-style approximation of the normal tail
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? tail : 1 - tail;
}

function fmt(c: ReturnType<typeof cohort>, p0?: number) {
  const ci = c.n ? `${c.lo.toFixed(0)}-${c.hi.toFixed(0)}%` : "—";
  return (
    `  ${c.label.padEnd(38)} n=${String(c.n).padStart(4)}  win=${c.wr.toFixed(1).padStart(5)}%  ` +
    `CI[${ci.padEnd(9)}]  exp=${(c.exp >= 0 ? "+" : "") + c.exp.toFixed(2)}R  ` +
    `days=${c.daysAbove}/${c.days} >50%` +
    (p0 !== undefined && c.n ? `  p=${binomTail(c.wins, c.n, p0).toFixed(4)}` : "")
  );
}

async function main() {
  const DATES = discoverDates();
  console.log(`Sessions (complete ETH only): ${DATES.length} — ${DATES[0]} .. ${DATES[DATES.length - 1]}\n`);

  const samples: Sample[] = [];

  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    const an = await analyze(date, SESSION, undefined, undefined, 4);
    if (!fp || !an) {
      console.log(`skip ${date}: no data`);
      continue;
    }
    const sheet = await computeSheet(date);
    const m = fp.minutes;
    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);
    const vol = m.map((x) => (x.buy ?? 0) + (x.sell ?? 0));
    const medVol = q(vol, 0.5) || 1;

    // cumulative session VWAP (HLC3) as it stood at each bar — no lookahead
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

    // LVN zones from the profile stack. The sheet stores them as display
    // strings ("30500–30504") on a capitalised LVNs key — reading a lowercase
    // key silently yields zero zones and would report "LVN edge: n=0".
    const zones: [number, number][] = [];
    for (const p of Object.values(sheet.profiles)) {
      if (!p) continue;
      for (const z of (p as { LVNs?: string[] }).LVNs ?? []) {
        const [a, b] = String(z)
          .split("–")
          .map((x) => parseFloat(x.replace(/,/g, "")));
        if (Number.isFinite(a) && Number.isFinite(b)) out_zones_push(zones, a, b);
      }
    }

    const absorption = (an.absorption ?? []) as AbsorbEvent[];
    const divs = (an.alerts ?? []).filter((a: AlertEvent) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
    const minuteOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const etHourOf = (t: string) => (Number(t.slice(0, 2)) + 1) % 24;

    // reclaim detection — identical to study.ts, capturing the CONFIRMATION bar
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
          if (mid[j] > pl) {
            reclaims.push({ i: j, dir: "low", extreme: pl, breakBar: i });
            break;
          }
        }
      }
      if (hi[i] >= ph + TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] < ph) {
            reclaims.push({ i: j, dir: "high", extreme: ph, breakBar: i });
            break;
          }
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

      let win = false;
      let mfe = 0;
      let mae = 0;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        const long = dir === "long";
        if (long ? lo[k] <= stop : hi[k] >= stop) break;
        mfe = Math.max(mfe, (long ? hi[k] - entry : entry - lo[k]) / risk);
        mae = Math.max(mae, (long ? entry - lo[k] : hi[k] - entry) / risk);
        if (long ? hi[k] >= entry + BASE_R * risk : lo[k] <= entry - BASE_R * risk) {
          win = true;
          break;
        }
      }

      const atEdge = zones.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      const wantKind = dir === "long" ? "DIVERGENCE_D2" : "DIVERGENCE_D4";
      const hasDiv = divs.some((d) => {
        if (d.kind !== wantKind) return false;
        const dm = minuteOf(d.t);
        const bm = minuteOf(bar.t);
        return bm - dm >= 0 && bm - dm <= DIV_BARS;
      });
      const hasAbs = absorption.some(
        (a) => Math.abs(minuteOf(a.t) - minuteOf(bar.t)) <= ABS_BARS && Math.abs(a.price - entry) <= ABS_PTS,
      );

      const w = vwap[r.i] || entry;
      const long = dir === "long";
      const prior30 = Math.max(0, r.i - 30);
      const slope = (vwap[r.i] || 0) - (vwap[prior30] || 0);
      const atr = q(
        m.slice(Math.max(0, r.i - 15), r.i).map((x) => x.high - x.low),
        0.5,
      );
      const minute = minuteOf(bar.t);
      const etHour = etHourOf(bar.t);

      samples.push({
        date,
        t: bar.t,
        dir,
        entry,
        stop,
        risk,
        win,
        mfeR: mfe,
        maeR: mae,
        hourET: etHour,
        minuteOfSession: minute,
        // RTH = 09:30-15:59 New York; the feed clock is Central, so ET hour 9 with min>=30
        sessionType: etHour >= 9 && !(etHour === 9 && Number(bar.t.slice(3, 5)) < 30) && etHour < 16 ? "RTH" : "OVERNIGHT",
        atEdge,
        hasDiv,
        hasAbs,
        vwapSide: entry >= w ? "above" : "below",
        distVwapR: Math.abs(entry - w) / risk,
        distVwapPts: Math.abs(entry - w),
        barsToReclaim: r.i - r.breakBar,
        sweepDepthR: Math.abs(mid[r.breakBar] - r.extreme) / risk,
        // the other way to read the same break: how far the break bar's WICK
        // reached beyond the prior extreme, in points (definition robustness)
        sweepWickPts: r.dir === "low" ? r.extreme - lo[r.breakBar] : hi[r.breakBar] - r.extreme,
        rvol: vol[r.i] / medVol,
        absDeltaPct: Math.abs(bar.delta ?? 0) / Math.max(1, vol[r.i]),
        riskPts: risk,
        // how far the confirmation bar closed BACK INSIDE the range from the
        // failed extreme: risk = snapBack + 2 ticks, so this is the same
        // quantity as "stop width" read from the other end
        snapBackPts: Math.abs(entry - r.extreme),
        atrPts: atr,
        withVwapSlope: slope > 0 ? long : slope < 0 ? !long : false,
        reclaimOrdinal: ordinal,
        barRangePts: bar.high - bar.low,
      });
    }
  }

  console.log(`Reclaim samples: ${samples.length} across ${DATES.length} sessions`);
  console.log(`Baseline: ${fmt(cohort(samples, "ALL reclaims (1R target / structural stop)", () => true))}`);
  const baseline = cohort(samples, "baseline", () => true);
  console.log(`Expected sessions needed for a 10-point win-rate edge to be significant at n=${samples.length}: see CI above.\n`);

  // Held-out halves, declared up front because several later sections validate
  // against them. Chronological split (not random): earlier sessions train,
  // later ones test, which is the honest analogue of trading the future.
  const half = Math.floor(DATES.length / 2);
  const train = new Set(DATES.slice(0, half));
  const test = new Set(DATES.slice(half));

  // ── univariate: what actually moves the win rate? ──────────────────────
  const mid50 = (arr: number[], target: number) => target;
  const medians = {
    distVwapR: q(samples.map((s) => s.distVwapR), 0.5),
    sweepDepthR: q(samples.map((s) => s.sweepDepthR), 0.5),
    rvol: q(samples.map((s) => s.rvol), 0.5),
    absDeltaPct: q(samples.map((s) => s.absDeltaPct), 0.5),
    riskPts: q(samples.map((s) => s.riskPts), 0.5),
    atrPts: q(samples.map((s) => s.atrPts), 0.5),
    barRangePts: q(samples.map((s) => s.barRangePts), 0.5),
  };
  void mid50;

  console.log("── Univariate cohorts ──");
  const singles: ReturnType<typeof cohort>[] = [];
  const add = (label: string, keep: (s: Sample) => boolean) => {
    const c = cohort(samples, label, keep);
    singles.push(c);
    console.log(fmt(c, baseline.wr / 100));
  };

  add("at an LVN edge", (s) => s.atEdge);
  add("not at an LVN edge", (s) => !s.atEdge);
  add("with matching CVD divergence", (s) => s.hasDiv);
  add("without divergence", (s) => !s.hasDiv);
  add("absorption nearby", (s) => s.hasAbs);
  add("RTH hours", (s) => s.sessionType === "RTH");
  add("overnight hours", (s) => s.sessionType === "OVERNIGHT");
  add("entries 18:00-21:00 NY", (s) => s.hourET >= 18 && s.hourET < 21);
  add("entries outside 18:00-21:00 NY", (s) => !(s.hourET >= 18 && s.hourET < 21));
  add("long below VWAP (mean-revert)", (s) => s.dir === "long" && s.vwapSide === "below");
  add("short above VWAP (mean-revert)", (s) => s.dir === "short" && s.vwapSide === "above");
  add("VWAP distance >= median", (s) => s.distVwapR >= medians.distVwapR);
  add("VWAP distance < median", (s) => s.distVwapR < medians.distVwapR);
  add("reclaim within 1 bar of the break", (s) => s.barsToReclaim <= 1);
  add("sweep depth >= median", (s) => s.sweepDepthR >= medians.sweepDepthR);
  add("sweep depth < median", (s) => s.sweepDepthR < medians.sweepDepthR);
  add("RVOL >= 1.0 on reclaim bar", (s) => s.rvol >= 1);
  add("RVOL >= 1.5 (climactic)", (s) => s.rvol >= 1.5);
  add("RVOL < 1 (quiet reclaim)", (s) => s.rvol < 1);
  add("reclaim bar |delta| >= median share", (s) => s.absDeltaPct >= medians.absDeltaPct);
  add("risk <= median (tight structural stop)", (s) => s.riskPts <= medians.riskPts);
  add("risk > median (wide structural stop)", (s) => s.riskPts > medians.riskPts);
  add("ATR(15) >= median", (s) => s.atrPts >= medians.atrPts);
  add("ATR(15) < median", (s) => s.atrPts < medians.atrPts);
  add("trade with VWAP slope", (s) => s.withVwapSlope);
  add("trade against VWAP slope", (s) => !s.withVwapSlope);
  add("1st or 2nd reclaim of the session", (s) => s.reclaimOrdinal <= 2);
  add("3rd+ reclaim of the session", (s) => s.reclaimOrdinal > 2);

  console.log("\n── By New York hour ──");
  for (let h = 18; h < 24; h++) {
    const c = cohort(samples, `${String(h).padStart(2, "0")}:00`, (s) => s.hourET === h);
    if (c.n >= 8) console.log(fmt(c));
  }
  for (let h = 0; h < 17; h++) {
    const c = cohort(samples, `${String(h).padStart(2, "0")}:00`, (s) => s.hourET === h);
    if (c.n >= 8) console.log(fmt(c));
  }

  // ── shape of the two strongest continuous features ────────────────────
  // A median split is an in-sample threshold, so look at the whole curve: if
  // the win rate falls monotonically with distance, the effect is real and any
  // cut inside the trend works; if one bucket jumps out, it is noise.
  const quartileTable = (label: string, pick: (s: Sample) => number) => {
    const vals = samples.map(pick).filter(Number.isFinite);
    const cuts = [0.25, 0.5, 0.75].map((f) => q(vals, f));
    console.log(`\n── ${label} (quartile cuts ${cuts.map((c) => c.toFixed(2)).join(" / ")}) ──`);
    const bounds = [0, ...cuts, Infinity];
    for (let i = 0; i < 4; i++) {
      const name = i === 0 ? "Q1 closest/lowest" : i === 3 ? "Q4 farthest/highest" : `Q${i + 1}`;
      const c = cohort(samples, `${name}  [${bounds[i].toFixed(2)}..${bounds[i + 1] === Infinity ? "inf" : bounds[i + 1].toFixed(2)}]`, (s) => {
        const v = pick(s);
        return Number.isFinite(v) && v >= bounds[i] && v < bounds[i + 1];
      });
      if (c.n) console.log(fmt(c));
    }
  };
  // ── what "shallow sweep" actually means, in points ────────────────────
  {
    const midPts = samples.map((s) => s.sweepDepthR * s.riskPts);
    const wickPts = samples.map((s) => s.sweepWickPts);
    const show = (label: string, a: number[]) =>
      console.log(
        `  ${label.padEnd(34)} p10=${q(a, 0.1).toFixed(2)}  p25=${q(a, 0.25).toFixed(2)}  med=${q(a, 0.5).toFixed(2)}  p75=${q(a, 0.75).toFixed(2)}  p90=${q(a, 0.9).toFixed(2)} pt`,
      );
    console.log("\n── Sweep penetration beyond the prior extreme, in POINTS ──");
    show("break-bar MIDPOINT beyond prior ext.", midPts);
    show("break-bar WICK beyond prior ext.", wickPts);
    console.log("  (median trade risk = " + q(samples.map((s) => s.riskPts), 0.5).toFixed(2) + " pt, so 0.3R ~= " + (0.3 * q(samples.map((s) => s.riskPts), 0.5)).toFixed(2) + " pt)");
  }

  quartileTable("sweep depth in R (break-bar midpoint)", (s) => s.sweepDepthR);
  quartileTable("sweep WICK beyond prior extreme (points)", (s) => s.sweepWickPts);
  quartileTable("reclaim snap-back (points closed back inside)", (s) => s.snapBackPts);
  quartileTable("VWAP distance in R", (s) => s.distVwapR);
  quartileTable("VWAP distance in POINTS", (s) => s.distVwapPts);
  quartileTable("sweep depth in R", (s) => s.sweepDepthR);

  // ── confound check: is "near VWAP in R" just "wide stop"? ──────────────
  // distVwapR divides by the trade's own risk, so a small value can come from
  // being near VWAP or from having a wide stop — and wide stops already scored
  // better on their own. Crossing the two separates the effects.
  console.log("\n── Confound check: VWAP distance (in R) x risk size ──");
  const medRisk = q(samples.map((s) => s.riskPts), 0.5);
  for (const [vLabel, vKeep] of [
    ["VWAP<10R", (s: Sample) => s.distVwapR < 10],
    ["VWAP>=10R", (s: Sample) => s.distVwapR >= 10],
  ] as [string, (s: Sample) => boolean][]) {
    for (const [rLabel, rKeep] of [
      ["tight stop", (s: Sample) => s.riskPts <= medRisk],
      ["wide stop", (s: Sample) => s.riskPts > medRisk],
    ] as [string, (s: Sample) => boolean][]) {
      const c = cohort(samples, `${vLabel} + ${rLabel}`, (s) => vKeep(s) && rKeep(s));
      if (c.n) console.log(fmt(c, baseline.wr / 100));
    }
  }
  // and the same split using PONITS so the ratio cannot drive it
  console.log("\n── Same split with ABSOLUTE points (removes the risk ratio) ──");
  const medPts = q(samples.map((s) => s.distVwapPts), 0.5);
  for (const [vLabel, vKeep] of [
    ["VWAP near (<median pt)", (s: Sample) => s.distVwapPts < medPts],
    ["VWAP far (>=median pt)", (s: Sample) => s.distVwapPts >= medPts],
  ] as [string, (s: Sample) => boolean][]) {
    const c = cohort(samples, vLabel, vKeep);
    if (c.n) console.log(fmt(c, baseline.wr / 100));
  }

  // ── combinations of the filters that showed a monotonic effect ─────────
  // Round thresholds chosen from the quartile shape, not the exact optimum, so
  // they are less likely to be an artefact of these ten sessions.
  const VWAP_NEAR = 10; // R — Q1 boundary was 10.3R
  const SHALLOW = 0.3; // R — Q1 boundary was 0.29R
  const combos: { label: string; keep: (s: Sample) => boolean }[] = [
    { label: "LVN edge", keep: (s) => s.atEdge },
    { label: "VWAP dist < 10R", keep: (s) => s.distVwapR < VWAP_NEAR },
    { label: "shallow sweep < 0.3R", keep: (s) => s.sweepDepthR < SHALLOW },
    { label: "LVN + VWAP<10R", keep: (s) => s.atEdge && s.distVwapR < VWAP_NEAR },
    { label: "LVN + shallow", keep: (s) => s.atEdge && s.sweepDepthR < SHALLOW },
    { label: "LVN + VWAP<10R + shallow", keep: (s) => s.atEdge && s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW },
    { label: "  + divergence", keep: (s) => s.atEdge && s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW && s.hasDiv },
    { label: "  + evening 18-21", keep: (s) => s.atEdge && s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW && s.hourET >= 18 && s.hourET < 21 },
    { label: "  + RTH excluded", keep: (s) => s.atEdge && s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW && s.sessionType !== "RTH" },
    {
      label: "VWAP<10R + shallow + evening",
      keep: (s) => s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW && s.hourET >= 18 && s.hourET < 21,
    },
    {
      label: "VWAP<10R + shallow (no LVN req)",
      keep: (s) => s.distVwapR < VWAP_NEAR && s.sweepDepthR < SHALLOW,
    },
  ];

  // ── decisive split: does PROXIMITY add anything on top of stop width? ──
  console.log("\n── ABSOLUTE VWAP proximity x stop size (is proximity its own edge?) ──");
  for (const [vLabel, vKeep] of [
    ["near VWAP (<50pt)", (s: Sample) => s.distVwapPts < 50],
    ["far VWAP (>=50pt)", (s: Sample) => s.distVwapPts >= 50],
  ] as [string, (s: Sample) => boolean][]) {
    for (const [rLabel, rKeep] of [
      ["tight", (s: Sample) => s.riskPts <= medRisk],
      ["wide", (s: Sample) => s.riskPts > medRisk],
    ] as [string, (s: Sample) => boolean][]) {
      const c = cohort(samples, `${vLabel} + ${rLabel} stop`, (s) => vKeep(s) && rKeep(s));
      if (c.n >= 10) console.log(fmt(c, baseline.wr / 100));
    }
  }
  console.log("\n── LVN edge x stop size ──");
  for (const [vLabel, vKeep] of [
    ["at LVN edge", (s: Sample) => s.atEdge],
    ["not at edge", (s: Sample) => !s.atEdge],
  ] as [string, (s: Sample) => boolean][]) {
    for (const [rLabel, rKeep] of [
      ["tight", (s: Sample) => s.riskPts <= medRisk],
      ["wide", (s: Sample) => s.riskPts > medRisk],
    ] as [string, (s: Sample) => boolean][]) {
      const c = cohort(samples, `${vLabel} + ${rLabel} stop`, (s) => vKeep(s) && rKeep(s));
      if (c.n >= 10) console.log(fmt(c, baseline.wr / 100));
    }
  }

  console.log("\n── Filter combinations, each validated on held-out halves ──");
  console.log("  (train = 09-14..09-18, test = 09-21..09-25)");
  const comboRows: { label: string; all: ReturnType<typeof cohort>; tr: ReturnType<typeof cohort>; te: ReturnType<typeof cohort> }[] = [];
  for (const combo of combos) {
    const all = cohort(samples, combo.label, combo.keep);
    const tr = cohort(samples.filter((s) => train.has(s.date)), combo.label, combo.keep);
    const te = cohort(samples.filter((s) => test.has(s.date)), combo.label, combo.keep);
    comboRows.push({ label: combo.label, all, tr, te });
    console.log(
      `  ${combo.label.padEnd(30)} all ${all.wr.toFixed(0).padStart(3)}% (n=${String(all.n).padStart(3)}) exp=${(all.exp >= 0 ? "+" : "") + all.exp.toFixed(2)}R  ` +
        `train ${tr.wr.toFixed(0).padStart(3)}% (n=${String(tr.n).padStart(3)})  test ${te.wr.toFixed(0).padStart(3)}% (n=${String(te.n).padStart(3)})  ` +
        `p=${binomTail(all.wins, all.n, baseline.wr / 100).toFixed(4)}`,
    );
  }

  // ── does a wider stop raise the win rate? (the user's objective) ───────
  // Re-walks each surviving sample with stops of k ticks beyond the failed
  // extreme, always targeting 1R, so the comparison is apples to apples.
  const bestKeep = combos[5].keep; // LVN + VWAP<10R + shallow
  console.log(`\n── Stop width vs win rate (cohort: ${combos[5].label}), target always 1R ──`);
  const fpCache = new Map<string, Awaited<ReturnType<typeof extractFootprint>>>();
  for (const s of samples) if (!fpCache.has(s.date)) fpCache.set(s.date, await extractFootprint(s.date, SESSION));
  for (const ticks of [2, 4, 6, 8, 12, 16]) {
    let n = 0;
    let wins = 0;
    let exp = 0;
    const perDay = new Map<string, { w: number; n: number }>();
    for (const s of samples.filter(bestKeep)) {
      const fp = fpCache.get(s.date);
      if (!fp) continue;
      const m = fp.minutes;
      const idx = m.findIndex((x) => x.t === s.t);
      if (idx < 0) continue;
      const long = s.dir === "long";
      // stop sits `ticks` beyond the failed extreme, which is where it was
      const risk = s.risk - 2 * TICK + ticks * TICK;
      const stop = long ? s.entry - risk : s.entry + risk;
      let won = false;
      for (let k = idx + 1; k < Math.min(m.length, idx + 1 + LOOKAHEAD); k++) {
        const b = m[k];
        if (long ? b.low <= stop : b.high >= stop) break;
        if (long ? b.high >= s.entry + risk : b.low <= s.entry - risk) {
          won = true;
          break;
        }
      }
      n++;
      if (won) wins++;
      exp += won ? 1 : -1;
      const d = perDay.get(s.date) ?? { w: 0, n: 0 };
      d.n++;
      if (won) d.w++;
      perDay.set(s.date, d);
    }
    const above = [...perDay.values()].filter((d) => d.w / d.n > 0.5).length;
    console.log(
      `  stop ${String(ticks).padStart(2)} ticks (${(ticks * TICK).toFixed(2)} pt)  n=${String(n).padStart(3)}  ` +
        `win=${((wins / Math.max(1, n)) * 100).toFixed(1).padStart(5)}%  exp=${((exp / Math.max(1, n)) >= 0 ? "+" : "") + (exp / Math.max(1, n)).toFixed(2)}R  days>50%=${above}/${perDay.size}`,
    );
  }

  // ── recommended configuration from the filters that survived scrutiny ──
  const RECOMMEND: { label: string; keep: (s: Sample) => boolean }[] = [
    { label: "RECOMMENDED: LVN edge + shallow sweep + wide stop", keep: (s) => s.atEdge && s.sweepDepthR < SHALLOW && s.riskPts > medRisk },
    { label: "RECOMMENDED + overnight only", keep: (s) => s.atEdge && s.sweepDepthR < SHALLOW && s.riskPts > medRisk && s.sessionType !== "RTH" },
    { label: "RECOMMENDED + evening 18-21", keep: (s) => s.atEdge && s.sweepDepthR < SHALLOW && s.riskPts > medRisk && s.hourET >= 18 && s.hourET < 21 },
    { label: "LVN edge + wide stop", keep: (s) => s.atEdge && s.riskPts > medRisk },
    { label: "shallow sweep + wide stop", keep: (s) => s.sweepDepthR < SHALLOW && s.riskPts > medRisk },
    { label: "LVN edge + shallow + divergence", keep: (s) => s.atEdge && s.sweepDepthR < SHALLOW && s.hasDiv },
  ];
  // A marginal reclaim (confirmation bar closes barely back inside) is the
  // single worst cohort in the data, so test it as an explicit exclusion.
  const NONMARGINAL = 1.6; // pt — Q1 boundary of snap-back
  const RULESET: { label: string; keep: (s: Sample) => boolean }[] = [
    { label: "A. non-marginal reclaim only", keep: (s) => s.snapBackPts >= NONMARGINAL },
    { label: "B. A + shallow sweep", keep: (s) => s.snapBackPts >= NONMARGINAL && s.sweepDepthR < SHALLOW },
    { label: "C. A + LVN edge", keep: (s) => s.snapBackPts >= NONMARGINAL && s.atEdge },
    { label: "D. A + LVN edge + shallow", keep: (s) => s.snapBackPts >= NONMARGINAL && s.atEdge && s.sweepDepthR < SHALLOW },
    { label: "E. D + divergence", keep: (s) => s.snapBackPts >= NONMARGINAL && s.atEdge && s.sweepDepthR < SHALLOW && s.hasDiv },
    { label: "F. D + overnight only", keep: (s) => s.snapBackPts >= NONMARGINAL && s.atEdge && s.sweepDepthR < SHALLOW && s.sessionType !== "RTH" },
    { label: "G. A + VWAP within 10R", keep: (s) => s.snapBackPts >= NONMARGINAL && s.distVwapR < VWAP_NEAR },
    { label: "H. A + shallow + VWAP<10R", keep: (s) => s.snapBackPts >= NONMARGINAL && s.sweepDepthR < SHALLOW && s.distVwapR < VWAP_NEAR },
  ];
  console.log("\n── Interpretable rule sets (snap-back threshold + structure), held-out validated ──");
  for (const r of RULESET) {
    const all = cohort(samples, r.label, r.keep);
    const tr = cohort(samples.filter((s) => train.has(s.date)), r.label, r.keep);
    const te = cohort(samples.filter((s) => test.has(s.date)), r.label, r.keep);
    console.log(
      `  ${r.label.padEnd(34)} all ${all.wr.toFixed(0).padStart(3)}% (n=${String(all.n).padStart(3)}) exp=${(all.exp >= 0 ? "+" : "") + all.exp.toFixed(2)}R  ` +
        `train ${tr.wr.toFixed(0).padStart(3)}% (n=${String(tr.n).padStart(3)})  test ${te.wr.toFixed(0).padStart(3)}% (n=${String(te.n).padStart(3)})  ` +
        `per-session=${(all.n / DATES.length).toFixed(1)}  days>50%=${all.daysAbove}/${all.days}  p=${binomTail(all.wins, all.n, baseline.wr / 100).toFixed(4)}`,
    );
  }

  console.log("\n── Recommended configuration, held-out validated ──");
  for (const r of RECOMMEND) {
    const all = cohort(samples, r.label, r.keep);
    const tr = cohort(samples.filter((s) => train.has(s.date)), r.label, r.keep);
    const te = cohort(samples.filter((s) => test.has(s.date)), r.label, r.keep);
    console.log(
      `  ${r.label.replace("RECOMMENDED: ", "").replace("RECOMMENDED ", "").padEnd(42)} all ${all.wr.toFixed(0).padStart(3)}% (n=${String(all.n).padStart(3)}) exp=${(all.exp >= 0 ? "+" : "") + all.exp.toFixed(2)}R  ` +
        `train ${tr.wr.toFixed(0).padStart(3)}% (n=${String(tr.n).padStart(3)})  test ${te.wr.toFixed(0).padStart(3)}% (n=${String(te.n).padStart(3)})  ` +
        `trades/session=${(all.n / DATES.length).toFixed(2)}  p=${binomTail(all.wins, all.n, baseline.wr / 100).toFixed(4)}`,
    );
  }

  // ── is the "marginal reclaim" result an artefact of my tie-break? ─────
  // When the stop and the 1R target BOTH sit inside the next bar's range the
  // outcome is decided purely by the pessimistic "stop first" convention, not
  // by the market. If that share is large, the cohort's win rate says more
  // about the convention than about the setup.
  console.log("\n── Ambiguity check: share of trades whose next bar contains BOTH levels ──");
  {
    const fpAll = new Map<string, Awaited<ReturnType<typeof extractFootprint>>>();
    for (const s of samples) if (!fpAll.has(s.date)) fpAll.set(s.date, await extractFootprint(s.date, SESSION));
    const bands: [string, number, number][] = [
      ["snapBack Q1 (<1.63pt)", 0, 1.63],
      ["snapBack Q2 (1.63-3.50)", 1.63, 3.5],
      ["snapBack Q3 (3.50-6.75)", 3.5, 6.75],
      ["snapBack Q4 (>6.75)", 6.75, Infinity],
    ];
    for (const [label, lo, hi] of bands) {
      let n = 0;
      let amb = 0;
      for (const s of samples.filter((x) => x.snapBackPts >= lo && x.snapBackPts < hi)) {
        const fp = fpAll.get(s.date);
        if (!fp) continue;
        const idx = fp.minutes.findIndex((x) => x.t === s.t);
        if (idx < 0 || idx + 1 >= fp.minutes.length) continue;
        const nb = fp.minutes[idx + 1];
        const long = s.dir === "long";
        const tgt = long ? s.entry + s.risk : s.entry - s.risk;
        const containsStop = long ? nb.low <= s.stop : nb.high >= s.stop;
        const containsTgt = long ? nb.high >= tgt : nb.low <= tgt;
        n++;
        if (containsStop && containsTgt) amb++;
      }
      console.log(`  ${label.padEnd(24)} n=${String(n).padStart(3)}  both-levels-in-next-bar=${((amb / Math.max(1, n)) * 100).toFixed(0)}%`);
    }
  }

  // ── final honest numbers: only trades whose outcome resolves cleanly ───
  // A trade is "ambiguous" when the stop and the 1R target both sit inside the
  // next bar's range and the pessimistic convention alone decides it. Those
  // cannot inform a win-rate estimate, so the headline cohorts are restated on
  // the unambiguous remainder.
  console.log("\n── Restated on unambiguous outcomes only (no convention-decided trades) ──");
  {
    const fpAll = new Map<string, Awaited<ReturnType<typeof extractFootprint>>>();
    for (const s of samples) if (!fpAll.has(s.date)) fpAll.set(s.date, await extractFootprint(s.date, SESSION));
    const clean = new Set<string>();
    const key = (s: Sample) => `${s.date}|${s.t}|${s.dir}`;
    for (const s of samples) {
      const fp = fpAll.get(s.date);
      if (!fp) continue;
      const idx = fp.minutes.findIndex((x) => x.t === s.t);
      if (idx < 0 || idx + 1 >= fp.minutes.length) continue;
      const nb = fp.minutes[idx + 1];
      const long = s.dir === "long";
      const tgt = long ? s.entry + s.risk : s.entry - s.risk;
      const cs = long ? nb.low <= s.stop : nb.high >= s.stop;
      const ct = long ? nb.high >= tgt : nb.low <= tgt;
      if (!(cs && ct)) clean.add(key(s));
    }
    const CLEAN = samples.filter((s) => clean.has(key(s)));
    // The null for any subgroup of CLEAN is the CLEAN baseline, not the raw
    // one: excluding convention-decided trades lifts the baseline by ~8 points,
    // and testing against the old number would manufacture significance.
    const cleanBase = cohort(CLEAN, "clean baseline", () => true);
    console.log(fmt(cleanBase, baseline.wr / 100));
    console.log(
      fmt(
        cohort(
          CLEAN,
          "marginal reclaim (<1.63pt)",
          (s) => s.snapBackPts < 1.63,
        ),
        cleanBase.wr / 100,
      ),
    );
    console.log(
      fmt(
        cohort(
          CLEAN,
          "non-marginal reclaim (>=1.63pt)",
          (s) => s.snapBackPts >= 1.63,
        ),
        cleanBase.wr / 100,
      ),
    );
    console.log(fmt(cohort(CLEAN, "G. non-marginal + VWAP<10R", (s) => s.snapBackPts >= 1.63 && s.distVwapR < 10), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "D. non-marginal + LVN + shallow", (s) => s.snapBackPts >= 1.63 && s.atEdge && s.sweepDepthR < 0.3), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "LVN edge", (s) => s.atEdge), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "not at LVN edge", (s) => !s.atEdge), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "evening 18-21", (s) => s.hourET >= 18 && s.hourET < 21), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "shallow sweep <0.3R", (s) => s.sweepDepthR < 0.3), cleanBase.wr / 100));
    console.log(fmt(cohort(CLEAN, "deep sweep >=0.9R", (s) => s.sweepDepthR >= 0.9), cleanBase.wr / 100));
    console.log(`  (ambiguous trades excluded: ${samples.length - CLEAN.length} of ${samples.length})`);

    // ── the proposed rule set, tiered by selectivity ──────────────────────
    // Same filters, progressively narrower: the trade-off is win rate against
    // how many opportunities survive, and both matter. A 90% rule that fires
    // once a session takes months to validate.
    // ── does the recommended rule set survive a definition change? ────────
    // sweepDepthR is a RATIO: penetration divided by the reclaim distance
    // (risk). So "shallow" can come from a small penetration OR a large
    // snap-back, and the wick-only measure above shows the penetration itself
    // carries no signal. This separates the two.
    console.log("\n── Does 'shallow sweep' survive as its own filter? ──");
    const defs: { label: string; keep: (s: Sample) => boolean }[] = [
      { label: "LVN edge alone", keep: (s) => s.atEdge },
      { label: "LVN + sweepDepthR<0.3 (ratio, as reported)", keep: (s) => s.atEdge && s.sweepDepthR < 0.3 },
      { label: "LVN + wick<1.0pt (pure penetration)", keep: (s) => s.atEdge && s.sweepWickPts < 1.0 },
      { label: "LVN + wick>=5pt (deep penetration)", keep: (s) => s.atEdge && s.sweepWickPts >= 5.0 },
      { label: "LVN + snapBack>=1.63pt (the ratio's numerator)", keep: (s) => s.atEdge && s.snapBackPts >= 1.63 },
      { label: "LVN + risk<=median (small denominator)", keep: (s) => s.atEdge && s.riskPts <= 4.0 },
      { label: "LVN + risk>median (large denominator)", keep: (s) => s.atEdge && s.riskPts > 4.0 },
      { label: "LVN + ratio<0.3 AND wick<1.0 (both)", keep: (s) => s.atEdge && s.sweepDepthR < 0.3 && s.sweepWickPts < 1.0 },
    ];
    for (const d of defs) {
      const c = cohort(CLEAN, d.label, d.keep);
      if (!c.n) continue;
      console.log(
        `  ${d.label.padEnd(46)} n=${String(c.n).padStart(3)}  win=${c.wr.toFixed(1).padStart(5)}%  ` +
          `exp=${(c.exp >= 0 ? "+" : "") + c.exp.toFixed(2)}R  per-session=${(c.n / DATES.length).toFixed(1)}  days>50%=${c.daysAbove}/${c.days}`,
      );
    }

    // ── corrected rule set: only filters that survived in ABSOLUTE units ──
    console.log("\n── CORRECTED rule set (dropping the ratio artefacts) ──");
    const fixed: { label: string; keep: (s: Sample) => boolean }[] = [
      { label: "LVN edge", keep: (s) => s.atEdge },
      { label: "near VWAP <50pt", keep: (s) => s.distVwapPts < 50 },
      { label: "evening 18-21", keep: (s) => s.hourET >= 18 && s.hourET < 21 },
      { label: "LVN + near VWAP", keep: (s) => s.atEdge && s.distVwapPts < 50 },
      { label: "LVN + evening", keep: (s) => s.atEdge && s.hourET >= 18 && s.hourET < 21 },
      { label: "LVN + near VWAP + evening", keep: (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21 },
      { label: "  + divergence", keep: (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21 && s.hasDiv },
    ];
    for (const d of fixed) {
      const c = cohort(CLEAN, d.label, d.keep);
      if (!c.n) continue;
      console.log(
        `  ${d.label.padEnd(32)} n=${String(c.n).padStart(3)}  win=${c.wr.toFixed(1).padStart(5)}%  ` +
          `exp=${(c.exp >= 0 ? "+" : "") + c.exp.toFixed(2)}R  per-session=${(c.n / DATES.length).toFixed(1)}  days>50%=${c.daysAbove}/${c.days}  CI[${c.lo.toFixed(0)}-${c.hi.toFixed(0)}%]  p=${binomTail(c.wins, c.n, cleanBase.wr / 100).toFixed(4)}`,
      );
    }

    console.log("\n── Proposed rule set, tiered (all on clean outcomes) ──");
    const core = (s: Sample) => s.atEdge && s.sweepDepthR < 0.3;
    const tiers: { label: string; keep: (s: Sample) => boolean }[] = [
      { label: "T1 LVN edge + shallow sweep", keep: core },
      { label: "T2 T1 + near VWAP (<50pt)", keep: (s) => core(s) && s.distVwapPts < 50 },
      { label: "T3 T1 + evening 18-21", keep: (s) => core(s) && s.hourET >= 18 && s.hourET < 21 },
      { label: "T4 T1 + near VWAP + evening", keep: (s) => core(s) && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21 },
      { label: "T5 T1 + non-marginal reclaim", keep: (s) => core(s) && s.snapBackPts >= 1.63 },
      { label: "  current playbook (LVN + divergence)", keep: (s) => s.atEdge && s.hasDiv },
      { label: "  current trigger only (any reclaim)", keep: () => true },
    ];
    for (const t of tiers) {
      const c = cohort(CLEAN, t.label, t.keep);
      if (!c.n) continue;
      const above = c.daysAbove;
      console.log(
        `  ${t.label.padEnd(36)} n=${String(c.n).padStart(3)}  win=${c.wr.toFixed(1).padStart(5)}%  ` +
          `exp=${(c.exp >= 0 ? "+" : "") + c.exp.toFixed(2)}R  per-session=${(c.n / DATES.length).toFixed(1)}  days>50%=${above}/${c.days}  ` +
          `CI[${c.lo.toFixed(0)}-${c.hi.toFixed(0)}%]`,
      );
    }

    // Direct cohort-vs-cohort test, which is the honest comparison: does the
    // filter beat its own complement inside the clean set?
    const twoProp = (a: ReturnType<typeof cohort>, b: ReturnType<typeof cohort>, label: string) => {
      const p1 = a.wr / 100;
      const p2 = b.wr / 100;
      const pooled = (a.wins + b.wins) / (a.n + b.n);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
      const z = se > 0 ? (p1 - p2) / se : 0;
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const d = 0.3989423 * Math.exp((-z * z) / 2);
      const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
      const p = z > 0 ? tail : 1 - tail;
      console.log(
        `  contrast ${label.padEnd(38)} ${(p1 * 100).toFixed(1)}% vs ${(p2 * 100).toFixed(1)}%  diff=${((p1 - p2) * 100).toFixed(1)}pt  p=${p.toFixed(3)}`,
      );
    };
    twoProp(cohort(CLEAN, "a", (s) => s.snapBackPts >= 1.63), cohort(CLEAN, "b", (s) => s.snapBackPts < 1.63), "non-marginal vs marginal reclaim");
    twoProp(cohort(CLEAN, "a", (s) => s.atEdge), cohort(CLEAN, "b", (s) => !s.atEdge), "LVN edge vs not");
    twoProp(cohort(CLEAN, "a", (s) => s.sweepDepthR < 0.3), cohort(CLEAN, "b", (s) => s.sweepDepthR >= 0.9), "shallow vs deep sweep");
    twoProp(cohort(CLEAN, "a", (s) => s.hourET >= 18 && s.hourET < 21), cohort(CLEAN, "b", (s) => !(s.hourET >= 18 && s.hourET < 21)), "evening vs rest of day");
    twoProp(cohort(CLEAN, "a", (s) => s.hasDiv), cohort(CLEAN, "b", (s) => !s.hasDiv), "divergence vs not");
    twoProp(cohort(CLEAN, "a", (s) => s.distVwapPts < 50), cohort(CLEAN, "b", (s) => s.distVwapPts >= 50), "near VWAP (abs) vs far");
  }

  console.log("\n── By direction ──");
  console.log(fmt(cohort(samples, "long", (s) => s.dir === "long")));
  console.log(fmt(cohort(samples, "short", (s) => s.dir === "short")));

  // ── pair search, ranked by win rate with a usable sample ───────────────
  const filters: { label: string; keep: (s: Sample) => boolean }[] = [
    { label: "LVN edge", keep: (s) => s.atEdge },
    { label: "divergence", keep: (s) => s.hasDiv },
    { label: "absorption", keep: (s) => s.hasAbs },
    { label: "RTH", keep: (s) => s.sessionType === "RTH" },
    { label: "evening 18-21", keep: (s) => s.hourET >= 18 && s.hourET < 21 },
    { label: "mean-revert side", keep: (s) => (s.dir === "long" && s.vwapSide === "below") || (s.dir === "short" && s.vwapSide === "above") },
    { label: "VWAP dist >= med", keep: (s) => s.distVwapR >= medians.distVwapR },
    { label: "VWAP dist < med", keep: (s) => s.distVwapR < medians.distVwapR },
    { label: "fast reclaim", keep: (s) => s.barsToReclaim <= 1 },
    { label: "deep sweep", keep: (s) => s.sweepDepthR >= medians.sweepDepthR },
    { label: "shallow sweep", keep: (s) => s.sweepDepthR < medians.sweepDepthR },
    { label: "RVOL>=1", keep: (s) => s.rvol >= 1 },
    { label: "RVOL<1", keep: (s) => s.rvol < 1 },
    { label: "RVOL>=1.5", keep: (s) => s.rvol >= 1.5 },
    { label: "tight stop", keep: (s) => s.riskPts <= medians.riskPts },
    { label: "wide stop", keep: (s) => s.riskPts > medians.riskPts },
    { label: "low ATR", keep: (s) => s.atrPts < medians.atrPts },
    { label: "high ATR", keep: (s) => s.atrPts >= medians.atrPts },
    { label: "with slope", keep: (s) => s.withVwapSlope },
    { label: "against slope", keep: (s) => !s.withVwapSlope },
    { label: "early reclaim (<=2)", keep: (s) => s.reclaimOrdinal <= 2 },
    { label: "late reclaim (3+)", keep: (s) => s.reclaimOrdinal > 2 },
    { label: "long", keep: (s) => s.dir === "long" },
    { label: "short", keep: (s) => s.dir === "short" },
  ];

  const MIN_N = 40;
  const pairs: ReturnType<typeof cohort>[] = [];
  for (let i = 0; i < filters.length; i++) {
    for (let j = i + 1; j < filters.length; j++) {
      const a = filters[i];
      const b = filters[j];
      const c = cohort(samples, `${a.label} + ${b.label}`, (s) => a.keep(s) && b.keep(s));
      if (c.n >= MIN_N) pairs.push(c);
    }
  }
  pairs.sort((x, y) => y.wr - x.wr);
  console.log(`\n── Best pairs by win rate (n >= ${MIN_N}, of ${pairs.length} qualifying) ──`);
  for (const c of pairs.slice(0, 12)) console.log(fmt(c));

  // ── honest check: does the winner survive on held-out sessions? ────────
  console.log(
    `\n── Held-out validation: train ${DATES.slice(0, half).join(",")}  |  test ${DATES.slice(half).join(",")} ──`,
  );
  const top = pairs.slice(0, 6);
  for (const c of top) {
    const f = filters.find((x) => `${x.label} + ${filters.find((y) => y !== x && (c.label === `${x.label} + ${y.label}`))?.label}` === c.label);
    // resolve the pair by label instead of the brittle lookup above
    const [l1, l2] = c.label.split(" + ");
    const f1 = filters.find((x) => x.label === l1);
    const f2 = filters.find((x) => x.label === l2);
    void f;
    if (!f1 || !f2) continue;
    const keep = (s: Sample) => f1.keep(s) && f2.keep(s);
    const tr = cohort(samples.filter((s) => train.has(s.date)), c.label, keep);
    const te = cohort(samples.filter((s) => test.has(s.date)), c.label, keep);
    console.log(
      `  ${c.label.padEnd(34)} all ${c.wr.toFixed(0).padStart(3)}% (n=${String(c.n).padStart(3)})   ` +
        `train ${tr.wr.toFixed(0).padStart(3)}% (n=${String(tr.n).padStart(3)})   test ${te.wr.toFixed(0).padStart(3)}% (n=${String(te.n).padStart(3)})`,
    );
  }
  console.log(`\n  baseline: all ${baseline.wr.toFixed(0)}% (n=${baseline.n})`);
  const trB = cohort(samples.filter((s) => train.has(s.date)), "b", () => true);
  const teB = cohort(samples.filter((s) => test.has(s.date)), "b", () => true);
  console.log(`  baseline split: train ${trB.wr.toFixed(0)}% (n=${trB.n})   test ${teB.wr.toFixed(0)}% (n=${teB.n})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
