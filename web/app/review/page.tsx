import type { Metadata } from "next";
import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { WeeklyBoard } from "@/components/review/WeeklyBoard";

export const metadata: Metadata = {
  title: "Weekly Review",
  description:
    "The Saturday self-improvement loop: the closed week's rollup, the promotion-contract study verdicts, the backtest proposals to approve or reject, and the AI week narrative.",
};

/** REVIEW — the weekly self-improvement surface. Renders one
 *  weekly_reviews row (scripts/weeklyReview.ts, Sat 09:15 ET) with the
 *  week rollup, the promotion-contract verdicts (fail-closed), the
 *  approve/reject proposals, and the LLM narrative + next-week
 *  hypotheses. The system proposes; the promotion contract gates; the
 *  human approves — see docs/architecture/WEEKLY-REVIEW.md. */
export default function ReviewPage() {
  return (
    <StageLayout
      base="/review"
      kicker="review · weekly self-improvement"
      title="Every weekend, the system reviews the week and re-tests its own gates"
      intro={
        <>
          The Saturday job rolls up the trading week that just closed — realized trades, edge health, friction,
          vetoed cards — then re-runs the{" "}
          <Link href="/promotions" className="text-long hover:underline">
            promotion-contract
          </Link>{" "}
          studies against the frozen production stack and writes one review row per week. Verdicts fail closed: a
          rejected study writes nothing. The AI narrative proposes next week&apos;s experiments — the contract and
          the approve button decide. Design:{" "}
          <Link href="/docs" className="text-long hover:underline">
            docs/architecture/WEEKLY-REVIEW.md
          </Link>
          .
        </>
      }
    >
      <WeeklyBoard />
    </StageLayout>
  );
}
