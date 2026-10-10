import { Callout } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course module 05 lessons — the Journal inputs & gates codebook.
 *
 * The module that answers "what do the input/gate features in the
 * journal actually do, and how is each one used in each strategy?"
 * Every row mirrors lib/featureRegistry.ts + lib/featureGroups.ts, but
 * explained for a beginner, strategy by strategy.
 * ------------------------------------------------------------------ */

type GlossRow = {
  k: string;
  what: React.ReactNode;
  used: React.ReactNode;
};

type GlossGroup = { title: string; note: string; rows: GlossRow[] };

/* ---------------- the glossary, grouped exactly like the journal ---------------- */

const FLUSH_FAMILY: GlossGroup = {
  title: "The flush family — what the failed push looked like",
  note: "Recorded on every momentum card. The flush is the probe: one side attacking, the system measuring whether it achieved anything.",
  rows: [
    {
      k: "kind",
      what: <>which trigger produced the card: <b className="text-zinc-100">flush</b> (failed-flush breakout) or <b className="text-zinc-100">expansion</b> (huge-bar).</>,
      used: <>set by the detector — the first thing to read on any card.</>,
    },
    {
      k: "flushFrac",
      what: <>the flush bar&rsquo;s buy-fraction: what share of its volume was buying. 0.20 means 80% selling.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> ≤0.30 for a long setup (≥0.70 for a short). Recorded
          everywhere else.
        </>
      ),
    },
    {
      k: "flushVol",
      what: <>the flush bar&rsquo;s volume in contracts — how hard the attack hit.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> ≥ max(15, min(0.5 × med60, 250)) — at least 15 contracts,
          usually at least half a normal minute, never more than 250 needed.
        </>
      ),
    },
    {
      k: "flushRange",
      what: <>the flush bar&rsquo;s range in points — how violent the probe was.</>,
      used: <>recorded for study (big violent flushes vs quiet probes).</>,
    },
    {
      k: "failDepth",
      what: (
        <>
          how many points the flush <b className="text-zinc-100">missed</b> a new session extreme by. Positive =
          it held (failed flush ✓). A flush that broke the extreme by more than 0.5 pts resets the machine — it
          was a real breakdown.
        </>
      ),
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> low ≥ session low − 0.5 (mirror: high ≤ session high +
          0.5). This number IS the failed-flush check.
        </>
      ),
    },
    {
      k: "flushRangeR",
      what: <>the flush bar&rsquo;s range ÷ ATR14 — the probe&rsquo;s size on the normal-bar ruler.</>,
      used: <>recorded; the quiet-before-flush lead reads the prior bar&rsquo;s value (off in production).</>,
    },
  ],
};

