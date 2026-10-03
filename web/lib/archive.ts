/* ------------------------------------------------------------------ *
 * Archive access for offline studies.
 *
 * Two-store design (10-year ready):
 *   R2 (GC_REMOTE_URL)  — the record: gzipped per-session JSON + a
 *                         manifest.json index with per-file sha256 and
 *                         a precomputed `usable` flag. Never mutated by
 *                         studies; uploaded by scripts/r2_sync.py.
 *   local cache         — the working set: <MOM_CACHE_DIR>/<date>_ETH.json.gz
 *                         (default ~/.cache/nq-archive, persistent across
 *                         reboots). Filled on first read, then every sweep
 *                         is pure disk I/O. MOM_VERIFY_SHA=1 additionally
 *                         checks each cached file against the manifest's
 *                         sha256 before parsing, and refetches on mismatch.
 *
 * archiveDates({source:"manifest"}) lists usable sessions straight from
 * the manifest (deterministic, no database). warmArchive() prefetches the
 * whole store in parallel — the one-time rebuild step for any new machine.
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { listUsableSessions } from "./gcdata";
import type { MomMinute } from "./momentum";

const REMOTE = process.env.GC_REMOTE_URL?.replace(/\/+$/, "") ?? "";
const CACHE_DIR = process.env.MOM_CACHE_DIR || path.join(os.homedir(), ".cache", "nq-archive");
const VERIFY = process.env.MOM_VERIFY_SHA === "1";

type ManifestFile = {
  key: string;
  date: string;
  session?: string | null;
  candles?: number | null;
  usable?: boolean | null;
  sha256?: string;
};

type Manifest = { generated: string; bucket: string; files: ManifestFile[] };

type RawCandle = {
  t: string;
  high: number;
  low: number;
  total: number;
  buy: number;
  sell: number;
  levels: Record<string, [number, number, number, number, number]>;
};

let manifestP: Promise<Manifest | null> | null = null;

function manifest(): Promise<Manifest | null> {
  if (!REMOTE) return Promise.resolve(null);
  if (!manifestP) {
    manifestP = fetch(`${REMOTE}/manifest.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
      .catch(() => null);
  }
  return manifestP;
}

export function cacheDir(): string {
  return CACHE_DIR;
}

/* ---------------- inventory ---------------- */

export async function archiveDates(opts: { source?: "auto" | "manifest" } = {}): Promise<string[]> {
  if (opts.source === "manifest") {
    const m = await manifest();
    if (!m) return [];
    return m.files
      .filter((f) => f.session === "ETH" && f.usable && f.date)
      .map((f) => f.date)
      .sort();
  }
  const inv = await listUsableSessions();
  return inv?.dates ?? [];
}

/* ---------------- one session ---------------- */

async function sha256Of(buf: Buffer): Promise<string> {
  return createHash("sha256").update(buf).digest("hex");
}

/** True when the raw (uncompressed) bytes match the manifest, or when
 *  verification is disabled / the manifest has no entry for the key. */
async function verifyOk(raw: Buffer, key: string): Promise<boolean> {
  if (!VERIFY) return true;
  const m = await manifest();
  if (!m) return true;
  const entry = m.files.find((f) => f.key === key);
  if (!entry?.sha256) return true;
  return (await sha256Of(raw)) === entry.sha256;
}

