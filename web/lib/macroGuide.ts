/* ------------------------------------------------------------------ *
 * Macro guide — the STATIC interpretation layer of the Macro tab.
 *
 * Pure data, no feeds, no DB: one family per metric group, one guide
 * entry per metric describing (a) what the number is, (b) what it
 * means when it is up, (c) what it means when it is down — or, for
 * non-directional metrics (calendar/proximity), how to read it — and
 * (d) the impact on reading NQ. Plus the news-event catalog: for
 * every scheduled US release, what it measures, why NQ cares, and
 * what a market-friendly vs market-hostile result means.
 *
 * Consumed by:
 *   - lib/interpretText.ts (deterministic fallback + DeepSeek payload)
 *   - components/MacroInterpretation.tsx (the always-visible guides)
 *   - components/NewsCalendarPanel.tsx (per-event explanations)
 * DISPLAY-ONLY — never imported by signal/executor code.
 * ------------------------------------------------------------------ */

export type MetricFamily =
  | "risk"
  | "rates"
  | "fx-equities"
  | "commodities"
  | "crypto"
  | "liquidity"
  | "calendar"
  | "structure";

export type FamilyDef = {
  id: MetricFamily;
  label: string;
  /** one line: what this family of metrics is about */
  blurb: string;
};

export type MetricGuide = {
  id: string;
  family: MetricFamily;
  label: string;
  /** what this number IS, one line */
  what: string;
  /** what it means when it is up / high (null when non-directional) */
  up: string | null;
  /** what it means when it is down / low (null when non-directional) */
  down: string | null;
  /** how to read a non-directional metric (null when up/down apply) */
  read: string | null;
  /** the impact on READING NQ — what this metric means for the NQ tape */
  nqImpact: string;
  /** whether an UP state votes risk-on, a DOWN state votes risk-on, or
   *  neither (used by the deterministic stance counter) */
  riskOnWhen: "up" | "down" | null;
};

export const FAMILIES: FamilyDef[] = [
  { id: "risk", label: "Risk & vol", blurb: "the fear gauge + dealer gamma: how big the moves are, and whether dealers damp or amplify them" },
  { id: "rates", label: "Rates", blurb: "the curve + the Fed: the discount rate that prices every long-duration asset" },
  { id: "fx-equities", label: "FX & equities", blurb: "the dollar + the indexes: risk appetite, breadth and leadership" },
  { id: "commodities", label: "Commodities", blurb: "gold + crude: the haven bid and the growth/inflation tell" },
  { id: "crypto", label: "Crypto", blurb: "bitcoin: the purest risk-appetite barometer" },
  { id: "liquidity", label: "Liquidity & positioning", blurb: "Fed balance sheet, reserves, credit spreads and spec positioning: the plumbing" },
  { id: "calendar", label: "Calendar & events", blurb: "OPEX, auctions, FOMC, news and earnings: the scheduled vol events" },
  { id: "structure", label: "Structure", blurb: "the system's own archive: HTF swing structure + the gap/bias layer" },
];