const BREAKOUT_FAMILY: GlossGroup = {
  title: "The response & breakout family — what the counterattack looked like",
  note: "These describe the bar (or bars) that answered the flush. In merged mode the breakout bar is its own response evidence, so resp* and break* keys often hold the same bar's numbers.",
  rows: [
    {
      k: "respFrac",
      what: <>the response/breakout bar&rsquo;s buy-fraction.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·flush (merged mode):</b> ≥0.75 long / ≤0.25 short — the breakout bar
          itself is the response evidence.
        </>
      ),
    },
    {
      k: "respVol",
      what: <>the response/breakout bar&rsquo;s volume.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> same volume floor as the flush — the counterattack must
          be real too.
        </>
      ),
    },
    {
      k: "respDelay",
      what: <>how many bars passed between the flush and the breakout.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> ≤10 bars. Exhaustion decays fast; a breakout ten minutes
          later is a different story.
        </>
      ),
    },
    {
      k: "respProof",
      what: <>dominant cluster proof count at/inside the flush zone (merged mode&rsquo;s tick-level evidence).</>,
      used: <>recorded on momentum cards (the older two-bar mode gated on it; merged mode uses the breakout bar).</>,
    },
    {
      k: "breakFrac",
      what: <>the breakout/trigger bar&rsquo;s buy-fraction — the most-read number in the whole system.</>,
      used: (
        <>
          <b className="text-long">GATE:</b> MOM·flush ≥0.75 (≤0.25 short) · RTH ≥0.60 (≤0.40) with{" "}
          <b className="text-long">A+</b> at ≥0.65 · open drive ≥0.55 (≤0.45) · sniper ≥55% toward the anchor.
          Recorded on every card regardless of family.
        </>
      ),
    },
    {
      k: "breakVol",
      what: <>the breakout/trigger bar&rsquo;s volume.</>,
      used: (
        <>
          <b className="text-long">GATE:</b> momentum volume floor · RTH ≥0.5 × med60. Recorded elsewhere.
        </>
      ),
    },
    {
      k: "breakDelay",
      what: <>bars between flush and breakout (same story as respDelay, kept under both names).</>,
      used: <>recorded; the ≤10-bar window gate reads it in merged mode.</>,
    },
    {
      k: "refDist",
      what: (
        <>
          how many points the breakout traded <b className="text-zinc-100">through</b> the reference — the max
          high of the flush bar plus the 2 bars before it (mirror: reference low). Positive = it broke the
          defended level.
        </>
      ),
      used: (
        <>
          <b className="text-long">GATE — MOM·flush:</b> &gt; 0 — through the level, not just to it.
        </>
      ),
    },
    {
      k: "progressPts",
      what: <>breakout high vs the session high at flush time — how much new ground the breakout claimed.</>,
      used: <>recorded (the require-progress gate is off in production).</>,
    },
    {
      k: "breakRangeR",
      what: <>the breakout bar&rsquo;s range ÷ ATR14 — its size on the normal-bar ruler.</>,
      used: (
        <>
          <b className="text-long">GATE:</b> MOM·flush ≥1.0 · MOM·expansion ≥1.6 · RTH ≥1.0. The candle-size
          gate — the most recently tuned one (1.0× adopted 2026-10-02 over 0.85×).
        </>
      ),
    },
    {
      k: "breakStack",
      what: <>the breakout bar&rsquo;s dominant cluster stack: <b className="text-zinc-100">buy | sell | none</b> — which side owned the footprint rows.</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·expansion:</b> the stack must match the trade direction. Recorded
          on other cards.
        </>
      ),
    },
    {
      k: "breakVwapPos",
      what: <>where the breakout bar&rsquo;s VWAP sat inside the bar (0 = low, 1 = high) — where the bar&rsquo;s real business was done.</>,
      used: <>recorded for study (position-of-business leads).</>,
    },
    {
      k: "deltaFrac",
      what: <>|delta| ÷ volume of the trigger bar — how lopsided the aggression was (0.5 = at least 75% net one way).</>,
      used: (
        <>
          <b className="text-long">GATE — MOM·expansion:</b> ≥0.5. Recorded (never gated) on other cards.
        </>
      ),
    },
    {
      k: "domClusters",
      what: <>how many dominant cluster rows (≥3 lots, ≥2:1) sat on the trade side — the footprint proof count.</>,
      used: (
        <>
          <b className="text-long">GATE — RTH:</b> ≥3. Recorded on momentum cards but the RTH gate reads its own
          count.
        </>
      ),
    },
  ],
};

