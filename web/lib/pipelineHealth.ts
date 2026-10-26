/* ------------------------------------------------------------------ *
 * Health-pipeline derivation — PURE, display-only.
 *
 * Turns the /api/gc?action=health payload into one stage per step of
 * signal production → execution, each with a health LEVEL and the
 * live metrics behind it. Never gates, sizes, or places anything —
 * this module only mirrors what the executor reports.
 *
 * Stages (left → right, the production flow):
 *   TAPE   the GoCharting tick/footprint feed (lib/live.ts)
 *   BARS   candle confirmation / tape gate (the family checkers' gate)
 *   DETECT the family detectors scanning the live buffer
 *   CARD   signal-card production + Telegram push (signalFeed)
 *   GUARD  the risk guard (crossGuard) — floors, caps, halts
 *   ROUTE  order routing to CrossTrade/Tradovate (latency + ledger)
 *   WATCH  position management (open trades, entry verification)
 * ------------------------------------------------------------------ */

export type PipelineLevel = "ok" | "warn" | "down" | "off" | "idle" | "unknown";

/** the `pipeline` block the health route assembles (display-only reads) */
export type PipelineExtras = {
  windowOpen: boolean;
  signalCard: {
    live: boolean;
    lastRunMs: number;
    lastError: string | null;
    lastNote: string | null;
    lastSignal: { timeET: string; day: string; side: string; headline: string } | null;
  } | null;
  latency: {
    latest: { totalMs: number; source: string; barAgeMs: number | null; stages: Record<string, number> } | null;
    fills: Array<{
      ts: number;
      label: string;
      dir: string;
      qty: number;
      submitMs: number;
      ackMs: number | null;
      fillMs: number | null;
      seenMs: number | null;
    }>;
  } | null;
  execTrades: {
    open: number;
    wins: number;
    losses: number;
    netUsd: number;
    failed: number;
    lastFailAt: number | null;
    last: { ts: number; label: string; status: string; result: string; netUsd: number; fillEntryAt: number | null } | null;
  } | null;
};

/* ---- the health payload shapes the derivation reads ------------------ */

type LiveFeedDiag = {
  connected: boolean;
  minutes: number;
  lastTradeAgeSec: number | null;
  lastVolChangeAgeSec: number | null;
  ratio: number | null;
  barSource: { candle: number; tick: number } | null;
  confirmRace: { restWins: number; frameWins: number } | null;
  heal: { step: number; episodes: number } | null;
  tapeGate: {
    totalBars: number;
    tail: number;
    tailAgeMs: number | null;
    hold: boolean;
    veto: boolean;
    lastBarClose: number | null;
  } | null;
  detectors: { bars: number; momentumFlush: number; momentumExpansion: number; rth: number } | null;
} | null;

type ProtectionsDiag = {
  status: { state: "live" | "dry" | "halted" | "watch"; label: string; reason: string; halts: string[] };
  stage: "eval" | "funded";
  floor: number;
  consistencyCap: number;
  profitArmed: boolean;
  dd: { halved: boolean };
  dayPnl: number;
  account: { equity: number; realized: number } | null;
} | null;

export type PipelineHealthInput = {
  execution: {
    crosstradeConfigured: boolean;
    tradingHalt: boolean;
    executeLive: boolean;
    instrument: string;
    feeds: Record<string, boolean> | null;
    liveFeed: LiveFeedDiag;
    protections: ProtectionsDiag;
    market: { open: boolean; next: { kind: string; atMs: number } } | null;
    /** the pipeline extras the health route assembles next to the feeds */
    pipeline: PipelineExtras | null;
  } | null;
};

export type PipelineStage = {
  id: string;
  name: string;
  icon: string;
  level: PipelineLevel;
  /** one line — what the stage is doing / why its level is what it is */
  headline: string;
  /** the compact live metric shown on the node */
  metric: string;
  details: Array<{ label: string; value: string; tone?: PipelineLevel }>;
};

