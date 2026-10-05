/* ------------------------------------------------------------------ *
 * Gap-only validation — the honest replay of what the live executor
 * ACTUALLY does (fix-plan F3, docs/research/fix-plan-2026-10-05.md).
 *
 * Divergence from every earlier study: the live feed trades EVERY
 * ≥5-bar-gapped card, while the historical replays skipped any signal
 * inside a 60-bar window of the previous entry (one-position-at-a-time).
 * This study replays gap-only (all signals), charges the measured
 * 0.95 pt round-trip cost, models the measured −1.75 pt adverse entry
 * drift, and runs the MFF account sim + a walk-forward — the policy
 * evidence base for the F4 env changes.
 *
 * Grid per family (MOM flush · EXP expansion · RTH soft):
 *   rate:   gap (every card — live) · flat60 (backtest semantics)
 *   stop:   0.35× 0.45× 0.6× 0.75× 0.9× 1.0× (profile targets) +
 *           structural (1R mom/exp, 0.75R rth)
 *   drift:  0 · losers-only (1.75) · all (1.75)
 *   gate:   first-N-cards/day N ∈ {1,2,3} on the headline configs
 * plus walk-forward (150-train → 30-test) on the top configs.
 *
 *   node --import ../scripts/ts-loader.mjs scripts/gapOnlyValidation.ts \
 *     [--offline] [--max N]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";

const COST = 0.95; // measured live round-trip (TRADE_REVIEW_2026-10-02)
const DRIFT = 1.75; // measured median adverse fill drift on losers
const SPLIT = "2026-01-01";
const WF_TRAIN = 150;
const WF_TEST = 30;

type Fam = {
  name: string;
  detect: (m: MomMinute[]) => MomentumSignal[];
  targetR: number; // profile target
  timeExit: number;
  structuralT: number; // structural target (1R / 0.75R)
};

const FAMILIES: Fam[] = [
  { name: "MOM", detect: (m) => detectMomentum(m, MOM_PROD), targetR: 2.25, timeExit: 60, structuralT: 1 },
  { name: "EXP", detect: (m) => detectExpansionScalp(m, EXP_PROD), targetR: 2.25, timeExit: 60, structuralT: 1 },
  { name: "RTH", detect: (m) => detectSoftMomentum(m, SOFT_PROD), targetR: 1.75, timeExit: 45, structuralT: 0.75 },
];

type Trade = { date: string; pnlPts: number; riskPts: number };

function replay(
  minutes: MomMinute[],
  sigs: MomentumSignal[],
  stopMult: number,
  targetR: number,
  timeExit: number,
  rate: "gap" | "flat60",
  drift: "none" | "losers" | "all",
  firstN: number,
): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  const dayCount = new Map<string, number>();
  for (const s of sigs) {
    if (rate === "flat60" && s.entryIdx <= openUntil) continue;
    if (firstN > 0) {
      const n = (dayCount.get(s.d) ?? 0) + 1;
      dayCount.set(s.d, n);
      if (n > firstN) continue;
    }
    const dir = s.dir === "long" ? 1 : -1;
    const risk = Math.abs(s.entry - s.stop) * stopMult;
    if (!(risk > 0)) continue;
    const entry = s.entry;
    const stop = entry - dir * risk;
    const target = entry + dir * risk * targetR;
    const end = Math.min(minutes.length - 1, s.entryIdx + timeExit);
    if (s.entryIdx + 1 > end) continue;
    let exit = closeOf(minutes[end]);
    for (let j = s.entryIdx + 1; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = stop; break; }
      if (dir > 0 ? b.high >= target : b.low <= target) { exit = target; break; }
    }
    let pnl = (exit - entry) * dir - COST;
    if (drift === "all") pnl -= DRIFT;
    else if (drift === "losers" && pnl < 0) pnl -= DRIFT;
    out.push({ date: s.d, pnlPts: pnl, riskPts: risk });
    openUntil = s.entryIdx + timeExit;
  }
  return out;
}

type Stats = { n: number; wr: number; pf: number; net: number; exp: number };

function stats(tt: Trade[]): Stats {
  const wins = tt.filter((t) => t.pnlPts > 0);
  const losses = tt.filter((t) => t.pnlPts < 0);
  const gw = wins.reduce((a, t) => a + t.pnlPts, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnlPts, 0));
  const net = tt.reduce((a, t) => a + t.pnlPts, 0);
  const dec = wins.length + losses.length;
  return { n: tt.length, wr: dec ? (wins.length / dec) * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, net, exp: tt.length ? net / tt.length : 0 };
}

function sim(tt: Trade[]): string {
  if (!tt.length) return "n/a";
  const d = dollarize(tt.map((t) => ({ date: t.date, pnlPts: t.pnlPts, riskPts: t.riskPts })));
  const acc = simulateAccount(d, "eval");
  return accountLine(acc);
}

type Cell = { label: string; s: Stats; sim: string; tr: Stats; te: Stats };

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
  console.log(`gap-only validation · ${dates.length} sessions · cost ${COST}pt · drift ${DRIFT}pt · gap-only + flat60 + first-N gates`);

  // precompute all sessions once (warm cache: seconds)
  const sessions: { date: string; minutes: MomMinute[]; sigs: Record<string, MomentumSignal[]> }[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs: Record<string, MomentumSignal[]> = {};
      for (const f of FAMILIES) sigs[f.name] = f.detect(minutes);
      sessions.push({ date, minutes, sigs });
    }
    i += 8;
    if (i % 200 < 8) console.log(`  loaded ${i}/${dates.length}…`);
  }
  console.log(`  ${sessions.length} sessions loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  for (const fam of FAMILIES) {
    console.log(`\n=== ${fam.name} (profile ${fam.targetR}R / ${fam.timeExit}-bar · structural ${fam.structuralT}R) ===`);
    const cells: Cell[] = [];
    for (const rate of ["gap", "flat60"] as const) {
      for (const mult of [0.35, 0.45, 0.6, 0.75, 0.9, 1.0]) {
        for (const drift of ["none", "losers", "all"] as const) {
          const tt: Trade[] = [];
          for (const s of sessions) tt.push(...replay(s.minutes, s.sigs[fam.name], mult, fam.targetR, fam.timeExit, rate, drift, 0));
          const s = stats(tt);
          const tr = stats(tt.filter((t) => t.date < SPLIT));
          const te = stats(tt.filter((t) => t.date >= SPLIT));
          cells.push({
            label: `${rate.padEnd(6)} s${String(mult).padEnd(4)} ${drift.padEnd(6)}`,
            s, sim: sim(tt), tr, te,
          });
        }
      }
      // structural bracket at the same rates
      for (const drift of ["none", "losers", "all"] as const) {
        const tt: Trade[] = [];
        for (const s of sessions) tt.push(...replay(s.minutes, s.sigs[fam.name], 1.0, fam.structuralT, 60, rate, drift, 0));
        const s = stats(tt);
        cells.push({
          label: `${rate.padEnd(6)} struct ${drift.padEnd(6)}`,
          s, sim: sim(tt),
          tr: stats(tt.filter((t) => t.date < SPLIT)),
          te: stats(tt.filter((t) => t.date >= SPLIT)),
        });
      }
    }
    console.log(`  ${"config".padEnd(22)} ${"n".padStart(5)} ${"WR%".padStart(6)} ${"exp".padStart(7)} ${"net pts".padStart(9)} ${"train".padStart(7)} ${"test".padStart(7)}  eval`);
    for (const c of cells) {
      const pf = Number.isFinite(c.s.pf) ? c.s.pf.toFixed(2) : " inf";
      console.log(
        `  ${c.label.padEnd(22)} ${String(c.s.n).padStart(5)} ${c.s.wr.toFixed(1).padStart(6)} ${(c.s.exp >= 0 ? "+" : "") + c.s.exp.toFixed(2).padStart(7)} ${c.s.net.toFixed(0).padStart(9)} ${(c.tr.exp >= 0 ? "+" : "") + c.tr.exp.toFixed(2).padStart(7)} ${(c.te.exp >= 0 ? "+" : "") + c.te.exp.toFixed(2).padStart(7)}  ${c.sim}`,
      );
    }
    // first-N gates on the gap-only headline: mult 1.0 profile + structural, drift losers
    console.log(`  first-N-cards/day gates (gap rate, drift=losers):`);
    for (const [label, mult, tR, x] of [
      ["profile s1.0", 1.0, fam.targetR, fam.timeExit],
      ["structural s1.0", 1.0, fam.structuralT, 60],
    ] as [string, number, number, number][]) {
      for (const n of [1, 2, 3]) {
        const tt: Trade[] = [];
        for (const s of sessions) tt.push(...replay(s.minutes, s.sigs[fam.name], mult, tR, x, "gap", "losers", n));
        const s = stats(tt);
        console.log(`  ${`  ${label} first${n}`.padEnd(22)} ${String(s.n).padStart(5)} ${s.wr.toFixed(1).padStart(6)} ${(s.exp >= 0 ? "+" : "") + s.exp.toFixed(2).padStart(7)} ${s.net.toFixed(0).padStart(9)}  ${sim(tt)}`);
      }
    }
  }

  // walk-forward on the headline configs (gap rate, drift=losers, s1.0)
  console.log("\n=== walk-forward (150-train → 30-test · gap rate · drift=losers) ===");
  for (const fam of FAMILIES) {
    for (const [label, mult, tR, x] of [
      ["s1.0 profile", 1.0, fam.targetR, fam.timeExit],
      ["s1.0 structural", 1.0, fam.structuralT, 60],
    ] as [string, number, number, number][]) {
      let passes = 0;
      let breaches = 0;
      let aggTestNet = 0;
      for (let w = 0; w + WF_TRAIN + WF_TEST <= sessions.length; w += WF_TEST) {
        const testSeg = sessions.slice(w + WF_TRAIN, w + WF_TRAIN + WF_TEST);
        const tt: Trade[] = [];
        for (const s of testSeg) tt.push(...replay(s.minutes, s.sigs[fam.name], mult, tR, x, "gap", "losers", 0));
        const d = dollarize(tt.map((t) => ({ date: t.date, pnlPts: t.pnlPts, riskPts: t.riskPts })));
        const acc = simulateAccount(d, "eval");
        aggTestNet += tt.reduce((a, t) => a + t.pnlPts, 0);
        passes += acc.breachDay === null ? 1 : 0;
        breaches += acc.breachDay === null ? 0 : 1;
      }
      const windows = Math.max(1, Math.floor((sessions.length - WF_TRAIN) / WF_TEST));
      console.log(`  ${`${fam.name} ${label}`.padEnd(18)} ${passes}/${windows} windows pass${breaches ? ` · ${breaches} breach` : ""} · test net ${aggTestNet.toFixed(0)} pts`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
