import { Callout } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course module 02 lessons — the Momentum strategy (the one trade
 * signal). Two triggers (failed-flush breakout, huge-bar expansion),
 * one ticket, taught act by act with the exact gates and journal keys.
 * Source of truth: PLAYBOOK.md + lib/momentum.ts (MOM_PROD / EXP_PROD).
 * ------------------------------------------------------------------ */

type GateRow = {
  act: string;
  check: React.ReactNode;
  gate: React.ReactNode;
  key: string;
};

const FLUSH_GATES: GateRow[] = [
  {
    act: "1 · FLUSH",
    check: (
      <>
        One minute bar where ≥70% of the volume is <b className="text-zinc-100">selling</b> (for a long setup —
        mirror with ≥70% buying for a short).
      </>
    ),
    gate: <>buy-frac ≤ 0.30 · volume ≥ max(15, min(0.5 × med60, 250))</>,
    key: "flushFrac · flushVol",
  },
  {
    act: "2 · FAILED flush",
    check: (
      <>
        That big push of selling makes <b className="text-zinc-100">no new session low</b>. All that effort, no
        result — the sellers are exhausted. If the flush <i>does</i> break the low, it is a real breakdown: the
        machine resets and waits for a fresh flush.
      </>
    ),
    gate: <>low ≥ session low − 0.5 (tolerance of half a point)</>,
    key: "failDepth",
  },
  {
    act: "3 · BREAKOUT",
    check: (
      <>
        Within the next <b className="text-zinc-100">10 bars</b>, a bar with ≥75% <b className="text-zinc-100">
        buying</b> volume whose high trades <b className="text-zinc-100">through the reference</b> — the max high
        of the flush bar plus the 2 bars before it. Buyers are back in control and taking out the level the
        sellers defended.
      </>
    ),
    gate: <>buy-frac ≥ 0.75 · volume gate again · high &gt; reference · within 10 bars</>,
    key: "breakFrac · breakVol · refDist · respDelay",
  },
  {
    act: "4 · SIZE gate",
    check: (
      <>
        The breakout bar must be a <b className="text-zinc-100">real bar</b> — normal size or bigger. One-sided
        volume in a tiny bar is noise; the studies showed only real-size bars continue.
      </>
    ),
    gate: <>breakout range ≥ 1.0 × ATR14</>,
    key: "breakRangeR · atr14",
  },
];

const WHY_GATES: Array<[string, string]> = [
  ["the flush (≥70% one-sided)", "proves one side actually attacked — 50/50 bars prove nothing"],
  ["the failed flush (no new low)", "effort without result is the whole thesis; a break is a breakdown, not a setup"],
  ["the 10-bar window", "exhaustion decays fast — a breakout minutes later is a different story"],
  ["the breakout (≥75% + through the reference)", "the counter-side must take control AND reclaim the defended level"],
  ["the 1.0 × ATR14 size gate", "filters quiet-bar noise — adopted 2026-10-02 over 0.85× after a 648-session sweep"],
  ["Globex only", "the thick RTH tape never completes 75% bars; the RTH card owns the day session"],
  ["the ≥5-bar gap", "one trade at a time — the replay only ever held one bracket"],
  ["the 3.5-pt stop floor", "stops tighter than 3.5 pts get run; widening them back beats both skipping and trading them raw"],
];

const MOM_STATS: Array<[string, string]> = [
  ["Flush trigger (validation)", "1,828 trades · 76.1% WR · PF 2.76"],
  ["Expansion trigger (validation)", "4,152 sequential trades · 78.4% WR · PF 3.14"],
  ["Combined card", "4,822 trades · 77.5% WR · PF 2.98 · +11,680 pts net"],
  ["Per year", "2024 80.0% · 2025 75.3% · 2026 (out-of-sample) 77.9%"],
  ["By direction", "long 78.5% (PF 3.08) · short 76.4% (PF 2.88)"],
  ["First card of the day", "77.2% WR · PF 3.15 (marked “1st today”)"],
];

/* ------------------------------------------------ lesson 1: the flush story */

