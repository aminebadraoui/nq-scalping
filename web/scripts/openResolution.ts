/* ------------------------------------------------------------------ *
 * Open resolution study — footprint decides the real move, 9:30-9:59.
 *
 * Two mechanics over the whole opening half-hour:
 *   FAKE-OUT FADE — a new opening high/low whose cumulative delta does NOT
 *     back it (weak push = fake), reclaimed back inside within 3 bars →
 *     fade the fake (short the fake high / long the fake low).
 *   REAL-DRIVE CONFIRM — a new opening high/low WITH strong cumulative
 *     delta and a one-sided bar → join the real move.
 *
 * Scored first-touch style: TP 10/SL 30 and TP 15/SL 35 over the next
 * 60 minutes. GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 * scripts/openResolution.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";

const TPSL: [number, number][] = [[10, 30], [15, 35]];

type Entry = { name: string; i: number; dir: 1 | -1; entry: number; cumD: number };

function scan(minutes: MomMinute[], i0: number, cfg: { cumD: number; frac: number }): Entry[] {
  const out: Entry[] = [];
  const end = Math.min(minutes.length - 1, i0 + 29); // 9:30-9:59
  let cumD = 0;
  let winHi = -Infinity;
  let winLo = Infinity;
  let fakeHi = false; // a fake high is currently being tested
  let fakeLo = false;
  let fakeLvl = 0;
  let driven = false;

  for (let k = i0; k <= end; k++) {
    const m = minutes[k];
    const vol = m.buy + m.sell;
    const frac = vol > 0 ? m.buy / vol : 0.5;
    const priorHi = winHi;
    const priorLo = winLo;
    winHi = Math.max(winHi, m.high);
    winLo = Math.min(winLo, m.low);
    cumD += m.buy - m.sell;

    // REAL-DRIVE: new window high backed by strong delta + one-sided bar
    if (!driven && k > i0) {
      if (m.high > priorHi && priorHi > -Infinity && cumD >= cfg.cumD && frac >= cfg.frac) {
        out.push({ name: "drive", i: k, dir: 1, entry: closeOf(m), cumD });
        driven = true;
      } else if (m.low < priorLo && priorLo < Infinity && cumD <= -cfg.cumD && frac <= 1 - cfg.frac) {
        out.push({ name: "drive", i: k, dir: -1, entry: closeOf(m), cumD });
        driven = true;
      }
    }

    // FAKEOUT tracking: a new extreme NOT backed by delta
    if (!fakeHi && !fakeLo && k > i0) {
      if (m.high > priorHi && priorHi > -Infinity && cumD < 50) {
        fakeHi = true;
        fakeLvl = priorHi;
      } else if (m.low < priorLo && priorLo < Infinity && cumD > -50) {
        fakeLo = true;
        fakeLvl = priorLo;
      }
    }
    // FAKEOUT RESOLUTION: close back inside within 3 bars → fade it
    if (fakeHi) {
      if (closeOf(m) < fakeLvl) {
        out.push({ name: "fakeFade", i: k, dir: -1, entry: closeOf(m), cumD });
        fakeHi = false;
      } else if (k - i0 > 3 && m.high >= fakeLvl + 5) {
        fakeHi = false; // ran away — not a fake, drop it
      }
    } else if (fakeLo) {
      if (closeOf(m) > fakeLvl) {
        out.push({ name: "fakeFade", i: k, dir: 1, entry: closeOf(m), cumD });
        fakeLo = false;
      } else if (k - i0 > 3 && m.low <= fakeLvl - 5) {
        fakeLo = false;
      }
    }
  }
  return out;
}

async function main() {
  const dates = await archiveDates();
  console.log(`open resolution study over ${dates.length} sessions…`);
  const t0 = Date.now();

  const agg = new Map<string, { n: number; hits: number; bars: number[]; maes: number[]; cumDs: number[] }>();
  const CFGS = [
    { cumD: 200, frac: 0.5 },
    { cumD: 300, frac: 0.55 },
    { cumD: 400, frac: 0.55 },
    { cumD: 500, frac: 0.6 },
  ];
  const dayAvail = new Map<string, Set<string>>();

  const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
  const mmOf = (t: string): number => Number(t.slice(3, 5));

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date);
    if (!minutes) continue;
    let i0 = -1;
    for (let i = 0; i < minutes.length; i++) if (hourET(minutes[i].t) === 9 && mmOf(minutes[i].t) >= 30) { i0 = i; break; }
    if (i0 < 0 || i0 + 30 >= minutes.length) continue;
    for (let ci = 0; ci < CFGS.length; ci++) {
      for (const e of scan(minutes, i0, CFGS[ci])) {
      const end = Math.min(minutes.length - 1, e.i + 60);
      for (const [tp, sl] of TPSL) {
        const key = `${e.name}|c${ci}|${tp}|${sl}`;
        const a = agg.get(key) ?? { n: 0, hits: 0, bars: [], maes: [], cumDs: [] };
        let hit = false;
        let barsTo = 0;
        let mae = 0;
        for (let j = e.i + 1; j <= end; j++) {
          const m = minutes[j];
          const fav = e.dir > 0 ? m.high - e.entry : e.entry - m.low;
          const adv = e.dir > 0 ? e.entry - m.low : m.high - e.entry;
          mae = Math.max(mae, adv);
          if (adv >= sl) break;
          if (fav >= tp) { hit = true; barsTo = j - e.i; break; }
        }
        a.n++;
        if (hit) { a.hits++; a.bars.push(barsTo); a.maes.push(mae); a.cumDs.push(e.cumD); }
        agg.set(key, a);
      }
        const ds = dayAvail.get(e.name) ?? new Set();
        ds.add(date);
        dayAvail.set(e.name, ds);
      }
    }
  }

  console.log(`${(Date.now() - t0) / 1000}s\n`);
  console.log("rule      | TP | SL | n   | hit%  | med bars | med MAE | exp pts (gross) | day availability");
  for (let ci = 0; ci < 4; ci++) {
    for (const [tp, sl] of TPSL) {
      const a = agg.get(`drive|c${ci}|${tp}|${sl}`);
      if (!a) continue;
      const hitPct = (100 * a.hits) / a.n;
      const medBars = a.bars.length ? a.bars.sort((x, y) => x - y)[Math.floor(a.bars.length / 2)] : 0;
      const medMae = a.maes.length ? a.maes.sort((x, y) => x - y)[Math.floor(a.maes.length / 2)] : 0;
      const expPts = (hitPct / 100) * tp - (1 - hitPct / 100) * sl;
      const days = dayAvail.get("drive")?.size ?? 0;
      const tag = `c${ci} d${CFGS[ci].cumD} f${CFGS[ci].frac}`;
      console.log(
        `${tag.padEnd(11)} | ${String(tp).padStart(2)} | ${String(sl).padStart(2)} | ${String(a.n).padStart(4)} | ${hitPct.toFixed(0).padStart(4)}% | ${String(medBars).padStart(8)} | ${medMae.toFixed(0).padStart(7)} | ${expPts.toFixed(1).padStart(17)} | ${(100 * days / dates.length).toFixed(0).padStart(3)}% of days`,
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