const CONTEXT_FAMILY: GlossGroup = {
  title: "The context family — the tape around the setup",
  note: "The rulers and scoreboards the gates are written against, plus what the surrounding session looked like.",
  rows: [
    {
      k: "medVol",
      what: <>the median volume of the trailing 60 bars — what a normal minute looks like right now.</>,
      used: (
        <>
          <b className="text-long">GATE baseline:</b> every volume gate (flush, breakout, RTH, expansion) is
          written as a multiple or fraction of this number.
        </>
      ),
    },
    {
      k: "atr14",
      what: <>the median range of the prior 14 bars — what a normal bar&rsquo;s size looks like right now.</>,
      used: (
        <>
          <b className="text-long">GATE baseline:</b> every range gate (breakRangeR, flushRangeR) divides by
          this number.
        </>
      ),
    },
    {
      k: "distVwapPts",
      what: <>how far the entry sat from the session VWAP (the market&rsquo;s average cost), in points.</>,
      used: <>recorded — session-context color, not a gate.</>,
    },
    {
      k: "cumDelta",
      what: <>the session&rsquo;s cumulative delta (buys − sells) at entry — the day&rsquo;s aggression scoreboard.</>,
      used: (
        <>
          <b className="text-long">GATE — open drive:</b> ≥ +300 long / ≤ −300 short. Recorded on momentum cards
          (the expansion veto reads it).
        </>
      ),
    },
    {
      k: "deltaFromFlush",
      what: <>cumulative delta since the flush bar — the scoreboard restarted at the flush.</>,
      used: <>recorded — did the counterattack gather delta on the way to the breakout?</>,
    },
    {
      k: "trailLowDist / trailHighDist",
      what: <>flush low vs the trailing 20-bar swing low (mirror: swing high vs flush high) — the local version of the failed-flush check.</>,
      used: <>recorded; the unusual-volume watch line reads the 20-bar swing for its “no new local low” note.</>,
    },
    {
      k: "hourET",
      what: <>the entry hour, Eastern time — which bucket the bar printed in.</>,
      used: (
        <>
          <b className="text-long">GATE:</b> momentum = Globex only (9:30–16:00 excluded) · RTH = 9:30–16:00 only
          · open family = its morning windows. The session gate that keeps every card in its own habitat.
        </>
      ),
    },
    {
      k: "riskPts",
      what: <>the stop distance in points AFTER the 3.5-pt widen floor — the bracket&rsquo;s risk.</>,
      used: (
        <>
          <b className="text-long">GATE band:</b> momentum 3.5–30 · expansion/RTH 3.5–15 · pullback ≤25. Stops
          tighter than 3.5 are widened; under 3 pts never trades.
        </>
      ),
    },
    {
      k: "dir · side · risk · extreme · buyPct",
      what: <>direction (long/short), the legacy stop-distance key, and the retired sweep-reclaim keys (feed OFF).</>,
      used: <>direction labels every card; the legacy keys remain for old rows.</>,
    },
  ],
};

const LABELS_FAMILY: GlossGroup = {
  title: "CARD LABELS & GATES — the decision-time labels and vetoes",
  note: "The journal's second signal-role group: not tape measurements but the card's identity, the override snapshot and everything that could have stopped it.",
  rows: [
    {
      k: "family",
      what: (
        <>
          the strategy family: <span className="font-mono text-xs">momentum_flush · momentum_expansion · rth ·
          open_drive · open_pullback · open_sniper · sweep_reclaim · reversal</span>. The UI shows friendlier
          names (MOM·flush, RTH, OPEN DRIVE…).
        </>
      ),
      used: <>every override, stat table and review is keyed by this.</>,
    },
    {
      k: "aPlus",
      what: <>the A+ label — momentum: both triggers on the same bar · RTH: ≥65% one-sided.</>,
      used: (
        <>
          <b className="text-zinc-100">a label, never a gate</b> — the day plan trades all cards, A+ or not.
          Prints on the card and lands in the journal for measurement.
        </>
      ),
    },
    {
      k: "firstToday / firstOfDay",
      what: <>the day&rsquo;s first momentum card / the day&rsquo;s first card of its family.</>,
      used: <>labels — the first-card subset is measured separately (77.2% WR, PF 3.15).</>,
    },
    {
      k: "gates",
      what: (
        <>
          the <b className="text-zinc-100">override snapshot</b> active at decision time — the self-improving
          loop&rsquo;s strategy_overrides rows (family on/off, hour veto, trend filter, tighter risk…), frozen as they
          were when the card was decided.
        </>
      ),
      used: (
        <>
          this is the journal&rsquo;s <b className="text-zinc-100">second meaning of “gate”</b>: not a threshold but a
          lever. Approve a proposal on the Journal&rsquo;s Insights panel and the live feed applies it within minutes
          — this key records which levers were active for each card.
        </>
      ),
    },
    {
      k: "rejectedBy",
      what: <>the veto reasons recorded when a candidate setup existed but the card did NOT fire (e.g. daily card cap, counter-gate, drift veto).</>,
      used: <>the loop&rsquo;s loss ledger — it counts what the gates ate so the gates can be judged.</>,
    },
    {
      k: "newsBlocked",
      what: <>the news blackout reason when the card was skipped inside a release window.</>,
      used: <>no card is sent during scheduled news — this records which event ate it.</>,
    },
    {
      k: "retrace",
      what: (
        <>
          the expansion limit-entry lifecycle: <span className="font-mono text-xs">filled · expired · void ·
          news-blocked · crossed-stop</span> — what happened to the resting 1-pt limit.
        </>
      ),
      used: <>tracks the live expansion path (limit behind the close, ≤5 bars).</>,
    },
    {
      k: "wallStop",
      what: <>a note when WALL_STOP=1 widened the stop beyond a near dealer wall (default OFF).</>,
      used: <>records the opt-in stop rule (the placement rule awaits historical gamma data).</>,
    },
    {
      k: "hourBucket · side · contracts",
      what: <>the hour block label, the direction, and the sized MNQ contracts (floor(100 ÷ risk pts × $2), 30-micro cap).</>,
      used: <>re-attached from the trades row so every feature table is self-contained.</>,
    },
  ],
};

