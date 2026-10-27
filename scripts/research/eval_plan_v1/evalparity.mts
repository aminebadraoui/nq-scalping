import { archiveDates, loadSessionMinutes } from "../../../web/lib/archive.ts";
import { barClose, gapDecision, isCheckBar, noiseBands, noiseEntry, noiseSigma, rthIndex, rthOpen, sessionClose, sessionMoves, type Bar } from "../../../web/lib/evalPlan.ts";
const dates = (await archiveDates({ source: "manifest" })).sort();
const moves: number[][] = []; let prev: number | null = null; const out: Record<string, unknown> = {};
for (const d of dates) {
  const m = await loadSessionMinutes(d); if (!m) continue;
  const bars: Bar[] = m.map((x) => ({ t: x.t, high: x.high, low: x.low, buy: x.buy, sell: x.sell, o: x.o, c: x.c }));
  const rth = bars.filter((b) => rthIndex(b.t) >= 0);
  if (rth.length < 380) { continue; }
  const op = rthOpen(bars); const mv = sessionMoves(bars);
  const sig = noiseSigma(moves);
  if (op !== null && prev !== null) {
    const g = gapDecision(op, prev, { maxStopPts: 1e9 });
    let first: string | null = null;
    if (sig) { const b = noiseBands(op, prev, sig); for (const x of rth) { if (!isCheckBar(x.t)) continue; const dr = noiseEntry(rthIndex(x.t), barClose(x), b); if (dr) { first = `${x.t}:${dr}`; break; } } }
    out[d] = { gap: g ? g.dir : 0, na: first };
  }
  if (mv) moves.push(mv); prev = sessionClose(bars);
}
console.log(JSON.stringify(out));