/* ---- helpers ---------------------------------------------------------- */

const usd = (n: number) => `${n < 0 ? "−$" : "+$"}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const ageSec = (ms: number, now: number) => Math.round((now - ms) / 1000);

const secFmt = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

/** feed flag display names (same order as the health payload) */
const FEED_NAMES: Record<string, string> = {
  momentum: "MOM",
  bigbar: "BIG",
  rth: "SES",
  openDrive: "DRV",
  open: "OPN",
  openPullback: "OPB",
  openSniper: "SNP",
  reversal: "REV",
  sweepReclaim: "SWP",
  pullbackTicket: "PBT",
  unusualVolume: "UVL",
  gapAlerts: "GAP",
};

/** the families that ship enabled — pausing one of these degrades detection */
const CORE_FEEDS = ["momentum", "rth", "open", "openDrive"];

const TICK_FIRE_MS = 300_000; // TAPE_GATE_TICK_FIRE_MS default
const CARD_STALL_MS = 5 * 60_000; // no production tick in 5 min = stalled
const TAPE_ALERT_TAIL = 8; // TAPE_GATE_TAIL_ALERT
const ENTRY_UNVERIFIED_MS = 90_000; // CHECK_AFTER_MS in execWatch

/* ---- stage derivations ------------------------------------------------ */

function tapeStage(h: PipelineHealthInput): PipelineStage {
  const ex = h.execution;
  const lf = ex?.liveFeed ?? null;
  const marketOpen = ex?.market?.open ?? false;
  const details: PipelineStage["details"] = [];
  if (!lf) return { id: "tape", name: "tape", icon: "≋", level: "unknown", headline: "tick feed state unavailable", metric: "—", details };
  if (!lf.connected) return { id: "tape", name: "tape", icon: "≋", level: "down", headline: "tick feed disconnected", metric: "no data", details };

  let level: PipelineLevel = "ok";
  let headline = "tape streaming";
  if (marketOpen && lf.lastTradeAgeSec !== null) {
    if (lf.lastTradeAgeSec >= 90) {
      level = "down";
      headline = `no prints for ${lf.lastTradeAgeSec}s — feed looks dead`;
    } else if (lf.lastTradeAgeSec >= 30) {
      level = "warn";
      headline = `prints stale ${lf.lastTradeAgeSec}s`;
    }
  }
  if (level !== "down" && lf.ratio !== null && lf.ratio < 0.7) {
    // the ratio compares the live buffer's volume against the vendor's
    // day snapshot — windows that only line up by accident (12.96 one
    // boot, 0.51 the next). It is only meaningful when the recent bars
    // are materially TICK-built (the undercount it exists to detect).
    // A candle-healthy mix (cards fire on vendor candle bars) shows the
    // ratio in the details without crying wolf.
    const mix0 = lf.barSource;
    const tickFrac0 = mix0 && mix0.candle + mix0.tick > 0 ? mix0.tick / (mix0.candle + mix0.tick) : 0;
    if (tickFrac0 > 0.3) {
      level = "warn";
      headline = `volume undercount — feed ratio ×${lf.ratio.toFixed(2)}`;
    }
  }
  const mix = lf.barSource;
  if (level === "ok" && mix && mix.candle + mix.tick > 0 && mix.tick / (mix.candle + mix.tick) > 0.6) {
    level = "warn";
    headline = "tick-heavy bar mix — candle confirmation lagging";
  }

  const metric = `${lf.lastTradeAgeSec ?? "—"}s prints · vol×${lf.ratio ?? "—"}`;
  details.push({ label: "buffered", value: `${lf.minutes} min` });
  if (mix) details.push({ label: "bar source", value: `${mix.candle} candle / ${mix.tick} tick (120)` });
  details.push({ label: "vol change", value: lf.lastVolChangeAgeSec !== null ? `${lf.lastVolChangeAgeSec}s ago` : "—" });
  if (lf.confirmRace)
    details.push({ label: "confirm race", value: `rest ${lf.confirmRace.restWins} · frame ${lf.confirmRace.frameWins}` });
  if (lf.heal && lf.heal.step > 0)
    details.push({ label: "self-heal", value: `step ${lf.heal.step} · ${lf.heal.episodes} episode(s)`, tone: "warn" });
  return { id: "tape", name: "tape", icon: "≋", level, headline, metric, details };
}

function barsStage(h: PipelineHealthInput): PipelineStage {
  const tg = h.execution?.liveFeed?.tapeGate ?? null;
  const details: PipelineStage["details"] = [];
  if (!tg) return { id: "bars", name: "bars", icon: "▓", level: "unknown", headline: "tape-gate state unavailable", metric: "—", details };

  if (tg.totalBars === 0)
    return { id: "bars", name: "bars", icon: "▓", level: "idle", headline: "live buffer seeding — no bars yet", metric: "0 bars", details };

  let level: PipelineLevel;
  let headline: string;
  if (tg.veto) {
    level = "down";
    headline = "stale tail bar — every card vetoed (dead bar)";
  } else if (tg.tail >= TAPE_ALERT_TAIL) {
    level = "down";
    headline = `${tg.tail} unconfirmed bars — operator page threshold`;
  } else if (tg.hold && tg.tailAgeMs !== null && tg.tailAgeMs >= TICK_FIRE_MS) {
    level = "warn";
    headline = "tick-fire fallback released a held card (stall-grade lag)";
  } else if (tg.tail >= 6) {
    // real degradation: the vendor's normal publish cycle leaves a tail
    // of 0-4 (it confirms each bar ~60-90s late); 6+ unconfirmed bars
    // means confirmation is genuinely falling behind, short of the
    // operator-page threshold (8)
    level = "warn";
    headline = `confirmation lag — ${tg.tail} bars unconfirmed`;
  } else if (tg.hold) {
    level = "ok";
    headline = `vendor confirming — ${tg.tail} unconfirmed bar${tg.tail === 1 ? "" : "s"} (normal cadence)`;
  } else {
    level = "ok";
    headline = "bars confirmed — gate clear";
  }

  details.push({ label: "tail", value: `${tg.tail} / ${tg.totalBars}` });
  details.push({ label: "tail age", value: tg.tailAgeMs !== null ? `${Math.round(tg.tailAgeMs / 1000)}s` : "—" });
  details.push({ label: "veto", value: tg.veto ? "active" : "clear", tone: tg.veto ? "down" : undefined });
  details.push({ label: "gate", value: tg.hold ? "holding" : "clear" });
  return { id: "bars", name: "bars", icon: "▓", level, headline, metric: `tail ${tg.tail} · ${tg.hold ? "holding" : "clear"}`, details };
}

function detectStage(h: PipelineHealthInput): PipelineStage {
  const det = h.execution?.liveFeed?.detectors ?? null;
  const feeds = h.execution?.feeds ?? null;
  const details: PipelineStage["details"] = [];
  if (!det) return { id: "detect", name: "detect", icon: "⌖", level: "unknown", headline: "detector state unavailable", metric: "—", details };

  const on: string[] = [];
  const off: string[] = [];
  if (feeds) {
    for (const [k, v] of Object.entries(feeds)) (v ? on : off).push(FEED_NAMES[k] ?? k.toUpperCase());
  }
  const coreOff = CORE_FEEDS.filter((f) => feeds && feeds[f] === false);

  let level: PipelineLevel = "ok";
  let headline = "detectors scanning the live buffer";
  if (feeds && off.length === Object.keys(feeds).length) {
    level = "off";
    headline = "all detectors paused";
  } else if (coreOff.length > 0) {
    level = "warn";
    headline = `core detector paused: ${coreOff.map((f) => FEED_NAMES[f]).join(" ")}`;
  }

  const cands = det.momentumFlush + det.momentumExpansion + det.rth;
  details.push({ label: "bars scanned", value: String(det.bars) });
  details.push({ label: "failed-flush", value: String(det.momentumFlush) });
  details.push({ label: "huge-bar", value: String(det.momentumExpansion) });
  details.push({ label: "session cont", value: String(det.rth) });
  details.push({ label: "feeds on", value: feeds ? `${on.length}/${Object.keys(feeds).length} · ${on.join(" ") || "none"}` : "—" });
  if (off.length > 0) details.push({ label: "paused", value: off.join(" "), tone: coreOff.length > 0 ? "warn" : undefined });
  return { id: "detect", name: "detect", icon: "⌖", level, headline, metric: `ffb ${det.momentumFlush}/${det.momentumExpansion} · ses ${det.rth} · ${cands} cands`, details };
}

function cardStage(h: PipelineHealthInput, now: number): PipelineStage {
  const sc = h.execution?.pipeline?.signalCard ?? null;
  const details: PipelineStage["details"] = [];
  if (!sc) return { id: "card", name: "card", icon: "▤", level: "unknown", headline: "card production state unavailable", metric: "—", details };

  if (!h.execution?.pipeline?.windowOpen) {
    const next = h.execution?.market?.next;
    details.push({ label: "window", value: "closed — cards paused" });
    if (next) details.push({ label: "next", value: `${next.kind} ${new Date(next.atMs).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET` });
    return { id: "card", name: "card", icon: "▤", level: "off", headline: "signal window closed", metric: "no cards", details };
  }

  let level: PipelineLevel = "ok";
  let headline = "card production live";
  if (sc.lastRunMs === 0) {
    level = "warn";
    headline = "no production tick yet — waiting for the first cycle";
  } else if (now - sc.lastRunMs > CARD_STALL_MS) {
    level = "down";
    headline = `production stalled ${ageSec(sc.lastRunMs, now)}s — no tick`;
  } else if (!sc.live) {
    level = "warn";
    headline = `no live context — ${sc.lastNote ?? "feed not live"}`;
  } else if (sc.lastError) {
    level = "warn";
    headline = `last push failed — ${sc.lastError}`;
  }

  const last = sc.lastSignal;
  details.push({ label: "last tick", value: sc.lastRunMs ? `${ageSec(sc.lastRunMs, now)}s ago` : "never" });
  details.push({ label: "live context", value: sc.live ? "yes" : "no", tone: sc.live ? undefined : "warn" });
  if (sc.lastNote) details.push({ label: "note", value: sc.lastNote });
  if (sc.lastError) details.push({ label: "last error", value: sc.lastError, tone: "warn" });
  if (last) {
    details.push({ label: "last card", value: `${last.side !== "none" ? last.side.toUpperCase() : "•"} ${last.timeET} ET · ${last.headline}` });
  } else {
    details.push({ label: "last card", value: "none yet" });
  }
  return {
    id: "card",
    name: "card",
    icon: "▤",
    level,
    headline,
    metric: last ? `${last.side !== "none" ? last.side.toUpperCase() : "flat"} ${last.timeET}` : "no card yet",
    details,
  };
}

function guardStage(h: PipelineHealthInput): PipelineStage {
  const p = h.execution?.protections ?? null;
  const details: PipelineStage["details"] = [];
  if (!h.execution) return { id: "guard", name: "guard", icon: "⛨", level: "unknown", headline: "execution state unavailable", metric: "—", details };
  if (!p) return { id: "guard", name: "guard", icon: "⛨", level: "warn", headline: "guard state unavailable", metric: "—", details };

  const st = p.status;
  const level: PipelineLevel = st.state === "live" ? "ok" : st.state === "halted" ? "down" : st.state === "dry" ? "off" : "warn";
  const headline = st.state === "live" ? "all gates clear — trading" : `${st.state === "halted" ? "halted" : st.state === "dry" ? "dry-run" : "watch"} — ${st.reason}`;

  const eq = p.account?.equity ?? null;
  details.push({ label: "day pnl", value: usd(p.dayPnl), tone: p.dayPnl >= 0 ? "ok" : "warn" });
  if (eq !== null && p.floor > 0) details.push({ label: "floor buffer", value: `${usd(eq - p.floor)}`, tone: eq - p.floor < 1000 ? "warn" : undefined });
  if (p.consistencyCap > 0) details.push({ label: "consistency", value: `${usd(p.dayPnl)} / ${usd(p.consistencyCap)}`, tone: p.dayPnl >= p.consistencyCap ? "down" : undefined });
  if (p.profitArmed) details.push({ label: "profit arm", value: "armed", tone: "warn" });
  if (p.dd.halved) details.push({ label: "dd size", value: "halved", tone: "warn" });
  details.push({ label: "stage", value: p.stage });
  if (st.halts.length > 0) details.push({ label: "halts", value: st.halts.join(" · "), tone: "down" });

  const haltsNote = st.halts.length > 0 ? ` · ${st.halts.length} halt(s)` : "";
  return { id: "guard", name: "guard", icon: "⛨", level, headline, metric: `day ${usd(p.dayPnl)}${haltsNote}`, details };
}

function routeStage(h: PipelineHealthInput, now: number): PipelineStage {
  const ex = h.execution;
  const details: PipelineStage["details"] = [];
  const trades = h.execution?.pipeline?.execTrades ?? null;
  const lat = h.execution?.pipeline?.latency ?? null;
  if (!ex) return { id: "route", name: "route", icon: "➤", level: "unknown", headline: "execution state unavailable", metric: "—", details };

  if (!ex.crosstradeConfigured)
    return { id: "route", name: "route", icon: "➤", level: "off", headline: "CrossTrade not configured — no routing", metric: "offline", details };
  if (!ex.executeLive)
    return { id: "route", name: "route", icon: "➤", level: "off", headline: "dry-run — cards recorded, orders not routed", metric: "dry-run", details };
  if (ex.tradingHalt)
    return { id: "route", name: "route", icon: "➤", level: "down", headline: "kill switch active — trading halted", metric: "halted", details };

  let level: PipelineLevel = "ok";
  let headline = "routing healthy";
  const latestFill = lat?.fills.at(-1) ?? null;
  if (latestFill) {
    if (latestFill.ackMs === null && now - latestFill.ts < 10 * 60_000) {
      level = "warn";
      headline = `placement unacked ${ageSec(latestFill.ts, now)}s — verification pending`;
    } else if (latestFill.fillMs !== null && latestFill.fillMs > 5000) {
      level = "warn";
      headline = `slow fill — ${secFmt(latestFill.fillMs)} submit→fill`;
    } else if (latestFill.seenMs !== null && latestFill.seenMs > 10_000) {
      level = "warn";
      headline = `watcher noticed the fill late — ${secFmt(latestFill.seenMs)}`;
    }
  }
  if (level === "ok" && trades && trades.failed > 0 && trades.lastFailAt !== null && now - trades.lastFailAt < 4 * 3600_000) {
    level = "warn";
    headline = `${trades.failed} failed order(s) in the recent ledger`;
  }

  const metric = latestFill
    ? `ack ${secFmt(latestFill.ackMs)} · fill ${secFmt(latestFill.fillMs)}`
    : "no fills yet";
  details.push({ label: "instrument", value: ex.instrument || "—" });
  if (trades?.last) {
    const last = trades.last;
    details.push({
      label: "last order",
      value: `${last.label} · ${last.status}${last.result ? ` ${last.result}` : ""}`,
      tone: last.status === "failed" ? "down" : last.result === "loss" ? "warn" : undefined,
    });
    details.push({ label: "today", value: `${trades.wins}W / ${trades.losses}L · net ${usd(trades.netUsd)}`, tone: trades.netUsd >= 0 ? undefined : "warn" });
  }
  if (lat?.latest) {
    const l = lat.latest;
    details.push({ label: "last cycle", value: `${l.totalMs}ms · ${l.source}${l.barAgeMs !== null ? ` · bar ${l.barAgeMs}ms` : ""}` });
    const stageMs = Object.entries(l.stages)
      .filter(([, v]) => Number.isFinite(v))
      .map(([k, v]) => `${k} ${v}ms`)
      .join(" · ");
    if (stageMs) details.push({ label: "cycle stages", value: stageMs });
  }
  return { id: "route", name: "route", icon: "➤", level, headline, metric, details };
}

function watchStage(h: PipelineHealthInput, now: number): PipelineStage {
  const trades = h.execution?.pipeline?.execTrades ?? null;
  const details: PipelineStage["details"] = [];
  if (!trades) return { id: "watch", name: "watch", icon: "◉", level: "unknown", headline: "position state unavailable", metric: "—", details };

  const last = trades.last;
  if (trades.open === 0) {
    details.push({ label: "book", value: "flat" });
    if (last)
      details.push({
        label: "last close",
        value: `${last.label} · ${last.status}${last.result ? ` ${last.result}` : ""} · ${usd(last.netUsd)}`,
      });
    return { id: "watch", name: "watch", icon: "◉", level: "idle", headline: "book flat — nothing to manage", metric: "flat", details };
  }

  let level: PipelineLevel = "ok";
  let headline = `managing ${trades.open} open position(s)`;
  if (last && last.status === "placed" && !last.fillEntryAt && now - last.ts > ENTRY_UNVERIFIED_MS) {
    level = "warn";
    headline = `entry unverified ${ageSec(last.ts, now)}s — watcher checking`;
  }
  if (trades.failed > 0 && trades.lastFailAt !== null && now - trades.lastFailAt < 4 * 3600_000) {
    level = "warn";
    headline = `${trades.failed} failed order(s) — watcher alarms active`;
  }

  if (last)
    details.push({
      label: "position",
      value: `${last.label} · ${last.status}${last.fillEntryAt ? " (filled)" : ""}`,
      tone: level === "warn" ? "warn" : undefined,
    });
  details.push({ label: "today", value: `${trades.wins}W / ${trades.losses}L · net ${usd(trades.netUsd)}` });
  details.push({ label: "stop/bracket", value: "watchdog + OSO verified" });
  return { id: "watch", name: "watch", icon: "◉", level, headline, metric: `open ${trades.open} · ${trades.wins}W ${trades.losses}L`, details };
}

/* ---- assembly ---------------------------------------------------------- */

export function derivePipeline(h: PipelineHealthInput | null, now: number): PipelineStage[] {
  const input = h ?? { execution: null };
  return [tapeStage(input), barsStage(input), detectStage(input), cardStage(input, now), guardStage(input), routeStage(input, now), watchStage(input, now)];
}

/** one glance for the whole pipeline: the worst non-idle/non-off level */
export function pipelineOverall(stages: PipelineStage[]): { level: PipelineLevel; label: string } {
  const weight: Record<PipelineLevel, number> = { unknown: 1, ok: 2, idle: 2, off: 2, warn: 3, down: 4 };
  const worst = stages.reduce<PipelineLevel>((acc, s) => (weight[s.level] > weight[acc] ? s.level : acc), "unknown");
  if (worst === "down") return { level: "down", label: "PIPELINE DOWN" };
  if (worst === "warn") return { level: "warn", label: "DEGRADED" };
  if (stages.some((s) => s.level === "ok")) return { level: "ok", label: "ALL SYSTEMS GO" };
  return { level: "idle", label: "STANDBY" };
}
