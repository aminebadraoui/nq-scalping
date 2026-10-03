/* ------------------------------------------------------------------ *
 * Options / gamma box — dealer positioning as regime + levels.
 *
 * What it answers (it is a CONTEXT box, not a directional vote):
 *   1. Regime — are dealers net LONG gamma (they dampen moves → chop,
 *      mean-reversion, fades work) or net SHORT gamma (they amplify
 *      moves → trend, follow-through, fades blow up)?
 *   2. Levels — where are the gamma "walls" that pin/repel price:
 *        call wall  = the strike with the biggest call gamma concentration
 *                     (resistance/magnet above)
 *        put wall   = the biggest put gamma concentration (support below)
 *        gamma flip = where net gamma crosses zero (above = dampen,
 *                     below = amplify) — the single most important level
 *
 * Data: the CBOE delayed-quotes JSON (free, no key) already carries
 * per-strike open_interest, iv, delta and gamma, so we do NOT need to
 * re-price Black-Scholes — we aggregate the published greeks:
 *
 *   net GEX(strike) = Σ gamma·OI (calls) − Σ gamma·OI (puts)
 *
 * The exact dollar scaling (×S²×100 vs ×S×100) differs across vendors and
 * only affects the MAGNITUDE — the sign (regime) and the locations (walls,
 * flip) are invariant, which is all this box relies on. We report the
 * magnitude in the S²×100 convention for the "$ per 1%" display only.
 *
 * Honest caveats (same ethos as the rest of the system):
 *   - Options data is a daily snapshot. This is a CONTEXT/LOCATION box,
 *     never a trigger. "Live option flow" (order-sweep alerts) is a paid
 *     product and is NOT reliably scrapeable; positioning is free AND the
 *     more useful of the two for a scalper.
 *   - QQQ is a proxy for NQ (≈ NDX/40). Levels are mapped to NQ points by
 *     the live NQ/QQQ ratio, which is recomputed on every refresh.
 *   - CBOE's endpoint is undocumented and delayed ~15 min — be gentle,
 *     one fetch a day (EOD OI) is plenty. See docs/strategy/OPTIONS_SIGNAL.md.
 * ------------------------------------------------------------------ */

export type OptionRow = {
  option: string; // "QQQ260928C00450000"
  bid: number;
  ask: number;
  iv: number;
  open_interest: number;
  volume: number;
  delta: number;
  gamma: number;
};

export type ParsedOption = {
  expiry: string; // "2026-09-28"
  side: "call" | "put";
  strike: number;
  oi: number;
  gamma: number;
  delta: number;
};

