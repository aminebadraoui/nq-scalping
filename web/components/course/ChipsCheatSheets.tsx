import { Callout } from "@/components/ui";

/* ------------------------------------------------------------------ *
 * Course modules 08–09 lessons — the study-only chips and the cheat
 * sheets. Chips: the journal-only context labels (never gates).
 * Cheat sheets: the one-page checklists to keep open while trading.
 * ------------------------------------------------------------------ */

type ChipFamily = {
  title: string;
  group: string;
  note: string;
  rows: Array<[string, string, string]>;
};

const CHIP_FAMILIES: ChipFamily[] = [
  {
    title: "ES cross-asset — what the S&P twin was doing",
    group: "ES CROSS-ASSET",
    note: "NQ and ES move together; ES is the deeper, calmer twin. These chips describe ES's state around the entry.",
    rows: [
      ["ES CONFIRM 85%", "ES printed a fresh session extreme in the 5 bars before entry", "n=629: 85.2% WR / PF 4.84 — the strongest measured context"],
      ["ES Δ− 68% test", "short card with ES cumulative delta negative at the flush", "the worst cell in every test window — know the headwind, trade the plan"],
      ["RS STRETCH 84%", "NQ stretched against the trade direction over the past hour", "weak-RS longs / strong-RS shorts — measured 84%"],
    ],
  },
  {
    title: "Seasonal — the calendar facts",
    group: "SEASONAL",
    note: "Pure calendar context, measured over all 649 sessions (3,266 sequential trades, 2026-01-01 split).",
    rows: [
      ["FOMC DAY 84%", "the session's RTH day is a Fed decision day", "n=99: 83.8% WR / PF 5.16 — the best cell in the study"],
      ["PRE-FOMC 67%", "the trading day before a decision", "n=138: 67.4% WR / PF 1.64 — the worst cell; stand-aside context"],
      ["HOUR 3–7 ET 80%", "entry hour inside the 3–7 ET prime window", "n=904: 79.8% WR / PF 3.27 — the overnight-drift leg"],
    ],
  },
  {
    title: "Round numbers — the Naso hypotheses",
    group: "ROUND NUMBERS",
    note: "Richie Naso's tape-read claims, logged as falsifiable per-trade features since 2026-10-04. Forward-logged hypotheses, not rules.",
    rows: [
      ["STOP @ROUND", "the structural stop sits within 1 pt of a 50-handle", "Naso: stops parked on the number get swept"],
      ["TARGET CROSSES 50", "a 50-handle lies inside the entry → target path", "the “algos print the number” test"],
      ["ENTRY @ROUND", "the entry printed on a 50-handle", "same family of question"],
      ["GAP IN PATH", "an unfilled price gap intersects the entry → target window", "price magnets inside the profit path"],
      ["GAP FILLED 30m", "a gap half-filled in the last 30 bars", "recent-fill momentum context"],
    ],
  },
  {
    title: "Gamma walls — the dealer levels",
    group: "GAMMA WALLS",
    note: "The nearest QQQ gamma wall in NQ points. Forward-logged only — no historical options archive exists yet.",
    rows: [
      ["WALL IN PATH", "the wall sits inside the profit path", "forward evidence for wall-aware targets"],
      ["WALL nPT", "the wall is within 20 pts", "proximity context"],
      ["PAST WALL", "price already traded through the directional wall", "the wall is behind you"],
    ],
  },
  {
    title: "Kelly + DOM evidence — the research instruments",
    group: "KELLY · DOM EVIDENCE",
    note: "Opt-in lab instruments riding on the cards, never steering them.",
    rows: [
      ["KELLY n t WR → $", "a self-updating edge chip (KELLY_MODE=1)", "journal-only — sizing stays flat $100 unless KELLY_LIVE_USE=1 (never enabled)"],
      ["dom.*", "iceberg candidates vs the ticket at signal time (NQ + ES)", "observational only — candidates / nearEntry / nearStop / nearTarget"],
    ],
  },
];