function parseRaw(raw: Buffer): MomMinute[] {
  const j = JSON.parse(raw.toString("utf8")) as { candles?: RawCandle[] };
  const candles = j.candles ?? [];
  if (candles.length < 60) return [];
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

/* ---------------- OHLC twins (optional join for studies) ----------------
 * The session archive is footprint-only by contract (high/low/buy/sell, no
 * open/close). gcdata/collect_ohlc.py stores vendor OHLCV twins separately
 * on R2: data/ohlc/<date>_ETH.json (1,380 bars, the full day) and the legacy
 * 390-bar RTH twin. Studies that need TRUE opens/closes (e.g. next-bar-open
 * entry fills) can opt in with loadSessionMinutes(date, { withOhlc: true })
 * — the ETH twin is joined onto each minute by its feed-clock "HH:mm" key.
 * Minutes without a twin bar keep o=0/c=0 (callers fall back to mid-price). */

export type OhlcTwin = Map<string, { o: number; h: number; l: number; c: number; v: number }>;

async function fetchTwinRaw(date: string): Promise<Buffer | null> {
  const name = `ohlc-${date}_ETH.json`;
  const gzFile = path.join(CACHE_DIR, `${name}.gz`);
  const legacyFile = path.join(CACHE_DIR, name);
  for (const f of [gzFile, legacyFile]) {
    try {
      const b = await fs.readFile(f);
      return f.endsWith(".gz") ? gunzipSync(b) : b;
    } catch {
      /* cache miss */
    }
  }
  if (!REMOTE) return null;
  const r = await fetch(`${REMOTE}/data/ohlc/${date}_ETH.json`);
  if (!r.ok) return null;
  const raw = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(gzFile, gzipSync(raw)).catch(() => {});
  await fs.rm(legacyFile, { force: true }).catch(() => {});
  return raw;
}

export async function loadOhlcTwin(date: string): Promise<OhlcTwin | null> {
  const raw = await fetchTwinRaw(date);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.toString("utf8")) as {
      bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[];
    };
    const out: OhlcTwin = new Map();
    for (const b of j.bars ?? []) {
      out.set(String(b.t).slice(11, 16), { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function loadSessionMinutes(date: string, opts?: { withOhlc?: boolean }): Promise<MomMinute[] | null> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const key = `data/${date}_ETH.json`;
  const gzFile = path.join(CACHE_DIR, `${date}_ETH.json.gz`);
  const legacyFile = path.join(CACHE_DIR, `${date}_ETH.json`);

  // 1) local cache first (gzip form, then the pre-gzip layout)
  let minutes: MomMinute[] | null = null;
  for (const f of [gzFile, legacyFile]) {
    let raw: Buffer;
    try {
      const b = await fs.readFile(f);
      raw = f.endsWith(".gz") ? gunzipSync(b) : b;
    } catch {
      continue;
    }
    if (await verifyOk(raw, key)) {
      minutes = parseRaw(raw);
      break;
    }
    // corrupted or tampered — drop it and fall through to a fresh fetch
    await fs.rm(f, { force: true }).catch(() => {});
  }

  // 2) fetch from R2, store gzipped bytes for next time
  if (minutes === null) {
    if (!REMOTE) return null;
    const r = await fetch(`${REMOTE}/${key}`);
    if (!r.ok) return null;
    const raw = Buffer.from(await r.arrayBuffer());
    if (VERIFY && !(await verifyOk(raw, key))) return null;
    await fs.writeFile(gzFile, gzipSync(raw)).catch(() => {});
    await fs.rm(legacyFile, { force: true }).catch(() => {});
    minutes = parseRaw(raw);
  }

  // 3) optional OHLC twin join (true opens/closes for the whole day)
  if (opts?.withOhlc) {
    const twin = await loadOhlcTwin(date);
    if (twin) {
      for (const m of minutes) {
        const b = twin.get(m.t);
        if (b) {
          m.o = b.o;
          m.c = b.c;
        }
      }
    }
  }
  return minutes;
}

/* ---------------- warm the whole store ---------------- */

export async function warmArchive(opts: {
  dates?: string[];
  concurrency?: number;
  log?: (msg: string) => void;
} = {}): Promise<{ ok: number; failed: number; bytes: number }> {
  const con = opts.concurrency ?? 16;
  const dates = opts.dates ?? (await archiveDates({ source: "manifest" }));
  const log = opts.log ?? ((m: string) => console.log(m));
  let ok = 0;
  let failed = 0;
  let done = 0;
  let i = 0;
  const worker = async () => {
    for (;;) {
      const d = dates[i++];
      if (d === undefined) return;
      const minutes = await loadSessionMinutes(d);
      if (minutes) ok++;
      else failed++;
      done++;
      if (done % 50 === 0 || done === dates.length) {
        log(`warm ${done}/${dates.length} · ${ok} ok · ${failed} failed`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(con, dates.length)) }, worker));

  let bytes = 0;
  try {
    for (const f of await fs.readdir(CACHE_DIR)) {
      if (!f.endsWith(".json.gz")) continue;
      const st = await fs.stat(path.join(CACHE_DIR, f));
      bytes += st.size;
    }
  } catch {
    /* ignore */
  }
  log(`cache: ${(bytes / 1e9).toFixed(2)} GB gzipped in ${CACHE_DIR}`);
  return { ok, failed, bytes };
}