const ANATOMY: GlossGroup = {
  title: "ANATOMY — what happened after the fill (post-hoc)",
  note: "Computed after the trade ends — the role is “post”, not “input”. These are the autopsy numbers, used for review, never for the entry decision.",
  rows: [
    {
      k: "drift",
      what: <>entry adverse drift: points the tape ran against the entry before the fill (positive = filled worse than the signal price).</>,
      used: <>measures fill quality — the reason the live brackets switched to resting limits.</>,
    },
    {
      k: "heldMin",
      what: <>minutes held, fill to final exit.</>,
      used: <>the trade&rsquo;s time in market.</>,
    },
    {
      k: "mfe / mae",
      what: <>max favorable / max adverse excursion — the best and worst the trade ever was, in points.</>,
      used: <>MFE vs MAE shows whether winners ran and losers stayed small.</>,
    },
    {
      k: "stopRun",
      what: <>the loss stopped out by only a few ticks past the stop — the sweep (about 5% of stops, no hour clustering).</>,
      used: <>the stop-run rate the stop-pad studies measured before keeping structural stops.</>,
    },
    {
      k: "targetReached",
      what: <>the tape reached the target before the stop — the first-touch score.</>,
      used: <>the same pessimistic scoring every backtest uses.</>,
    },
    {
      k: "recovered",
      what: <>after a deep adverse drift the trade still won.</>,
      used: <>resilience evidence for the bracket.</>,
    },
    {
      k: "lossLabel",
      what: (
        <>
          the loss class: <span className="font-mono text-xs">stop-run</span> (swept by ticks) ·{" "}
          <span className="font-mono text-xs">never worked</span> (wrong from the start) ·{" "}
          <span className="font-mono text-xs">gave back</span> (had it, lost it).
        </>
      ),
      used: <>losses are reviewed by class, not by pain — each class has a different fix.</>,
    },
  ],
};

/* ---------------- per-strategy gate map ---------------- */

const STRATEGY_GATES: Array<{ name: string; gates: string; recorded: string }> = [
  {
    name: "MOM·flush",
    gates: "flushFrac ≤0.30 · flushVol floor · failDepth (no new extreme) · ≤10 bars · breakFrac ≥0.75 · breakVol floor · refDist >0 · breakRangeR ≥1.0× · hourET Globex · risk 3.5–30 · gap ≥5",
    recorded: "flushRange · respProof · progressPts · breakVwapPos · cumDelta · deltaFromFlush · trail* · domClusters · deltaFrac · distVwapPts",
  },
  {
    name: "MOM·expansion",
    gates: "breakRangeR ≥1.6× · deltaFrac ≥0.5 · breakStack = trade side · breakVol floor · hourET Globex · risk 3.5–15 · gap ≥5 · live: 1-pt limit ≤5 bars",
    recorded: "breakFrac · breakVwapPos · flushRangeR · cumDelta · domClusters",
  },
  {
    name: "RTH",
    gates: "hourET 9:30–16 · breakFrac ≥0.60 · domClusters ≥3 · breakRangeR ≥1.0× · breakVol ≥0.5×med60 · risk 3–15 · gap ≥5 · A+ label at ≥0.65",
    recorded: "breakStack · deltaFrac · flushRangeR · distVwapPts",
  },
  {
    name: "OPEN DRIVE",
    gates: "hourET 9:30–9:59 · new window extreme · cumDelta ≥+300 · breakFrac ≥0.55 · fixed TP+15 / SL−35",
    recorded: "medVol · atr14",
  },
  {
    name: "OPEN PULLBACK",
    gates: "15-bar cumDelta trend · pullback holds 5-bar low ±0.25 · counter-delta shrank · reclaim close + trend-side delta · risk ≤25 · gap ≥5",
    recorded: "—",
  },
  {
    name: "OPEN SNIPER",
    gates: "9:36–9:45 · vol ≥max(300, 1.5×15-bar med) · ≥55% toward anchor · |delta| ≥60 · anchor holds ±1 · limit anchor ±9.5 · stop ∓10 · target = flush extreme",
    recorded: "—",
  },
];

