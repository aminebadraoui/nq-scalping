/* ------------------------------------------------------------------ *
 * Archive access for offline studies: R2 session inventory + per-day
 * candles (disk-cached), in the MomMinute shape the momentum detector
 * and the feature studies share.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listUsableSessions } from "./gcdata";
import type { MomMinute } from "./momentum";

const REMOTE = process.env.GC_REMOTE_URL?.replace(/\/+$/, "") ?? "";
const CACHE_DIR = process.env.MOM_CACHE_DIR || path.join(os.tmpdir(), "nq-mom-cache");

type RawCandle = {
  t: string;
  high: number;
  low: number;
  total: number;
  buy: number;
  sell: number;
  levels: Record<string, [number, number, number, number, number]>;
};

export async function archiveDates(): Promise<string[]> {
  const inv = await listUsableSessions();
  return inv?.dates ?? [];
}

export async function loadSessionMinutes(date: string): Promise<MomMinute[] | null> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${date}_ETH.json`);
  let j: { candles?: RawCandle[] };
  try {
    j = JSON.parse(await fs.readFile(cacheFile, "utf8"));
  } catch {
    if (!REMOTE) return null;
    const r = await fetch(`${REMOTE}/data/${date}_ETH.json`);
    if (!r.ok) return null;
    j = (await r.json()) as { candles?: RawCandle[] };
    await fs.writeFile(cacheFile, JSON.stringify(j)).catch(() => {});
  }
  const candles = j.candles ?? [];
  if (candles.length < 60) return null;
  return candles.map((c) => ({
    t: c.t.slice(11, 16),
    d: c.t.slice(0, 10),
    o: 0,
    c: 0,
    high: c.high / 100,
    low: c.low / 100,
    buy: c.buy,
    sell: c.sell,
    levels: Object.entries(c.levels).map(([p, v]) => ({
      price: Number(p) / 100,
      buy: v[1],
      sell: v[2],
    })),
  }));
}
