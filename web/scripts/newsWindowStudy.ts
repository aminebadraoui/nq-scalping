/* ------------------------------------------------------------------ *
 * News-window study — the measured stand-aside veto (gap A6).
 *
 * Question: what do momentum/RTH card outcomes look like INSIDE the
 * release windows the hardcoded newsGate.ts vetoes today, at ±5 / ±15 /
 * ±30 min — and what do the tape statistics say the windows should be?
 *
 * Events (point-in-time safe by construction):
 *   · 8:30 ET shock bars — the DATA-DRIVEN release proxy (CPI/NFP/PPI
 *     and other 8:30 prints; the reverse-engineered family-A approach,
 *     no calendar needed): the 08:30 bar whose range ≥ max(8 pts,
 *     3 × the day's pre-8:30 median range).
 *   · FOMC — the repo calendar (seasonalAlmanac FOMC_DAYS, official):
 *     statement 14:00 ET + presser 14:30 ET.
 *
 * Momentum (flush+expansion) trades premkt, so it meets the 8:30
 * windows; RTH (soft) trades 09:30–16:00, so it meets the FOMC
 * windows. Each family is replayed with its live plan shape (0.5 pt,
 * 60-bar, sequential full-window) and every scored trade is tagged by
 * its distance to the nearest event of its kind, then bucketed
 * inside/outside ±5 / ±15 / ±30 min. The vetoed-share column is the
 * deployment number: how many cards each width removes.
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/newsWindowStudy.ts --offline [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { scoreTrade, scoreSequential, coreStats, propViability, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";

const SPLIT = "2026-01-01";
const COST = 0.5;
const HOLD = 60;
const SHOCK_MIN_PTS = 8;
const SHOCK_MED_MULT = 3;

const FOMC_DAYS = new Set<string>([
  "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31",
  "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30",
  "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29",
  "2026-09-16", "2026-10-28", "2026-12-09",
]);

type Scored = { date: string; pnl: number; risk: number; entryMin: number; distShock: number | null; distFomc: number | null; key: string };

function scoreList(minutes: MomMinute[], sigs: MomentumSignal[], shockMin: number | null, fomcMins: number[]): Scored[] {
  const dist = (m: number, evs: number[]): number | null => (evs.length ? Math.min(...evs.map((e) => Math.abs(m - e))) : null);
  return scoreSequential(
    sigs,
    (s) => {
      const dir = s.dir === "long" ? 1 : -1;
      const sc = scoreTrade(
        minutes,
        { dir, entry: s.entry, stop: s.stop, target: s.target, entryIdx: s.entryIdx, risk: Math.abs(s.entry - s.stop) },
        { costPts: COST, holdBars: HOLD },
      );
      return sc ? { ...sc, s } : null;
    },
    { occupy: "full", window: HOLD },
  ).map((o) => {
    const t = o.s.t;
    const entryMin = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    return {
      date: o.s.d,
      pnl: o.pnl,
      risk: o.risk,
      entryMin,
      distShock: shockMin !== null ? Math.abs(entryMin - shockMin) : null,
      distFomc: dist(entryMin, fomcMins),
      key: `${o.s.d}|${o.s.entryIdx}|${o.s.dir}`,
    };
  });
}

/** 8:30 shock events per session (release proxy) + FOMC event minutes.
 *  The shock threshold is data-driven: a session qualifies when its
 *  8:30 bar range is ≥ the archive-wide 90th percentile of 8:30-bar
 *  ranges (releases print the biggest 8:30 bars by construction) AND
 *  ≥ max(8 pts, 3 × the day's pre-8:30 median range). */
function shockMinute(minutes: MomMinute[]): { min: number | null; range: number; localFloor: number } {
  const bar = minutes.find((m) => m.t === "08:30");
  if (!bar) return { min: null, range: 0, localFloor: Infinity };
  const range = bar.high - bar.low;
  const prior = minutes.filter((m) => m.t >= "06:00" && m.t < "08:30").map((m) => m.high - m.low).sort((a, b) => a - b);
  const med = prior.length ? prior[Math.floor(prior.length / 2)] : 0;
  return { min: 8 * 60 + 30, range, localFloor: Math.max(SHOCK_MIN_PTS, SHOCK_MED_MULT * med) };
}

function fomcMinutes(date: string): number[] {
  return FOMC_DAYS.has(date) ? [14 * 60, 14 * 60 + 30] : [];
}

type Cell = { n: number; wr: number; wrCi: [number, number]; pf: number; expPts: number; expR: number; sessions: number };

