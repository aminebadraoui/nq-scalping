/* ---------------------------------------------------------------------------
 * auditB_extract.ts — AUDIT SUPPORT ONLY. Writes nothing into the repo.
 *
 *   cd web && node --import ../scripts/ts-loader.mjs ./db/auditB_extract.ts
 *
 * Rebuilds the *identical* sample set that refine.ts builds (same engine, same
 * reclaim detection, same features, same conventions), and additionally records
 * the outcome-resolution bookkeeping the audit needs:
 *   - whether the NEXT bar contains both the stop and the 1R target
 *     (= refine.ts's "ambiguous" definition, which it uses to build CLEAN)
 *   - the bar offset at which the walk resolved, and whether that resolving bar
 *     also contained the other level (residual convention-dependence)
 *   - the win outcome under the OPTIMISTIC tie-break (target first)
 * so convention-sensitivity can be measured instead of assumed.
 *
 * Dumps JSON to /tmp/auditB_samples.json for auditB_stats.ts.
 * Must be run with DATABASE_URL UNSET so the JSON feed is used, exactly as the
 * reported numbers were produced (with DATABASE_URL set only 5 sessions load).
 * ------------------------------------------------------------------------- */
import { analyze, extractFootprint, computeSheet, type AlertEvent, type AbsorbEvent } from "../lib/gcdata.ts";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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

type Row = Record<string, unknown>;

async function main() {
  if (process.env.DATABASE_URL) {
    console.error("REFUSING: DATABASE_URL is set — the JSON feed must be used to reproduce the 449-sample set.");
    process.exit(2);
  }
  const DATES = discoverDates();
  console.error(`Sessions: ${DATES.length} — ${DATES[0]} .. ${DATES[DATES.length - 1]}`);

  const rows: Row[] = [];

  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    const an = await analyze(date, SESSION, undefined, undefined, 4);
    if (!fp || !an) {
      console.error(`skip ${date}: no data`);
      continue;
    }
    const sheet = await computeSheet(date);
    const m = fp.minutes;
    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);
    const vol = m.map((x) => (x.buy ?? 0) + (x.sell ?? 0));
    const medVol = q(vol, 0.5) || 1;

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

      const long = dir === "long";
      const tgt = long ? entry + BASE_R * risk : entry - BASE_R * risk;

      // --- replicate refine.ts exactly: pessimistic same-bar ordering ---------
      let win = false;
      let mfe = 0;
      let mae = 0;
      let resolveK = -1; // bar offset (absolute index) at which the walk stopped
      let resolveKind: "stop" | "target" | "none" = "none";
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        const isLong = long;
        if (isLong ? lo[k] <= stop : hi[k] >= stop) {
          resolveK = k;
          resolveKind = "stop";
          break;
        }
        mfe = Math.max(mfe, (isLong ? hi[k] - entry : entry - lo[k]) / risk);
        mae = Math.max(mae, (isLong ? entry - lo[k] : hi[k] - entry) / risk);
        if (isLong ? hi[k] >= tgt : lo[k] <= tgt) {
          win = true;
          resolveK = k;
          resolveKind = "target";
          break;
        }
      }

      // --- same walk with the OPTIMISTIC tie-break (target checked first) ----
      let winOpt = false;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        if (long ? hi[k] >= tgt : lo[k] <= tgt) {
          winOpt = true;
          break;
        }
        if (long ? lo[k] <= stop : hi[k] >= stop) break;
      }

      // --- ambiguity bookkeeping -------------------------------------------
      // refine.ts's CLEAN rule: the NEXT bar contains BOTH levels.
      let nextIdx = r.i + 1;
      let ambNext = false;
      let ambNextValid = false;
      if (nextIdx < m.length) {
        const nb = m[nextIdx];
        const cs = long ? nb.low <= stop : nb.high >= stop;
        const ct = long ? nb.high >= tgt : nb.low <= tgt;
        ambNext = cs && ct;
        ambNextValid = true;
      }
      // residual: did the bar that RESOLVED the trade also contain the other level?
      let resolveBarHasOther = false;
      if (resolveK >= 0 && resolveKind !== "none") {
        const rb = m[resolveK];
        if (resolveKind === "stop") {
          resolveBarHasOther = long ? rb.high >= tgt : rb.low <= tgt;
        } else {
          resolveBarHasOther = long ? rb.low <= stop : rb.high >= stop;
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
      const prior30 = Math.max(0, r.i - 30);
      const slope = (vwap[r.i] || 0) - (vwap[prior30] || 0);
      const atr = q(
        m.slice(Math.max(0, r.i - 15), r.i).map((x) => x.high - x.low),
        0.5,
      );
      const minute = minuteOf(bar.t);
      const etHour = etHourOf(bar.t);

      rows.push({
        date,
        t: bar.t,
        barIndex: r.i,
        dir,
        entry,
        stop,
        risk,
        win,
        winOpt,
        resolveK,
        resolveKind,
        resolveBarHasOther,
        ambNext,
        ambNextValid,
        mfeR: mfe,
        maeR: mae,
        hourET: etHour,
        minuteOfSession: minute,
        sessionType:
          etHour >= 9 && !(etHour === 9 && Number(bar.t.slice(3, 5)) < 30) && etHour < 16 ? "RTH" : "OVERNIGHT",
        atEdge,
        hasDiv,
        hasAbs,
        vwapSide: entry >= w ? "above" : "below",
        distVwapR: Math.abs(entry - w) / risk,
        distVwapPts: Math.abs(entry - w),
        snapBackPts: Math.abs(entry - r.extreme),
        sweepWickPts: r.dir === "low" ? r.extreme - lo[r.breakBar] : hi[r.breakBar] - r.extreme,
        barsToReclaim: r.i - r.breakBar,
        sweepDepthR: Math.abs(mid[r.breakBar] - r.extreme) / risk,
        rvol: vol[r.i] / medVol,
        absDeltaPct: Math.abs(bar.delta ?? 0) / Math.max(1, vol[r.i]),
        riskPts: risk,
        atrPts: atr,
        withVwapSlope: slope > 0 ? long : slope < 0 ? !long : false,
        reclaimOrdinal: ordinal,
        barRangePts: bar.high - bar.low,
      });
    }
  }

  const wins = rows.filter((r) => r.win).length;
  console.error(`samples=${rows.length} wins=${wins} winrate=${((wins / rows.length) * 100).toFixed(2)}%`);
  const amb = rows.filter((r) => r.ambNext).length;
  console.error(`ambiguous(next bar contains both)=${amb}  clean=${rows.length - amb}`);
  writeFileSync("/tmp/auditB_samples.json", JSON.stringify({ dates: DATES, rows }, null, 0));
  console.error("wrote /tmp/auditB_samples.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
