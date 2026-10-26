/* Unit tests for the Tradovate primary live feed (lib/tvFeed.ts) and the
 * live-source arbitration helpers (lib/live.ts). */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TvBarBuilder,
  TvFeed,
  TV_FINALIZE_MS,
  decodeTvPacket,
  parseJournalLine,
  sessionJournalDays,
  tvBarComplete,
  tvFamily,
  tvSide,
  type TvRawTick,
} from "../lib/tvFeed";
import {
  TV_RECOVER_MS,
  TV_STALE_MS,
  arbiterStep,
  composeTvMinutes,
  liveBarSourceForced,
  seedArbiter,
  tvHealth,
  type LiveMinute,
} from "../lib/live";

// 2026-10-26 14:00:00Z = 10:00 ET Monday (market open)
const T0 = Date.UTC(2026, 9, 26, 14, 0, 0);
let nextId = 1000;
function tk(ms: number, price: number, size = 1, side: "buy" | "sell" = "buy", id: number | null = nextId++): TvRawTick {
  return side === "buy"
    ? { t: ms, price, size, bid: price - 0.25, ask: price, id }
    : { t: ms, price, size, bid: price, ask: price + 0.25, id };
}

test("tvSide: at/above ask = buy, at/below bid = sell, inside = nearer side", () => {
  assert.equal(tvSide({ price: 100, bid: 99.75, ask: 100 }), 1);
  assert.equal(tvSide({ price: 99.75, bid: 99.75, ask: 100 }), -1);
  assert.equal(tvSide({ price: 100.1, bid: 100, ask: 100.5 }), -1);
  assert.equal(tvSide({ price: 100.4, bid: 100, ask: 100.5 }), 1);
});

test("decodeTvPacket: relative ticks → absolute time/price", () => {
  const out = decodeTvPacket({ bp: 116000, bt: T0, tks: [{ t: 5, p: 2, s: 3, b: 1, a: 2, id: 7 }] });
  assert.deepEqual(out, [{ t: T0 + 5, price: 29000.5, size: 3, bid: 29000.25, ask: 29000.5, id: 7 }]);
});

test("tvFamily: full-size NQ/ES only — micros never route", () => {
  assert.equal(tvFamily("NQZ6"), "nq");
  assert.equal(tvFamily("ESZ6"), "es");
  assert.equal(tvFamily("MNQZ6"), null);
  assert.equal(tvFamily("MESZ6"), null);
  assert.equal(tvFamily(undefined), null);
});

test("builder: first minute is partial, next minute complete + source candle after grace", () => {
  const b = new TvBarBuilder();
  b.ingest(tk(T0 + 10_000, 29000, 2, "buy"), T0 + 10_000);
  b.ingest(tk(T0 + 61_000, 29001, 3, "buy"), T0 + 61_000);
  b.ingest(tk(T0 + 62_000, 29000.5, 1, "sell"), T0 + 62_000);
  b.ingest(tk(T0 + 121_000, 29002, 1, "buy"), T0 + 121_000);
  assert.equal(b.finalize(T0 + 120_000 + TV_FINALIZE_MS - 1), 1); // only the first minute
  assert.equal(b.finalize(T0 + 120_000 + TV_FINALIZE_MS), 1);
  const closed = b.closedBars();
  assert.equal(closed.length, 2);
  assert.equal(closed[0].partial, true);
  assert.equal(closed[0].source, "tick");
  const m1 = closed[1];
  assert.equal(m1.source, "candle");
  assert.equal(m1.vendor, "tv");
  assert.equal(m1.t, "14:01");
  assert.equal(m1.du, "2026-10-26");
  assert.deepEqual([m1.o, m1.h, m1.l, m1.c, m1.vol, m1.buy, m1.sell], [29001, 29001, 29000.5, 29000.5, 4, 3, 1]);
  assert.deepEqual(m1.levels, { "29001.00": [3, 0], "29000.50": [0, 1] });
  assert.deepEqual(m1.levelTrades, { "29001.00": [1, 0], "29000.50": [0, 1] });
  assert.equal(b.developing()?.t, "14:02");
  assert.equal(b.coverageStart(), T0 + 60_000);
});

test("builder: duplicate ids (history replay) are ignored", () => {
  const b = new TvBarBuilder();
  const a = tk(T0 + 1000, 29000, 5, "buy", 1);
  b.ingest(a, T0);
  b.ingest({ ...a }, T0);
  b.ingest(tk(T0 + 2000, 29000, 1, "buy", 2), T0);
  b.ingest(tk(T0 + 1000, 29000, 5, "buy", 1), T0);
  assert.equal(b.developing()?.vol, 6);
});