export function FlushStoryLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        This is the system&rsquo;s flagship trade. It fires only in Globex (18:00–9:30 ET; the 9:30–16:00 day session
        is excluded). Two triggers feed one ticket — learn trigger A (the failed-flush breakout) act by act
        first, then trigger B.
      </p>

      <Callout tone="info" title="Window: Globex only">
        18:00 → 9:30 ET. The day session is excluded because its thick two-way tape almost never completes a
        75% one-sided bar — the momentum gates are written for the thinner, more directional overnight tape. If
        it is 9:30–16:00 and you are trading this card, you are in the wrong window (that is the RTH card&rsquo;s job
        — the next module).
      </Callout>

      <h3 className="pt-2 text-base font-bold text-zinc-50">
        Trigger A — the failed-flush breakout <span className="font-mono text-xs text-zinc-500">MOM·flush</span>
      </h3>
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        A four-act story, told for a <b className="text-zinc-200">long</b>. Shorts are the exact mirror (≥70%
        buying flush that makes no new high → ≤25% selling breakout that trades through the reference low).
        Every act maps to one row in the card&rsquo;s <span className="font-mono text-xs">SIGNAL INPUTS</span>.
      </p>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[720px] text-left align-top text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">act</th>
              <th className="px-4 py-2 font-normal">what you are looking at</th>
              <th className="px-4 py-2 font-normal">the gate</th>
              <th className="px-4 py-2 font-normal">journal key</th>
            </tr>
          </thead>
          <tbody>
            {FLUSH_GATES.map((g) => (
              <tr key={g.act} className="border-b border-zinc-800/60 last:border-0">
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-long">{g.act}</td>
                <td className="px-4 py-3 leading-relaxed text-zinc-300">{g.check}</td>
                <td className="px-4 py-3 font-mono text-xs leading-relaxed text-info">{g.gate}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-500">{g.key}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["ENTRY", "at the breakout bar's close — not inside the bar"],
          ["STOP", "the breakout bar's low − 0.5 (short: high + 0.5)"],
          ["TARGET", "1R — entry + 1 × the entry-to-stop distance"],
          ["RISK", "3.5–30 pts after the widen floor · ≥5-bar gap between signals"],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="font-mono text-[10px] text-long">{k}</p>
            <p className="text-sm text-zinc-200">{v}</p>
          </div>
        ))}
      </div>

      <Callout tone="warn" title="The widen floor — the one deliberate exception to structural stops">
        If the structural stop lands closer than 3.5 pts from the entry, widen it to entry ∓ 3.5 and let the 1R
        target follow. The measurement: the 3–4 pt zone is the weak zone (PF 1.87 vs 2.75) — its stops get swept
        by noise. Widening them back to 3.5 beats both skipping the trade and trading it raw. Stops under 3 pts{" "}
        <i>never</i> trade, and floors past ~4 pts only add risk without edge. Everywhere else the stop stays
        structural: the bar&rsquo;s own extreme, not your comfort level.
      </Callout>
    </div>
  );
}

/* ------------------------------------------------ lesson 2: worked example */

