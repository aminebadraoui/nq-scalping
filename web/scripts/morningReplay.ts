/* ------------------------------------------------------------------ *
 * Morning replay (experiment): rebuild the live feed's footprint buffer
 * from the Neon live-capture tables (candles_1m + footprint_ticks) for
 * the RTH open and run the PRODUCTION detectors over it — what SHOULD
 * the system have seen since 09:30 ET?
 *
 * The live feed's minute clock is CDT (the detectors shift +1h), so the
 * Neon UTC timestamps are converted to the feed clock (UTC−5 in October).
 *
 * Run from web/ (needs DATABASE_URL):
 *   DATABASE_URL=... node --import ../scripts/ts-loader.mjs scripts/morningReplay.ts [--from 2026-10-05T12:00Z]
 * ------------------------------------------------------------------ */

import postgres from "postgres";
import { detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 2 });

/** UTC ts → the live feed's CDT minute clock ("HH:MM") */
const feedClock = (ts: Date): string => {
  const d = new Date(ts.getTime() - 5 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const etClock = (ts: Date): string => {
  const d = new Date(ts.getTime() - 4 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

type Minute = {
  t: string;
  d: string;
  o: number;
  c: number;
  high: number;
  low: number;
  buy: number;
  sell: number;
  levels: { price: number; buy: number; sell: number }[];
};

async function main() {
  const fromArg = process.argv.indexOf("--from");
  const from = fromArg >= 0 ? process.argv[fromArg + 1] : "2026-10-05T12:29:00Z";

  const candles = await sql`
    select ts, o::float8 as o, h::float8 as h, l::float8 as l, c::float8 as c, buy::float8 as buy, sell::float8 as sell
    from candles_1m where date = '2026-10-05' and ts >= ${from} order by ts`;
  const ticks = await sql`
    select ts, price_cents, buy::float8 as buy, sell::float8 as sell
    from footprint_ticks where date = '2026-10-05' and ts >= ${from} order by ts`;

  const levelByMin = new Map<string, { price: number; buy: number; sell: number }[]>();
  for (const r of ticks) {
    const key = feedClock(r.ts);
    if (!levelByMin.has(key)) levelByMin.set(key, []);
    levelByMin.get(key)!.push({ price: Number(r.price_cents) / 100, buy: Number(r.buy), sell: Number(r.sell) });
  }

  const minutes: Minute[] = candles.map((r) => ({
    t: feedClock(r.ts),
    d: "2026-10-05",
    o: Number(r.o),
    c: Number(r.c),
    high: Number(r.h),
    low: Number(r.l),
    buy: Number(r.buy),
    sell: Number(r.sell),
    levels: levelByMin.get(feedClock(r.ts)) ?? [],
  }));
  if (!minutes.length) {
    console.error("no candles in window");
    process.exit(1);
  }
  const etT = minutes.map((m, i) => {
    const d = new Date(Date.parse(from) + i * 60_000);
    return etClock(d);
  });
  console.log(`replay buffer: ${minutes.length} minutes (${etT[0]} → ${etT[etT.length - 1]} ET), ` +
    `${minutes.reduce((a, m) => a + m.levels.length, 0)} price levels from footprint_ticks\n`);

  // the move itself, for reference
  let lo = Infinity;
  let hi = -Infinity;
  let loT = "";
  let hiT = "";
  for (let i = 0; i < minutes.length; i++) {
    if (minutes[i].low < lo) {
      lo = minutes[i].low;
      loT = etT[i];
    }
    if (minutes[i].high > hi) {
      hi = minutes[i].high;
      hiT = etT[i];
    }
  }
  console.log(`tape: low ${lo} @ ${loT} ET · high ${hi} @ ${hiT} ET · move ${(hi - lo).toFixed(2)} pts\n`);

  const print = (fam: string, ss: MomentumSignal[], desc: string) => {
    console.log(`== ${fam} (${desc}) — ${ss.length} signal(s)`);
    for (const s of ss) {
      const tET = etT[s.entryIdx] ?? s.t;
      console.log(
        `  ${s.dir.padEnd(5)} kind=${s.kind.padEnd(9)} bar=${tET} ET (idx ${s.entryIdx}) entry ${s.entry.toFixed(2)} stop ${s.stop.toFixed(2)} target ${s.target.toFixed(2)} risk ${s.risk.toFixed(2)}`,
      );
    }
  };

  print("momentum", detectMomentum(minutes, MOM_PROD), "MOM_PROD");
  print("expansion", detectExpansionScalp(minutes, EXP_PROD), "EXP_PROD");
  print("rth-soft", detectSoftMomentum(minutes, SOFT_PROD), "SOFT_PROD");
  print("openDrive", detectOpenDrive(minutes, OPEN_PROD), "OPEN_PROD");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
