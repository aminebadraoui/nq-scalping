/* Unit tests for the health-pipeline derivation (display-only): every
 * stage's level comes from the /api/gc?action=health payload the
 * dashboard polls — the pipeline must never invent health. */
import { test } from "node:test";
import assert from "node:assert";
import { derivePipeline, pipelineOverall, type PipelineHealthInput } from "../lib/pipelineHealth";

const NOW = 1_700_000_000_000;

/* ---- payload builders ------------------------------------------------ */

function healthyExecution(): NonNullable<PipelineHealthInput["execution"]> {
  return {
    crosstradeConfigured: true,
    tradingHalt: false,
    executeLive: true,
    instrument: "MNQZ26",
    feeds: {
      momentum: true,
      bigbar: false,
      rth: true,
      openDrive: true,
      open: true,
      openPullback: false,
      openSniper: false,
      reversal: false,
      sweepReclaim: false,
      pullbackTicket: false,
      unusualVolume: false,
      gapAlerts: false,
    },
    liveFeed: {
      connected: true,
      minutes: 400,
      lastTradeAgeSec: 2,
      lastVolChangeAgeSec: 3,
      ratio: 1.02,
      barSource: { candle: 110, tick: 10 },
      confirmRace: { restWins: 3, frameWins: 7 },
      heal: { step: 0, episodes: 0 },
      tapeGate: { totalBars: 400, tail: 1, tailAgeMs: 45_000, hold: true, veto: false, lastBarClose: NOW - 45_000 },
      detectors: { bars: 400, momentumFlush: 1, momentumExpansion: 2, rth: 1 },
    },
    domFeed: { connected: true, frames: 8_000, silentConnects: 0, lastReconnectAt: 0, nqSnapshots: 900, nqIncrements: 7_000 },
    protections: {
      status: { state: "live", label: "TRADING", reason: "all gates clear", halts: [] },
      stage: "eval",
      floor: 48_000,
      consistencyCap: 900,
      profitArmed: false,
      dd: { halved: false },
      dayPnl: 120,
      account: { equity: 50_120, realized: 50_120 },
    },
    market: { open: true, next: { kind: "close", atMs: NOW + 3_600_000 } },
    pipeline: null,
  };
}

function healthyPipeline(): NonNullable<NonNullable<PipelineHealthInput["execution"]>["pipeline"]> {
  return {
    windowOpen: true,
    signalCard: {
      live: true,
      lastRunMs: NOW - 20_000,
      lastError: null,
      lastNote: "live",
      lastSignal: { timeET: "09:41", day: "2026-10-15", side: "short", headline: "sweep-reclaim fade" },
    },
    latency: {
      latest: { totalMs: 210, source: "event", barAgeMs: 400, stages: { getData: 12, feedCheck: 3, compute: 140, dispatch: 55 } },
      fills: [
        { ts: NOW - 120_000, label: "sweep-reclaim short", dir: "short", qty: 1, submitMs: 900, ackMs: 1_100, fillMs: 2_200, seenMs: 3_000 },
      ],
    },
    execTrades: {
      open: 1,
      wins: 0,
      losses: 0,
      netUsd: 0,
      failed: 0,
      lastFailAt: null,
      last: { ts: NOW - 120_000, label: "sweep-reclaim short", status: "filled", result: "", netUsd: 0, fillEntryAt: NOW - 115_000 },
    },
  };
}

type ExecShape = NonNullable<PipelineHealthInput["execution"]>;
type PipeShape = NonNullable<ExecShape["pipeline"]>;

const input = (over: { exec?: Partial<ExecShape>; pipe?: Partial<PipeShape> | null } = {}): PipelineHealthInput => ({
  execution: {
    ...healthyExecution(),
    ...(over.exec ?? {}),
    pipeline: over.pipe === null ? null : { ...healthyPipeline(), ...(over.pipe ?? {}) },
  },
});

const stage = (h: PipelineHealthInput, id: string) => {
  const s = derivePipeline(h, NOW).find((x) => x.id === id);
  assert.ok(s, `stage ${id} exists`);
  return s!;
};

/* ---- tape ------------------------------------------------------------- */

test("tape: streaming feed with clean ratio is ok", () => {
  assert.equal(stage(input(), "tape").level, "ok");
});

test("tape: disconnected feed is down", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, connected: false } } }), "tape");
  assert.equal(s.level, "down");
});