export function FlushExampleLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        Put the four acts together on a real-looking tape. Below is a long from start to bracket — then the
        table of <i>why each gate exists</i>, so you are never following a rule you do not understand.
      </p>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">
          worked example — a long from start to bracket
        </h4>
        <div className="space-y-2 font-mono text-xs leading-relaxed">
          <p className="text-zinc-400">
            <span className="text-zinc-500">tape:</span> session low 21,150.00 · med60 volume 500 · ATR14 7.0 pts
          </p>
          <p className="text-zinc-300">
            <span className="text-long">21:14 flush bar</span> — 480 contracts, 80% sells, buy-frac 0.20 ✓
            (≤0.30) · volume 480 ✓ (≥250) · low 21,150.50 vs session low 21,150.00 → no new low ✓ (missed it by
            0.5) <span className="text-zinc-500">· failDepth = 0.5</span>
          </p>
          <p className="text-zinc-300">
            <span className="text-long">21:16 breakout bar</span> — 420 contracts, 78.6% buys, buy-frac 0.79 ✓
            (≥0.75) · 2 bars after the flush ✓ (≤10) · high 21,178 trades through the reference 21,175 ✓{" "}
            <span className="text-zinc-500">· refDist = +3</span> · range 9.5 ÷ ATR 7.0 = 1.36× ✓ (≥1.0)
          </p>
          <p className="text-zinc-200">
            bracket: entry 21,177.00 (the close) · stop 21,168.50 − 0.5 = 21,168.00 · risk 9.0 pts · target 1R =
            21,186.00
          </p>
          <p className="text-zinc-300">
            size (the sizing lesson): floor(100 ÷ (9 × 2)) = <span className="text-long">5 MNQ</span> · dollar
            risk $90 · a win pays +$90
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">why this gate exists</th>
              <th className="px-4 py-2 font-normal">what it filters out</th>
            </tr>
          </thead>
          <tbody>
            {WHY_GATES.map(([g, w]) => (
              <tr key={g} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-3 text-zinc-300">{g}</td>
                <td className="px-4 py-3 text-zinc-400">{w}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout tone="info" title="How this connects to the Journal">
        Open any momentum trade in the Journal and expand <i>variables at signal time</i>. The{" "}
        <span className="font-mono text-xs text-long">SIGNAL INPUTS</span> group holds every number from the two
        tables above — <span className="font-mono text-xs">flushFrac</span>,{" "}
        <span className="font-mono text-xs">failDepth</span>, <span className="font-mono text-xs">breakFrac</span>,{" "}
        <span className="font-mono text-xs">breakRangeR</span> — so you can re-run each gate by eye. The codebook
        module decodes the whole group, key by key.
      </Callout>
    </div>
  );
}

/* ------------------------------------------------ lesson 3: expansion + labels */

export function ExpansionLabelsLesson() {
  return (
    <div className="space-y-4">
      <h3 className="pt-2 text-base font-bold text-zinc-50">
        Trigger B — the huge-bar expansion <span className="font-mono text-xs text-zinc-500">MOM·expansion</span>
      </h3>
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        No flush needed — a single bar so big and so one-sided that it is an event on its own. Same Globex
        window, same bracket math, smaller risk band.
      </p>

      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/60">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2 font-normal">check</th>
              <th className="px-4 py-2 font-normal">the gate</th>
              <th className="px-4 py-2 font-normal">journal key</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["A genuinely huge bar", "range ≥ 1.6 × ATR14", "breakRangeR"],
              ["Lopsided aggression", "|delta| ÷ volume ≥ 0.5 (≥75% one-sided)", "deltaFrac"],
              ["Tick-level proof on the trade side", "≥3 dominant cluster rows (≥3 lots, ≥2:1)", "breakStack"],
              ["Real volume", "≥ max(15, min(0.5 × med60, 250))", "breakVol · medVol"],
              ["Globex hours only", "9:30–16:00 ET excluded", "hourET"],
            ].map(([c, g, k]) => (
              <tr key={k} className="border-b border-zinc-800/60 last:border-0">
                <td className="px-4 py-3 text-zinc-300">{c}</td>
                <td className="px-4 py-3 font-mono text-xs text-info">{g}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-500">{k}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        Brackets: entry at the close, stop under the bar − 0.5, target 1R, risk 3.5–15 pts (floor-widened).
        Live, this card no longer market-fills: it rests a <b className="text-zinc-200">1-pt limit behind the
        close for up to 5 bars</b> and rebuilds the brackets from the fill — measured 68% WR, PF 1.29 on the
        entry-quality study. The journal&rsquo;s <span className="font-mono text-xs">retrace</span> key records the
        limit&rsquo;s lifecycle: <span className="font-mono text-xs">filled · expired · void · news-blocked · crossed-stop</span>.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h4 className="mb-2 text-sm font-bold text-zinc-100">The labels — A+ and 1st today</h4>
          <p className="text-[13px] leading-relaxed text-zinc-400">
            When <b className="text-zinc-200">both triggers fire on the same bar</b>, the card prints{" "}
            <span className="font-mono text-xs text-long">A+</span> — the highest-conviction subset, measured
            78.9% WR / PF 3.23. The day&rsquo;s first momentum card is marked{" "}
            <span className="font-mono text-xs">1st today</span> (77.2% WR, PF 3.15).{" "}
            <b className="text-zinc-100">These are labels, not gates</b> — the day plan trades every card, A+ or
            not (the risk module).
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h4 className="mb-2 font-mono text-xs uppercase tracking-wider text-zinc-400">backtest findings</h4>
          <ul className="space-y-1.5">
            {MOM_STATS.map(([l, v]) => (
              <li key={l} className="flex gap-3 text-[13px]">
                <span className="w-40 shrink-0 font-mono text-[11px] text-zinc-500">{l}</span>
                <span className="text-zinc-200">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