function GlossTable({ group }: { group: GlossGroup }) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-300">{group.title}</h3>
        <span className="font-mono text-[10px] text-zinc-600">role: signal input</span>
      </div>
      <p className="mb-2 text-[12px] italic text-zinc-500">{group.note}</p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[720px] text-left align-top text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">variable</th>
              <th className="px-4 py-2 font-normal">what it is (plain english)</th>
              <th className="px-4 py-2 font-normal">how each strategy uses it</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((r) => (
              <tr key={r.k} className="border-b border-zinc-800/60 align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-info">{r.k}</td>
                <td className="px-4 py-2.5 leading-relaxed text-zinc-300">{r.what}</td>
                <td className="px-4 py-2.5 leading-relaxed text-zinc-400">{r.used}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------ lesson 1: roles */

export function RolesLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        This module answers the question the whole course is built around: what do the input and gate features
        in the Journal do, and how does each strategy use them? By the end, the variable dump on any trade will
        read like a sentence instead of a spreadsheet.
      </p>

      <Callout tone="long" title="First: the three roles a variable can have">
        <p className="mb-2">
          <b className="text-zinc-100">input</b> — a measurement taken from the tape at signal time (the numbers
          in <span className="font-mono text-xs">SIGNAL INPUTS</span> and{" "}
          <span className="font-mono text-xs">CARD LABELS &amp; GATES</span>).{" "}
          <b className="text-zinc-100">study</b> — context recorded at the same moment but never read by any
          gate (ES, seasonal, round numbers, gaps, walls, kelly, DOM — the chips module).{" "}
          <b className="text-zinc-100">post</b> — computed after the trade ends (the anatomy).
        </p>
        <p>
          In the Journal&rsquo;s variable dump the badge does the work for you:{" "}
          <span className="font-mono text-xs text-long">drives signal</span> marks the input groups,{" "}
          <span className="font-mono text-xs text-zinc-400">study only</span> marks everything else. In the
          Pattern Explorer the same split is the <span className="font-mono text-xs">all / input / study / post</span>{" "}
          role filter.
        </p>
      </Callout>

      <Callout tone="info" title="Input vs gate — the one-line version">
        An <b className="text-zinc-100">input</b> is a measurement. A <b className="text-zinc-100">gate</b> is a
        strategy applying a pass/fail threshold to an input. The same input can be a gate in one strategy and a
        mere recording in another: <span className="font-mono text-xs">breakFrac</span> is gated at ≥0.75 by the
        momentum card, at ≥0.60 by the RTH card — and it is still recorded on every card regardless of who
        gated it, because the pattern miner studies all of them. A value on a card does not mean a gate read
        it; the tables in this module say exactly which strategy reads what.
      </Callout>

      <Callout tone="warn" title="The word “gate” appears twice in the journal — know both">
        <p className="mb-2">
          (1) <b className="text-zinc-100">The thresholds in the detectors</b> — the ≥/≤ rules in the strategy
          modules: the things that decide whether a card exists at all. (2){" "}
          <b className="text-zinc-100">The <span className="font-mono text-xs">gates</span> key</b> in{" "}
          <span className="font-mono text-xs">CARD LABELS &amp; GATES</span> — the{" "}
          <b className="text-zinc-100">override snapshot</b>: the self-improving loop&rsquo;s levers (family on/off,
          hour vetoes, tighter risk…) as they stood the moment the card was decided.
        </p>
        <p>
          You approve the second kind on the Journal&rsquo;s <i>Insights &amp; gates</i> panel — the nightly miner
          proposes changes with evidence, you approve, and the live feed applies them within minutes. Every
          card then carries the snapshot of exactly which levers were active for it. That is the loop: trade →
          journal → mine → gate → trade better.
        </p>
      </Callout>
    </div>
  );
}

/* ------------------------------------------------ lesson 2: glossary I */

