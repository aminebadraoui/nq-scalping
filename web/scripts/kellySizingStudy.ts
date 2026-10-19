/* ------------------------------------------------------------------ *
 * Kelly sizing study — the validation for the Kelly mode
 * (lib/kelly.ts, docs/research/kelly-mode-2026-10-07.md).
 *
 * The question: does sizing each card from a self-updating, shrunken
 * Kelly estimate of its family's edge beat the flat $100 day plan —
 * through the FULL live rule stack, not just the MFF account sim?
 *
 * Modeled (grounded in the live code, not approximated):
 *   · MFF Rapid EOD 50k (lib/propAccount.ts): EOD trailing $2,000 MLL,
 *     $100 floor lock (funded), $3,000 target, 4 min days, 30%
 *     consistency, $2,100 payout buffer + $500 steps — simulateAccount.
 *   · The live day-plan guard stack (lib/accountGuard.ts semantics):
 *     DAILY_LOSS_FLOOR 250 · PROFIT_ARM 400 (one-more-trade) ·
 *     give-back protection (0.5 × dayPeak, $250 floor) · consistency-day
 *     halt at $900 · GUARD_MARGIN 500 floor halt · target halt ·
 *     dd600→half sizing with 300 hysteresis (DD_HALF_MULT 0.5).
 *   · Sizing caps (lib/propRules.ts): 30-micro cap, $ budget floor(÷ $2/pt),
 *     min 1 contract; Kelly risk caps KELLY_MAX_RISK/MIN_RISK/MAX_FRAC.
 *   · Live replay semantics (gapOnlyValidation conventions): every
 *     detector signal (the ≥5-bar gap lives in the detectors), measured
 *     0.95 pt cost, measured −1.75 pt adverse drift on losers (default).
 *
 * NOT modeled (documented gaps): news blackouts, operator overrides /
 * ticket veto, the EXP retrace-arm limit fill, the open family (separate
 * $170 budget — see PLAYBOOK), size tiers (OFF live).
 *
 * Sections: per family (MOM flush · EXP · RTH market 0.75R), the RTH
 * live limit bracket (0.5× stop / 2.5R, TTL-5 limit fill, rthLimit-
 * Validation model), and the combined POOL (all families interleaved —
 * the day plan actually trades the pool together).
 *
 *   node --import ../scripts/ts-loader.mjs scripts/kellySizingStudy.ts \
 *     [--offline] [--max N] [--cost 0.95] [--drift none|losers|all]
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, midOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount, accountLine, type DollarizedTrade } from "../lib/propAccount";
import { dollarizeKelly, KELLY_DEFAULTS, type KellyConfig, type KellyPrior } from "../lib/kelly";
import { guardReplay } from "../lib/guardReplay";
import { scoreTrade, coreStats, propViability, renderT1, renderT4, renderVerdict } from "../lib/backtestEngine";

const SPLIT = "2026-01-01";
const PRIOR_STRENGTH = 40; // virtual trades seeded from the train window
const DRIFT_PTS = 1.75; // measured median adverse fill drift on losers

/* ---------------- replays ---------------- */

type Trade = { date: string; idx: number; pnlPts: number; riskPts: number; family: string };

function replayStructural(minutes: MomMinute[], sigs: MomentumSignal[], family: string, targetR: number, cost: number, drift: string): Trade[] {
  const out: Trade[] = [];
  for (const s of sigs) {
    const dir = s.dir === "long" ? 1 : -1;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk > 0)) continue;
    // consolidated engine scorer: stop-first, `cost` pts, 60-bar time exit
    // (closeOf midpoint fallback), last-bar signals dropped — identical to
    // the former local loop. Drift is applied post-scoring (as before).
    const sc = scoreTrade(
      minutes,
      { dir, entry: s.entry, stop: s.stop, target: s.entry + dir * risk * targetR, entryIdx: s.entryIdx, risk },
      { costPts: cost, holdBars: 60 },
    );
    if (!sc) continue;
    let pnl = sc.pnl;
    if (drift === "all") pnl -= DRIFT_PTS;
    else if (drift === "losers" && pnl < 0) pnl -= DRIFT_PTS;
    out.push({ date: s.d, idx: s.entryIdx, pnlPts: pnl, riskPts: risk, family });
  }
  return out;
}

/** the RTH live limit bracket (rthLimitValidation model): resting limit at
 *  the signal price, fill-or-expire TTL 5 bars, 0.5× stop, 2.5R target,
 *  $1.90/RT fees (folded to 0.95 pt), limits fill at/better (no drift). */
function replayRthLimit(minutes: MomMinute[], sigs: MomentumSignal[], cost: number): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  const TTL = 5;
  for (const s of sigs) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const risk = s.risk * 0.5;
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * 2.5;
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + TTL);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= s.entry : b.high >= s.entry) {
        fillBar = j;
        const open = b.o > 0 ? b.o : midOf(b);
        fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
        break;
      }
    }
    if (fillBar < 0) continue;
    const end = Math.min(minutes.length - 1, s.entryIdx + 60);
    let exit = closeOf(minutes[end]);
    for (let j = fillBar + 1; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) { exit = stop; break; }
      if (dir > 0 ? b.high >= target : b.low <= target) { exit = target; break; }
    }
    out.push({ date: s.d, idx: s.entryIdx, pnlPts: (exit - fill) * dir - 0.95, riskPts: risk, family: "rth" });
    openUntil = s.entryIdx + 60;
  }
  void cost;
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

