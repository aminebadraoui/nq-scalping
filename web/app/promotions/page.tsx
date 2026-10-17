import type { Metadata } from "next";
import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { PromotionBoard } from "@/components/promotions/PromotionBoard";

export const metadata: Metadata = {
  title: "Promotions",
  description:
    "The backtest→production promotion pipeline state: every study's contract verdict (promoted / rejected with reasons), the live override rows, and the Kelly sizing state — read live from the server.",
};

/** PROMOTIONS — the promotion pipeline state, always in sync with the
 *  server: the study catalog × the promotion_runs ledger (every verdict,
 *  pass AND reject) × active strategy_overrides × the Kelly knobs. */
export default function PromotionsPage() {
  return (
    <StageLayout
      base="/promotions"
      kicker="promotions · backtest → production"
      title="What got promoted, what failed promotion, and why"
      intro={
        <>
          The direct path between a backtest and a live gate. Every candidate passes through the{" "}
          <strong className="text-zinc-200">promotion contract</strong> (suppressive gates only, sample floors, the
          cost-bar veto standard, the 30% veto budget, DSR ≥ 0.95 / PBO ≤ 0.20 on grids) — and every verdict,{" "}
          <em>including rejections</em>, is recorded to the ledger below. The surface polls the server every 15
          seconds: what you see here is the database&apos;s state, not a snapshot. The gate inventory lives on{" "}
          <Link href="/gates" className="text-long hover:underline">
            /gates
          </Link>
          , the studies themselves on{" "}
          <Link href="/studies" className="text-long hover:underline">
            /studies
          </Link>
          .
        </>
      }
    >
      <PromotionBoard />
    </StageLayout>
  );
}
