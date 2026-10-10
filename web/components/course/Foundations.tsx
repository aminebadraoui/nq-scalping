import { Callout, Section } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course modules 00–01 — the big picture and the vocabulary.
 *
 * The course teaches the SAME system the live feed runs, but for a
 * human trading it by hand: the same bar-by-bar checks, the same
 * thresholds, the same names the journal records (SIGNAL INPUTS /
 * CARD LABELS & GATES). Modules 00–01 give a beginner the map and
 * the words before the strategy modules.
 * ------------------------------------------------------------------ */

const OVERVIEW_ROWS: Array<[string, string, string, string]> = [
  ["⚡ Momentum", "Globex · 18:00–9:30 ET", "failed flushes + huge-bar expansions", "77.5% WR · PF 2.98 · 4,822 trades"],
  ["🟦 RTH", "Day session · 9:30–16:00 ET", "one-sided 60% continuation bars with footprint proof", "82.2% WR · PF 3.47 · 10,325 trades"],
  ["🔔 Open drive", "The open · 9:30–9:59 ET", "the first delta-backed opening-range break", "96% hit at TP10/SL30 · 87% of days"],
  ["🔔 Open pullback", "Morning · 9:30–10:30 ET", "exhausted counter-bar in a delta trend", "69.8% WR · +5.2 pts net"],
  ["🔔 Open sniper", "9:36–9:45 ET", "the flush that holds the 6-minute opening anchor", "55.8% WR · +6.5 pts net"],
];

const BUCKETS: Array<[string, string, string]> = [
  ["globex_early", "18:00–21:00 ET", "evening Globex — momentum territory"],
  ["globex_core", "21:00–00:00 ET", "overnight core — momentum territory"],
  ["globex_late", "00:00–03:00 ET", "late night — momentum territory"],
  ["globex_dawn", "03:00–06:00 ET", "pre-dawn — momentum territory"],
  ["premkt", "06:00–9:30 ET", "pre-market — momentum still live until 9:30"],
  ["rth", "9:30–16:00 ET", "the day session — the RTH card's home"],
  ["close", "16:00–18:00 ET", "settlement/after-hours — no live card"],
];

const ONE_SIDED: Array<[string, string, string]> = [
  ["0.55 / 0.45", "open drive", "the scan's minimum one-sided bar (55% buys for a long)"],
  ["0.60 / 0.40", "RTH", "the daytime continuation minimum (60% one-sided)"],
  ["0.65 / 0.35", "RTH A+", "the RTH A+ tier (65% one-sided)"],
  ["0.70 / 0.30", "flush", "the failed-flush probe (70% one-sided selling for a long setup)"],
  ["0.75 / 0.25", "breakout", "the momentum breakout bar (75% one-sided)"],
  ["0.50 |delta|÷vol", "expansion", "the huge-bar expansion (half the volume must be net one way)"],
];

function Term({
  name,
  keys,
  children,
}: {
  name: string;
  keys?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-zinc-100">{name}</h3>
        {keys && <span className="font-mono text-[10px] text-info">journal keys: {keys}</span>}
      </div>
      <div className="space-y-1.5 text-[13px] leading-relaxed text-zinc-400">{children}</div>
    </div>
  );
}