const CHEAT_SHEETS: Array<{ title: string; items: string[] }> = [
  {
    title: "Pre-trade — every strategy, every time",
    items: [
      "Read the clock first: Globex → momentum · 9:30–16:00 → RTH · 9:30–10:30 → open family",
      "News check: inside a release window, stand down (the feed's blackout would have eaten the card)",
      "Overrides: read the active gates snapshot — family on, hour vetoes, risk caps",
      "Gap check: ≥5 bars since the last signal of the family",
      "Setup bar present with ALL gates cleared — write down the one that failed if it didn't",
      "Brackets computed before the click: entry, stop (3.5 floor applied), target (R-multiple per strategy)",
      "Size = floor(100 ÷ (risk × 2)) micros — never more, never fewer",
      "Journal the inputs at signal time (or confirm the feed's card)",
    ],
  },
  {
    title: "Gate cheat sheet — one line per strategy",
    items: [
      "MOM·flush — ≥70% one-sided flush · no new extreme · ≤10 bars · ≥75% breakout through the reference · ≥1.0×ATR · Globex",
      "MOM·expansion — ≥1.6×ATR · |delta|÷vol ≥0.5 · cluster stack on the trade side · Globex · limit 1 pt behind close ≤5 bars",
      "RTH — ≥60% one-sided · ≥3 dominant clusters · ≥1.0×ATR · ≥0.5×med60 volume · 9:30–16:00 · 0.75R (A+ at ≥65%)",
      "OPEN DRIVE — 9:30–9:59 · new window extreme · cumD ≥±300 · ≥55% one-sided · fixed TP15/SL35",
      "OPEN PULLBACK — 15-bar cumD trend · pullback holds 5-bar low ±0.25 · counter-delta shrank · reclaim close · risk ≤25",
      "OPEN SNIPER — flush ≥max(300, 1.5×15-bar med) · ≥55% toward anchor · |delta| ≥60 · anchor holds · limit anchor ±9.5",
    ],
  },
  {
    title: "In the trade — there is nothing to do",
    items: [
      "Stop and target are both placed — the bracket is complete",
      "No stop widening, no target chasing, no averaging down",
      "A limit entry that never fills expires — that is a valid outcome (expired), not a miss",
      "Log anything unusual for the review; touch nothing",
    ],
  },
  {
    title: "End of day — the review that compounds",
    items: [
      "Day P&L vs the −$250 floor and the +$400 arm — did you follow both?",
      "Every trade's anatomy: drift, MFE/MAE, stop-run, loss class (stop-run / never worked / gave back)",
      "Compare live results vs the module baselines — the Journal's edge monitor does this automatically",
      "Check the account vs the $2,000 end-of-day trailing MLL and the drawdown rule",
      "Mine the pattern: what did the winning cards share? What did the losers share? Propose a gate.",
    ],
  },
];

const NUMBERS: Array<[string, string]> = [
  ["0.30 / 0.70", "flush one-sidedness (long / short)"],
  ["0.75", "breakout one-sidedness (momentum)"],
  ["1.0× ATR14", "candle-size gate (momentum + RTH)"],
  ["1.6× ATR14 · 0.5", "expansion: range gate · |delta|÷vol gate"],
  ["0.60 · 3", "RTH: one-sidedness · dominant clusters"],
  ["0.75R", "RTH target (research bracket)"],
  ["300 · 0.55", "open drive: cum-delta floor · one-sidedness"],
  ["+15 / −35", "open drive: fixed target / stop"],
  ["3.5 pts", "the stop widen floor"],
  ["$100", "dollar risk per trade"],
  ["−$250 · +$400", "daily loss floor · one-more-trade arm"],
  ["$2,000", "end-of-day trailing max loss"],
];

/* ------------------------------------------------ module 08 */

export function ChipsLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        The cards print small labels — ES CONFIRM 85%, FOMC DAY 84%, STOP @ROUND, WALL IN PATH… These are the
        study-role features from the codebook module: context recorded at signal time so the research can
        measure it. One rule covers them all:
      </p>

      <Callout tone="warn" title="The one rule: chips describe the weather — they never decide the trade">
        The day plan trades <b className="text-zinc-100">every card</b>, chip or no chip, A+ or not. A card
        with no chips is still a card; a card with a scary chip (PRE-FOMC 67%) is still a card. The chips
        exist so that a hundred trades from now, the journal can tell you which contexts actually mattered —
        and the miner can propose a gate with evidence. That is their only job.
      </Callout>

      <div className="space-y-4">
        {CHIP_FAMILIES.map((f) => (
          <div key={f.title} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-bold text-zinc-100">{f.title}</h3>
              <span className="font-mono text-[10px] text-zinc-500">
                journal group: {f.group} · study only
              </span>
            </div>
            <p className="mb-3 text-[12px] italic text-zinc-500">{f.note}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    <th className="px-3 py-1.5 font-normal">chip</th>
                    <th className="px-3 py-1.5 font-normal">what it says</th>
                    <th className="px-3 py-1.5 font-normal">what it measured</th>
                  </tr>
                </thead>
                <tbody>
                  {f.rows.map(([c, w, m]) => (
                    <tr key={c} className="border-b border-zinc-800/60 last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-info">{c}</td>
                      <td className="px-3 py-2 text-zinc-300">{w}</td>
                      <td className="px-3 py-2 text-zinc-400">{m}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------ module 09 */

export function CheatSheetsLesson() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
        Everything a live session needs, compressed. Keep the four checklists next to the chart and re-read the
        numbers card until they are reflexes.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {CHEAT_SHEETS.map((c) => (
          <div key={c.title} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-300">{c.title}</h3>
            <ul className="space-y-1.5">
              {c.items.map((i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-zinc-400">
                  <span className="text-zinc-600">·</span>
                  <span>{i}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-300">
          The numbers to memorize
        </h3>
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBERS.map(([n, m]) => (
            <div key={n} className="flex items-baseline justify-between gap-2 border-b border-zinc-900 py-1">
              <span className="font-mono text-sm font-bold text-long">{n}</span>
              <span className="text-right font-mono text-[11px] text-zinc-500">{m}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-zinc-500">
        You have reached the end of the course. The loop from here: the strategy modules for the setups · the
        codebook for every variable · execution for the procedure · risk for the plan · chips for context — and
        the Journal to prove it all, trade by trade.
      </p>
    </div>
  );
}
