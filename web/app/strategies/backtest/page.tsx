import { StageLayout } from "@/components/stage/StageLayout";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";
import BacktestView from "@/components/backtest/BacktestView";

const STRATEGY_BEST: string[] = ["momentum-study", "expansion-study", "rth-optimizer", "side-filter-study", "seasonal-almanac", "bias-time-of-day"];

/** Strategies → Backtest: the full walk-forward sweep + overfit audit. */
export default function StrategiesBacktestPage() {
  return (
    <StageLayout
      base="/strategies"
      kicker="strategies · backtest"
      title="Walk-forward threshold sweeps + overfit audit"
      intro={
        <>
          The offline sweep surface: threshold grids per session window, the standard T1/T4 report, DSR/PBO/PSR
          audit cards, and the trial ledger. Sweeps are points-level research input — the validated pick is the
          coordinate that survives DSR/PBO and the frozen holdout, not the argmax.
        </>
      }
    >
      <BestConfigsTable studyIds={STRATEGY_BEST} compact />
      <BacktestView />
    </StageLayout>
  );
}
