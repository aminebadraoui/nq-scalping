/* ------------------------------------------------------------------ *
 * FILL-MODEL AUDIT (2026-10-08) — every live family replayed with
 * honest fills on BOTH sides.
 *
 * The RTH reckoning showed the codebase never modeled stop-out
 * slippage. This audit gives every other live family the same
 * treatment, mirroring LIVE execution mechanics:
 *
 *   momentum  (failed-flush breakout / huge-bar expansion, market):
 *     fill at the next bar's OPEN, brackets at the SIGNAL prices
 *     (absolute REST brackets — a drifted fill compresses the stop),
 *     then the LIVE fill-anchored RE-BRACKET when the compression
 *     drops below half the planned risk (crossTrade.reanchorBracketForFill
 *     — modeled since 2026-10-12), instant −0.5 OCO when the fill lands
 *     beyond the target, no time exit (trade runs to stop/target),
 *     $100 budget sizing.
 *   expansion retrace (limit): armed 1 pt behind the huge-bar close AT
 *     THE BROKER when the card fires (the live path since 2026-10-12 —
 *     the faithful 0.0-pt cell of retraceSlippageStudy), fill at the
 *     limit or better within 5 bars (gap-through = the bar's open),
 *     brackets rebuilt FROM THE FILL (1R), $100 budget.
 *   open drive (market at the open): fill at the next bar's open,
 *     brackets at the signal prices (TP15/SL35 style), $100 budget.
 *
 * FILL MODEL DECLARED ON BOTH SIDES: entry = limit-or-better / open
 * market fill with the live re-bracket; exit = stop PRICE (slip=N) or
 * the stop-market chase model (slip=Y). The live 60s flat-entry latch
 * is a same-bar refusal at minute granularity — replay cannot express
 * two entries in one bar, so the latch is a no-op here and NOT modeled.
 * The live time-exit profiles are OFF → the honest horizon is
 * Infinity; 60 bars is kept for comparison against the published
 * studies.
 *
 * Run from web/ (env GC_REMOTE_URL):
 *   node --import ../scripts/ts-loader.mjs ./scripts/fillAudit.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute } from "../lib/momentum";
import { detectMomentum, MOM_PROD, detectExpansionScalp, EXP_PROD, type MomentumSignal } from "../lib/momentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { coreStats, wilson95, propViability, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const FEE_RT = 1.9;
const RISK_BUDGET = 100;
const MAX_CONTRACTS = 30;
const RETRACE_PTS = 1; // the live EXP_RETRACE_PTS
const RETRACE_BARS = 5; // the live EXP_RETRACE_BARS

type Family = "momentum" | "expansion" | "open";
type Trade = { date: string; pnl: number; risk: number };

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

/** first-touch stop/target scan from a fill; the stop-out exit fills at
 *  the trigger (slip=N) or chases the flush to the bar close (slip=Y,
 *  optionally capped). */
function scoreFromFill(
  minutes: MomMinute[],
  fill: number,
  startIdx: number,
  stop: number,
  target: number,
  dir: number,
  slip: boolean,
  slipCap = Infinity,
  horizonBars = Infinity,
): number | null {
  const end = Math.min(minutes.length - 1, horizonBars === Infinity ? minutes.length - 1 : startIdx - 1 + horizonBars); // no time exit vs a bar-based one
  let exit = closeOf(minutes[end]);
  for (let j = Math.max(startIdx, 0); j <= end; j++) {
    const b = minutes[j];
    if (dir > 0 ? b.low <= stop : b.high >= stop) {
      if (slip) {
        const worst = dir > 0 ? Math.min(stop, closeOf(b)) : Math.max(stop, closeOf(b));
        exit = dir > 0 ? Math.max(stop - slipCap, worst) : Math.min(stop + slipCap, worst);
      } else exit = stop;
      break;
    }
    if (dir > 0 ? b.high >= target : b.low <= target) {
      exit = target;
      break;
    }
  }
  return (exit - fill) * dir;
}

