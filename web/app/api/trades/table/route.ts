/* ------------------------------------------------------------------ *
 * Trade ledger API — the journal's all-variables trade table.
 *
 * One row per bot trade: the reconciled signal↔fill row joined with the
 * feature vector recorded at fire time (incl. context that does not
 * participate in the signal) and the daybook boot variation in effect
 * when the trade fired. `variables` lists every distinct feature key
 * across the rows (most common first) so the UI can render them as
 * columns on demand.
 *
 * DB mode: Neon `trades` (features jsonb already carried over from the
 * signal at reconcile time) LEFT JOIN `signals` for the card metadata.
 * DB-less mode (Neon quota/unreachable): the daybook archive (local
 * volume ∪ R2) — signal records joined to the nightly dayend summaries.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "@/lib/gcdb";
import {
  daybookR2Base,
  listDaybookDaysRemote,
  readDaybookDay,
  type DaybookRecord,
} from "@/lib/daybook";
import {
  attachVariations,
  buildRowsFromDb,
  buildRowsFromDaybook,
  distinctVariables,
  type DaybookDayPack,
  type LedgerRow,
} from "@/lib/tradeLedger";

export const dynamic = "force-dynamic";

const MAX_ROWS = 2000;
const MAX_VARIATION_DAYS = 120;

/** the R2 archive copy of a day's daybook (local volume can shadow R2 in
 *  `readDaybookDayRemote`, so fetch the remote file directly for merging) */
async function fetchR2Day(day: string): Promise<DaybookRecord[]> {
  try {
    const res = await fetch(`${daybookR2Base()}/data/daybook/${day}.jsonl`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    return (await res.text())
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as DaybookRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is DaybookRecord => r !== null);
  } catch {
    return [];
  }
}

/** local volume ∪ R2 archive — the full record set for a day */
async function mergedDay(day: string): Promise<DaybookRecord[]> {
  const local = readDaybookDay(day);
  const remote = await fetchR2Day(day);
  return [...remote, ...local];
}

async function variationRecs(days: string[]): Promise<Map<string, DaybookRecord[]>> {
  const out = new Map<string, DaybookRecord[]>();
  await Promise.all(
    days.slice(0, MAX_VARIATION_DAYS).map(async (d) => {
      try {
        out.set(d, await mergedDay(d));
      } catch {
        out.set(d, []);
      }
    }),
  );
  return out;
}

async function daybookLedger(): Promise<{ rows: LedgerRow[] }> {
  const days = (await listDaybookDaysRemote()).slice(-MAX_VARIATION_DAYS);
  const packs: DaybookDayPack[] = [];
  for (const d of days) {
    try {
      packs.push({ day: d, recs: await mergedDay(d) });
    } catch {
      /* best-effort archive read */
    }
  }
  const rows = buildRowsFromDaybook(packs);
  attachVariations(rows, new Map(packs.map((p) => [p.day, p.recs])));
  return { rows };
}

export async function GET() {
  if (!dbEnabled()) {
    return Response.json({ ok: true, source: "daybook", ...(await daybookLedger()) });
  }
  try {
    const db = getDb();
    const raw = (await db`
      select t.*, s.size as sig_size, s.headline as sig_headline, s.source as sig_source,
             s.test as sig_test, s.sent as sig_sent, s.reason as sig_reason
      from trades t
      left join signals s on s.key = t.signal_key
      order by t.ts desc
      limit ${MAX_ROWS}`) as Array<Record<string, unknown>>;
    const rows = buildRowsFromDb(raw);
    const days = [...new Set(rows.map((r) => r.day))];
    attachVariations(rows, await variationRecs(days));
    return Response.json({
      ok: true,
      source: "db",
      rows,
      variables: distinctVariables(rows),
    });
  } catch {
    // DB configured but unreachable (Neon quota etc.) — serve the
    // daybook journal instead of an error page
    try {
      return Response.json({ ok: true, source: "daybook", ...(await daybookLedger()) });
    } catch (e) {
      return Response.json({ ok: false, reason: String(e) });
    }
  }
}
