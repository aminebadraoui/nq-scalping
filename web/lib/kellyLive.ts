/* ------------------------------------------------------------------ *
 * Kelly live estimator — the self-updating edge book for trade cards.
 *
 * Folds the last KELLY_WINDOW decided outcomes for a family (signals
 * table, features->>'family') into the SAME shrunken estimator that
 * lib/kelly.ts uses in backtests — one book, two consumers, so the
 * chip on a live card and the sizing in a replay can never disagree.
 *
 * Purely observational: signalFeed prints a KELLY chip and stores the
 * numbers in features jsonb. Sizing follows the Kelly risk only when
 * BOTH KELLY_MODE=1 and KELLY_LIVE_USE=1 (the live-use switch is OFF
 * by default and is a rule-4 env approval, not a code path).
 *
 * Best-effort by design: any DB hiccup returns null and the card falls
 * back to the flat day plan.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { withTimeout } from "./asyncTimeout";
import {
  KELLY_DEFAULTS,
  KELLY_PRIORS,
  applyKellyOutcome,
  kellyEnvOverrides,
  kellyEstimate,
  type KellyConfig,
  type KellyEstimate,
  type KellyFamilyState,
} from "./kelly";

export type KellyChip = KellyEstimate & {
  family: string;
  /** rows examined (decided trades + anything filtered out) */
  window: number;
  /** the playbook prior win rate the estimate shrinks toward */
  priorWr: number;
};

/** one-line card text for the chip (journal-only context) */
export function kellyChipLabel(c: KellyChip): string {
  const wr = Math.round(c.p * 100);
  const risk = Math.round(c.risk);
  const stand = c.skip ? " · stand-aside" : "";
  return `KELLY ${c.n}t ${wr}% → $${risk}${stand}`;
}

/**
 * The self-updating live estimate for one card family. Reads the most
 * recent decided outcomes from the signals table, folds them into the
 * family's shrunken state, and returns the chip. `flatRisk` anchors the
 * ratio to the card's actual budget (defaults to the $100 day plan).
 */
export async function kellyLiveChip(
  family: string,
  cfgOver: Partial<KellyConfig> = {},
): Promise<KellyChip | null> {
  if (!dbEnabled()) return null;
  const window = Math.max(10, Number(process.env.KELLY_WINDOW) || 60);
  const prior = KELLY_PRIORS[family] ?? KELLY_PRIORS.default;
  const cfg: KellyConfig = { ...KELLY_DEFAULTS, ...kellyEnvOverrides(), ...cfgOver, prior };
  try {
    const rows = (await withTimeout(
      getDb()`
      select side, entry, stop, exit_price, outcome
      from signals
      where source = 'live' and test = false
        and outcome in ('win','loss','time')
        and exit_price is not null
        and features->>'family' = ${family}
      order by ts desc
      limit ${window}
    `,
      3_000,
      "kelly live chip",
    )) as unknown as { side: string; entry: string; stop: string; exit_price: string | number }[];

    const st: KellyFamilyState = { wins: 0, losses: 0, sumWinR: 0, sumLossR: 0 };
    for (const r of rows) {
      const entry = parseFloat(r.entry);
      const stop = parseFloat(r.stop);
      const exit = Number(r.exit_price);
      const sign = r.side === "long" ? 1 : -1;
      if (![entry, stop, exit].every(Number.isFinite)) continue;
      const riskPts = Math.abs(entry - stop);
      if (!(riskPts > 0)) continue;
      applyKellyOutcome(st, (exit - entry) * sign, riskPts);
    }
    const est = kellyEstimate(st, cfg);
    return {
      ...est,
      family,
      window: rows.length,
      priorWr: prior.wins / (prior.wins + prior.losses),
    };
  } catch {
    return null;
  }
}
