import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";
import { BestConfigsTable } from "@/components/studies/BestConfigsTable";

/** Risk → Studies: full inline content of the risk & sizing studies. */
export default function RiskStudiesPage() {
  return (
    <StageLayout
      base="/risk"
      kicker="risk · studies"
      title="The protection math's evidence"
      intro={<>Full content of every risk/sizing study — stops, caps, Kelly, prop-plan survival.</>}
    >
      <BestConfigsTable studyIds={["sizing-optimizer"]} compact />
      <StudyPane categories={["risk"]} />
    </StageLayout>
  );
}