function cellOf(tt: Scored[]): Cell {
  const s = coreStats(tt.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return { n: s.n, wr: s.wr, wrCi: s.wrCi, pf: s.pf, expPts: s.expPts, expR: s.expR, sessions: s.sessions };
}

function inside(tt: Scored[], w: number, kind: "shock" | "fomc"): Scored[] {
  return tt.filter((t) => (kind === "shock" ? t.distShock !== null && t.distShock <= w : t.distFomc !== null && t.distFomc <= w));
}

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
  console.log(`newsWindowStudy · ${dates.length} sessions`);

  const momAll: Scored[] = [];
  const rthAll: Scored[] = [];
  const dayRanges = new Map<string, { range: number; floor: number }>();
  const t0 = Date.now();
  let i = 0;
  let fomcDays = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const sessions = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of sessions) {
      if (!minutes) continue;
      const sh = shockMinute(minutes);
      dayRanges.set(date, { range: sh.range, floor: sh.localFloor ?? Infinity });
      const fomc = fomcMinutes(date);
      if (fomc.length) fomcDays++;
      momAll.push(...scoreList(minutes, [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)], sh.min, fomc));
      rthAll.push(...scoreList(minutes, detectSoftMomentum(minutes, SOFT_PROD), sh.min, fomc));
    }
    i += 8;
    if (i % 200 < 8) console.log(`  ${i}/${dates.length}…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${fomcDays} FOMC days\n`);

  /* data-driven shock threshold: archive-wide P90 of 8:30-bar ranges */
  const ranges = [...dayRanges.values()].map((r) => r.range).sort((a, b) => a - b);
  const p90 = ranges.length ? ranges[Math.floor(ranges.length * 0.9)] : Infinity;
  const isShockDay = (date: string): boolean => {
    const d = dayRanges.get(date);
    return !!d && d.range >= p90 && d.range >= d.floor;
  };
  const shockDays = dates.filter(isShockDay).length;
  console.log(`shock threshold: 8:30 range ≥ ${p90.toFixed(1)} pts (P90) → ${shockDays} release-proxy days\n`);
  const finalize = (tt: Scored[]): Scored[] =>
    tt.map((t) => ({ ...t, distShock: isShockDay(t.date) && t.distShock !== null ? t.distShock : null }));

  const rows: { label: string; c: Cell }[] = [];
  const momFinal = finalize(momAll);
  const rthFinal = finalize(rthAll);
  rows.push({ label: "momentum all", c: cellOf(momFinal) });
  for (const w of [5, 15, 30]) {
    rows.push({ label: `momentum ±${w}min of 8:30 shock`, c: cellOf(inside(momFinal, w, "shock")) });
  }
  rows.push({ label: "rth all", c: cellOf(rthFinal) });
  for (const w of [5, 15, 30]) {
    rows.push({ label: `rth ±${w}min of FOMC`, c: cellOf(inside(rthFinal, w, "fomc")) });
  }

  console.log("=== STANDARD REPORT ===");
  console.log(
    renderT1(
      rows.map((r) => ({
        label: r.label,
        stats: {
          n: r.c.n,
          wins: 0,
          losses: 0,
          wr: r.c.wr,
          wrCi: r.c.wrCi,
          avgWin: 0,
          avgLoss: 0,
          payoff: 0,
          expPts: r.c.expPts,
          expR: r.c.expR,
          pf: r.c.pf,
          sqn: 0,
          maxDdPts: 0,
          sharpeSess: 0,
          concTop10: 0,
          netPts: 0,
          grossWin: 0,
          grossLoss: 0,
          sessions: r.c.sessions,
        },
      })),
    ),
  );
  const momBase = cellOf(momFinal);
  const rthBase = cellOf(rthFinal);
  const t2: { rule: string; n: number; wr: number; ci: [number, number]; pf: number; expPts: number; trainTest: string; compare: string }[] = [];
  for (const w of [5, 15, 30]) {
    const c = cellOf(inside(momFinal, w, "shock"));
    t2.push({ rule: `momentum ±${w}min of 8:30 shock`, n: c.n, wr: c.wr, ci: c.wrCi, pf: c.pf, expPts: c.expPts, trainTest: "—", compare: `all ${momBase.wr.toFixed(0)}% WR · ${((c.n / Math.max(1, momFinal.length)) * 100).toFixed(1)}% of cards` });
  }
  for (const w of [5, 15, 30]) {
    const c = cellOf(inside(rthFinal, w, "fomc"));
    t2.push({ rule: `rth ±${w}min of FOMC`, n: c.n, wr: c.wr, ci: c.wrCi, pf: c.pf, expPts: c.expPts, trainTest: "—", compare: `all ${rthBase.wr.toFixed(0)}% WR · ${((c.n / Math.max(1, rthFinal.length)) * 100).toFixed(1)}% of cards` });
  }
  console.log("\n" + renderT2(t2));
  const viability = propViability(momFinal.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })), { splitDate: SPLIT });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: "n/a (window measurement)",
        significance: "—",
        stability: "—",
        holdout: "n/a",
        viability: "n/a (no layer varied)",
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
