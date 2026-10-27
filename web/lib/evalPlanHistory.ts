/* Eval plan v1 — the prior-session inputs the live checks need, read from
 * the session archive (R2 + local cache) exactly as the research did:
 * 14 prior sessions' per-minute moves (noise-area sigma) and the prior
 * session's 16:00 ET close (both strategies). Cached per trading day. */
import { archiveDates, loadSessionMinutes } from "./archive";
import { noiseSigma, sessionClose, sessionMoves, NA_LOOKBACK, type Bar } from "./evalPlan";

export type EvalHistory = { day: string; sigma: number[] | null; prevClose: number | null; sessions: string[] };

let cache: { day: string; p: Promise<EvalHistory> } | null = null;

async function build(day: string): Promise<EvalHistory> {
  const dates = (await archiveDates({ source: "manifest" }).catch(() => [] as string[])).filter((d) => d < day).sort();
  const want = dates.slice(-(NA_LOOKBACK + 4)); // a few spare for short/missing sessions
  const moves: number[][] = [];
  const used: string[] = [];
  let prevClose: number | null = null;
  for (const d of want) {
    const mins = await loadSessionMinutes(d).catch(() => null);
    if (!mins || mins.length < 300) continue;
    const bars: Bar[] = mins.map((m) => ({ t: m.t, high: m.high, low: m.low, buy: m.buy, sell: m.sell, o: m.o, c: m.c }));
    const mv = sessionMoves(bars);
    if (mv) { moves.push(mv); used.push(d); }
    const pc = sessionClose(bars);
    if (pc !== null) prevClose = pc; // the LAST loaded session wins
  }
  const last = used[used.length - 1];
  // the prior close must be the session right before today
  const expectedPrev = dates[dates.length - 1];
  return { day, sigma: noiseSigma(moves), prevClose: last === expectedPrev ? prevClose : null, sessions: used };
}

/** history for trading day `day` (YYYY-MM-DD, the RTH date); memoized */
export function evalHistory(day: string): Promise<EvalHistory> {
  if (!cache || cache.day !== day) {
    const p = build(day).catch((e) => {
      console.warn(`[evalPlan] history load failed: ${String(e)}`);
      cache = null; // retry on the next call
      return { day, sigma: null, prevClose: null, sessions: [] } as EvalHistory;
    });
    cache = { day, p };
  }
  return cache.p;
}