function priorFrom(train: Trade[]): KellyPrior {
  const wins = train.filter((t) => t.pnlPts > 0);
  const losses = train.filter((t) => t.pnlPts < 0);
  const dec = wins.length + losses.length;
  const wr = dec ? wins.length / dec : 0.5;
  const winR = wins.length ? wins.reduce((a, t) => a + t.pnlPts / t.riskPts, 0) / wins.length : 1;
  const lossR = losses.length ? losses.reduce((a, t) => a + -t.pnlPts / t.riskPts, 0) / losses.length : 1;
  return { wins: wr * PRIOR_STRENGTH, losses: (1 - wr) * PRIOR_STRENGTH, winR, lossR };
}

/* ---------------- runner ---------------- */

type Config = { label: string; size: (tt: Trade[]) => DollarizedTrade[] };

function configsFor(priors: Record<string, KellyPrior>): Config[] {
  const priorFor = (fam: string): KellyPrior => priors[fam] ?? priors.default;
  /* owner sizing rule (2026-10-17): any positive Kelly size below one micro
   * is floored to 1 contract (momentumSize's max(1, raw)); the per-trade
   * contract cap is 10 micros (maxMicro: 10); stand-aside (0 contracts)
   * still applies only when the measured edge is gone (f ≤ 0). */
  const MICRO_CAP = 10;
  const mk = (label: string, kellyMult: number, maxRisk: number): Config => ({
    label,
    size: (tt) =>
      dollarizeKelly(
        tt,
        (fam) => ({ ...KELLY_DEFAULTS, kellyMult, maxRisk, prior: priorFor(fam) }),
        { maxMicro: MICRO_CAP, pointValue: 2 },
      ),
  });
  return [
    { label: "flat $100", size: (tt) => dollarize(tt.map((t) => ({ date: t.date, pnlPts: t.pnlPts, riskPts: t.riskPts }))) },
    mk("kelly m0.25 cap100 μ10", 0.25, 100),
    mk("kelly m0.35 cap100 μ10", 0.35, 100),
    mk("kelly m0.5  cap100 μ10", 0.5, 100),
    mk("kelly m0.75 cap100 μ10", 0.75, 100),
    mk("kelly m1.0  cap100 μ10", 1.0, 100),
  ];
}

function riskDiagnostics(kd: DollarizedTrade[], cfg: { maxRisk?: number; minRisk?: number }): { meanRisk: number; capHit: number; floorHit: number } {
  const risks = kd.map((t) => (t.contracts === 0 ? 0 : t.contracts * t.riskPts * 2));
  const traded = risks.filter((r) => r > 0);
  const meanRisk = traded.length ? traded.reduce((a, r) => a + r, 0) / traded.length : 0;
  const capHit = traded.filter((r) => Math.abs(r - (cfg.maxRisk ?? 150)) < 1).length;
  const floorHit = traded.filter((r) => Math.abs(r - (cfg.minRisk ?? 25)) < 1).length;
  return { meanRisk, capHit, floorHit };
}