test("builder: an id hole marks the minute incomplete; a late fill heals it", () => {
  const b = new TvBarBuilder();
  b.ingest(tk(T0 + 1000, 29000, 1, "buy", 100), T0); // partial first minute
  b.ingest(tk(T0 + 61_000, 29000, 1, "buy", 101), T0);
  b.ingest(tk(T0 + 62_000, 29000, 1, "buy", 110), T0); // 8 missing
  const bar = b.developing()!;
  assert.equal(bar.missing, 8);
  assert.equal(tvBarComplete(bar), false);
  for (let id = 102; id <= 109; id++) b.ingest(tk(T0 + 61_500, 29000, 1, "buy", id), T0);
  assert.equal(bar.missing, 0);
  assert.equal(tvBarComplete(bar), true);
  // small holes are tolerated
  const b2 = new TvBarBuilder();
  b2.ingest(tk(T0 + 1000, 1, 1, "buy", 1), T0);
  b2.ingest(tk(T0 + 61_000, 1, 1, "buy", 2), T0);
  b2.ingest(tk(T0 + 62_000, 1, 1, "buy", 4), T0);
  assert.equal(tvBarComplete(b2.developing()!), true);
});

test("builder: a tick into a finalized bar bumps the revision", () => {
  const b = new TvBarBuilder();
  b.ingest(tk(T0 + 1000, 29000), T0);
  b.ingest(tk(T0 + 61_000, 29000), T0);
  b.finalize(T0 + 120_000 + TV_FINALIZE_MS);
  const rev = b.revision;
  b.ingest(tk(T0 + 59_000, 29000), T0);
  assert.ok(b.revision > rev);
});

test("parseJournalLine: stamped chart + quote lines; outbound/unstamped ignored", () => {
  const chart = JSON.stringify({
    dir: "in",
    t: new Date(T0).toISOString(),
    type: "a",
    data: { e: "chart", d: { charts: [{ id: 9, sym: "NQZ6", bp: 116000, bt: T0, tks: [{ t: 0, p: 0, s: 2, b: -1, a: 0, id: 1 }] }] } },
  });
  const p = parseJournalLine(chart)!;
  assert.equal(p.wallMs, T0);
  assert.equal(p.ticks.length, 1);
  assert.equal(p.ticks[0].sym, "NQZ6");
  assert.equal(p.ticks[0].tk.price, 29000);
  const quote = JSON.stringify({
    dir: "in",
    t: new Date(T0).toISOString(),
    type: "a",
    data: { e: "md", d: { quotes: [{ contractId: 1, sym: "NQZ6", timestamp: "x", entries: { Trade: { price: 29000 }, TotalTradeVolume: { size: 1234 } } }] } },
  });
  const q = parseJournalLine(quote)!;
  assert.equal(q.quotes[0].q.ltp, 29000);
  assert.equal(q.quotes[0].q.volume, 1234);
  assert.equal(parseJournalLine(JSON.stringify({ dir: "out", t: "x", frame: "authorize" })), null);
  const unstamped = JSON.parse(chart);
  delete unstamped.data.d.charts[0].sym;
  assert.equal(parseJournalLine(JSON.stringify(unstamped))!.ticks.length, 0);
});

test("sessionJournalDays: after 18:00 ET only today; before, yesterday + today", () => {
  assert.deepEqual(sessionJournalDays(T0), ["2026-10-25", "2026-10-26"]);
  assert.deepEqual(sessionJournalDays(Date.UTC(2026, 9, 26, 23, 0, 0)), ["2026-10-26"]); // 19:00 ET
});

test("TvFeed: tails the journal, routes NQ/ES, ignores micros", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tvfeed-"));
  const file = path.join(dir, "md-2026-10-26.jsonl");
  writeFileSync(path.join(dir, "md-2026-10-25.jsonl"), "");
  const line = (sym: string, ms: number, id: number, p = 0) =>
    JSON.stringify({ dir: "in", t: new Date(ms).toISOString(), type: "a", data: { e: "chart", d: { charts: [{ id: 1, sym, bp: 116000, bt: ms, tks: [{ t: 0, p, s: 1, b: p - 1, a: p, id }] }] } } }) + "\n";
  writeFileSync(file, line("NQZ6", T0 + 1000, 1) + line("ESZ6", T0 + 1000, 1) + line("MNQZ6", T0 + 1000, 1));
  const feed = new TvFeed(dir);
  await feed.poll(T0 + 2000);
  assert.equal(feed.nq.developing()?.vol, 1);
  assert.equal(feed.es.developing()?.vol, 1);
  assert.deepEqual(feed.status.ignoredSyms, ["MNQZ6"]);
  // incremental tail, including a partial trailing line
  const l2 = line("NQZ6", T0 + 61_000, 2, 4);
  appendFileSync(file, l2.slice(0, 20));
  await feed.poll(T0 + 61_500);
  appendFileSync(file, l2.slice(20));
  await feed.poll(T0 + 62_000);
  assert.equal(feed.nq.developing()?.t, "14:01");
  assert.equal(feed.nq.lastPrice, 29001);
  await feed.poll(T0 + 120_000 + TV_FINALIZE_MS);
  assert.equal(feed.nq.closedBars().at(-1)?.source, "candle");
});

