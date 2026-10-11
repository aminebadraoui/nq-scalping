import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { StudyPane } from "@/components/stage/StudyPane";

/** Risk → Backtest: the risk studies + the risk research CLIs. */
export default function RiskBacktestPage() {
  return (
    <StageLayout
      base="/risk"
      kicker="risk · backtest"
      title="What the protection math measures"
      intro={
        <>
          Every study that replayed the account — stop sweeps, sizing, the day plan, prop viability — plus the
          research CLIs that run against the realized trade record. The full sweep surface (walk-forward grids,
          overfit audit) is the{" "}
          <Link href="/strategies/backtest" className="text-long hover:underline">strategies backtest</Link>.
        </>
      }
    >
      <StudyPane categories={["risk"]} compact />

      <section className="mt-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">risk research CLIs</p>
        <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950/80 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
{`$ cd web
$ node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/riskStackStudy.ts --offline   # full-stack sim, all families + MFF rules
$ node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/capacityTable.ts              # contracts ceiling per family
$ node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/breadthAudit.ts               # effective independent bets per family
$ node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/fdrLedger.ts                  # false-discovery ledger`}
        </pre>
      </section>
    </StageLayout>
  );
}