function scoreFamily(minutes: MomMinute[], sigs: MomentumSignal[], date: string, family: Family, slip: boolean, slipCap = Infinity, entryLag: "close" | "open" = "open", horizonBars = Infinity): Trade[] {
  const out: Trade[] = [];
  for (const s of sigs) {
    const dir = s.dir === "long" ? 1 : -1;
    if (!(s.risk > 0)) continue;

    if (family === "expansion") {
      // retrace limit: 1 pt behind the close, fill-or-expire within 5 bars
      const limit = s.entry - dir * RETRACE_PTS;
      const endTtl = Math.min(minutes.length - 1, s.entryIdx + RETRACE_BARS);
      let fillBar = -1;
      let fill = 0;
      for (let j = s.entryIdx + 1; j <= endTtl; j++) {
        const b = minutes[j];
        const touched = dir > 0 ? b.low <= limit : b.high >= limit;
        if (!touched) continue;
        fillBar = j;
        const open = openOf(b);
        fill = dir > 0 ? Math.min(open, limit) : Math.max(open, limit); // limit-or-better on gap-through
        break;
      }
      if (fillBar < 0) continue;
      const risk = Math.abs(s.entry - s.stop); // structural distance, rebuilt from the fill
      const stop = fill - dir * risk;
      const target = fill + dir * risk;
      const pnl = scoreFromFill(minutes, fill, fillBar + 1, stop, target, dir, slip, slipCap, horizonBars);
      if (pnl === null) continue;
      out.push({ date, pnl, risk });
      continue;
    }

    // momentum + open: market fill at the next bar's open (1-min lag
    // proxy) or at the signal close (≈0 lag — the immediate-dispatch
    // bound; the live truth sits between them), brackets at the SIGNAL
    // prices (live absolute REST brackets)
    const nb = minutes[s.entryIdx + 1];
    if (!nb) continue;
    const fill = entryLag === "close" ? s.entry : openOf(nb);
    let stop = s.stop;
    let target = s.target;
    if (!(dir > 0 ? stop < s.entry && s.entry < target : target < s.entry && s.entry < stop)) continue;
    // fill-anchored RE-BRACKET (2026-10-12): the live burst verifier
    // re-anchors a drifted fill whose signal-anchored stop compressed
    // below half the planned risk (lib/crossTrade.ts reanchorBracketForFill
    // + burstPollOnce) — the trade then carries the PLANNED risk from the
    // fill. The old model scored the compressed stop as if the repair
    // didn't exist and overstated the damage of every drifted fill.
    const drift = (fill - s.entry) * dir;
    if (drift < 0) {
      const compressed = Math.abs(fill - stop);
      if (compressed < 0.5 * s.risk) {
        stop = fill - dir * s.risk;
        target = fill + dir * s.risk;
      }
    }
    // fill beyond the absolute target → instant OCO (the live drift case)
    const beyondTarget = dir > 0 ? fill >= target : fill <= target;
    const pnl = beyondTarget ? -0.5 : scoreFromFill(minutes, fill, s.entryIdx + 2, stop, target, dir, slip, slipCap, horizonBars);
    if (pnl === null) continue;
    out.push({ date, pnl, risk: s.risk });
  }
  return out;
}