test("tape: prints 45s stale while the market is open degrades", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, lastTradeAgeSec: 45 } } }), "tape");
  assert.equal(s.level, "warn");
});

test("tape: prints 120s stale while the market is open is down", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, lastTradeAgeSec: 120 } } }), "tape");
  assert.equal(s.level, "down");
});

test("tape: stale prints during a closed market stay ok (no prints is normal)", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, lastTradeAgeSec: 500 }, market: { open: false, next: { kind: "open", atMs: NOW + 3_600_000 } } } }), "tape");
  assert.equal(s.level, "ok");
});

test("tape: volume undercount (ratio < 0.7) degrades", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, ratio: 0.55 } } }), "tape");
  assert.equal(s.level, "warn");
});

/* ---- bars (tape gate) ------------------------------------------------- */

test("bars: normal 1-bar confirm hold is ok", () => {
  assert.equal(stage(input(), "bars").level, "ok");
});

test("bars: stale-tail veto is down", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, tapeGate: { ...healthyExecution().liveFeed!.tapeGate!, veto: true } } } }), "bars");
  assert.equal(s.level, "down");
});

test("bars: 8 unconfirmed bars is down (page threshold)", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, tapeGate: { ...healthyExecution().liveFeed!.tapeGate!, tail: 8 } } } }), "bars");
  assert.equal(s.level, "down");
});

test("bars: 3-bar confirm lag degrades", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, tapeGate: { ...healthyExecution().liveFeed!.tapeGate!, tail: 3, tailAgeMs: 60_000 } } } }), "bars");
  assert.equal(s.level, "warn");
});

test("bars: tick-fire fallback release degrades", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, tapeGate: { ...healthyExecution().liveFeed!.tapeGate!, hold: true, tail: 2, tailAgeMs: 320_000 } } } }), "bars");
  assert.equal(s.level, "warn");
});

test("bars: empty buffer is idle (seeding)", () => {
  const s = stage(input({ exec: { liveFeed: { ...healthyExecution().liveFeed!, tapeGate: { totalBars: 0, tail: 0, tailAgeMs: null, hold: false, veto: false, lastBarClose: null } } } }), "bars");
  assert.equal(s.level, "idle");
});

/* ---- detect ----------------------------------------------------------- */

test("detect: scanning with core feeds on is ok", () => {
  assert.equal(stage(input(), "detect").level, "ok");
});

test("detect: a paused core feed degrades", () => {
  const s = stage(input({ exec: { feeds: { ...healthyExecution().feeds, momentum: false } } }), "detect");
  assert.equal(s.level, "warn");
});

test("detect: every feed paused is off", () => {
  const feeds = Object.fromEntries(Object.keys(healthyExecution().feeds!).map((k) => [k, false]));
  const s = stage(input({ exec: { feeds } }), "detect");
  assert.equal(s.level, "off");
});

/* ---- card ------------------------------------------------------------- */

test("card: live production with a recent tick is ok", () => {
  assert.equal(stage(input(), "card").level, "ok");
});

test("card: closed signal window is off", () => {
  const s = stage(input({ pipe: { windowOpen: false } }), "card");
  assert.equal(s.level, "off");
});

test("card: production stalled 10 minutes is down", () => {
  const s = stage(input({ pipe: { signalCard: { ...healthyPipeline().signalCard!, lastRunMs: NOW - 600_000 } } }), "card");
  assert.equal(s.level, "down");
});

test("card: last push failure degrades", () => {
  const s = stage(input({ pipe: { signalCard: { ...healthyPipeline().signalCard!, lastError: "telegram send refused" } } }), "card");
  assert.equal(s.level, "warn");
});

/* ---- guard ------------------------------------------------------------ */

test("guard: live state is ok", () => {
  assert.equal(stage(input(), "guard").level, "ok");
});

test("guard: halted state is down and lists halts", () => {
  const s = stage(input({ exec: { protections: { ...healthyExecution().protections!, status: { state: "halted", label: "HALTED", reason: "floor: equity within $500", halts: ["floor"] } } } }), "guard");
  assert.equal(s.level, "down");
  assert.ok(s.details.some((d) => d.label === "halts"));
});

test("guard: watch state degrades", () => {
  const s = stage(input({ exec: { protections: { ...healthyExecution().protections!, status: { state: "watch", label: "WATCH", reason: "guard state unavailable", halts: [] } } } }), "guard");
  assert.equal(s.level, "warn");
});

