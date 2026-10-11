import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { RuleBoard } from "@/components/RuleBoard";
import { GATES, type GateGroup } from "@/lib/gates/inventory";

const GROUP_ORDER: GateGroup[] = ["regime", "session", "card"];
const GROUP_LABEL: Record<GateGroup, string> = {
  regime: "regime — the environment a strategy lives in",
  session: "session rules",
  card: "card-level vetoes",
  account: "account halts (shown on /risk)",
};

/** GATES — the regime layer. Live: the server's current session + card
 *  rules, plus the full gate inventory (what each gate decides, where it
 *  lives, and its knob). Backtest/Studies: the gate studies. */
export default function GatesPage() {
  return (
    <StageLayout
      base="/gates"
      kicker="gates · the regime layer"
      title="When and where a strategy is allowed to execute"
      intro={
        <>
          A gate decides the <strong className="text-zinc-200">regime</strong> in which a strategy may fire — signal
          windows, feed and tape confirmation, news blackouts, family switches, counter-gates, self-improvement
          overrides, vetoes. It is the layer between a signal and a ticket. The <em>account</em> protections
          (floor, target, consistency, day plan) are risk, not gates — they live on{" "}
          <Link href="/risk" className="text-long hover:underline">/risk</Link>. Live state below is read from this
          server right now; the inventory lists every gate with its code location and knob.
        </>
      }
    >
      <RuleBoard groups={["session", "card"]} title="live gates — session + card rules (from the running server)" />

      <section className="mb-8">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">the gate inventory</h2>
        <div className="space-y-6">
          {GROUP_ORDER.map((g) => {
            const list = GATES.filter((x) => x.group === g);
            if (!list.length) return null;
            return (
              <div key={g}>
                <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-600">{GROUP_LABEL[g]}</h3>
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-3 py-2">gate</th>
                        <th className="px-3 py-2">what it decides</th>
                        <th className="px-3 py-2">where</th>
                        <th className="px-3 py-2">knob</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((x) => (
                        <tr key={x.id} className="border-t border-zinc-800/70 align-top">
                          <td className="px-3 py-2 font-mono text-xs text-zinc-200 whitespace-nowrap">{x.name}</td>
                          <td className="px-3 py-2 text-xs leading-relaxed text-zinc-400">{x.decides}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-zinc-500">{x.where}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-zinc-500 whitespace-nowrap">{x.knob}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </StageLayout>
  );
}