/** "QQQ260928C00450000" → expiry 2026-09-28, call, strike 450.000 */
export function parseSymbol(sym: string): { expiry: string; side: "call" | "put"; strike: number } {
  const ymd = sym.slice(3, 9);
  const side = sym.charAt(9) === "C" ? "call" : "put";
  const strike = Number(sym.slice(10)) / 1000;
  const expiry = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`;
  return { expiry, side, strike };
}

export function parseChain(options: OptionRow[]): ParsedOption[] {
  const out: ParsedOption[] = [];
  for (const o of options) {
    if (!o || typeof o.option !== "string") continue;
    const { expiry, side, strike } = parseSymbol(o.option);
    const gamma = Number(o.gamma);
    const oi = Number(o.open_interest);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    out.push({
      expiry,
      side,
      strike,
      oi: Number.isFinite(oi) ? oi : 0,
      gamma: Number.isFinite(gamma) ? gamma : 0,
      delta: Number(o.delta),
    });
  }
  return out;
}

/** infer the underlying spot from the nearest expiry: the call strike whose
 *  delta is closest to 0.5 (the at-the-money call). Self-contained, so we
 *  do not need a second quote endpoint. */
export function inferSpot(rows: ParsedOption[]): number {
  if (rows.length === 0) return NaN;
  const nearest = rows.reduce((a, b) => (b.expiry < a.expiry ? b : a)).expiry;
  const calls = rows.filter((r) => r.expiry === nearest && r.side === "call" && Number.isFinite(r.delta));
  if (calls.length === 0) return NaN;
  let best = calls[0];
  for (const c of calls) if (Math.abs(c.delta - 0.5) < Math.abs(best.delta - 0.5)) best = c;
  return best.strike;
}

export type StrikeGex = {
  strike: number;
  callGex: number;
  putGex: number;
  net: number;
  callOi: number;
  putOi: number;
};

/** per-strike gamma-weighted open interest (calls +, puts −), aggregated
 *  across every expiration. `net` is proportional to GEX; sign and shape
 *  are what the walls/flip/regime depend on. */
export function gammaProfile(rows: ParsedOption[]): StrikeGex[] {
  const map = new Map<number, StrikeGex>();
  for (const r of rows) {
    if (!Number.isFinite(r.gamma) || !Number.isFinite(r.oi) || r.oi <= 0) continue;
    let s = map.get(r.strike);
    if (!s) map.set(r.strike, (s = { strike: r.strike, callGex: 0, putGex: 0, net: 0, callOi: 0, putOi: 0 }));
    const g = r.gamma * r.oi;
    if (r.side === "call") {
      s.callGex += g;
      s.callOi += r.oi;
    } else {
      s.putGex += g;
      s.putOi += r.oi;
    }
  }
  const out = [...map.values()];
  for (const s of out) s.net = s.callGex - s.putGex;
  out.sort((a, b) => a.strike - b.strike);
  return out;
}

export type Regime = "chop" | "trend" | "unknown";

export type OptionsRefreshMeta = {
  symbol: string;
  asOf: string;
  lastFetch: number; // epoch ms, 0 = never
  nextFetch: number; // epoch ms
  intervalMs: number;
  lastError: string | null;
  fetched: boolean;
};

export type ExpiryBucket = "near" | "monthly" | "far";
export type WallSet = { flip: number | null; callWall: number | null; putWall: number | null };
export type WallSetNq = WallSet; // same shape, NQ points

/** calendar days from the snapshot date (`asOf`) to `expiry`. */
export function daysToExpiry(expiry: string, asOf: string): number {
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const e = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(e)) return NaN;
  return Math.round((e - a) / 86400000);
}

export function bucketOf(days: number): ExpiryBucket | null {
  if (!Number.isFinite(days) || days < 0) return null;
  if (days <= 7) return "near";
  if (days <= 45) return "monthly";
  return "far";
}

export type GammaRead = {
  /** underlying spot in the OPTION's units (QQQ points) */
  spot: number;
  /** gamma flip: strike where net GEX crosses zero */
  flip: number | null;
  /** call wall: strike with the largest call gamma concentration */
  callWall: number | null;
  /** put wall: strike with the largest put gamma concentration */
  putWall: number | null;
  /** total net gamma-weighted OI — the SIGN is the regime */
  netGex: number;
  /** dollar magnitude in the S²×100 convention (display only) */
  totalGexUsd: number;
  regime: Regime;
  aboveFlip: boolean;
  /** walls split by expiration bucket (populated by the server); near = scalping */
  buckets?: Record<ExpiryBucket, WallSet | null>;
};

/** flip / call wall / put wall from an already-aggregated per-strike profile. */
function wallSet(prof: StrikeGex[], spot: number): WallSet {
  if (prof.length === 0) return { flip: null, callWall: null, putWall: null };

  // the gamma flip is the zero-crossing of net GEX NEAREST to spot. Scanning
  // from the lowest strike would grab a far-OTM noise flip (sparse 1-lot
  // strikes with near-zero net), so we take the closest sign change instead —
  // the literature sanity check is exactly "flip sits near current price".
  let flip: number | null = null;
  let flipDist = Infinity;
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1];
    const b = prof[i];
    if (a.net * b.net < 0) {
      const x = a.strike + ((b.strike - a.strike) * -a.net) / (b.net - a.net);
      const d = Math.abs(x - spot);
      if (d < flipDist) {
        flipDist = d;
        flip = x;
      }
    }
  }

  let callWall = prof[0];
  let putWall = prof[0];
  for (const s of prof) {
    if (s.callGex > callWall.callGex) callWall = s;
    if (s.putGex > putWall.putGex) putWall = s;
  }

  return {
    flip,
    callWall: callWall.callGex > 0 ? callWall.strike : null,
    putWall: putWall.putGex > 0 ? putWall.strike : null,
  };
}

export function computeGamma(rows: ParsedOption[], spot: number): GammaRead {
  const prof = gammaProfile(rows);
  const ws = wallSet(prof, spot);
  const netGex = prof.reduce((sum, s) => sum + s.net, 0);
  const regime: Regime = netGex > 0 ? "chop" : netGex < 0 ? "trend" : "unknown";
  const aboveFlip = ws.flip !== null ? spot > ws.flip : netGex > 0;

  return {
    spot,
    flip: ws.flip,
    callWall: ws.callWall,
    putWall: ws.putWall,
    netGex,
    totalGexUsd: netGex * spot * spot * 100,
    regime,
    aboveFlip,
  };
}

/** walls per expiration bucket — the walls genuinely move with expiration:
 *  near-dated (≤7d) gamma is sharp and pins price today/tomorrow, the monthly
 *  (8–45d, OPEX) is the structural wall, and far (>45d, LEAPS) barely registers. */
export function computeGammaByExpiry(
  rows: ParsedOption[],
  spot: number,
  asOf: string,
): Record<ExpiryBucket, WallSet | null> {
  const out: Record<ExpiryBucket, WallSet | null> = { near: null, monthly: null, far: null };
  for (const bucket of ["near", "monthly", "far"] as ExpiryBucket[]) {
    const sel = rows.filter((r) => bucketOf(daysToExpiry(r.expiry, asOf)) === bucket);
    if (sel.length === 0) continue;
    out[bucket] = wallSet(gammaProfile(sel), spot);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * NQ-mapped read — what the dashboard box actually consumes.
 * ------------------------------------------------------------------ */

export type OptionsRead = {
  regime: Regime;
  note: string;
  /** TOTAL walls (all expirations) — the structural backdrop */
  flipNq: number | null;
  callWallNq: number | null;
  putWallNq: number | null;
  /** walls by expiration bucket (NQ points); near = scalping magnets */
  near: WallSetNq | null;
  monthly: WallSetNq | null;
  far: WallSetNq | null;
  nqSpot: number;
  qqqSpot: number;
  netGexUsd: number;
  aboveFlip: boolean;
  dataOk: boolean;
};

const fmtUsd = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
};

export function readOptionsFromSnapshot(g: GammaRead, nqSpot: number): OptionsRead {
  const ok = g && Number.isFinite(g.spot) && g.spot > 0 && Number.isFinite(nqSpot) && nqSpot > 0;
  const mult = ok ? nqSpot / g.spot : NaN;
  const toNq = (k: number | null) => (k !== null && Number.isFinite(mult) ? k * mult : null);

  const regime: Regime = ok ? g.regime : "unknown";
  let note: string;
  if (!ok) note = "no usable gamma profile — options data missing";
  else if (regime === "chop")
    note = `dealers net LONG gamma (${fmtUsd(g.totalGexUsd)}) — they dampen moves: mean-reversion/chop, the fade playbook is in regime`;
  else if (regime === "trend")
    note = `dealers net SHORT gamma (${fmtUsd(g.totalGexUsd)}) — they amplify moves: trend/follow-through, do not fade`;
  else note = "flat gamma — no regime signal";

  const mapWs = (ws: WallSet | null | undefined): WallSetNq | null =>
    ws ? { flip: toNq(ws.flip), callWall: toNq(ws.callWall), putWall: toNq(ws.putWall) } : null;
  const buckets: Record<ExpiryBucket, WallSet | null> = g.buckets ?? { near: null, monthly: null, far: null };

  return {
    regime,
    note,
    flipNq: toNq(g.flip),
    callWallNq: toNq(g.callWall),
    putWallNq: toNq(g.putWall),
    near: mapWs(buckets.near),
    monthly: mapWs(buckets.monthly),
    far: mapWs(buckets.far),
    nqSpot,
    qqqSpot: ok ? g.spot : NaN,
    netGexUsd: ok ? g.totalGexUsd : 0,
    aboveFlip: g.aboveFlip,
    dataOk: ok,
  };
}

/* ------------------------------------------------------------------ *
 * Location helpers — feed the walls into the mechanism's location box
 * and show the "dealer range" band in the UI.
 * ------------------------------------------------------------------ */

export type WallKind = "call" | "put" | "flip";
export type WallLevel = { kind: WallKind; p: number };

/** the walls to feed the location box: NEAR-term (≤7d) walls are the scalping
 *  magnets; fall back to the total when the near bucket is unavailable. */
export function wallsFromRead(r: OptionsRead): WallLevel[] {
  const near = r.near && (r.near.callWall !== null || r.near.putWall !== null || r.near.flip !== null) ? r.near : null;
  const call = near ? near.callWall : r.callWallNq;
  const put = near ? near.putWall : r.putWallNq;
  const flip = near ? near.flip : r.flipNq;
  const out: WallLevel[] = [];
  if (call !== null && Number.isFinite(call)) out.push({ kind: "call", p: call });
  if (put !== null && Number.isFinite(put)) out.push({ kind: "put", p: put });
  if (flip !== null && Number.isFinite(flip)) out.push({ kind: "flip", p: flip });
  return out;
}

/** the put-wall → call-wall "dealer range": 0 = at put support, 1 = at call
 *  resistance. In a chop regime price oscillates inside this band. */
export function dealerBand(r: OptionsRead): { put: number; call: number; pct: number; span: number } | null {
  const put = r.near && r.near.putWall !== null ? r.near.putWall : r.putWallNq;
  const call = r.near && r.near.callWall !== null ? r.near.callWall : r.callWallNq;
  if (put == null || call == null || call <= put) return null;
  const span = call - put;
  const pct = span > 0 ? (r.nqSpot - put) / span : 0.5;
  return { put, call, pct: Math.max(0, Math.min(1, pct)), span };
}
