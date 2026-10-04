/* ------------------------------------------------------------------ *
 * Per-session divergence store — the canonical derived artifact that
 * backtests (and future studies) read instead of re-deriving D2/D4
 * pivots from raw footprint files.
 *
 *   gcdata/data/divergences/{date}_{session}.json
 *
 * · computed with the SAME lib/divergence.ts definition the ladder and
 *   the analysis use, so the UI, the store and the backtest can never
 *   drift apart
 * · backfilled for the whole history by `db/divStore.ts` and refreshed
 *   nightly (scripts/nightly.sh) for progressive storage of new days
 * · self-healing: a read miss computes and persists the session
 *   (atomic rename, safe for concurrent readers)
 *
 * One row per qualifying pivot pair, carrying the comparison pair
 * (prior pivot price + CVD) so a backtest can measure HOW divergent
 * the extreme was, not just that a divergence existed.
 * ------------------------------------------------------------------ */

import { promises as fs } from "fs";
import path from "path";
import { computeDivergences, type Divergence } from "./divergence";
import { extractFootprint, type Session } from "./gcdata";

const DATA_DIR = process.env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");
export const DIVERGENCE_DIR = path.join(DATA_DIR, "divergences");

export const DIV_STORE_SCHEMA = 1;

/** a stored divergence row — the pivot pair plus its minute stamp */
export type DivRow = Divergence & {
  /** feed-clock "HH:mm" of the pivot minute (matches FootprintMinute.t) */
  t: string;
  /** feed-clock calendar date of the bar */
  d: string;
};

export type DivFile = {
  schema: number;
  date: string;
  session: Session;
  minutes: number;
  generatedAt: string;
  divergences: DivRow[];
};

function fileOf(date: string, session: Session): string {
  return path.join(DIVERGENCE_DIR, `${date}_${session}.json`);
}

/** derive rows from the session's footprint (the single shared definition) */
export async function computeSessionDivergences(date: string, session: Session): Promise<DivFile | null> {
  const fp = await extractFootprint(date, session);
  if (!fp || fp.minutes.length < 5) return null;
  const divs = computeDivergences(fp.minutes);
  const rows: DivRow[] = divs.map((d) => {
    const m = fp.minutes[d.index];
    return { ...d, t: m.t, d: m.d };
  });
  return {
    schema: DIV_STORE_SCHEMA,
    date,
    session,
    minutes: fp.minutes.length,
    generatedAt: new Date().toISOString(),
    divergences: rows,
  };
}

/** atomic write so a concurrent reader never sees a half-written file */
export async function writeSessionDivergences(date: string, session: Session): Promise<DivFile | null> {
  const div = await computeSessionDivergences(date, session);
  if (!div) return null;
  await fs.mkdir(DIVERGENCE_DIR, { recursive: true });
  const file = fileOf(date, session);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(div), "utf8");
  await fs.rename(tmp, file);
  return div;
}

/**
 * Load stored divergences for a session. A read miss computes and persists
 * them (self-healing — the store fills itself in as backtests run), so every
 * consumer gets the canonical artifact whether or not the nightly backfill
 * has covered this date yet.
 */
export async function loadSessionDivergences(date: string, session: Session): Promise<DivFile | null> {
  const file = fileOf(date, session);
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DivFile>;
    if (raw.schema === DIV_STORE_SCHEMA && Array.isArray(raw.divergences)) {
      return raw as DivFile;
    }
  } catch {
    /* miss — compute below */
  }
  return writeSessionDivergences(date, session);
}

/**
 * Backfill (or refresh) the store for every session found in the local data
 * directory — the same discovery the studies use (files, not the DB, because
 * the 2.5-year history lives in JSON while Neon only holds a rolling window).
 * `since` limits writes to sessions dated >= since (nightly progressive mode).
 */
export async function backfillDivergences(opts: {
  since?: string;
  session?: Session;
  skipExisting?: boolean;
} = {}): Promise<{ written: string[]; failed: string[] }> {
  const { since, session, skipExisting = false } = opts;
  let files: string[] = [];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return { written: [], failed: [] };
  }
  const written: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const m = /^(\d{4}-\d{2}-\d{2})_(ETH|RTH)\.json$/.exec(f);
    if (!m) continue;
    const [, date, sess] = m;
    if (session && sess !== session) continue;
    if (since && date < since) continue;
    if (skipExisting) {
      try {
        await fs.access(fileOf(date, sess as Session));
        continue;
      } catch {
        /* write below */
      }
    }
    try {
      const div = await writeSessionDivergences(date, sess as Session);
      if (div) written.push(`${date}_${sess} (${div.divergences.length})`);
    } catch (e) {
      failed.push(`${date}_${sess}: ${String(e)}`);
    }
  }
  return { written: written.sort(), failed: failed.sort() };
}