/* ---- arbitration ---- */

function healthyBuilder(now: number): TvBarBuilder {
  const b = new TvBarBuilder();
  b.ingest(tk(now - 125_000, 29000), now - 125_000);
  b.ingest(tk(now - 65_000, 29000), now - 65_000);
  b.ingest(tk(now - 1000, 29000), now - 1000);
  b.finalize(now);
  return b;
}

test("tvHealth: ok / stale / warming / gap", () => {
  const now = T0 + 10 * 60_000 + 5_000;
  assert.equal(tvHealth(healthyBuilder(now), now, true), "ok");
  assert.equal(tvHealth(healthyBuilder(now), now, false), "bootstrapping");
  assert.match(tvHealth(healthyBuilder(now), now + TV_STALE_MS + 2000, true), /^stale/);
  const warm = new TvBarBuilder();
  warm.ingest(tk(now - 1000, 29000), now - 1000);
  assert.match(tvHealth(warm, now, true), /^warming/);
  const gap = healthyBuilder(now);
  gap.ingest(tk(now - 500, 29000, 1, "buy", nextId + 50), now - 500);
  gap.finalize(now + 60_000);
  gap.ingest(tk(now + 60_000, 29000), now + 60_000);
  gap.finalize(now + 61_000 + TV_FINALIZE_MS);
  assert.match(tvHealth(gap, now + 61_000 + TV_FINALIZE_MS, true), /^gap \d+ ticks/);
});

test("arbiterStep: GC until TV healthy for TV_RECOVER_MS, instant fail-over, closed market holds", () => {
  let a = seedArbiter();
  assert.equal(a.active, "gc");
  a = arbiterStep(a, "ok", T0, true, false);
  assert.equal(a.active, "gc");
  a = arbiterStep(a, "ok", T0 + TV_RECOVER_MS - 1, true, false);
  assert.equal(a.active, "gc");
  a = arbiterStep(a, "ok", T0 + TV_RECOVER_MS, true, false);
  assert.equal(a.active, "tv");
  assert.equal(a.switches, 1);
  a = arbiterStep(a, "stale 30s", T0 + TV_RECOVER_MS + 1000, true, false);
  assert.equal(a.active, "gc");
  assert.equal(a.reason, "tradovate stale 30s");
  assert.equal(a.switches, 2);
  // a blip resets the recovery streak
  a = arbiterStep(a, "ok", T0 + 300_000, true, false);
  a = arbiterStep(a, "gap 9 ticks in 14:05Z", T0 + 360_000, true, false);
  a = arbiterStep(a, "ok", T0 + 361_000, true, false);
  a = arbiterStep(a, "ok", T0 + 361_000 + TV_RECOVER_MS - 1, true, false);
  assert.equal(a.active, "gc");
  // closed market: hold whatever is active
  const tvA = { ...a, active: "tv" as const };
  assert.equal(arbiterStep(tvA, "stale 999s", T0, false, false).active, "tv");
  // forced GC wins over health
  assert.equal(arbiterStep(tvA, "ok", T0, true, true).active, "gc");
});

test("liveBarSourceForced: only an explicit gc forces GC", () => {
  assert.equal(liveBarSourceForced({}), false);
  assert.equal(liveBarSourceForced({ LIVE_BAR_SOURCE: "GC" }), true);
  assert.equal(liveBarSourceForced({ LIVE_BAR_SOURCE: "tradovate" }), false);
});

test("composeTvMinutes: TV complete bars win, GC fills history, GC tail past TV dropped", () => {
  const gcBar = (t: string, source: "tick" | "candle" = "candle"): LiveMinute => ({ t, du: "2026-10-26", o: 0, h: 1, l: 1, c: 0, vol: 10, buy: 5, sell: 5, live: true, source });
  const b = new TvBarBuilder();
  b.ingest(tk(T0 + 60_000 + 1000, 29000), T0); // 14:01 partial
  b.ingest(tk(T0 + 120_000 + 1000, 29001), T0); // 14:02 complete
  b.ingest(tk(T0 + 180_000 + 1000, 29002), T0); // developing 14:03
  b.finalize(T0 + 180_000 + TV_FINALIZE_MS);
  const out = composeTvMinutes([gcBar("14:00"), gcBar("14:01"), gcBar("14:02"), gcBar("14:03", "tick")], b.closedBars());
  assert.deepEqual(out.map((m) => `${m.t}:${m.vendor ?? "gc"}`), ["14:00:gc", "14:01:gc", "14:02:tv"]);
});