function runSection(title: string, tt: Trade[], priors: Record<string, KellyPrior>, drift: string) {
  const st = stats(tt);
  const p0 = priors.default;
  console.log(`${title} — n=${st.n} · WR ${st.wr.toFixed(1)}% · PF ${st.pf.toFixed(2)} · ${st.net.toFixed(0)} pts · prior(train) WR ${((p0.wins / (p0.wins + p0.losses)) * 100).toFixed(1)}% · winR ${p0.winR.toFixed(2)} · lossR ${p0.lossR.toFixed(2)} · drift ${drift}`);
  for (const cfg of configsFor(priors)) {
    const kd = cfg.size(tt);
    const diag = riskDiagnostics(kd, {});
    for (const stage of ["eval", "funded"] as const) {
      const g = guardReplay(kd, stage);
      const acc = simulateAccount(g.rows, stage);
      const h = g.stats.halts;
      const halts = `halts: floor ${h.loss} · arm ${h.profit} · gb ${h.giveback} · cons ${h.consistency} · margin ${h.margin} · target ${h.target}`;
      const risk = `meanR $${diag.meanRisk.toFixed(0)} · cap ${diag.capHit} · floor ${diag.floorHit} · skips ${g.stats.standAsides} · traded ${g.stats.traded}`;
      const dd = `worstDay $${g.stats.worstDayUsd.toFixed(0)} · maxDD $${g.stats.maxDdUsd.toFixed(0)} · redDays ${g.stats.longestRedDays} · loseStreak ${g.stats.longestLoseStreak}`;
      console.log(`  ${(cfg.label + " · " + stage).padEnd(24)} ${accountLine(acc).padEnd(52)} | ${risk} | ${dd} | ${halts}`);
    }
  }
  console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const offline = argv.includes("--offline");
  const costArg = argv.indexOf("--cost");
  const cost = costArg >= 0 ? Number(argv[costArg + 1]) : 0.95;
  const driftArg = argv.indexOf("--drift");
  const drift = driftArg >= 0 ? (["none", "losers", "all"].includes(argv[driftArg + 1]) ? argv[driftArg + 1] : "losers") : "losers";
  const maxArg = argv.indexOf("--max");
  const max = maxArg >= 0 ? Number(argv[maxArg + 1]) : undefined;

  let dates = await archiveDates(offline ? { source: "manifest" } : {});
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (max) dates = dates.slice(0, max);
  console.log(`kelly sizing study · ${dates.length} sessions · cost ${cost}pt · drift ${drift} (${DRIFT_PTS}pt) · full day-plan guard stack + MFF sim`);

  const fams = {
    MOM: { family: "failed_flush_breakout", detect: detectMomentum, tR: 1 },
    EXP: { family: "huge_bar_expansion", detect: detectExpansionScalp, tR: 1 },
    RTH: { family: "rth", detect: detectSoftMomentum, tR: 0.75 },
  };

  const sessions: { date: string; minutes: MomMinute[]; sigs: Record<string, MomentumSignal[]> }[] = [];
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + 8);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs: Record<string, MomentumSignal[]> = {
        MOM: detectMomentum(minutes, MOM_PROD),
        EXP: detectExpansionScalp(minutes, EXP_PROD),
        RTH: detectSoftMomentum(minutes, SOFT_PROD),
      };
      sessions.push({ date, minutes, sigs });
    }
    i += 8;
  }
  console.log(`  ${sessions.length} sessions loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  for (const [name, f] of Object.entries(fams)) {
    const all: Trade[] = [];
    for (const s of sessions) all.push(...replayStructural(s.minutes, s.sigs[name], f.family, f.tR, cost, drift));
    runSection(`=== ${name} (${f.family}, ${f.tR}R structural)`, all, { default: priorFrom(all.filter((t) => t.date < SPLIT)) }, drift);
  }

  // RTH live limit bracket (the LIVE card's actual mechanics)
  {
    const all: Trade[] = [];
    for (const s of sessions) all.push(...replayRthLimit(s.minutes, s.sigs.RTH, cost));
    runSection(`=== RTH LIVE LIMIT bracket (0.5× stop · 2.5R · TTL5 fill)`, all, { default: priorFrom(all.filter((t) => t.date < SPLIT)) }, drift);
  }

  // POOL — the day plan trades all families together, interleaved per session
  {
    const pool: Trade[] = [];
    for (const s of sessions) {
      const merged: Trade[] = [
        ...replayStructural(s.minutes, s.sigs.MOM, "failed_flush_breakout", 1, cost, drift),
        ...replayStructural(s.minutes, s.sigs.EXP, "huge_bar_expansion", 1, cost, drift),
        ...replayStructural(s.minutes, s.sigs.RTH, "rth", 0.75, cost, drift),
      ].sort((a, b) => a.idx - b.idx);
      pool.push(...merged);
    }
    const train = pool.filter((t) => t.date < SPLIT);
    const priors: Record<string, KellyPrior> = { default: priorFrom(train) };
    for (const [name, f] of Object.entries(fams)) {
      priors[f.family] = priorFrom(train.filter((t) => t.family === f.family));
    }
    runSection(`=== POOL (MOM + EXP + RTH interleaved)`, pool, priors, drift);

    /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
     * Primary cohort = the POOL (all families interleaved; pnl carries cost
     * 0.95pt + the −1.75pt loser drift). The legacy stats() above uses a
     * "decided" WR denominator (wins+losses, pnl===0 excluded) and its
     * replayRthLimit is a resting-limit fill (TTL 5), so both stay untouched;
     * the engine rows use the standard n denominator. The per-config lines
     * are account-sim rows, not trade cells, so no T2. ---- */
    const splitDate = SPLIT;
    const engineTrades = pool.map((t) => ({ date: t.date, pnl: t.pnlPts, risk: t.riskPts }));
    console.log("\n=== STANDARD REPORT ===");
    console.log(renderT1([
      { label: "all", stats: coreStats(engineTrades) },
      { label: "train", stats: coreStats(engineTrades.filter((t) => t.date < splitDate)) },
      { label: "test", stats: coreStats(engineTrades.filter((t) => t.date >= splitDate)) },
    ]));
    const viability = propViability(engineTrades, { splitDate });
    console.log("\n" + renderT4(viability));
    const trainStats = coreStats(engineTrades.filter((t) => t.date < splitDate));
    const testStats = coreStats(engineTrades.filter((t) => t.date >= splitDate));
    console.log(
      "\n" +
        renderVerdict({
          edge: testStats.netPts > 0 && testStats.expR > 0 ? "real" : "absent",
          significance: "—",
          stability: `train/test WR gap ${(trainStats.wr - testStats.wr).toFixed(1)} pts`,
          holdout: "n/a (validation pipeline)",
          viability:
            viability.pPass === null
              ? "n/a"
              : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
        }),
    );
  }
}

void main();
