/* ------------------------------------------------------------------ *
 * Macro guide — the STATIC interpretation layer of the Macro tab.
 *
 * Pure data, no feeds, no DB: one family per metric group, one guide
 * entry per metric describing (a) what the number is, (b) what it
 * means when it is up, (c) what it means when it is down — or, for
 * non-directional metrics (calendar/proximity), how to read it.
 *
 * Consumed by:
 *   - lib/interpretText.ts (deterministic fallback + DeepSeek payload)
 *   - components/MacroInterpretation.tsx (the always-visible guides)
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
    read: null,
  },
  {
    id: "vix.pct1y", family: "risk", label: "VIX 1y pctile", riskOnWhen: "down",
    what: "where today's VIX sits inside the last year's distribution",
    up: "fear regime — rallies get sold, protection is the crowded trade",
    down: "calm regime — the fragility is one-sided positioning",
    read: null,
  },
  {
    id: "vix.term9d", family: "risk", label: "VIX 9d", riskOnWhen: "down",
    what: "9-day implied volatility",
    up: "near-term event fear — this week's calendar is priced hot",
    down: "no event premium — the week is expected quiet",
    read: null,
  },
  {
    id: "vix.term3m", family: "risk", label: "VIX 3m", riskOnWhen: "down",
    what: "3-month implied volatility",
    up: "protection bid further out — a longer-fuse worry",
    down: "the market sees smooth months ahead",
    read: null,
  },
  {
    id: "vix.rangePct", family: "risk", label: "VIX 1σ day", riskOnWhen: null,
    what: "the expected daily move, VIX ÷ 16",
    up: "wider expected range — size stops and targets up",
    down: "tight expected range — scalps get smaller",
    read: null,
  },
  {
    id: "gex.regime", family: "risk", label: "GEX regime", riskOnWhen: null,
    what: "dealer gamma posture: CHOP pins, TREND amplifies",
    up: null,
    down: null,
    read: "CHOP = dealers damp moves toward the flip · TREND = dealers amplify moves away from it",
  },
  {
    id: "gex.flipDist", family: "risk", label: "GEX flip", riskOnWhen: "down",
    what: "QQQ points from spot to the zero-gamma flip",
    up: "spot is below the flip — dealers sell into weakness, dips accelerate",
    down: "spot is above the flip — dealers lean with the bid",
    read: null,
  },
  {
    id: "gex.callWall", family: "risk", label: "Call wall", riskOnWhen: "up",
    what: "QQQ points up to the call wall",
    up: "room above before overhead gamma caps the rally",
    down: "the magnet overhead — rallies stall into it",
    read: null,
  },
  {
    id: "gex.putWall", family: "risk", label: "Put wall", riskOnWhen: "up",
    what: "QQQ points down to the put wall",
    up: "support close below — selloffs slow into it",
    down: "no nearby gamma floor — gap-downs have room",
    read: null,
  },

  /* ---------------- rates ------------------------------------------ */
  {
    id: "rates.y2", family: "rates", label: "2Y", riskOnWhen: "down",
    what: "the policy tenor: where the market prices the Fed",
    up: "hawkish repricing — higher-for-longer, a headwind for NDX multiples",
    down: "dovish repricing — cuts being priced, supports growth",
    read: null,
  },
  {
    id: "rates.y10", family: "rates", label: "10Y", riskOnWhen: "down",
    what: "the global discount rate",
    up: "tighter financial conditions — long-duration growth gets repriced",
    down: "easier conditions — valuations get support",
    read: null,
  },
  {
    id: "rates.y30", family: "rates", label: "30Y", riskOnWhen: "down",
    what: "the long end: inflation expectations + term premium",
    up: "inflation / term-premium fear — bond-vigilante regime",
    down: "long-end demand — no inflation scare",
    read: null,
  },
  {
    id: "rates.spread210", family: "rates", label: "2s10s", riskOnWhen: "up",
    what: "the curve slope (10Y − 2Y)",
    up: "steepening — growth being priced, a risk-on confirmation",
    down: "inverting — slowdown / recession pricing",
    read: null,
  },
  {
    id: "rates.spread103m", family: "rates", label: "10y−3m", riskOnWhen: "up",
    what: "the classic recession gauge (10Y − 3M)",
    up: "healthy — expansion is priced",
    down: "inverted — recession warning, the Fed is tight",
    read: null,
  },
  {
    id: "rates.real10y", family: "rates", label: "10Y real", riskOnWhen: "down",
    what: "nominal minus breakevens: the real cost of capital",
    up: "tighter real conditions — semis and growth feel it first",
    down: "easy real money — risk assets get support",
    read: null,
  },
  {
    id: "rates.breakeven10y", family: "rates", label: "Breakevens", riskOnWhen: null,
    what: "market-implied 10y inflation",
    up: "inflation worry — check commodities for confirmation",
    down: "disinflation — supports the cut case",
    read: null,
  },
  {
    id: "rates.ffrImpled", family: "rates", label: "FFR implied", riskOnWhen: "down",
    what: "the policy rate implied by front fed-funds futures",
    up: "fewer cuts priced — hawkish",
    down: "cuts priced — dovish",
    read: null,
  },
  {
    id: "rates.effr", family: "rates", label: "EFFR", riskOnWhen: "down",
    what: "the actual effective fed funds rate",
    up: "the stance itself — tight money is the backdrop",
    down: "the stance itself — easing is the backdrop",
    read: null,
  },
  {
    id: "rates.y10ChangeBps", family: "rates", label: "10Y day Δ", riskOnWhen: "down",
    what: "today's change in the 10Y yield, in basis points",
    up: "yields leaking higher today — equities under pressure",
    down: "yields easing today — a bid for risk",
    read: null,
  },

  /* ---------------- fx & equities ---------------------------------- */
  {
    id: "dxy", family: "fx-equities", label: "DXY", riskOnWhen: "down",
    what: "the dollar index",
    up: "strong dollar — tightens global liquidity, an NQ headwind",
    down: "weak dollar — risk-on, supports EM and NQ",
    read: null,
  },
  {
    id: "spx", family: "fx-equities", label: "S&P 500", riskOnWhen: "up",
    what: "the broad tape",
    up: "broad risk-on",
    down: "broad risk-off",
    read: null,
  },
  {
    id: "ndx", family: "fx-equities", label: "Nasdaq-100", riskOnWhen: "up",
    what: "NQ's cash twin",
    up: "growth bid — NQ follows",
    down: "growth offered — NQ under pressure",
    read: null,
  },
  {
    id: "sox", family: "fx-equities", label: "SOX semis", riskOnWhen: "up",
    what: "the semiconductor index",
    up: "semis leading — the AI/growth leadership is intact",
    down: "semis weak — the leadership question for the tape",
    read: null,
  },
  {
    id: "spy", family: "fx-equities", label: "SPY", riskOnWhen: "up",
    what: "the S&P 500 ETF",
    up: "index ETFs confirm the bid",
    down: "index ETFs confirm the offer",
    read: null,
  },
  {
    id: "rsp", family: "fx-equities", label: "RSP eq-wt", riskOnWhen: "up",
    what: "equal-weight S&P 500",
    up: "broad participation — a healthy tape",
    down: "narrow tape — only the mega caps move",
    read: null,
  },
  {
    id: "smh", family: "fx-equities", label: "SMH semis", riskOnWhen: "up",
    what: "the semis ETF",
    up: "semis bid — NQ's engine is running",
    down: "semis offered — the engine sputters",
    read: null,
  },
  {
    id: "qqq", family: "fx-equities", label: "QQQ", riskOnWhen: "up",
    what: "the Nasdaq-100 ETF",
    up: "large-cap growth bid — NQ's anchor",
    down: "growth offered — NQ drifts lower",
    read: null,
  },

  /* ---------------- commodities ------------------------------------ */
  {
    id: "gold", family: "commodities", label: "Gold", riskOnWhen: null,
    what: "the haven + inflation hedge",
    up: "haven bid or inflation hedge — with yields down at the same time, it is stress",
    down: "no haven demand — real rates dominate",
    read: null,
  },
  {
    id: "wti", family: "commodities", label: "WTI crude", riskOnWhen: "up",
    what: "the growth / inflation tell",
    up: "growth demand or a supply shock — sharp spikes are an inflation headwind",
    down: "demand worry — a growth scare",
    read: null,
  },

  /* ---------------- crypto ----------------------------------------- */
  {
    id: "btc", family: "crypto", label: "Bitcoin", riskOnWhen: "up",
    what: "the purest risk-appetite barometer",
    up: "risk appetite — crypto leads risk-on",
    down: "risk-off — leverage comes out",
    read: null,
  },

  /* ---------------- liquidity & positioning ------------------------ */
  {
    id: "fred.walcl", family: "liquidity", label: "Fed B/S", riskOnWhen: "up",
    what: "the Fed's balance sheet size",
    up: "QE — reserves added, a liquidity tailwind",
    down: "QT — liquidity draining, a tighter backdrop",
    read: null,
  },
  {
    id: "fred.rrp", family: "liquidity", label: "RRP", riskOnWhen: "down",
    what: "cash parked at the Fed's reverse repo",
    up: "excess liquidity sitting idle at the Fed",
    down: "reserves being redeployed — money flowing toward markets",
    read: null,
  },
  {
    id: "fred.tga", family: "liquidity", label: "TGA", riskOnWhen: "down",
    what: "the Treasury's checking account",
    up: "Treasury hoarding cash — drains reserves, liquidity negative",
    down: "Treasury spending down — adds reserves, liquidity positive",
    read: null,
  },
  {
    id: "fred.hyOas", family: "liquidity", label: "HY OAS", riskOnWhen: "down",
    what: "the high-yield credit spread",
    up: "credit stress — risk-off at the margin",
    down: "credit calm — risk appetite intact",
    read: null,
  },
  {
    id: "cot.netPctOi", family: "liquidity", label: "COT net", riskOnWhen: null,
    what: "spec net position as % of open interest (Nasdaq-100)",
    up: "specs very long — crowded; extremes are contrarian",
    down: "specs short — washed out; contrarian support",
    read: null,
  },
  {
    id: "cot.pct52w", family: "liquidity", label: "COT 52w", riskOnWhen: null,
    what: "where the spec net position sits in its 52-week range",
    up: "positioning near its 52w max — crowded long",
    down: "positioning near its 52w min — max pessimism",
    read: null,
  },

  /* ---------------- calendar & events ------------------------------ */
  {
    id: "calendar.opex", family: "calendar", label: "OPEX", riskOnWhen: null,
    what: "days to the monthly options expiry (3rd Friday)",
    up: null,
    down: null,
    read: "≤2 days left: pinning / suppression risk, vol flattens — quad witching is the big one",
  },
  {
    id: "calendar.auctions", family: "calendar", label: "Auctions", riskOnWhen: null,
    what: "the next Treasury coupon auctions",
    up: null,
    down: null,
    read: "supply hitting the long end — auction days can push yields up",
  },
  {
    id: "calendar.fomcMinutes", family: "calendar", label: "FOMC mins", riskOnWhen: null,
    what: "days to the next FOMC minutes release",
    up: null,
    down: null,
    read: "policy repricing risk — bonds move on the tone",
  },
  {
    id: "news.next", family: "calendar", label: "Next release", riskOnWhen: null,
    what: "the next US economic release",
    up: null,
    down: null,
    read: "high-impact prints (CPI/NFP/FOMC) own the minutes around release — the pulse line shows the countdown",
  },
  {
    id: "earnings.next", family: "calendar", label: "Next earnings", riskOnWhen: null,
    what: "the next Nasdaq-100 mega-cap print",
    up: null,
    down: null,
    read: "mega-caps move the NDX after hours — the week's gap risk",
  },

  /* ---------------- structure -------------------------------------- */
  {
    id: "htf.daily", family: "structure", label: "HTF daily", riskOnWhen: "up",
    what: "daily swing structure from the system's own archive",
    up: "HH/HL — higher highs and lows: the uptrend owns the structure",
    down: "LH/LL — lower highs and lows: the downtrend owns it",
    read: "CHOP — no clean swing sequence: both sides are in range",
  },
  {
    id: "htf.weekly", family: "structure", label: "HTF weekly", riskOnWhen: "up",
    what: "weekly swing structure",
    up: "HH/HL — the slow trend is up",
    down: "LH/LL — the slow trend is down",
    read: "CHOP — no clean weekly sequence",
  },
  {
    id: "bias.score", family: "structure", label: "Structure score", riskOnWhen: "up",
    what: "the signed subtotal of the ALN / gap / prior-day / VIX chips",
    up: "the structure layer leans long",
    down: "the structure layer leans short",
    read: null,
  },
  {
    id: "bias.gapPct", family: "structure", label: "Gap %", riskOnWhen: "up",
    what: "the overnight gap vs the prior RTH close",
    up: "gapped up — the regime chip says whether to fade or follow",
    down: "gapped down — the regime chip says whether to fade or follow",
    read: null,
  },
  {
    id: "bias.gapRegime", family: "structure", label: "Gap regime", riskOnWhen: null,
    what: "the measured fade / continuation cell for this gap size",
    up: null,
    down: null,
    read: "small → fade toward the prior close · large → follow the gap (VIX-gated) · mid → no default",
  },
  {
    id: "bias.fadeOk", family: "structure", label: "Fade gate", riskOnWhen: "up",
    what: "the VIX fade gate",
    up: "vol calm enough to fade the gap",
    down: "too volatile — fades are coin flips",
    read: null,
  },
  {
    id: "bias.sideLean", family: "structure", label: "Side cells", riskOnWhen: null,
    what: "measured one-sided rules from the trade replay",
    up: null,
    down: null,
    read: "only-longs / only-shorts cells from the card's own replay — advisory, never a gate",
  },
];

const GUIDE_BY_ID = new Map(METRIC_GUIDES.map((g) => [g.id, g]));
const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

export const guideFor = (id: string): MetricGuide | undefined => GUIDE_BY_ID.get(id);
export const familyFor = (id: MetricFamily): FamilyDef => FAMILY_BY_ID.get(id) ?? { id, label: id, blurb: "" };
