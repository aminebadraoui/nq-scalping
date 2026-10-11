import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";

/** Strategies → Studies: the strategy-family studies with full content. */
export default function StrategiesStudiesPage() {
  return (
    <StageLayout
      base="/strategies"
      kicker="strategies · studies"
      title="What measured the strategies"
      intro={
        <>
          Full content of every strategy-family study (momentum, RTH, open, bias, retired reversal). The complete
          archive — including risk, gates, execution, validation and ops categories — is on the{" "}
          <Link href="/studies" className="text-long hover:underline">full studies page</Link>.
        </>
      }
    >
      <StudyPane categories={["momentum", "rth", "bias", "reversal"]} />
    </StageLayout>
  );
}