export function FoundationsSection() {
  return (
    <>
      {/* ------------------------------------------------ module 00 */}
      <section id="intro" className="mb-14 scroll-mt-20">
        <Section
          kicker="module 00 · start here"
          title="The big picture — what you are learning"
          lede="This course teaches you to trade our NQ scalping system by hand, bar by bar, exactly the way the live feed does it. By the end you will be able to look at any one-minute bar and know: is this a setup, what are its gates, where do I enter, where does the stop go, how big is the position, and when do I stop for the day."
        >
          <Callout tone="long" title="The one idea the whole system is built on">
            <b className="text-zinc-100">Effort without result.</b> When one side of the market throws real
            one-sided volume at a level and price <i>fails</i> to break it, that side is exhausted — the
            other side takes over. Every strategy in this system is a variation on that sentence: find the
            one-sided push, verify it achieved nothing, then join the reversal with a breakout, with the
            stop placed where the market itself proved the trade wrong.
          </Callout>

          <div className="mb-4 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2 font-normal">strategy</th>
                  <th className="px-4 py-2 font-normal">session</th>
                  <th className="px-4 py-2 font-normal">what it catches</th>
                  <th className="px-4 py-2 font-normal">measured</th>
                </tr>
              </thead>
              <tbody>
                {OVERVIEW_ROWS.map(([a, b, c, d]) => (
                  <tr key={a} className="border-b border-zinc-800/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-zinc-100">{a}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-400">{b}</td>
                    <td className="px-4 py-2.5 text-zinc-300">{c}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-long">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="mb-2 text-sm font-bold text-zinc-100">The machine and you</h3>
              <p className="text-[13px] leading-relaxed text-zinc-400">
                The live feed (<span className="font-mono text-xs">lib/signalFeed.ts</span>) runs these checks every 15
                seconds and prints a Telegram card. This course is the manual version of the <i>same</i> checks:
                same names, same thresholds, same numbers. When you trade by hand and then open the card in the
                Journal, the <span className="font-mono text-xs text-long">SIGNAL INPUTS</span> group is literally the
                checklist you just performed — recorded number by number. Module 05 decodes every one of them.
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
              <h3 className="mb-2 text-sm font-bold text-zinc-100">How the numbers were earned</h3>
              <p className="text-[13px] leading-relaxed text-zinc-400">
                Every win rate and profit factor in this course comes from the same 568-session archive
                (2023-12 → 2026-09), replayed <b className="text-zinc-200">lookahead-free</b> with pessimistic
                first-touch scoring, a 0.5 pt round-trip cost, and one trade at a time — never overlapping
                brackets. The numbers are not promises about the future; they are the measured behavior of the
                setup. Your job is to reproduce the setup, not the numbers.
              </p>
            </div>
          </div>

          <Callout tone="warn" title="Rule zero — learn this before anything else">
            Every trade is a <b className="text-zinc-100">bracket decided before the click</b>: entry price, stop
            price, target price and size are all computed <i>before</i> you enter, and they never change after.
            There is no discretion at exit in this system. The edge lives in the setup and the risk plan — not in
            how a trade feels while it is open.
          </Callout>
        </Section>
      </section>

      {/* ------------------------------------------------ module 01 */}
      <section id="foundations" className="scroll-mt-20">
        <Section
          kicker="module 01 · foundations"
          title="The vocabulary — every word you will need"
          lede="The system speaks in a small, precise vocabulary. Each entry below is a term you will see on the cards, in the journal's variable dump, and in the strategy modules. Master these twelve ideas first and the rest of the course is just assembling them."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Term name="1. The one-minute bar and buy-fraction" keys="flushFrac · breakFrac · respFrac">
              <p>
                Every minute prints one bar: open, high, low, close, and the contracts traded inside it. Volume
                splits into <b className="text-zinc-200">buys</b> and <b className="text-zinc-200">sells</b>{" "}
                (aggressive market orders hitting the bid/ask).{" "}
                <b className="text-zinc-200">Buy-fraction</b> = buys ÷ total volume. A bar with 300 buys and 700
                sells has buy-frac 0.30 — it is <b className="text-zinc-200">70% one-sided selling</b>.
              </p>
              <p>
                One-sidedness is the system&rsquo;s fuel gauge. A bar that is ≥60–75% one-sided tells you one side is
                in control; a 50/50 bar tells you nothing. Shorts are the exact mirror: for a short setup you
                want buy-frac ≥ 0.70 on the flush, ≤ 0.25 on the breakout.
              </p>
            </Term>

            <Term name="2. The one-sided thresholds" keys="—">
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="py-1 pr-2 font-normal">threshold</th>
                      <th className="py-1 pr-2 font-normal">strategy</th>
                      <th className="py-1 font-normal">meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ONE_SIDED.map(([t, s, m]) => (
                      <tr key={s} className="border-b border-zinc-900 last:border-0">
                        <td className="py-1 pr-2 text-long">{t}</td>
                        <td className="py-1 pr-2 text-zinc-300">{s}</td>
                        <td className="py-1 text-zinc-500">{m}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Term>

            <Term name="3. Volume and the volume gate" keys="flushVol · breakVol · medVol">
              <p>
                <b className="text-zinc-200">Normal volume</b> = the median volume of the last 60 bars
                (<span className="font-mono text-xs">medVol</span>). The flush and breakout volume gates require
                at least <span className="font-mono text-xs">max(15, min(0.5 × med60, 250))</span> contracts —
                in plain English: <b className="text-zinc-200">at least 15 contracts, usually at least half of a
                normal minute, and you never need more than 250</b> even in a huge market. The gate&rsquo;s job is to
                keep you out of bars printed by a handful of contracts.
              </p>
            </Term>

            <Term name="4. Delta and cumulative delta" keys="cumDelta · deltaFromFlush · deltaFrac">
              <p>
                <b className="text-zinc-200">Delta</b> = buys − sells for a bar: the net aggression.{" "}
                <b className="text-zinc-200">Cumulative delta</b> (<span className="font-mono text-xs">cumDelta</span>)
                is the running total since the session opened — the session&rsquo;s aggression scoreboard.{" "}
                <span className="font-mono text-xs">deltaFromFlush</span> restarts the count at the flush bar, and{" "}
                <span className="font-mono text-xs">deltaFrac</span> = |delta| ÷ volume (how lopsided the bar was —
                the expansion card&rsquo;s ≥0.5 gate). Volume says <i>how much</i>; delta says <i>which side paid up</i>.
              </p>
            </Term>

            <Term name="5. ATR14 — the ruler for “a real bar”" keys="atr14 · breakRangeR · flushRangeR">
              <p>
                <b className="text-zinc-200">ATR14</b> = the median range (high − low) of the last 14 bars: how big
                a normal minute bar is right now. Every candle-size gate is written in ATR multiples —{" "}
                <span className="font-mono text-xs">breakRangeR</span> = the bar&rsquo;s range ÷ ATR14. Momentum and RTH
                require ≥ 1.0× (a normal-or-bigger bar); the expansion requires ≥ 1.6× (an unusually huge bar).
                Small bars can print one-sided volume, but the studies showed only real-size bars continue.
              </p>
            </Term>

            <Term name="6. VWAP and the session extremes" keys="distVwapPts · failDepth">
              <p>
                <b className="text-zinc-200">VWAP</b> = the volume-weighted average price of the session — the
                market&rsquo;s average cost. <span className="font-mono text-xs">distVwapPts</span> records how far the
                entry sits from it. The <b className="text-zinc-200">session extreme</b> is the running high/low of
                the day, and <span className="font-mono text-xs">failDepth</span> is how many points a flush missed
                a new extreme by — the failed-flush measurement itself.
              </p>
            </Term>

            <Term name="7. Footprint: clusters and stacks" keys="domClusters · breakStack · respProof">
              <p>
                The <b className="text-zinc-200">footprint</b> breaks the bar into price rows, each row showing
                buys and sells executed at that price. A <b className="text-zinc-200">dominant cluster row</b> has
                ≥3 lots on one side and ≥2× the other side. Three or more of those rows on one side is a{" "}
                <b className="text-zinc-200">cluster stack</b> (
                <span className="font-mono text-xs">breakStack</span>) — tick-level proof that one side was
                fighting at those prices, not just touching them. The RTH card requires ≥3 dominant rows (
                <span className="font-mono text-xs">domClusters</span>); the expansion requires the stack to match
                the trade direction.
              </p>
            </Term>

            <Term name="8. The sessions and hour buckets" keys="hourET · hourBucket">
              <p>
                The system splits the day into named buckets — each strategy owns a window, and{" "}
                <span className="font-mono text-xs">hourET</span> is a gate: the momentum card only fires in
                Globex, the RTH card only in 9:30–16:00.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="py-1 pr-2 font-normal">bucket</th>
                      <th className="py-1 pr-2 font-normal">window (ET)</th>
                      <th className="py-1 font-normal">who trades here</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BUCKETS.map(([k, w, who]) => (
                      <tr key={k} className="border-b border-zinc-900 last:border-0">
                        <td className="py-1 pr-2 text-info">{k}</td>
                        <td className="py-1 pr-2 text-zinc-300">{w}</td>
                        <td className="py-1 text-zinc-500">{who}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Term>

            <Term name="9. Risk, R-multiples and the structural stop" keys="riskPts">
              <p>
                <b className="text-zinc-200">Risk</b> = entry − stop distance in points (
                <span className="font-mono text-xs">riskPts</span>). Targets are written in{" "}
                <b className="text-zinc-200">R-multiples</b>: a 1R target is entry + 1 × risk, 0.75R is three
                quarters of the risk, 2.5R is two and a half times it. The{" "}
                <b className="text-zinc-200">structural stop</b> is the setup bar&rsquo;s own extreme plus a small pad —
                the market itself says where the trade is wrong, so the stop goes right there, not where it feels
                comfortable.
              </p>
            </Term>

            <Term name="10. Win rate vs expectancy vs profit factor" keys="—">
              <p>
                <b className="text-zinc-200">Win rate</b> alone means nothing. The system&rsquo;s 77.5% momentum win rate
                pays because each win is about as big as each loss (1R): expectancy ≈ 0.775 − 0.225 ≈ +0.55R per
                trade. The RTH live bracket wins only 37.7% of the time but targets 2.5R — its expectancy is
                positive too (PF 1.49). <b className="text-zinc-200">Profit factor</b> = gross wins ÷ gross losses;
                above 2.0 is a strong edge here. Always judge a bracket by expectancy, never by win rate alone.
              </p>
            </Term>

            <Term name="11. The two sessions in one picture" keys="—">
              <p>
                <b className="text-zinc-200">Globex</b> (18:00–9:30 ET) is thin and directional: the 75%
                one-sided bars exist, so the momentum card hunts there.{" "}
                <b className="text-zinc-200">RTH</b> (9:30–16:00 ET) is thick and two-way: 75% bars almost never
                complete, but 60% continuation bars do — so a softer, footprint-proven card trades there. The
                first half hour of RTH gets its own family (the open) because the opening range and its delta are
                the day&rsquo;s first real information. Trading the wrong card in the wrong session is the system&rsquo;s
                cardinal sin — the hour gate exists precisely to stop it.
              </p>
            </Term>

            <Term name="12. Inputs, gates and study features" keys="→ module 05">
              <p>
                An <b className="text-zinc-200">input</b> is a measurement taken from the tape at signal time. A{" "}
                <b className="text-zinc-200">gate</b> is a strategy applying a pass/fail threshold to an input. A{" "}
                <b className="text-zinc-200">study</b> feature is context recorded at the same moment but never
                read by any gate. In the Journal&rsquo;s variable dump,{" "}
                <span className="font-mono text-xs text-long">drives signal</span> marks inputs and gate labels;{" "}
                <span className="font-mono text-xs text-zinc-400">study only</span> marks everything else. Module
                05 is the complete codebook — every variable, its threshold, and which strategy uses it.
              </p>
            </Term>
          </div>
        </Section>
      </section>
    </>
  );
}
