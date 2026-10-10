/* ------------------------------------------------------------------ *
 * ALN / structure study — verify the Steady Turtle base rates on OUR
 * 649-session archive (first-party cross-check of the daily-bias
 * structure layer):
 *   - RTH breaks the overnight (Globex) high/low — and both
 *   - RTH hits PDH / PDL (prior RTH extremes) — and both
 *   - RTH-open gap vs prior RTH close: fill rate by size bucket
 *   - Asia–London–NY (ALN) pattern P1..P4 frequencies, and the
 *     conditional rate at which NY breaks the London high/low
 *
 * Session convention (matches seasonalAlmanac): bars t in CT.
 *   Asia 19:00–00:59 · London 01:00–06:59 · RTH 08:30–14:59 CT.
 * Overnight range = all bars before 08:30 CT. Gap = first RTH open
 * vs prior session's RTH close.
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/alnStructureStudy.ts [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";

type Bar = { t: string; o: number; c: number; high: number; low: number };

function inAsia(t: string) { return t >= "19:00" || t <= "00:59"; }
function inLondon(t: string) { return t >= "01:00" && t <= "06:59"; }
function inRTH(t: string) { return t >= "08:30" && t <= "14:59"; }
function beforeRTH(t: string) { return t < "08:30"; }

const close = (b: Bar) => (b.c > 0 ? b.c : (b.high + b.low) / 2); // the shared closeOf fallback

async function main() {
  const o = process.argv.includes("--max") ? Number(process.argv[process.argv.indexOf("--max") + 1]) : undefined;
  let dates = await archiveDates({ source: "manifest" });
  dates.sort();
  if (o) dates = dates.slice(-o);
  console.log(`alnStructureStudy: ${dates.length} sessions`);

  /* prior session's RTH H/L/close */
  let prevRthHigh = 0;
  let prevRthLow = Infinity;
  let prevClose = 0;

  const agg = {
    sessions: 0,
    breaksONH: 0, breaksONL: 0, breaksBothON: 0,
    hitsPDH: 0, hitsPDL: 0, hitsBothPD: 0, insidePD: 0,
    gapped: 0, gapFilled: 0,
    gapBuckets: [] as { lo: number; hi: number; n: number; filled: number }[],
    patterns: {} as Record<string, { n: number; brkLH: number; brkLL: number; both: number }>,
    all: { n: 0, brkLH: 0, brkLL: 0 },
  };
  const GAP_BUCKETS = [[0, 10], [10, 20], [20, 40], [40, 80], [80, Infinity]] as const;
  for (const [lo, hi] of GAP_BUCKETS) agg.gapBuckets.push({ lo, hi, n: 0, filled: 0 });
  const PKEYS = ["P1", "P2", "P3", "P4", "other"];
  for (const k of PKEYS) agg.patterns[k] = { n: 0, brkLH: 0, brkLL: 0, both: 0 };

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date, { withOhlc: true });
    if (!minutes || minutes.length < 60) continue;
    const bars = minutes as unknown as Bar[];

    const onBars = bars.filter((b) => beforeRTH(b.t));
    const rthBars = bars.filter((b) => inRTH(b.t));
    const asiaBars = bars.filter((b) => inAsia(b.t));
    const lonBars = bars.filter((b) => inLondon(b.t));
    if (onBars.length < 60 || rthBars.length < 300) continue; // session too thin

    const onH = Math.max(...onBars.map((b) => b.high));
    const onL = Math.min(...onBars.map((b) => b.low));
    const aH = Math.max(...asiaBars.map((b) => b.high));
    const aL = Math.min(...asiaBars.map((b) => b.low));
    const lH = Math.max(...lonBars.map((b) => b.high));
    const lL = Math.min(...lonBars.map((b) => b.low));
    const rthH = Math.max(...rthBars.map((b) => b.high));
    const rthL = Math.min(...rthBars.map((b) => b.low));

    agg.sessions++;
    const brkH = rthH > onH, brkL = rthL < onL;
    if (brkH) agg.breaksONH++;
    if (brkL) agg.breaksONL++;
    if (brkH && brkL) agg.breaksBothON++;

    if (prevRthHigh > 0) {
      const hitH = rthH >= prevRthHigh, hitL = rthL <= prevRthLow;
      if (hitH) agg.hitsPDH++;
      if (hitL) agg.hitsPDL++;
      if (hitH && hitL) agg.hitsBothPD++;
      if (!hitH && !hitL) agg.insidePD++;

      /* gap = first RTH open (mid fallback: R2 o can be 0) vs prior RTH close */
      if (prevClose > 0) {
        const fb = rthBars[0];
        const open = fb.o > 0 ? fb.o : (fb.high + fb.low) / 2;
        if (open > 0) {
          const gap = open - prevClose;
          if (Math.abs(gap) > 0.01) {
            agg.gapped++;
            let filled = false;
            for (const b of rthBars) {
              if (gap > 0 ? b.low <= prevClose : b.high >= prevClose) { filled = true; break; }
            }
            if (filled) agg.gapFilled++;
            for (const bk of agg.gapBuckets) {
              if (Math.abs(gap) >= bk.lo && Math.abs(gap) < bk.hi) {
                bk.n++;
                if (filled) bk.filled++;
              }
            }
          }
        }
      }
    }

    /* ALN pattern */
    let pk = "other";
    if (lH >= aH && lL <= aL) pk = "P1";
    else if (aH >= lH && aL <= lL) pk = "P2";
    else if (lH > aH && lL >= aL) pk = "P3";
    else if (lL < aL && lH <= aH) pk = "P4";
    const bLH = rthH > lH, bLL = rthL < lL;
    agg.patterns[pk].n++;
    if (bLH) agg.patterns[pk].brkLH++;
    if (bLL) agg.patterns[pk].brkLL++;
    if (bLH && bLL) agg.patterns[pk].both++;
    agg.all.n++; if (bLH) agg.all.brkLH++; if (bLL) agg.all.brkLL++;

    /* prior-session bookkeeping from THIS session's RTH */
    prevRthHigh = rthH;
    prevRthLow = rthL;
    prevClose = close(rthBars[rthBars.length - 1]);
  }

  const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) + "%" : "—");
  const n = agg.sessions;
  console.log(`\nsessions ${n}`);
  console.log(`\n-- overnight (Globex) break rates --`);
  console.log(`breaks either ON extreme  ${agg.breaksONH + agg.breaksONL - agg.breaksBothON}/${n}  ${pct(agg.breaksONH + agg.breaksONL - agg.breaksBothON, n)}`);
  console.log(`breaks ON high            ${agg.breaksONH}/${n}  ${pct(agg.breaksONH, n)}`);
  console.log(`breaks ON low             ${agg.breaksONL}/${n}  ${pct(agg.breaksONL, n)}`);
  console.log(`breaks both               ${agg.breaksBothON}/${n}  ${pct(agg.breaksBothON, n)}`);
  console.log(`\n-- PDH/PDL hit rates --`);
  console.log(`hits PDH or PDL           ${agg.hitsPDH + agg.hitsPDL - agg.hitsBothPD}/${n}  ${pct(agg.hitsPDH + agg.hitsPDL - agg.hitsBothPD, n)}`);
  console.log(`hits PDH                  ${agg.hitsPDH}/${n}  ${pct(agg.hitsPDH, n)}`);
  console.log(`hits PDL                  ${agg.hitsPDL}/${n}  ${pct(agg.hitsPDL, n)}`);
  console.log(`hits both                 ${agg.hitsBothPD}/${n}  ${pct(agg.hitsBothPD, n)}`);
  console.log(`inside day                ${agg.insidePD}/${n}  ${pct(agg.insidePD, n)}`);
  console.log(`\n-- RTH-open gap fill by size (pts) --`);
  console.log(`gapped sessions ${agg.gapped} · filled ${agg.gapFilled}  ${pct(agg.gapFilled, agg.gapped)}`);
  for (const bk of agg.gapBuckets) {
    console.log(`  ${String(bk.lo).padStart(3)}–${bk.hi === Infinity ? "∞" : bk.hi}  n=${String(bk.n).padStart(3)}  filled ${pct(bk.filled, bk.n)}`);
  }
  console.log(`\n-- ALN patterns → NY breaks London extremes --`);
  console.log(`ALL  n=${agg.all.n}  brkLH ${pct(agg.all.brkLH, agg.all.n)}  brkLL ${pct(agg.all.brkLL, agg.all.n)}`);
  for (const k of PKEYS) {
    const p = agg.patterns[k];
    console.log(`${k.padEnd(6)} n=${String(p.n).padStart(3)} (${pct(p.n, n)})  brkLH ${pct(p.brkLH, p.n)}  brkLL ${pct(p.brkLL, p.n)}  both ${pct(p.both, p.n)}`);
  }
}

main().catch((e) => {
  console.error("alnStructureStudy failed:", e);
  process.exit(1);
});