function usdSim(trades: Trade[]) {
  const rows = trades.map((t) => {
    const contracts = Math.max(1, Math.min(MAX_CONTRACTS, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnl, riskPts: t.risk, pnlUsd: t.pnl * contracts * 2 - contracts * FEE_RT };
  });
  const d = dollarize(rows.map((r) => ({ date: r.date, pnlPts: r.pnlPts, riskPts: r.riskPts })));
  const acc = simulateAccount(d, "eval");
  const netUsd = rows.reduce((a, r) => a + r.pnlUsd, 0);
  let peak = 0;
  let maxDD = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  return { netUsd, maxDD, passed: acc.breachDay === null };
}

async function main() {
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const families: Family[] = ["momentum", "expansion", "open"];
  const slips = [false, true];
  const lags: Array<"close" | "open"> = ["open", "close"];
  const horizons: Array<number> = [Infinity, 60]; // session-end (live: no time exit) vs the published studies' 60-bar exit
  const buckets = new Map<string, Trade[]>();
  for (const f of families)
    for (const slip of slips)
      for (const lag of f === "expansion" ? (["open"] as const) : lags)
        for (const h of horizons) buckets.set(`${f}|${slip}|${lag}|${h}`, []);

  console.log(`replaying ${dates.length} sessions × ${families.length} families × 2 slip models…`);
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const mom = detectMomentum(minutes, MOM_PROD);
      const exp = detectExpansionScalp(minutes, EXP_PROD);
      const open = detectOpenDrive(minutes, OPEN_PROD);
      const byFamily: Record<Family, MomentumSignal[]> = { momentum: mom, expansion: exp, open };
      for (const f of families) {
        for (const slip of slips) {
          for (const lag of f === "expansion" ? (["open"] as const) : lags) {
            for (const h of horizons) {
              buckets.get(`${f}|${slip}|${lag}|${h}`)!.push(...scoreFamily(minutes, byFamily[f], date, f, slip, Infinity, lag, h));
            }
          }
        }
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  console.log("=== FILL-MODEL AUDIT: every live family, honest fills both sides ===");
  console.log("$100 budget · $1.90/RT · eval sim · slip=N = old assumption (stops at trigger) · slip=Y = stop-market chases the bar close");
  console.log(`${"family".padEnd(10)} ${"entry".padEnd(6)} ${"slip".padEnd(5)} ${"exit".padEnd(8)} ${"n".padStart(6)} ${"WR".padStart(7)} ${"PF".padStart(6)} ${"net$".padStart(10)} ${"dd$".padStart(9)}  verdict`);
  for (const f of families) {
    for (const lag of f === "expansion" ? (["open"] as const) : lags) {
      for (const h of horizons) {
        for (const slip of slips) {
          const ts = buckets.get(`${f}|${slip}|${lag}|${h}`)!;
          const st = coreStats(ts); // wins pnl>0 · pf gw/gl — identical formulas
          const sm = usdSim(ts);
          console.log(
            `${f.padEnd(10)} ${lag.padEnd(6)} ${(slip ? "Y" : "N").padEnd(5)} ${(h === Infinity ? "session" : String(h) + " bars").padEnd(8)} ${String(st.n).padStart(6)} ${st.wr.toFixed(1).padStart(6)}% ${(Number.isFinite(st.pf) ? st.pf.toFixed(2) : "∞").padStart(6)} ${String(Math.round(sm.netUsd)).padStart(10)} ${String(Math.round(sm.maxDD)).padStart(9)}  ${sm.passed ? "PASS" : "BREACH"}`,
          );
        }
      }
    }
  }

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * primary cohort = momentum · slip=Y (the honest stop-out model) ·
   * open-lag market fill · session horizon. Note: this study's pnl pts
   * exclude the round-trip cost (fees are applied as $1.90/RT in the USD
   * sim), so T1/T4 numbers here are pre-cost pts. No train/test split. ---- */
  const primary = buckets.get("momentum|true|open|Infinity")!;
  const engineTrades = primary.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  const allStats = coreStats(engineTrades);
  console.log("\n=== STANDARD REPORT ===");
  console.log(renderT1([{ label: "all", stats: allStats }]));
  const cells: { rule: string; trades: Trade[]; opp: Trade[] | null }[] = [];
  for (const f of families) {
    for (const lag of f === "expansion" ? (["open"] as const) : lags) {
      for (const h of horizons) {
        for (const slip of slips) {
          cells.push({
            rule: `${f} ${lag} slip=${slip ? "Y" : "N"} ${h === Infinity ? "session" : h + "b"}`,
            trades: buckets.get(`${f}|${slip}|${lag}|${h}`)!,
            opp: buckets.get(`${f}|${!slip}|${lag}|${h}`)!,
          });
        }
      }
    }
  }
  console.log(
    "\n" +
      renderT2(
        cells.map((c) => {
          const st = coreStats(c.trades);
          const opp = coreStats(c.opp ?? []);
          return {
            rule: c.rule,
            n: st.n,
            wr: st.wr,
            ci: wilson95(st.wins, st.n),
            pf: st.pf,
            expPts: st.expPts,
            compare: `opposite slip WR ${opp.wr.toFixed(0)}%`,
          };
        }),
      ),
  );
  const viability = propViability(engineTrades);
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: allStats.netPts > 0 && allStats.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: "—",
        holdout: "n/a (validation pipeline)",
        viability:
          viability.pPass === null
            ? "n/a"
            : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
