import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";

/** Execution → Backtest: execution is live-only; what backtests know
 *  about it is the FILL MODEL (slippage, drift, limit vs market). */
export default function ExecutionBacktestPage() {
  return (
    <StageLayout
      base="/execution"
      kicker="execution · backtest"
      title="The fill model — what backtests assume about execution"
      intro={
        <>
          Execution itself is live-only — backtests approximate it with a fill model (entry at the close, a constant
          round-trip cost, limit-fill rules). These studies measured the gap between that model and reality (measured
          live slippage 1–13 pts vs the 0.5 pt assumption) and validated the live entry mechanics. Honest label: this
          pane is fill-model research, not a backtested executor.
        </>
      }
    >
      <BestConfigsTable studyIds={[]} compact />
      <StudyPane categories={["execution"]} compact />
    </StageLayout>
  );
}
