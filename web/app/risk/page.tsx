import Link from "next/link";
import { StageLayout } from "@/components/stage/StageLayout";
import { RuleBoard } from "@/components/RuleBoard";
import { EVAL_RULES, FUNDED_RULES } from "@/lib/risk/challengeRules";
import { RAPID_EOD_50K, PROP_RISK_PER_TRADE } from "@/lib/propRules";

/** RISK — Live: the account-protection layer. One rule set on every
 *  stage (lib/risk/challengeRules.ts). */
export default function RiskPage() {
  return (
    <StageLayout
      base="/risk"
      kicker="risk · account protection"
      title="The layer that protects the account"
      intro={
        <>
          Account-level halts, checked before every order and fail-closed: MLL floor, profit target, consistency cap,
          daily loss floor, profit arm, give-back, dd600→half sizing. The same rules run on eval and funded — one
          source: <code className="text-zinc-300">lib/risk/challengeRules.ts</code>. The session/card vetoes are the{" "}
          <Link href="/gates" className="text-long hover:underline">gates</Link> layer.
        </>
      }
    >
      <RuleBoard groups={["account"]} title="live account halts (from the running server)" />

      <section className="mb-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">the challenge rules — same on every stage</p>
          <table className="w-full text-left text-xs">
            <tbody>
              {[
                ["max loss (EOD trailing)", `$${EVAL_RULES.maxLoss.toLocaleString()}`],
                ["profit target (halt)", `+$${EVAL_RULES.profitTarget.toLocaleString()} from start`],
                ["consistency cap", `+$${EVAL_RULES.consistencyCap}/day (every stage)`],
                ["min trading days (eval pass)", String(EVAL_RULES.minDays)],
                ["funded floor lock", `$${FUNDED_RULES.lockAt} (the $${FUNDED_RULES.buffer.toLocaleString()} buffer moment)`],
                ["first payout buffer", `$${FUNDED_RULES.buffer.toLocaleString()}`],
                ["payout step / split", `+$${FUNDED_RULES.payoutStep} · ${FUNDED_RULES.split * 100}%`],
              ].map(([k, v]) => (
                <tr key={k} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-400">{k}</td>
                  <td className="py-1.5 font-mono text-zinc-200">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">sizing</p>
          <table className="w-full text-left text-xs">
            <tbody>
              {[
                ["risk budget", `$${PROP_RISK_PER_TRADE}/trade → contracts = floor(100 ÷ (risk pts × $2))`],
                ["contract cap", `${RAPID_EOD_50K.maxMicro} micros`],
                ["day-plan floor", "−$250 (DAILY_LOSS_FLOOR, 0 = off)"],
                ["profit arm", "+$400 — first loss after arming ends the day"],
                ["give-back", "0.5 × day peak, $250 floor"],
                ["dd600→half", "half size at $600 drawdown, restore at $300"],
              ].map(([k, v]) => (
                <tr key={k} className="border-t border-zinc-800/60">
                  <td className="py-1.5 pr-3 text-zinc-400">{k}</td>
                  <td className="py-1.5 font-mono text-zinc-200">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 font-mono text-[10px] text-zinc-600">
            per-strategy sizing + entry mechanics:{" "}
            <Link href="/strategies" className="text-long hover:underline">
              /strategies
            </Link>
          </p>
        </div>
      </section>
    </StageLayout>
  );
}
