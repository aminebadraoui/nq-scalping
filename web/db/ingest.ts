/* ---------------------------------------------------------------------------
 * Neon ingestion: gcdata/data/*.json + gcdata/data/ohlc/*.json  →  Postgres.
 *
 *   node --import ./scripts/ts-loader.mjs ./db/ingest.ts [flags]
 *
 *   --all              backfill every collected dataset (default: today's)
 *   --since DATE       ingest datasets from DATE onward
 *   --profiles         also compute + store the daily P0–P5 level sheets
 *   --events           also compute + store the analysis events
 *   --dry-run          print what would be ingested, touch nothing
 *   --verify           integrity check against the DB (row counts per day)
 *   --url DSN          postgres URL (default: $DATABASE_URL)
 *
 * Idempotent: everything upserts on its natural key, so re-running after a
 * re-collection repairs instead of duplicating.
 * ------------------------------------------------------------------------- */
import postgres from "postgres";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", ".."); // repo root (ingest lives in web/db/)
const DATA = process.env.GC_DATA_DIR || path.join(ROOT, "gcdata", "data");
const OHLC = path.join(DATA, "ohlc");

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATABASE_URL = val("--url") ?? process.env.DATABASE_URL ?? "";
if (!DATABASE_URL && !flag("--dry-run")) {
  console.error(
    "set DATABASE_URL (or pass --url) — e.g. postgres://user:pass@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  );
  process.exit(1);
}

const SAFE = /^(\d{4}-\d{2}-\d{2})_(RTH|ETH)\.json$/;

function datasets(): { date: string; session: "RTH" | "ETH" }[] {
  return readdirSync(DATA)
    .map((f) => SAFE.exec(f))
    .filter(Boolean)
    .map((m) => ({ date: m![1], session: m![2] as "RTH" | "ETH" }))
    .sort((a, b) => (a.date + a.session < b.date + b.session ? -1 : 1));
}

type Candle = {
  t: string;
  high: number;
  low: number;
  total: number;
  buy: number;
  sell: number;
  levels: Record<string, [number, number, number, number, number]>;
};

function loadCandles(date: string, session: string): Candle[] {
  const f = path.join(DATA, `${date}_${session}.json`);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf8")).candles ?? [];
  } catch {
    return [];
  }
}

function loadOhlc(date: string): Map<string, { o: number; h: number; l: number; c: number; v: number }> {
  const f = path.join(OHLC, `${date}.json`);
  if (!existsSync(f)) return new Map();
  try {
    return new Map(JSON.parse(readFileSync(f, "utf8")).bars.map((b: { t: string }) => [b.t.slice(11, 16), b]));
  } catch {
    return new Map();
  }
}

/** postgres chokes on more than 65534 parameters in one statement — the ETH
 * session's tick clusters alone are ~26k rows x 6 columns, so chunk everything */
async function insertChunked<T extends Record<string, unknown>>(
  sql: postgres.Sql,
  rows: T[],
  columns: (keyof T & string)[],
  table: string,
  conflict: string,
  update: string,
  chunk = 2000,
) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    // `sql(part, ...columns)` is a Helper and must be embedded with the tagged
    // template (string concatenation would render it as "[object Object]")
    await sql`
      insert into ${sql(table)} ${sql(part as never, ...columns)}
      on conflict ${sql.unsafe(conflict)} do update set ${sql.unsafe(update)}
    `;
  }
}

/** the feed stamps bars in US Central; the ISO carries its own offset */
function toTs(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`unparseable stamp ${iso}`);
  return new Date(ms).toISOString();
}