export function CodebookFlushLesson() {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        Glossary part one: the two families that describe the signal itself — the failed push and the
        counterattack. For each variable: what it is in plain English, and exactly which strategy gates on it.
      </p>
      <GlossTable group={FLUSH_FAMILY} />
      <GlossTable group={BREAKOUT_FAMILY} />
    </div>
  );
}

/* ------------------------------------------------ lesson 3: glossary II */

export function CodebookContextLesson() {
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        Glossary part two: the tape around the setup, the card&rsquo;s identity and vetoes, and the post-trade
        anatomy.
      </p>
      <GlossTable group={CONTEXT_FAMILY} />
      <GlossTable group={LABELS_FAMILY} />
      <GlossTable group={ANATOMY} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wider text-zinc-400">
          The study-only groups — context, never gates
        </h3>
        <p className="text-[13px] leading-relaxed text-zinc-400">
          <span className="font-mono text-xs">ES CROSS-ASSET</span> ·{" "}
          <span className="font-mono text-xs">SEASONAL</span> ·{" "}
          <span className="font-mono text-xs">ROUND NUMBERS</span> ·{" "}
          <span className="font-mono text-xs">PRICE GAPS</span> ·{" "}
          <span className="font-mono text-xs">GAMMA WALLS</span> ·{" "}
          <span className="font-mono text-xs">KELLY</span> ·{" "}
          <span className="font-mono text-xs">DOM EVIDENCE</span> — every one of these is recorded at signal
          time for research, and{" "}
          <b className="text-zinc-200">none of them decides anything</b>. The day plan trades all cards, A+ or
          not, chip or no chip. The chips module explains each chip family and the one rule they all share.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------ lesson 4: the gate map */

export function CodebookMapLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        One screen, all six cards: the inputs each strategy actually gates on (with thresholds) versus the
        inputs it merely records. Then the five-step method for reading any trade&rsquo;s variable dump.
      </p>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[760px] text-left align-top text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">strategy</th>
              <th className="px-4 py-2 font-normal">inputs it GATES on (with thresholds)</th>
              <th className="px-4 py-2 font-normal">inputs it merely records</th>
            </tr>
          </thead>
          <tbody>
            {STRATEGY_GATES.map((s) => (
              <tr key={s.name} className="border-b border-zinc-800/60 align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-bold text-long">{s.name}</td>
                <td className="px-4 py-3 font-mono text-xs leading-relaxed text-info">{s.gates}</td>
                <td className="px-4 py-3 font-mono text-xs leading-relaxed text-zinc-500">{s.recorded}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-400">
          How to read a trade&rsquo;s variable dump in five steps
        </h3>
        <ol className="space-y-2.5 text-[13px] leading-relaxed text-zinc-300">
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-[10px] text-long">1</span>
            <span>
              Open the trade in the Journal and expand <i>variables at signal time</i>. Read{" "}
              <span className="font-mono text-xs text-info">kind</span> and{" "}
              <span className="font-mono text-xs text-info">family</span> first — which card is this?
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-[10px] text-long">2</span>
            <span>
              Walk the <span className="font-mono text-xs text-long">SIGNAL INPUTS</span> numbers through that
              strategy&rsquo;s gate list from the map above. Each number either cleared a threshold (e.g.{" "}
              <span className="font-mono text-xs">breakFrac 0.79 ≥ 0.75</span>) or was recorded for study — the
              “how each strategy uses it” column tells you which.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-[10px] text-long">3</span>
            <span>
              Check <span className="font-mono text-xs">CARD LABELS &amp; GATES</span>: which overrides were
              active (<span className="font-mono text-xs">gates</span>), was anything vetoed or news-blocked,
              and what labels did the card carry (<span className="font-mono text-xs">aPlus</span>,{" "}
              <span className="font-mono text-xs">firstToday</span>)?
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-[10px] text-long">4</span>
            <span>
              Skim the study-only groups for context — but remember: they describe the weather, they did not
              fire the trade.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-long/40 font-mono text-[10px] text-long">5</span>
            <span>
              Finish with the anatomy: <span className="font-mono text-xs">drift</span>,{" "}
              <span className="font-mono text-xs">mfe/mae</span>,{" "}
              <span className="font-mono text-xs">stopRun</span>,{" "}
              <span className="font-mono text-xs">lossLabel</span> — how the trade actually lived and how it
              died. That is the review data, not the entry data.
            </span>
          </li>
        </ol>
      </div>
    </div>
  );
}
