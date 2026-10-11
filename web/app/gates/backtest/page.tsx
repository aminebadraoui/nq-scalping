import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";

/** Gates → Backtest: the gate studies as runnable cards (question + CLI).
 *  Full content lives under Studies. */
export default function GatesBacktestPage() {
  return (
    <StageLayout
      base="/gates"
      kicker="gates · backtest"
      title="What the regime layer measures"
      intro={
        <>
          Every gate study that measured a veto, filter, counter-gate, or the full rule stack — with its regeneration
          command. Each is a points-level or standard-report study over the 649-session archive; a gate only goes live
          through the EXEC_CHANGE_POLICY path.
        </>
      }
    >
      <BestConfigsTable studyIds={[]} compact />
      <StudyPane categories={["gates"]} compact />
    </StageLayout>
  );
}
