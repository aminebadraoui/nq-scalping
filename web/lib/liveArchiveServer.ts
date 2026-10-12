/* ------------------------------------------------------------------ *
 * Cached I/O wrapper for the live archive (lib/liveArchive.ts).
 *
 * Reads every daybook day (local volume ∪ R2 readthrough), extracts
 * the nightly `dayend` summaries, and hands them to the pure
 * aggregation. Cached because the archive only moves once a day and
 * every study card on a page would otherwise re-read it: per-request
 * React cache + 10-minute cross-request unstable_cache.
 * ------------------------------------------------------------------ */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { listDaybookDaysRemote, readDaybookDayRemote, type DaybookDaySummary, type DaybookRecord } from "./daybook";
import { aggregateLiveArchive, type LiveArchive } from "./liveArchive";

async function fetchLiveArchive(): Promise<LiveArchive> {
  // newest 200 days bound the parallel R2 reads (the archive is young;
  // every day file is read once per 10-minute cache window)
  const dayKeys = (await listDaybookDaysRemote()).slice(-200);
  const days: Array<{ day: string; summary: DaybookDaySummary }> = (
    await Promise.all(
      dayKeys.map(async (day) => {
        try {
          const rows = await readDaybookDayRemote(day);
          const summaries = rows
            .filter((r): r is Extract<DaybookRecord, { t: "dayend" }> => r.t === "dayend")
            .map((r) => r.summary as unknown as DaybookDaySummary);
          return summaries.map((summary) => ({ day, summary }));
        } catch {
          return [] as Array<{ day: string; summary: DaybookDaySummary }>;
        }
      }),
    )
  ).flat();
  return aggregateLiveArchive(days);
}

const cachedFetch = unstable_cache(fetchLiveArchive, ["live-archive"], { revalidate: 600 });

/** the live archive: deduped per request, cached 10 minutes across
 *  requests. Server-side only (fs + R2 readthrough). */
export const getLiveArchive = cache(cachedFetch);
