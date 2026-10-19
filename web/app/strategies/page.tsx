"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StrategyRegistrySection } from "@/components/StrategyRegistrySection";
import { StageTabs } from "@/components/StageTabs";
import type { FeedFlags } from "@/components/docs/LiveStrategies";

/** One place in the dashboard that shows EXACTLY how the live signal engine
 *  works: the loop, the two kinds of signals, the shared gates — and each
 *  strategy condition-by-condition, RENDERED FROM THE STRATEGY REGISTRY
 *  (lib/strategies/registry.ts: the same config objects the feed trades),
 *  with its LIVE on/off state read from the running server
 *  (/api/gc?action=health). */

const PIPELINE = [
  {
    n: "1",
    title: "The loop — live only, every 15s",
    body: (
      <>
        The feed (lib/signalFeed.ts) runs server-side from instrumentation.ts — no browser open, no dashboard needed. Every
        15 seconds (SIGNAL_REFRESH_SECONDS) it recomputes everything from the LIVE GoCharting tick feed. If the feed is not
        connected or the last print is stale (market closed / maintenance), it produces nothing. Collected data is used for
        exactly one thing: the static level stack (LVN edges + POC). Every bar, event and number behind a card is live
        intraday data.
      </>
    ),
  },
  {
    n: "2",
    title: "Two kinds of signals",
    body: (
      <>
        <b className="text-zinc-200">Direct detectors</b> — the active strategies (momentum flush + expansion, RTH, open
        drive; pullback and sniper shipped but off). Each one is a self-contained detector with its own precise conditions
        (rendered card-by-card below from the registry) that fires only on the just-completed minute bar.{" "}
        <b className="text-zinc-200">The box pipeline</b> — the reversal card (currently OFF): three independent boxes —
        order flow (the location → absorption → divergence → reclaim sequence), price action (premium/discount) and
        options/gamma (context — reported, never votes). Every directional box must agree on the direction; then the card
        gate requires all 3 required ingredients (location, mechanism, trigger) plus ≥1 confirmation (4/6 ingredients
        present), and finally two footprint filters (the stack must not oppose the trade, and the entry bar's delta must
        print in the trade direction).
      </>
    ),
  },
  {
    n: "3",
    title: "Divergence's exact role",
    body: (
      <>
        CVD divergence (D2 bullish / D4 bearish) is the{" "}
        <b className="text-zinc-200">“fuel” ingredient</b> of the order-flow box. It is printed in every card's reasoning as
        information, and it counts as one of the six ingredients in the 4/6 confirmation count — but it{" "}
        <b className="text-zinc-200">never fires anything on its own</b> (it is a symptom, not a trigger; only the reclaim
        triggers). The momentum/RTH/open detectors do not use divergence at all. Every fired signal is recorded with its
        reasoning and feature vector (incl. divergence state) in the signals table, and the per-session divergence store
        (gcdata/data/divergences) feeds the backtests — analysis-ready, decision-agnostic.
      </>
    ),
  },
  {
    n: "4",
    title: "The shared gates every card passes before anything is sent",
    body: (
      <ol className="mt-1 list-inside list-decimal space-y-1 text-sm leading-relaxed">
        <li><b className="text-zinc-200">News blackout</b> — inside a release window, no card is sent; the candidate is recorded as a skip so the insight loop can count what the gate ate.</li>
        <li><b className="text-zinc-200">Self-improvement overrides</b> — approved strategy_overrides rows filter the card (family on/off, hour veto, trend filter, tighter risk…) without a redeploy.</li>
        <li><b className="text-zinc-200">Market-hours window</b> — the signal window must be open (session/calendar aware).</li>
        <li><b className="text-zinc-200">Dedupe</b> — one card per day/bar/strategy key; the day's first momentum card is marked “1st today”.</li>
        <li><b className="text-zinc-200">Sizing & account guard</b> — momentum/RTH size 9 contracts fixed (FIXED_CONTRACTS overrides); the open family keeps the $170-budget sizing; day-tier multiplier + EOD give-back guard apply.</li>
        <li><b className="text-zinc-200">Send + record</b> — the Telegram card (full reasoning + measured stats) is pushed, the row is recorded in the signals table (features jsonb includes the DOM context), and execution goes through the executor (dry-run by default; EXECUTE_LIVE=1 enables live orders). Fills reconcile back to signals nightly.</li>
      </ol>
    ),
  },
];

export default function StrategiesPage() {
  const [feeds, setFeeds] = useState<FeedFlags | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/gc?action=health")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const f = (j.execution?.feeds as FeedFlags | undefined) ?? null;
        setFeeds(f);
        if (!f) setError("health endpoint did not return feed flags");
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8">
      <header className="mb-8">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-long">live strategies · the signal engine</p>
        <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">How the live feed actually works</h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-400">
          One place for the whole picture: the engine loop, the two kinds of signals, every gate a card passes before it is
          sent, and each strategy condition-by-condition — rendered from the strategy registry (the same config objects the
          feed trades) with its <strong className="text-zinc-200">live ON/OFF state</strong> read from this server's
          environment right now.
        </p>
        <p className="mt-3 font-mono text-[11px] text-zinc-500">
          {feeds
            ? "feed status: connected to this server ✓"
            : error
              ? `feed status: ${error}`
              : "feed status: loading…"}
          {" · "}the per-strategy live reads (one tab per strategy) are on the{" "}
          <Link href="/#live-board" className="text-long hover:underline">
            dashboard&apos;s live signal board
          </Link>{" "}
          {" · "}the full research lives on the{" "}
          <Link href="/docs" className="text-long hover:underline">
            docs page
          </Link>
        </p>
      </header>

      <StageTabs base="/strategies" />

      {/* the pipeline, step by step */}
      <section className="mb-10 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5">
        <h2 className="mb-4 text-xl font-bold text-zinc-50">The pipeline — tick to card</h2>
        <div className="space-y-5">
          {PIPELINE.map((p) => (
            <div key={p.n} className="flex gap-4">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-info/40 font-mono text-sm text-info">
                {p.n}
              </span>
              <div className="min-w-0">
                <h3 className="mb-1 text-base font-semibold text-zinc-200">{p.title}</h3>
                <div className="text-sm leading-relaxed text-zinc-400">{p.body}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* the strategies, condition by condition, live flags — from the registry */}
      <StrategyRegistrySection feeds={feeds} />

      <p className="mt-12 border-t border-zinc-800 pt-6 font-mono text-[11px] text-zinc-600">
        Educational research only — not financial advice. The same strategy details (with the research and sources) are on the{" "}
        <Link href="/docs" className="text-zinc-400 hover:text-zinc-200">
          docs page
        </Link>
        , the studies that measured each strategy are on the{" "}
        <Link href="/studies" className="text-zinc-400 hover:text-zinc-200">
          studies page
        </Link>
        , and the live data lives on the{" "}
        <Link href="/" className="text-zinc-400 hover:text-zinc-200">
          dashboard
        </Link>
        .
      </p>
    </div>
  );
}
