import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";

/** Risk → Studies: full inline content of the risk & sizing studies. */
export default function RiskStudiesPage() {
  return (
    <StageLayout
      base="/risk"
      kicker="risk · studies"
      title="The protection math's evidence"
      intro={<>Full content of every risk/sizing study — stops, caps, Kelly, prop-plan survival.</>}
    >
      <StudyPane categories={["risk"]} />
    </StageLayout>
  );
}
