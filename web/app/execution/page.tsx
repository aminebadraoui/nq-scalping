import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import ExecLogPanel from "@/components/ExecLogPanel";

/** EXECUTION — Live: the executor's own records. Account controls
 *  (account switch, kill switch) live on the dashboard's status bar. */
export default function ExecutionPage() {
  return (
    <StageLayout
      base="/execution"
      kicker="execution · the order path"
      title="What the executor actually did"
      intro={
        <>
          The execution stage turns a passed ticket into a filled, bracketed, tracked position: guard check → REST
          placement → burst bracket verification → fill re-anchor → tracking (verified re-send, give-up) → close
          (OSO, runner ladder, time exit, naked-position repair). The log below is the executor&apos;s own record —
          written on every order attempt, read back here. Account switching and the kill switch live on the{" "}
          <Link href="/" className="text-long hover:underline">dashboard</Link> status bar.
        </>
      }
    >
      <ExecLogPanel />
    </StageLayout>
  );
}
