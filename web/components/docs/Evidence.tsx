import {
  Callout,
  DataTable,
  Section,
  SourceRef,
} from "@/components/ui";
import {
  evidenceAnchors,
  failureStats,
  patternTable,
} from "@/lib/data";

export function EvidenceSection() {
  return (
    <>
      <Section
        kicker="01 · Evidence"
        title="What is actually proven"
        lede="The claims that survive contact with fee-inclusive data — and the popular claims that don't."
      >
        <Callout tone="info" title="ORDER FLOW IS THE ONE VARIABLE WITH ACADEMIC BACKING">
          Cont, Kukanov & Stoikov (JFEC 2014): short-horizon price changes are
          driven mainly by order-flow imbalance at the best bid/ask, amplified
          when depth is thin. That is the mechanical reason stop-sweeps through
          thin liquidity produce sharp wicks — and why DOM, tape, CVD and
          footprint are legitimate tools rather than folklore.
        </Callout>

        <h3 className="mb-3 mt-8 font-semibold text-zinc-100">
          Fee-inclusive backtests of the popular reversal patterns
        </h3>
        <DataTable
          head={patternTable.head}
          rows={patternTable.rows.map((r) => [
            r[0],
            <span key="a" className="text-warn">
              {r[1]}
            </span>,
            <span key="b" className="text-long">
              {r[2]}
            </span>,
            r[3],
          ])}
        />
        <p className="mt-2 text-xs text-zinc-500">
          Walk-forward data, net of 0.12% round-trip fees (crypto: BTC/ETH/SOL/ZEC).
        </p>

        <h3 className="mt-8 mb-3 font-semibold text-zinc-100">
          Failure statistics that shape the playbook
        </h3>
        <ul className="space-y-2">
          {failureStats.map((f, i) => (
            <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-300">
              <span className="mt-0.5 font-mono text-xs text-short">▸</span>
              {f}
            </li>
          ))}
        </ul>

        <Callout tone="short" title="THE &ldquo;90% WIN RATE&rdquo; FOLKLORE IS NOT SUPPORTED">
          The same backtest publisher states outright:{" "}
          <em>
            &ldquo;Popular sources cite sweep win rates in the 70–80% range. Our
            data does not support that.&rdquo;
          </em>{" "}
          Measured fee-inclusive rates cluster ~50–65%. Even pages claiming
          85–97% have data tables showing ~50%.{" "}
          <span className="text-zinc-100">
            Rule: always check the data table, never the headline.
          </span>
        </Callout>
      </Section>

      <Section
        kicker="02 · Anchors"
        title="Additional empirical anchors"
        lede="Studies and datasets that calibrate how often breakouts actually fail."
      >
        <div className="space-y-4">
          {evidenceAnchors.map((a) => (
            <div
              key={a.title}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5"
            >
              <h3 className="mb-2 font-semibold text-zinc-100">{a.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">{a.body}</p>
              <ul className="mt-3 space-y-1">
                {a.sources.map((s) => (
                  <SourceRef key={s.href} {...s} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
