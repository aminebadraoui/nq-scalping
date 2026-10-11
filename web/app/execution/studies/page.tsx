import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";

/** Execution → Studies: full inline content of the fill-model studies. */
export default function ExecutionStudiesPage() {
  return (
    <StageLayout
      base="/execution"
      kicker="execution · studies"
      title="The fill model's evidence"
      intro={<>Full content of every execution/fill study — slippage, drift, limit entries, incidents.</>}
    >
      <BestConfigsTable studyIds={[]} compact />
      <StudyPane categories={["execution"]} />
    </StageLayout>
  );
}