export const METRIC_GUIDES: MetricGuide[] = [
  /* ---------------- risk ------------------------------------------- */
  {
    id: "vix.level", family: "risk", label: "VIX", riskOnWhen: "down",
    what: "the fear gauge: SPX 30-day implied volatility",
    up: "fear is being priced — vol expands, moves get bigger both ways",
    down: "complacency — options are cheap, ranges compress, dips get bought",
    nqImpact: "the vol budget for NQ scalps — low VIX = tight ranges that mean-revert, high VIX = wide stops and trend days",
    read: null,
  },
  {
    id: "vix.pct1y", family: "risk", label: "VIX 1y pctile", riskOnWhen: "down",
    what: "where today's VIX sits inside the last year's distribution",
    up: "fear regime — rallies get sold, protection is the crowded trade",
    down: "calm regime — the fragility is one-sided positioning",
    nqImpact: "the regime tell — extreme calm (low pctile) means NQ dips get bought until a shock; extreme fear means NQ rallies get sold",
    read: null,
  },
  {
    id: "vix.term9d", family: "risk", label: "VIX 9d", riskOnWhen: "down",
    what: "9-day implied volatility",
    up: "near-term event fear — this week's calendar is priced hot",
    down: "no event premium — the week is expected quiet",
    nqImpact: "a spike in 9d vs spot VIX warns the week's calendar owns the NQ tape — expect event-driven chop",
    read: null,
  },
  {
    id: "vix.term3m", family: "risk", label: "VIX 3m", riskOnWhen: "down",
    what: "3-month implied volatility",
    up: "protection bid further out — a longer-fuse worry",
    down: "the market sees smooth months ahead",
    nqImpact: "rising 3m while spot VIX is calm = the market hedges a future NQ drop — rallies are rented, not owned",
    read: null,
  },
  {
    id: "vix.rangePct", family: "risk", label: "VIX 1σ day", riskOnWhen: null,
    what: "the expected daily move, VIX ÷ 16",
    up: "wider expected range — size stops and targets up",
    down: "tight expected range — scalps get smaller",
    nqImpact: "the expected daily NQ range in % — it sets the session's realistic stop and target size",
    read: null,
  },
  {
    id: "gex.regime", family: "risk", label: "GEX regime", riskOnWhen: null,
    what: "dealer gamma posture: CHOP pins, TREND amplifies",
    up: null,
    down: null,
    read: "CHOP = dealers damp moves toward the flip · TREND = dealers amplify moves away from it",
    nqImpact: "CHOP pins NQ near the flip (fade the edges), TREND lets NQ runs extend (follow the move)",
  },
  {
    id: "gex.flipDist", family: "risk", label: "GEX flip", riskOnWhen: "down",
    what: "QQQ points from spot to the zero-gamma flip",
    up: "spot is below the flip — dealers sell into weakness, dips accelerate",
    down: "spot is above the flip — dealers lean with the bid",
    nqImpact: "NQ below the flip = dips accelerate into dealer selling; above it = pullbacks get supported",
    read: null,
  },
  {
    id: "gex.callWall", family: "risk", label: "Call wall", riskOnWhen: "up",
    what: "QQQ points up to the call wall",
    up: "room above before overhead gamma caps the rally",
    down: "the magnet overhead — rallies stall into it",
    nqImpact: "the overhead magnet: NQ rallies stall and fade into the call wall",
    read: null,
  },
  {
    id: "gex.putWall", family: "risk", label: "Put wall", riskOnWhen: "up",
    what: "QQQ points down to the put wall",
    up: "support close below — selloffs slow into it",
    down: "no nearby gamma floor — gap-downs have room",
    nqImpact: "the floor under NQ: selloffs slow into the put wall; without one nearby, gap-downs have room",
    read: null,
  },

  /* ---------------- rates ------------------------------------------ */
  {
    id: "rates.y2", family: "rates", label: "2Y", riskOnWhen: "down",
    what: "the policy tenor: where the market prices the Fed",
    up: "hawkish repricing — higher-for-longer, a headwind for NDX multiples",
    down: "dovish repricing — cuts being priced, supports growth",
    nqImpact: "the 2Y reprices the Fed — it drives the discount rate on NQ's long-duration growth names",
    read: null,
  },
  {
    id: "rates.y10", family: "rates", label: "10Y", riskOnWhen: "down",
    what: "the global discount rate",
    up: "tighter financial conditions — long-duration growth gets repriced",
    down: "easier conditions — valuations get support",
    nqImpact: "the 10Y is NQ's gravity — rising yields compress NQ multiples, falling yields lift them",
    read: null,
  },
  {
    id: "rates.y30", family: "rates", label: "30Y", riskOnWhen: "down",
    what: "the long end: inflation expectations + term premium",
    up: "inflation / term-premium fear — bond-vigilante regime",
    down: "long-end demand — no inflation scare",
    nqImpact: "a rising 30Y = bond-vigilante regime that caps NQ upside no matter what the tape does",
    read: null,
  },
  {
    id: "rates.spread210", family: "rates", label: "2s10s", riskOnWhen: "up",
    what: "the curve slope (10Y − 2Y)",
    up: "steepening — growth being priced, a risk-on confirmation",
    down: "inverting — slowdown / recession pricing",
    nqImpact: "steepening = growth priced (NQ-friendly); inversion = slowdown fear that keeps a lid on NQ rallies",
    read: null,
  },
  {
    id: "rates.spread103m", family: "rates", label: "10y−3m", riskOnWhen: "up",
    what: "the classic recession gauge (10Y − 3M)",
    up: "healthy — expansion is priced",
    down: "inverted — recession warning, the Fed is tight",
    nqImpact: "the recession gauge — while it is inverted, NQ rallies are treated as bear-market bounces",
    read: null,
  },
  {
    id: "rates.real10y", family: "rates", label: "10Y real", riskOnWhen: "down",
    what: "nominal minus breakevens: the real cost of capital",
    up: "tighter real conditions — semis and growth feel it first",
    down: "easy real money — risk assets get support",
    nqImpact: "real rates are the true cost of capital — up = semis and growth sell first and NQ follows",
    read: null,
  },
  {
    id: "rates.breakeven10y", family: "rates", label: "Breakevens", riskOnWhen: null,
    what: "market-implied 10y inflation",
    up: "inflation worry — check commodities for confirmation",
    down: "disinflation — supports the cut case",
    nqImpact: "hot breakevens force the Fed hawkish — bad for NQ multiples even when growth is fine",
    read: null,
  },
  {
    id: "rates.ffrImpled", family: "rates", label: "FFR implied", riskOnWhen: "down",
    what: "the policy rate implied by front fed-funds futures",
    up: "fewer cuts priced — hawkish",
    down: "cuts priced — dovish",
    nqImpact: "what the market prices the Fed to do — dovish repricing is a direct NQ tailwind",
    read: null,
  },
  {
    id: "rates.effr", family: "rates", label: "EFFR", riskOnWhen: "down",
    what: "the actual effective fed funds rate",
    up: "the stance itself — tight money is the backdrop",
    down: "the stance itself — easing is the backdrop",
    nqImpact: "the actual policy stance — the baseline gravity every NQ valuation trades against",
    read: null,
  },
  {
    id: "rates.y10ChangeBps", family: "rates", label: "10Y day Δ", riskOnWhen: "down",
    what: "today's change in the 10Y yield, in basis points",
    up: "yields leaking higher today — equities under pressure",
    down: "yields easing today — a bid for risk",
    nqImpact: "today's yield move — NQ usually trades inversely to it intraday",
    read: null,
  },

  /* ---------------- fx & equities ---------------------------------- */
  {
    id: "dxy", family: "fx-equities", label: "DXY", riskOnWhen: "down",
    what: "the dollar index",
    up: "strong dollar — tightens global liquidity, an NQ headwind",
    down: "weak dollar — risk-on, supports EM and NQ",
    nqImpact: "dollar up = global liquidity tightens = NQ headwind; dollar down = risk-on fuel for NQ",
    read: null,
  },
  {
    id: "spx", family: "fx-equities", label: "S&P 500", riskOnWhen: "up",
    what: "the broad tape",
    up: "broad risk-on",
    down: "broad risk-off",
    nqImpact: "the broad tape confirms or denies NQ's own move — divergence is the early warning",
    read: null,
  },
  {
    id: "ndx", family: "fx-equities", label: "Nasdaq-100", riskOnWhen: "up",
    what: "NQ's cash twin",
    up: "growth bid — NQ follows",
    down: "growth offered — NQ under pressure",
    nqImpact: "NQ's cash twin — it leads NQ at the turns, watch it when NQ stalls",
    read: null,
  },
  {
    id: "sox", family: "fx-equities", label: "SOX semis", riskOnWhen: "up",
    what: "the semiconductor index",
    up: "semis leading — the AI/growth leadership is intact",
    down: "semis weak — the leadership question for the tape",
    nqImpact: "semis are NQ's engine — SOX leads NQ direction at the margin",
    read: null,
  },
  {
    id: "spy", family: "fx-equities", label: "SPY", riskOnWhen: "up",
    what: "the S&P 500 ETF",
    up: "index ETFs confirm the bid",
    down: "index ETFs confirm the offer",
    nqImpact: "ETF flow confirmation of the cash tape NQ trades against",
    read: null,
  },
  {
    id: "rsp", family: "fx-equities", label: "RSP eq-wt", riskOnWhen: "up",
    what: "equal-weight S&P 500",
    up: "broad participation — a healthy tape",
    down: "narrow tape — only the mega caps move",
    nqImpact: "equal-weight breadth — narrow (weak RSP) NQ rallies fade more often than broad ones",
    read: null,
  },
  {
    id: "smh", family: "fx-equities", label: "SMH semis", riskOnWhen: "up",
    what: "the semis ETF",
    up: "semis bid — NQ's engine is running",
    down: "semis offered — the engine sputters",
    nqImpact: "the semis ETF — same leadership tell as SOX for the NQ tape",
    read: null,
  },
  {
    id: "qqq", family: "fx-equities", label: "QQQ", riskOnWhen: "up",
    what: "the Nasdaq-100 ETF",
    up: "large-cap growth bid — NQ's anchor",
    down: "growth offered — NQ drifts lower",
    nqImpact: "the anchor — QQQ flow is the closest liquid proxy to NQ",
    read: null,
  },

  /* ---------------- commodities ------------------------------------ */
  {
    id: "gold", family: "commodities", label: "Gold", riskOnWhen: null,
    what: "the haven + inflation hedge",
    up: "haven bid or inflation hedge — with yields down at the same time, it is stress",
    down: "no haven demand — real rates dominate",
    nqImpact: "gold up + yields down = stress hedge (risk-off for NQ); gold up + yields up = inflation regime",
    read: null,
  },
  {
    id: "wti", family: "commodities", label: "WTI crude", riskOnWhen: "up",
    what: "the growth / inflation tell",
    up: "growth demand or a supply shock — sharp spikes are an inflation headwind",
    down: "demand worry — a growth scare",
    nqImpact: "crude spikes = inflation headwind for NQ; demand-worry drops = growth scare that hits NQ too",
    read: null,
  },

  /* ---------------- crypto ----------------------------------------- */
  {
    id: "btc", family: "crypto", label: "Bitcoin", riskOnWhen: "up",
    what: "the purest risk-appetite barometer",
    up: "risk appetite — crypto leads risk-on",
    down: "risk-off — leverage comes out",
    nqImpact: "crypto leads risk appetite — BTC turning down is an early risk-off tell for NQ",
    read: null,
  },

  /* ---------------- liquidity & positioning ------------------------ */
  {
    id: "fred.walcl", family: "liquidity", label: "Fed B/S", riskOnWhen: "up",
    what: "the Fed's balance sheet size",
    up: "QE — reserves added, a liquidity tailwind",
    down: "QT — liquidity draining, a tighter backdrop",
    nqImpact: "the Fed balance sheet is the liquidity tide NQ floats on — QT drains it",
    read: null,
  },
  {
    id: "fred.rrp", family: "liquidity", label: "RRP", riskOnWhen: "down",
    what: "cash parked at the Fed's reverse repo",
    up: "excess liquidity sitting idle at the Fed",
    down: "reserves being redeployed — money flowing toward markets",
    nqImpact: "an RRP drain = reserves moving back into markets = liquidity fuel for NQ",
    read: null,
  },
  {
    id: "fred.tga", family: "liquidity", label: "TGA", riskOnWhen: "down",
    what: "the Treasury's checking account",
    up: "Treasury hoarding cash — drains reserves, liquidity negative",
    down: "Treasury spending down — adds reserves, liquidity positive",
    nqImpact: "TGA builds drain bank reserves (an NQ liquidity headwind); TGA draws add them",
    read: null,
  },
  {
    id: "fred.hyOas", family: "liquidity", label: "HY OAS", riskOnWhen: "down",
    what: "the high-yield credit spread",
    up: "credit stress — risk-off at the margin",
    down: "credit calm — risk appetite intact",
    nqImpact: "credit stress is the early crack — HY widening usually precedes NQ drawdowns",
    read: null,
  },
  {
    id: "cot.netPctOi", family: "liquidity", label: "COT net", riskOnWhen: null,
    what: "spec net position as % of open interest (Nasdaq-100)",
    up: "specs very long — crowded; extremes are contrarian",
    down: "specs short — washed out; contrarian support",
    nqImpact: "spec crowding — an extreme long book makes NQ rallies fragile; an extreme short book is squeeze fuel",
    read: null,
  },
  {
    id: "cot.pct52w", family: "liquidity", label: "COT 52w", riskOnWhen: null,
    what: "where the spec net position sits in its 52-week range",
    up: "positioning near its 52w max — crowded long",
    down: "positioning near its 52w min — max pessimism",
    nqImpact: "the percentile tells how crowded the NDX spec book is — extremes are contrarian for NQ",
    read: null,
  },

  /* ---------------- calendar & events ------------------------------ */
  {
    id: "calendar.opex", family: "calendar", label: "OPEX", riskOnWhen: null,
    what: "days to the monthly options expiry (3rd Friday)",
    up: null,
    down: null,
    read: "≤2 days left: pinning / suppression risk, vol flattens — quad witching is the big one",
    nqImpact: "OPEX proximity = NQ pinning risk toward the big strikes — trend days get muted",
  },
  {
    id: "calendar.auctions", family: "calendar", label: "Auctions", riskOnWhen: null,
    what: "the next Treasury coupon auctions",
    up: null,
    down: null,
    read: "supply hitting the long end — auction days can push yields up",
    nqImpact: "long-end supply pressure can lift yields into NQ's open",
  },
  {
    id: "calendar.fomcMinutes", family: "calendar", label: "FOMC mins", riskOnWhen: null,
    what: "days to the next FOMC minutes release",
    up: null,
    down: null,
    read: "policy repricing risk — bonds move on the tone",
    nqImpact: "minutes repricing risk — NQ chops around the release",
  },
  {
    id: "news.next", family: "calendar", label: "Next release", riskOnWhen: null,
    what: "the next US economic release",
    up: null,
    down: null,
    read: "high-impact prints (CPI/NFP/FOMC) own the minutes around release — the pulse line shows the countdown",
    nqImpact: "the countdown that matters — high-impact prints own NQ's minutes around the release",
  },
  {
    id: "earnings.next", family: "calendar", label: "Next earnings", riskOnWhen: null,
    what: "the next Nasdaq-100 mega-cap print",
    up: null,
    down: null,
    read: "mega-caps move the NDX after hours — the week's gap risk",
    nqImpact: "a mega-cap print gaps NQ after hours — the session's gap risk",
  },

  /* ---------------- structure -------------------------------------- */
  {
    id: "htf.daily", family: "structure", label: "HTF daily", riskOnWhen: "up",
    what: "daily swing structure from the system's own archive",
    up: "HH/HL — higher highs and lows: the uptrend owns the structure",
    down: "LH/LL — lower highs and lows: the downtrend owns it",
    read: "CHOP — no clean swing sequence: both sides are in range",
    nqImpact: "the daily structure is the map — NQ scalps with the HH/HL or LH/LL flow win more than against it",
  },
  {
    id: "htf.weekly", family: "structure", label: "HTF weekly", riskOnWhen: "up",
    what: "weekly swing structure",
    up: "HH/HL — the slow trend is up",
    down: "LH/LL — the slow trend is down",
    read: "CHOP — no clean weekly sequence",
    nqImpact: "the slow trend under the daily — NQ mean-reverts toward it",
  },
  {
    id: "bias.score", family: "structure", label: "Structure score", riskOnWhen: "up",
    what: "the signed subtotal of the ALN / gap / prior-day / VIX chips",
    up: "the structure layer leans long",
    down: "the structure layer leans short",
    nqImpact: "the structure layer's precomputed lean — positive = the session's first NQ move tilts long",
    read: null,
  },
  {
    id: "bias.gapPct", family: "structure", label: "Gap %", riskOnWhen: "up",
    what: "the overnight gap vs the prior RTH close",
    up: "gapped up — the regime chip says whether to fade or follow",
    down: "gapped down — the regime chip says whether to fade or follow",
    nqImpact: "the overnight gap sets the session's opening NQ range and the first trade's direction",
    read: null,
  },
  {
    id: "bias.gapRegime", family: "structure", label: "Gap regime", riskOnWhen: null,
    what: "the measured fade / continuation cell for this gap size",
    up: null,
    down: null,
    read: "small → fade toward the prior close · large → follow the gap (VIX-gated) · mid → no default",
    nqImpact: "tells whether the NQ open fades or follows the gap — the highest-base-rate opening rule on the card",
  },
  {
    id: "bias.fadeOk", family: "structure", label: "Fade gate", riskOnWhen: "up",
    what: "the VIX fade gate",
    up: "vol calm enough to fade the gap",
    down: "too volatile — fades are coin flips",
    nqImpact: "the vol gate — when it is off, fading the NQ gap is a coin flip",
    read: null,
  },
  {
    id: "bias.sideLean", family: "structure", label: "Side cells", riskOnWhen: null,
    what: "measured one-sided rules from the trade replay",
    up: null,
    down: null,
    read: "only-longs / only-shorts cells from the card's own replay — advisory, never a gate",
    nqImpact: "measured one-sided cells — journal facts that tilt the first NQ move",
  },
];

