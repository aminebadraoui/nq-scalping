import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";

/** Gates → Studies: full inline content of the gate studies. */
export default function GatesStudiesPage() {
  return (
    <StageLayout
      base="/gates"
      kicker="gates · studies"
      title="The regime layer's evidence"
      intro={<>Full content of every gate study — question, method, tables, falsified hypotheses, honest bounds.</>}
    >
      <BestConfigsTable studyIds={[]} compact />
      <StudyPane categories={["gates"]} />
    </StageLayout>
  );
}
