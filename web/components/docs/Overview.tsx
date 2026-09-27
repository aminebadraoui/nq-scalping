import Link from "next/link";
import { Callout, StatCard } from "@/components/ui";
import { statStrip } from "@/lib/data";

export function OverviewSection() {
  return (
    <>
      {/* Hero */}
      <section className="mb-12">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">
          Deep research · evidence-graded
        </p>
        <h1 className="mb-4 max-w-3xl text-4xl font-bold tracking-tight text-zinc-50 sm:text-5xl">
          Real reversal, or fakeout?
        </h1>
        <p className="max-w-3xl text-lg leading-relaxed text-zinc-400">
          The empirically grounded answer for scalpers. No single indicator
          reliably separates a true reversal from a stop-run — but a{" "}
          <span className="text-zinc-200">stacked confirmation model</span>{" "}
          does. This playbook condenses the academic evidence, fee-inclusive
          backtests, and professional order-flow practice into one desk-ready
          system.
        </p>
      </section>

      {/* The core model */}
      <Callout tone="long" title="THE CORE MODEL — WHAT THE EVIDENCE SUPPORTS">
        <p className="mb-2">
          <span className="font-mono font-semibold text-zinc-100">
            Real reversal
          </span>{" "}
          = (1) an obvious liquidity location + (2) an order-flow event —
          absorption or a stop sweep + (3) a{" "}
          <span className="text-long">reclaim close</span> + (4) pace in the
          new direction + (5) higher-timeframe context that agrees.
        </p>
        <p>
          <span className="font-mono font-semibold text-zinc-100">
            A fakeout
          </span>{" "}
          = any one of those pieces missing — especially the{" "}
          <span className="text-short">wick without the reclaim</span>, or the
          &ldquo;reversal&rdquo; against the HTF trend.
        </p>
      </Callout>

      {/* Honest stats */}
      <section className="mb-12">
        <h2 className="mb-1 text-xl font-bold text-zinc-50">
          The numbers nobody wants to show you
        </h2>
        <p className="mb-4 text-sm text-zinc-500">
          Fee-inclusive walk-forward backtests and pattern studies — not
          marketing copy.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statStrip.map((s) => (
            <StatCard key={s.label} {...s} />
          ))}
        </div>
      </section>

      {/* The #1 rule */}
      <Callout tone="warn" title="THE #1 RULE — THE RECLAIM CLOSE">
        A wick through a level is <span className="font-semibold">not</span> a
        sweep. The same or next candle must{" "}
        <span className="text-zinc-100">
          close back inside the range
        </span>
        . Entering on the wick alone flips the base rate against you. ~30–35%
        of even <em>valid</em> sweeps grind sideways — plan a scalp, not a
        swing.
      </Callout>

      {/* Section cards */}
      <section className="grid gap-4 sm:grid-cols-2">
        {[
          {
            href: "/docs#evidence",
            kicker: "01",
            title: "The Evidence",
            body: "Academic microstructure, fee-inclusive backtest tables, breakout failure statistics, and the folklore that fails them.",
          },
          {
            href: "/docs#tools",
            kicker: "02",
            title: "The Tool Stack",
            body: "DOM, CVD, footprint, heatmaps, VWAP/profile — ranked by evidence, with each tool's reversal tell and fakeout tell.",
          },
          {
            href: "/docs#strategies",
            kicker: "03",
            title: "The Strategies",
            body: "Sweep-and-reclaim, absorption fade, VWAP/POC reversion — step-by-step rules, stops, targets, and the red flags that kill them.",
          },
          {
            href: "/docs#checklist",
            kicker: "04",
            title: "The Checklist & Math",
            body: "Interactive pre-trade confirmation checklist, expectancy and break-even calculators, and the 100-trade validation protocol.",
          },
        ].map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-lg border border-zinc-800 bg-zinc-900/60 p-5 transition-colors hover:border-long/50"
          >
            <p className="font-mono text-xs text-long">{c.kicker}</p>
            <h3 className="mt-1 mb-1 text-lg font-semibold text-zinc-100 group-hover:text-long">
              {c.title}
            </h3>
            <p className="text-sm leading-relaxed text-zinc-400">{c.body}</p>
          </Link>
        ))}
      </section>
    </>
  );
}