const GUIDE_BY_ID = new Map(METRIC_GUIDES.map((g) => [g.id, g]));
const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

export const guideFor = (id: string): MetricGuide | undefined => GUIDE_BY_ID.get(id);
export const familyFor = (id: MetricFamily): FamilyDef => FAMILY_BY_ID.get(id) ?? { id, label: id, blurb: "" };

/* ------------------------------------------------------------------ *
 * news-event catalog — one guide per scheduled US release family.
 * `goodWhen`: which side of the forecast is GOOD for equities
 * (higher = a stronger print helps, lower = a cooler print helps,
 * null = no mechanical direction — the mix matters).
 * ------------------------------------------------------------------ */

export type NewsEventGuide = {
  pattern: RegExp;
  /** what the release measures */
  what: string;
  /** why NQ cares */
  nqImpact: string;
  /** what a market-friendly result means for NQ */
  goodForNq: string;
  /** what a market-hostile result means for NQ */
  badForNq: string;
  /** which side of the forecast is equity-friendly */
  goodWhen: "higher" | "lower" | null;
};

export const NEWS_EVENT_GUIDES: NewsEventGuide[] = [
  {
    pattern: /FOMC|Federal Funds Rate|Interest Rate Decision/i,
    what: "the Fed's rate decision, statement and press conference",
    nqImpact: "the policy event of the quarter — the press-conference tone owns NQ's afternoon",
    goodForNq: "dovish: a cut or a dovish hold — NQ rallies through the presser",
    badForNq: "hawkish: a hold with hawkish dots or a hike — NQ sells the statement",
    goodWhen: null,
  },
  {
    pattern: /Speaks|Testimony/i,
    what: "a Fed official's public remarks",
    nqImpact: "tone risk — a hawkish surprise can move NQ intraday without warning",
    goodForNq: "dovish tone (cuts or pain acknowledged) — an NQ tailwind",
    badForNq: "hawkish tone (higher-for-longer) — an NQ headwind",
    goodWhen: null,
  },
  {
    pattern: /Nonfarm|NFP|Employment Situation|Payrolls/i,
    what: "the monthly jobs report: payrolls, unemployment and wages",
    nqImpact: "the other #1 NQ mover — too hot is hawkish, too cold is recession",
    goodForNq: "goldilocks: solid-but-not-hot payrolls with tame wages — NQ bids the soft landing",
    badForNq: "either extreme — hot wages force the Fed hawkish; collapsing payrolls scream recession",
    goodWhen: null,
  },
  {
    pattern: /CPI/i,
    what: "inflation in consumer prices — the Fed's #1 input",
    nqImpact: "the single biggest NQ mover of the month — a hot print kills the cut case and compresses NQ multiples",
    goodForNq: "a cool print (at or below forecast) — cuts stay priced, NQ rallies on the relief",
    badForNq: "a hot print — hawkish repricing, NQ gaps down and semis lead the drop",
    goodWhen: "lower",
  },
  {
    pattern: /PCE/i,
    what: "the Fed's preferred inflation gauge",
    nqImpact: "the inflation print the Fed actually targets — second only to CPI for NQ",
    goodForNq: "cool PCE — cuts stay alive, NQ bids",
    badForNq: "hot PCE — hawkish repricing, NQ offered",
    goodWhen: "lower",
  },
  {
    pattern: /PPI/i,
    what: "pipeline inflation at the producer level",
    nqImpact: "the early-warning CPI — a hot PPI leaks into next month's CPI fears",
    goodForNq: "cool PPI — the disinflation story is intact, NQ bids",
    badForNq: "hot PPI — a stagflation scare, NQ under pressure",
    goodWhen: "lower",
  },
  {
    pattern: /Average Hourly Earnings/i,
    what: "wage growth inside the jobs report",
    nqImpact: "the inflation part of NFP — hot wages kill the cut case",
    goodForNq: "tame wages — the labor market cools without layoffs",
    badForNq: "hot wages — wage-price spiral fear",
    goodWhen: "lower",
  },
  {
    pattern: /Retail Sales/i,
    what: "consumer spending — roughly 70% of US GDP",
    nqImpact: "the growth pulse — strong retail means the soft-landing bid holds for NQ",
    goodForNq: "stronger than forecast — growth confirmed, NQ bids",
    badForNq: "weaker than forecast — the consumer is cracking, NQ offered",
    goodWhen: "higher",
  },
  {
    pattern: /Unemployment Claims|Jobless Claims|Initial Claims/i,
    what: "weekly layoffs — the fastest labor-market tell",
    nqImpact: "a 30-second NQ mover every Thursday at 08:30",
    goodForNq: "claims fall — the labor market holds, NQ bids the soft landing",
    badForNq: "claims spike — layoffs rising, hard-landing fear, NQ offered",
    goodWhen: "lower",
  },
  {
    pattern: /Philly Fed|Empire State|Richmond Fed|Dallas Fed|Kansas City Fed/i,
    what: "a regional manufacturing survey",
    nqImpact: "an early ISM proxy — a mild NQ mover at 08:30",
    goodForNq: "expansion above forecast — manufacturing is stabilizing, a mild NQ tailwind",
    badForNq: "contraction — factory weakness, a mild NQ headwind",
    goodWhen: "higher",
  },
  {
    pattern: /ISM Manufacturing|ISM Services|S&P Global|PMI/i,
    what: "business activity surveys",
    nqImpact: "the growth dial between jobs reports — NQ reacts to the direction",
    goodForNq: "expansion above forecast — a growth bid",
    badForNq: "contraction — slowdown fear, NQ offered",
    goodWhen: "higher",
  },
  {
    pattern: /GDP/i,
    what: "quarterly economic growth",
    nqImpact: "the growth baseline — revisions move NQ more than the headline",
    goodForNq: "solid growth without overheating — the soft-landing bid",
    badForNq: "stagnation or overheating — stagflation fear, NQ offered",
    goodWhen: null,
  },
  {
    pattern: /Consumer Confidence|Consumer Sentiment|Michigan/i,
    what: "consumer mood surveys",
    nqImpact: "the sentiment side of the consumer — the expectations sub-index matters more than the headline",
    goodForNq: "confidence holding up — the consumer is intact",
    badForNq: "confidence sliding — a spending fear",
    goodWhen: "higher",
  },
  {
    pattern: /Housing Starts|Building Permits/i,
    what: "new residential construction",
    nqImpact: "rate-sensitive housing — more a rates tell than a direct NQ mover",
    goodForNq: "stable activity — no housing crack",
    badForNq: "a collapse — housing-led slowdown fear",
    goodWhen: "higher",
  },
  {
    pattern: /New Home Sales|Existing Home Sales|Pending Home Sales/i,
    what: "housing market activity",
    nqImpact: "the rates-transmission channel — a minor NQ mover",
    goodForNq: "steady sales — housing is stable",
    badForNq: "a sales slump — rates are biting",
    goodWhen: "higher",
  },
  {
    pattern: /Durable Goods/i,
    what: "big-ticket factory orders",
    nqImpact: "a capex proxy — a minor NQ mover, more relevant for industrials",
    goodForNq: "orders strong — the capex cycle is alive",
    badForNq: "orders weak — a capex pause",
    goodWhen: "higher",
  },
  {
    pattern: /Trade Balance/i,
    what: "net exports",
    nqImpact: "rarely moves NQ — a dollar/growth footnote",
    goodForNq: "neutral — no direct NQ read",
    badForNq: "neutral — no direct NQ read",
    goodWhen: null,
  },
];

export const GENERIC_NEWS_GUIDE: NewsEventGuide = {
  pattern: /.*/,
  what: "a scheduled US economic release",
  nqImpact: "most scheduled releases move NQ only on surprise — watch the actual vs forecast gap",
  goodForNq: "in line or market-friendly — no damage to the NQ tape",
  badForNq: "a surprise in the wrong direction — NQ reprices fast",
  goodWhen: null,
};

export function newsGuideFor(title: string): NewsEventGuide {
  return NEWS_EVENT_GUIDES.find((g) => g.pattern.test(title)) ?? GENERIC_NEWS_GUIDE;
}

/** stable id for a calendar event — shared by the snapshot builder and
 *  the panel so AI reads map onto the right rows */
export function newsItemId(item: { day: string; timeET: string; title: string }): string {
  return `${item.day}|${item.timeET}|${item.title}`;
}