test("guard: dry-run is off", () => {
  const s = stage(input({ exec: { protections: { ...healthyExecution().protections!, status: { state: "dry", label: "DRY-RUN", reason: "executor live switch off", halts: [] } } } }), "guard");
  assert.equal(s.level, "off");
});

/* ---- route ------------------------------------------------------------ */

test("route: configured live routing with an acked fill is ok", () => {
  assert.equal(stage(input(), "route").level, "ok");
});

test("route: CrossTrade unconfigured is off", () => {
  assert.equal(stage(input({ exec: { crosstradeConfigured: false } }), "route").level, "off");
});

test("route: dry-run is off", () => {
  assert.equal(stage(input({ exec: { executeLive: false } }), "route").level, "off");
});

test("route: trading halt (kill switch) is down", () => {
  assert.equal(stage(input({ exec: { tradingHalt: true } }), "route").level, "down");
});

test("route: a fresh placement with no ack degrades", () => {
  const s = stage(input({ pipe: { latency: { ...healthyPipeline().latency!, fills: [{ ts: NOW - 60_000, label: "x", dir: "long", qty: 1, submitMs: 800, ackMs: null, fillMs: null, seenMs: null }] } } }), "route");
  assert.equal(s.level, "warn");
});

test("route: slow fill (>5s submit→fill) degrades", () => {
  const s = stage(input({ pipe: { latency: { ...healthyPipeline().latency!, fills: [{ ts: NOW - 120_000, label: "x", dir: "long", qty: 1, submitMs: 800, ackMs: 1_000, fillMs: 7_500, seenMs: 9_000 }] } } }), "route");
  assert.equal(s.level, "warn");
});

test("route: recent failed orders degrade", () => {
  const s = stage(input({ pipe: { execTrades: { ...healthyPipeline().execTrades!, failed: 2, lastFailAt: NOW - 300_000 } } }), "route");
  assert.equal(s.level, "warn");
});

/* ---- watch ------------------------------------------------------------ */

test("watch: a filled open position is ok", () => {
  assert.equal(stage(input(), "watch").level, "ok");
});

test("watch: flat book is idle", () => {
  const s = stage(input({ pipe: { execTrades: { ...healthyPipeline().execTrades!, open: 0, last: null } } }), "watch");
  assert.equal(s.level, "idle");
});

test("watch: a placed entry unverified past 90s degrades", () => {
  const s = stage(input({ pipe: { execTrades: { ...healthyPipeline().execTrades!, last: { ts: NOW - 200_000, label: "rth long", status: "placed", result: "", netUsd: 0, fillEntryAt: null } } } }), "watch");
  assert.equal(s.level, "warn");
});

/* ---- overall ---------------------------------------------------------- */

test("overall: all ok is ALL SYSTEMS GO", () => {
  const o = pipelineOverall(derivePipeline(input(), NOW));
  assert.equal(o.level, "ok");
  assert.equal(o.label, "ALL SYSTEMS GO");
});

test("overall: one degraded stage degrades the whole pipeline", () => {
  const h = input();
  h.execution!.feeds!.momentum = false;
  const o = pipelineOverall(derivePipeline(h, NOW));
  assert.equal(o.level, "warn");
  assert.equal(o.label, "DEGRADED");
});

test("overall: any down stage means PIPELINE DOWN", () => {
  const h = input();
  h.execution!.liveFeed!.connected = false;
  const o = pipelineOverall(derivePipeline(h, NOW));
  assert.equal(o.level, "down");
  assert.equal(o.label, "PIPELINE DOWN");
});

test("overall: everything off/idle/unknown is STANDBY, not DOWN", () => {
  const exec = healthyExecution();
  const h = input({
    exec: {
      crosstradeConfigured: false,
      executeLive: false,
      feeds: Object.fromEntries(Object.keys(exec.feeds!).map((k) => [k, false])),
      liveFeed: null,
      domFeed: null,
      protections: { ...exec.protections!, status: { state: "dry", label: "DRY-RUN", reason: "executor live switch off", halts: [] } },
    },
    pipe: { windowOpen: false, execTrades: { ...healthyPipeline().execTrades!, open: 0, last: null } },
  });
  const o = pipelineOverall(derivePipeline(h, NOW));
  assert.equal(o.level, "idle");
  assert.equal(o.label, "STANDBY");
});

test("null payload renders eight unknown stages without throwing", () => {
  const stages = derivePipeline(null, NOW);
  assert.equal(stages.length, 8);
  assert.ok(stages.every((s) => s.level === "unknown"));
});