async function main() {
  const since = val("--since");
  let ds = datasets();
  if (!flag("--all")) {
    if (since) ds = ds.filter((d) => d.date >= since);
    else {
      const latest = ds.at(-1)?.date;
      ds = ds.filter((d) => d.date === latest);
    }
  }
  if (ds.length === 0) {
    console.log("no datasets found under", DATA);
    return;
  }
  console.log(`datasets to process: ${ds.length} (${ds[0].date} … ${ds.at(-1)?.date})`);

  const ssl = /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : ("require" as const);
  const sql = flag("--dry-run") ? null : postgres(DATABASE_URL, { max: 4, ssl });

  if (sql && flag("--verify")) {
    await verify(sql);
    await sql.end();
    return;
  }

  if (sql) {
    // schema is applied here so a fresh Neon project needs no manual step
    const schema = readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8");
    await sql.unsafe(schema);
    console.log("schema ensured");
  }

  let candlesTotal = 0;
  let ticksTotal = 0;
  for (const { date, session } of ds) {
    const candles = loadCandles(date, session);
    if (!candles.length) {
      console.log(`  skip ${date} ${session}: no file`);
      continue;
    }
    const ohlc = loadOhlc(date);

    if (sql) {
      // ---- bars ----
      const rows = candles.map((c) => {
        const bar = ohlc.get(c.t.slice(11, 16));
        return {
          ts: toTs(c.t),
          date,
          session,
          o: bar?.o ?? null,
          h: (bar?.h ?? c.high / 100).toFixed(2),
          l: (bar?.l ?? c.low / 100).toFixed(2),
          c: bar?.c ?? null,
          v: bar?.v ?? c.total,
          buy: c.buy,
          sell: c.sell,
        };
      });
      await insertChunked(
        sql,
        rows,
        ["ts", "date", "session", "o", "h", "l", "c", "v", "buy", "sell"],
        "candles_1m",
        "(ts, session)",
        "date = excluded.date, o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, buy = excluded.buy, sell = excluded.sell",
        500,
      );

      // ---- per-tick clusters (the microstructure gold) ----
      const ticks = candles.flatMap((c) =>
        Object.entries(c.levels).map(([p, lv]) => ({
          ts: toTs(c.t),
          session,
          price_cents: Number(p),
          buy: lv[1],
          sell: lv[2],
          buy_trades: lv[3],
          sell_trades: lv[4],
        })),
      );
      await insertChunked(
        sql,
        ticks,
        ["ts", "session", "price_cents", "buy", "sell", "buy_trades", "sell_trades"],
        "footprint_ticks",
        "(ts, session, price_cents)",
        "buy = excluded.buy, sell = excluded.sell, buy_trades = excluded.buy_trades, sell_trades = excluded.sell_trades",
      );

      await sql`
        insert into sessions (date, session, candles, ticks, first_ts, last_ts, ingested_at)
        values (${date}, ${session}, ${candles.length}, ${ticks.length}, ${rows[0].ts}, ${rows[rows.length - 1].ts}, now())
        on conflict (date, session) do update set
          candles = excluded.candles, ticks = excluded.ticks,
          first_ts = excluded.first_ts, last_ts = excluded.last_ts, ingested_at = now()`;

      candlesTotal += candles.length;
      ticksTotal += ticks.length;
      console.log(`  ${date} ${session}: ${candles.length} bars, ${ticks.length} ticks`);
    } else {
      console.log(`  [dry-run] ${date} ${session}: ${candles.length} bars`);
      candlesTotal += candles.length;
    }
  }

  if (sql && flag("--profiles")) {
    console.log("computing profile sheets…");
    const { computeSheet } = await import("../lib/gcdata.ts");
    for (const { date } of ds) {
      const sheet = await computeSheet(date);
      for (const [profile, payload] of Object.entries(sheet.profiles)) {
        if (!payload) continue;
        await sql`
          insert into profile_sheets (date, profile, payload, computed_at)
          values (${date}, ${profile}, ${sql.json(payload)}, now())
          on conflict (date, profile) do update set payload = excluded.payload, computed_at = now()`;
      }
      const n = Object.values(sheet.profiles).filter(Boolean).length;
      console.log(`  sheet ${date}: ${n} profiles`);
    }
  }

  if (sql && flag("--events")) {
    console.log("computing analysis events…");
    const { analyze } = await import("../lib/gcdata.ts");
    for (const { date, session } of ds) {
      const candles = loadCandles(date, session);
      // the ETH session crosses midnight: map each minute key to its absolute ts
      const tsByKey = new Map(candles.map((c) => [c.t.slice(11, 16), toTs(c.t)]));
      const a = await analyze(date, session, undefined, undefined, 4);
      if (!a) continue;
      // absorption events appear in BOTH a.alerts (as ABSORPTION alerts) and
      // a.absorption — dedupe on the natural key so the upsert never sees the
      // same constrained row twice in one statement
      const byKey = new Map<string, { ts: string; date: string; session: string; kind: string; price: number; bias: string | null; payload: unknown }>();
      for (const x of [...a.alerts, ...a.absorption.map((y) => ({ ...y, kind: "ABSORPTION" })), ...a.reclaims.map((y) => ({ ...y, kind: "RECLAIM", bias: null }))] as {
        t: string;
        kind: string;
        price: number;
        bias: string | null;
        [k: string]: unknown;
      }[]) {
        const ts = tsByKey.get(x.t);
        if (!ts) continue;
        byKey.set(`${ts}|${session}|${x.kind}|${x.price}`, { ts, date, session, kind: x.kind, price: x.price, bias: x.bias, payload: x });
      }
      const rows = [...byKey.values()];
      await sql`
        insert into events ${sql(rows, "ts", "date", "session", "kind", "price", "bias", "payload")}
        on conflict (ts, session, kind, price) do update set
          bias = excluded.bias, payload = excluded.payload`;
      console.log(`  ${date} ${session}: ${rows.length} events`);
    }
  }

  if (sql) await sql.end();
  console.log(`\ndone: ${candlesTotal} bars, ${ticksTotal} ticks`);
}

/** cross-check the DB against the source files */
async function verify(sql: postgres.Sql) {
  console.log("integrity check:");
  const sessions = (await sql.unsafe(
    "select date, session, candles, ticks from sessions order by date, session limit 500",
  )) as { date: string; session: string; candles: number; ticks: number }[];
  let bad = 0;
  for (const s of sessions) {
    // the driver returns Postgres `date` as a JS Date at UTC midnight —
    // format it back to the YYYY-MM-DD key the files use
    const day = new Date(s.date).toISOString().slice(0, 10);
    const candles = loadCandles(day, s.session);
    const fileTicks = candles.reduce((n, c) => n + Object.keys(c.levels).length, 0);
    const okRow = s.candles === candles.length && s.ticks === fileTicks;
    if (!okRow) bad++;
    console.log(
      `  ${day} ${s.session}: db bars ${s.candles}/${candles.length}, ticks ${s.ticks}/${fileTicks} ${okRow ? "✓" : "✗ MISMATCH"}`,
    );
  }
  const [db] = (await sql.unsafe("select count(*)::int as bars from candles_1m")) as { bars: number }[];
  const [dbT] = (await sql.unsafe("select count(*)::int as ticks from footprint_ticks")) as { ticks: number }[];
  const [dbE] = (await sql.unsafe("select count(*)::int as events from events")) as { events: number }[];
  const [dbP] = (await sql.unsafe("select count(*)::int as sheets from profile_sheets")) as { sheets: number }[];
  console.log(
    `  totals in db: ${db.bars} bars, ${dbT.ticks} ticks, ${dbE.events} events, ${dbP.sheets} profile sheets · ${bad} mismatched sessions`,
  );
}

await main();
