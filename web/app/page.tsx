"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FlowChart, { fmt, type LevelSet } from "@/components/FlowChart";
import { blendLiveMinutes, type FPMinute, type Marker, type Absorb } from "@/lib/footprint";
import MinuteNavigator from "@/components/MinuteNavigator";
import MechanismPanel from "@/components/MechanismPanel";
import StoryPanel from "@/components/StoryPanel";
import { readMechanism } from "@/lib/mechanism";
import type { ImbalanceRollup } from "@/lib/gcdata";
import { useLive, type LiveMinute } from "@/lib/useLive";
import { cdtToET } from "@/lib/times";
import { imbalanceFor, summarizeImb } from "@/lib/imbalance";

type FootMinute = { t: string; d?: string; o?: number; c?: number; vwap?: number; high: number; low: number; buy: number; sell: number; delta: number };
type Alert = { t: string; kind: string; price: number; vwapSide: string; deltaPct: number | null; message: string; side?: "bid" | "ask" | null };
type AbsorbFull = Absorb & { volume: number; imbalance: number; defendedBars: number };

const KIND_STYLE: Record<string, string> = {
  LVN_ENTER: "bg-warn/15 text-warn border-warn/40",
  LVN_EXIT: "bg-warn/15 text-warn border-warn/40",
  DIVERGENCE_D2: "bg-long/15 text-long border-long/40",
  DIVERGENCE_D4: "bg-short/15 text-short border-short/40",
  ABSORPTION: "bg-info/15 text-info border-info/40",
  INITIATIVE: "bg-zinc-700/40 text-zinc-200 border-zinc-600",
};

/* Profile keys are numbered BY RECENCY: P0 is the newest profile, P5 the
 * oldest. The colour ramp follows the same order (hot = recent). */
const PROFILE_COLORS: Record<string, string> = {
  P0_developing_rth: "#f87171",
  P1_opening_range: "#fb923c",
  P2_full_session: "#fbbf24",
  P3_overnight: "#38bdf8",
  P4_prev_day_rth: "#a78bfa",
  P5_5day_composite: "#64748b",
};
/** display order = recency order */
const PROFILE_RECENCY = [
  "P0_developing_rth",
  "P1_opening_range",
  "P2_full_session",
  "P3_overnight",
  "P4_prev_day_rth",
  "P5_5day_composite",
];
const PROFILE_DEFS: Record<string, string> = {
  P0_developing_rth:
    "P0 · TODAY, developing — today's RTH profile from the 9:30 ET open, updated live. Where value is migrating right now (most recent)",
  P1_opening_range:
    "P1 · TODAY, opening range — the fixed 9:30–10:00 ET balance. The levels you trade from 10:00 on",
  P2_full_session:
    "P2 · TODAY, full session — today incl. overnight (18:00 ET → now). Whole-day inventory: is the overnight business being defended?",
  P3_overnight:
    "P3 · LAST NIGHT, overnight/premarket — 18:00 ET → 9:30 ET. Where the premarket business was done (ONH/ONL, ON POC)",
  P4_prev_day_rth: "P4 · YESTERDAY, RTH — prior-day POC/VAH/VAL and the naked POCs price still has to visit",
  P5_5day_composite:
    "P5 · TRAILING 5 RTH SESSIONS — the multi-day composite: the durable value areas and the LVNs worth trusting (oldest)",
};
const PROFILE_LABELS: Record<string, string> = {
  P0_developing_rth: "P0 Today",
  P1_opening_range: "P1 OpenRange",
  P2_full_session: "P2 FullDay",
  P3_overnight: "P3 Overnight",
  P4_prev_day_rth: "P4 PriorDay",
  P5_5day_composite: "P5 5Day",
};

export default function DashboardPage() {
  const live = useLive();
  const [levels, setLevels] = useState<LevelSet[]>([]);
  const [hist, setHist] = useState<LiveMinute[]>([]);
  const [fp, setFp] = useState<{ minutes: FPMinute[]; minPrice: number; maxPrice: number } | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [absorption, setAbsorption] = useState<AbsorbFull[]>([]);
  const [profileRows, setProfileRows] = useState<{ price: number; buy: number; sell: number }[]>([]);
  const [poc, setPoc] = useState(0);
  const [vah, setVah] = useState(0);
  const [val, setVal] = useState(0);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [vwap, setVwap] = useState(0);
  const [reclaims, setReclaims] = useState<{ t: string; price: number; dir: "low" | "high" }[]>([]);
  const [imb, setImb] = useState<ImbalanceRollup | null>(null);
  const [chartMax, setChartMax] = useState(false);
  const [tgPush, setTgPush] = useState(true);
  /** alerts already pushed to Telegram — survives re-renders, and is SEEDED with
   *  everything present at load so a browser reload cannot re-notify history */
  const pushedRef = useRef<Set<string>>(new Set());
  /** set once the bootstrap analysis has seeded pushedRef */
  const bootstrappedRef = useRef(false);
  const [tgStatus, setTgStatus] = useState("");
  const [showInit, setShowInit] = useState(true);
  const [showPoc, setShowPoc] = useState(true);
  const [showVa, setShowVa] = useState(false);

  const snap = live?.snapshot ?? null;
  const prevDay = (d: string) => {
    const t = Date.parse(d + "T00:00:00Z") - 86400000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const today = snap?.date ?? new Date().toISOString().slice(0, 10);

  const pushAlert = useCallback(
    async (a: Alert) => {
      if (!tgPush) return;
      const text = `GC ${a.t} ${a.kind.replace("DIVERGENCE_", "D")} @ ${fmt(a.price)} ${a.vwapSide} vwap · ${a.message}`;
      try {
        const r = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        const j = await r.json();
        if (!j.sent && j.reason && !j.reason.startsWith("Telegram not")) setTgStatus(j.reason);
      } catch {
        /* ignore */
      }
    },
    [tgPush],
  );

  // bootstrap: use the LATEST COLLECTED date (snapshot date only as fallback)
  const [dataDate, setDataDate] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let d = today;
      try {
        const j = await fetch("/api/gc?action=datasets").then((r) => r.json());
        const ds: { date: string }[] = j.datasets ?? [];
        if (ds[0]?.date) d = ds[0].date;
      } catch {
        /* keep today */
      }
      if (cancelled) return;
      setDataDate(d);

      fetch(`/api/gc?action=sheet&date=${d}`)
        .then((r) => r.json())
        .then((j) => {
          const prof: Record<string, any> = j.sheet?.profiles ?? {};
          const sets: LevelSet[] = [];
          for (const [key, vRaw] of Object.entries(prof)) {
            const v: any = vRaw;
            if (!v) continue;
            const lvns: [number, number][] = (v.LVNs ?? []).map((z: string) => {
              const [a, b] = z.split("–").map((s) => parseFloat(s.replace(/,/g, "")));
              return [a, b ?? a] as [number, number];
            });
            sets.push({
              id: key,
              label: PROFILE_LABELS[key] ?? key,
              color: PROFILE_COLORS[key] ?? "#64748b",
              poc: parseFloat(v.POC.replace(/,/g, "")),
              vah: parseFloat(v.VAH.replace(/,/g, "")),
              val: parseFloat(v.VAL.replace(/,/g, "")),
              lvns,
              on: true,
              recency: PROFILE_RECENCY.indexOf(key) === -1 ? 99 : PROFILE_RECENCY.indexOf(key),
            });
          }
          sets.sort((a, b) => a.recency - b.recency);
          setLevels(sets);
        })
        .catch(() => {});

      fetch(`/api/gc?action=footprint&date=${d}&session=ETH&start=&end=`)
        .then((r) => r.json())
        .then((j) => {
          if (!j.minutes) return;
          setHist(
            j.minutes.map((m: FootMinute) => ({
              t: m.t,
              d: m.d,
              o: m.o ?? 0,
              h: m.high,
              l: m.low,
              c: m.c ?? 0,
              vol: m.buy + m.sell,
              buy: m.buy,
              sell: m.sell,
              live: false,
            })),
          );
          setFp({ minutes: j.minutes, minPrice: j.minPrice, maxPrice: j.maxPrice });
        })
        .catch(() => {});

      fetch(`/api/gc?action=analysis&date=${d}&session=ETH&start=&end=&row=2`)
        .then((r) => r.json())
        .then((j) => {
          if (j.rows) {
            setProfileRows(j.rows);
            setPoc(j.stats.poc);
            setVah(j.stats.vah);
            setVal(j.stats.val);
            setVwap(j.vwap ?? 0);
            setAbsorption(j.absorption ?? []);
            setReclaims(j.reclaims ?? []);
            setImb(j.imbalance ?? null);
            setMarkers(
              (j.alerts ?? [])
                .filter((x: any) => x.kind !== "INITIATIVE")
                .map((x: any) => ({
                  t: x.t,
                  // overnight events (>= 17:00 feed) belong to the previous day
                  d: x.t >= "17:00" ? prevDay(d) : d,
                  kind: x.kind,
                  bias: x.bias ?? (x.kind === "DIVERGENCE_D2" ? "bull" : x.kind === "DIVERGENCE_D4" ? "bear" : null),
                })),
            );
            setAlerts(j.alerts ?? []);
            // seed the push-dedupe set: these already existed when the page loaded
            (j.alerts ?? []).forEach((a: Alert) => pushedRef.current.add(`${a.t}|${a.kind}|${a.price}`));
            bootstrappedRef.current = true;
          }
        })
        .catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [today]);

  // alert polling — only after the dataset bootstrap resolves, otherwise the
  // first tick fires against "today" (e.g. a Sunday with no data) and 404s
  const pollDate = dataDate || today;
  useEffect(() => {
    if (!dataDate || !bootstrappedRef.current) return; // bootstrap not resolved yet
    const tick = () => {
      fetch(`/api/gc?action=analysis&date=${pollDate}&session=ETH&start=&end=&row=4`)
        .then((r) => r.json())
        .then((j) => {
          if (!j.alerts) return;
          const key = (a: Alert) => `${a.t}|${a.kind}|${a.price}`;
          const unseen = (j.alerts as Alert[]).filter((a) => !pushedRef.current.has(key(a)));
          unseen.forEach((a) => pushedRef.current.add(key(a)));
          unseen.slice(-5).forEach((a) => pushAlert(a));
          setAlerts((prev) => {
            const seen = new Set(prev.map(key));
            const fresh = (j.alerts as Alert[]).filter((a) => !seen.has(key(a)));
            return [...fresh, ...prev].slice(0, 60);
          });
        })
        .catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 60000);
    return () => clearInterval(iv);
  }, [pollDate, pushAlert]);

  // ---- seamless live blend: the collected full day, continued by live ticks ----
  const blended = useMemo<LiveMinute[]>(() => {
    const liveMins = live ? (live.cur ? [...live.minutes, live.cur] : live.minutes) : [];
    return blendLiveMinutes(hist, liveMins as LiveMinute[]);
  }, [hist, live]);
  const liveTail = blended.slice(hist.length);

  // the appended live minutes as footprint rows (tick clusters + imbalance engine)
  const liveFpTail = useMemo<FPMinute[]>(
    () =>
      liveTail
        .filter((m) => m.levels && Object.keys(m.levels).length > 0)
        .map((m) => {
          const levels = imbalanceFor(
            Object.entries(m.levels!)
              .map(([p, v]) => ({ price: Number(p), buy: (v as [number, number])[0], sell: (v as [number, number])[1], bTrades: 0, sTrades: 0 }))
              .sort((a, b) => b.price - a.price),
          );
          let num = 0;
          let den = 0;
          for (const l of levels) {
            const v = l.buy + l.sell;
            num += l.price * v;
            den += v;
          }
          return {
            t: m.t,
            o: m.o,
            c: m.c,
            vwap: den > 0 ? num / den : (m.h + m.l) / 2,
            high: m.h,
            low: m.l,
            buy: m.buy,
            sell: m.sell,
            delta: m.buy - m.sell,
            levels,
            imb: summarizeImb(levels),
          };
        }),
    [liveTail],
  );
  const ladderMinutes: FPMinute[] = fp ? [...fp.minutes, ...liveFpTail] : liveFpTail;
  const ladderDate = dataDate || today;

// Developing session VWAP curve.
  // Must use the SAME definition as the session VWAP number shown in the chart
  // footer (typical price (h+l+c)/3 when the bar has real OHLC, else the mid) —
  // a mid-only curve sat ~0.2 pt away from the number it represents.
  // It is seeded with the collected session and then continued into live
  // minutes (keyed back into the feed clock) so the line tracks the candles.
  const vwapSeries = useMemo(() => {
    let num = 0;
    let den = 0;
    const out: { t: string; d?: string; value: number }[] = [];
    const push = (t: string, d: string, h: number, l: number, c: number, v: number) => {
      if (v <= 0) return;
      const px = c > 0 ? (h + l + c) / 3 : (h + l) / 2;
      num += px * v;
      den += v;
      out.push({ t, d, value: num / den });
    };
    // each point carries its OWN calendar day: the overnight session spans two
    // dates, and mapping everything onto the dataset date would break the
    // ascending-time invariant the chart asserts on
    for (const m of hist) push(m.t, m.d ?? today, m.h, m.l, m.c, m.buy + m.sell);
    for (const m of blended.slice(hist.length)) push(m.t, m.d ?? today, m.h, m.l, m.c, m.buy + m.sell);
    return out;
  }, [hist, live, blended]);

  const chg = snap ? snap.ltp - snap.prev_close : 0;
  // one blended series: the collected full day continued by live ticks, all
  // keyed in the feed clock so events and the chart share one time base
  const chartMinutes: LiveMinute[] = blended;
  const matchMinutes = chartMinutes;

  // ---- reversal conditions ----
  const lastMin = chartMinutes[chartMinutes.length - 1];
  const lastPrice = lastMin ? lastMin.c || lastMin.h : snap?.ltp ?? 0;
  const cands = levels.flatMap((l) => [
    { label: l.label, kind: "POC", p: l.poc },
    { label: l.label, kind: "VAH", p: l.vah },
    { label: l.label, kind: "VAL", p: l.val },
  ]);
  const nearest = [...cands].sort((a, b) => Math.abs(a.p - lastPrice) - Math.abs(b.p - lastPrice)).slice(0, 3);
  const byDist = (a: { p: number }, b: { p: number }) => Math.abs(a.p - lastPrice) - Math.abs(b.p - lastPrice);
  const lvnEdges = levels.flatMap((l) =>
    l.lvns.flatMap(([a, b]) => [
      { label: l.label, p: a, zone: `${fmt(a)}–${fmt(b)}` },
      { label: l.label, p: b, zone: `${fmt(a)}–${fmt(b)}` },
    ]),
  );
  const nearestEdge = [...lvnEdges].sort(byDist)[0];
  const edgeDist = nearestEdge ? Math.abs(nearestEdge.p - lastPrice) : Infinity;
  const atLvnEdge = edgeDist <= 2.5;
  const lvnZone = levels.flatMap((l) => l.lvns.map(([a, b]) => ({ label: l.label, a, b }))).find((z) => lastPrice >= z.a && lastPrice <= z.b);
  const nearestPoc = [...levels.map((l) => ({ label: `${l.label} POC`, p: l.poc }))].sort(byDist)[0];
  const nearestVa = [...levels.flatMap((l) => [{ label: `${l.label} VAH`, p: l.vah }, { label: `${l.label} VAL`, p: l.val }])].sort(byDist)[0];
  const inZone = lastPrice > 0 && nearest.some((n) => Math.abs(n.p - lastPrice) <= 2.5);
  const divAlert = alerts.find((a) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
  const lastAbs = absorption[absorption.length - 1];
  const lastReclaim = reclaims[reclaims.length - 1];
  const vwapSide = vwap > 0 && lastPrice >= vwap ? "above" : "below";
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etMin = etNow.getHours() * 60 + etNow.getMinutes();
  const newsWin = [510, 600, 840].some((r) => Math.abs(etMin - r) <= 5);

  
  // ---- reversal mechanism read (sequence: location -> mechanism -> fuel -> trigger) ----
  const lastLiveImb = liveFpTail[liveFpTail.length - 1]?.imb ?? null;
  const mech = useMemo(() => {
    // prefer the LIVE footprint stack over the collected-session rollup when ticks flow
    const rollup: ImbalanceRollup | null = imb
      ? {
          ...imb,
          lastStack: lastLiveImb?.stacked ? { t: liveFpTail[liveFpTail.length - 1].t, ...lastLiveImb.stacked } : imb.lastStack,
          lastMinute: lastLiveImb ?? imb.lastMinute,
        }
      : lastLiveImb
        ? {
            buyRows: lastLiveImb.buy,
            sellRows: lastLiveImb.sell,
            dBuyRows: lastLiveImb.dBuy,
            dSellRows: lastLiveImb.dSell,
            stackedMinutes: lastLiveImb.stacked ? 1 : 0,
            stacks: lastLiveImb.stacked ? [{ t: liveFpTail[liveFpTail.length - 1].t, ...lastLiveImb.stacked }] : [],
            lastStack: lastLiveImb.stacked ? { t: liveFpTail[liveFpTail.length - 1].t, ...lastLiveImb.stacked } : null,
            lastMinute: lastLiveImb,
          }
        : null;
    return readMechanism({
      minutes: matchMinutes.map((m) => ({
        t: m.t,
        high: m.h,
        low: m.l,
        delta: m.buy - m.sell,
      })),
      lastPrice,
      vwap,
      absorption,
      alerts,
      reclaims,
      imbalance: rollup,
      lvnEdges,
      poc: nearestPoc ? { label: nearestPoc.label, p: nearestPoc.p } : null,
      sessionHigh: snap?.high ?? Math.max(0, ...chartMinutes.map((m) => m.h)),
      sessionLow: snap?.low ?? Math.min(...chartMinutes.map((m) => m.l).concat([Infinity])),
      newsWin,
    });
  }, [matchMinutes, lastPrice, vwap, absorption, alerts, reclaims, imb, lastLiveImb, liveFpTail, lvnEdges, nearestPoc, snap?.high, snap?.low, newsWin]);
  const mechLive = !!(live && live.minutes.length > 0 && live.connected);
  const mechAsOf = chartMinutes.length ? cdtToET(chartMinutes[chartMinutes.length - 1].t) : "—";
  const mechStale = !mechLive;

  const alertCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of alerts) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }, [alerts]);

  const condRow = (icon: string, tone: string, name: string, value: string, hint: string) => (
    <div className="rounded border border-zinc-800/70 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 font-mono text-sm ${tone}`}>{icon}</span>
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-300">{name}</span>
            <span className="break-words text-right font-mono text-[11px] leading-snug text-zinc-200">{value}</span>
          </div>
          <p className="mt-0.5 font-mono text-[10px] leading-snug text-zinc-500">{hint}</p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="w-full px-4 pb-10 pt-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.25em] text-long">dashboard · NQ everything</p>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">Everything, one view</h1>
        </div>
        <span className={`flex items-center gap-2 font-mono text-xs ${live?.connected ? "text-long" : "text-short"}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${live?.connected ? "bg-long shadow-[0_0_8px_rgba(52,211,153,0.9)]" : "bg-short"}`} />
          {live?.connected ? "connected" : "reconnecting…"}
        </span>
      </div>

      {/* live strip */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">NQZ26 {snap?.date ?? ""}</p>
          <p className="font-mono text-lg font-bold text-zinc-50">{fmt(snap?.ltp)}</p>
          <p className={`font-mono text-[11px] ${chg >= 0 ? "text-long" : "text-short"}`}>{chg >= 0 ? "+" : ""}{fmt(chg)}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">cum delta</p>
          <p className={`font-mono text-lg font-semibold ${(snap?.delta ?? 0) >= 0 ? "text-long" : "text-short"}`}>
            {(snap?.delta ?? 0) >= 0 ? "+" : ""}{(snap?.delta ?? 0).toLocaleString()}
          </p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">volume</p>
          <p className="font-mono text-lg font-semibold text-zinc-200">{(snap?.volume ?? 0).toLocaleString()}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">range</p>
          <p className="font-mono text-[11px] text-zinc-300">{fmt(snap?.high)} / {fmt(snap?.low)}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">alerts</p>
          <p className="font-mono text-lg font-semibold text-warn">{alerts.length}</p>
        </div>
        <div className="rounded-md border border-zinc-800 bg-panel px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">absorption</p>
          <p className="font-mono text-lg font-semibold text-info">{absorption.length}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* left column */}
        <div className="min-w-0 space-y-4">
          <section className={`flex flex-col rounded-md border border-zinc-800 bg-panel p-3 ${chartMax ? "fixed inset-0 z-40 rounded-none bg-zinc-950" : ""}`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-zinc-50">Flow & levels</h2>
                <button
                  onClick={() => setChartMax((v) => !v)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${chartMax ? "border-info/50 bg-info/10 text-info" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                  title={chartMax ? "back to the dashboard grid" : "maximize the chart to the full window (esc-safe: click again)"}
                >
                  {chartMax ? "restore ▣" : "maximize ⛶"}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {levels.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setLevels((prev) => prev.map((x) => (x.id === l.id ? { ...x, on: !x.on } : x)))}
                    title={PROFILE_DEFS[l.id] ?? l.id}
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                      l.on ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-panel text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
                    {l.label}
                  </button>
                ))}
                {levels.length > 0 && <span className="font-mono text-[10px] text-zinc-600">P0 = most recent → P5 = oldest</span>}
                <span className="mx-1 h-3 w-px bg-zinc-700" />
                <button
                  onClick={() => setShowPoc((v) => !v)}
                  title="POC = the most-traded price: a magnet/target, not an entry trigger"
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] ${showPoc ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-panel text-zinc-500"}`}
                >
                  POC (target)
                </button>
                <button
                  onClick={() => setShowVa((v) => !v)}
                  title="VAH/VAL = value-area edges: acceptance vs rejection reference (not entry zones)"
                  className={`rounded border px-2 py-0.5 font-mono text-[10px] ${showVa ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 bg-panel text-zinc-500"}`}
                >
                  VAH/VAL
                </button>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer font-mono text-[10px] text-zinc-500 hover:text-zinc-300">what do P0–P5 mean? (P0 = most recent → P5 = oldest)</summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-zinc-400">
                  {Object.entries(PROFILE_DEFS).map(([k, d]) => (
                    <li key={k}>{d}</li>
                  ))}
                </ul>
              </details>
            </div>
            <div className={`min-h-[380px] ${chartMax ? "min-h-0 flex-1" : "h-[520px] xl:h-[calc(100vh-330px)] 2xl:h-[calc(100vh-300px)]"}`}>
              {chartMinutes.length > 0 ? (
                <FlowChart
                  minutes={chartMinutes}
                  levels={levels}
                  markers={markers}
                  dataDate={dataDate || today}
                  vwap={vwap}
                  vwapSeries={vwapSeries}
                  showPoc={showPoc}
                  showVa={showVa}
                  height={520}
                  autoHeight
                />
              ) : (
                <p className="p-8 font-mono text-sm text-zinc-600">waiting for data…</p>
              )}
            </div>
          </section>

          <StoryPanel
            minutes={ladderMinutes}
            absorption={absorption}
            timeMode="cdt"
            date={ladderDate}
          />

          <section className="rounded-md border border-zinc-800 bg-panel p-3">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-zinc-50">Footprint — minute ladder</h2>
                <span className="font-mono text-[10px] text-zinc-600">full day 18:00 → 16:59 New York · live minutes continue seamlessly</span>
              </div>
              <p className="font-mono text-[10px] text-zinc-500">
                bid×ask per tick · ▲▼ = imbalance (≥3:1, ≥10 ct) · ◆ = diagonal vs adjacent tick · □ = unfinished auction · stacked = 3+ imbalanced rows in a row
              </p>
            </div>
            {ladderMinutes.length > 0 ? (
              <MinuteNavigator minutes={ladderMinutes} date={ladderDate} absorption={absorption} timeMode="cdt" />
            ) : (
              <p className="p-8 font-mono text-sm text-zinc-600">no footprint data — collect with gcdata</p>
            )}
          </section>
        </div>

        {/* right column */}
        <aside className="space-y-4">
          <MechanismPanel read={mech} asOfET={mechAsOf} stale={mechStale} source={mechLive ? "live" : "collected"} />

          <details className="rounded-md border border-zinc-800 bg-panel p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between font-mono text-sm font-bold uppercase tracking-wider text-zinc-400 [&::-webkit-details-marker]:hidden">
              <span>Levels</span>
              <span className="font-mono text-[10px] normal-case tracking-normal text-zinc-600">
                {levels.length} profiles · same lines as on the chart ▸
              </span>
            </summary>
            <div className="mt-2 space-y-2">
              {levels.map((l) => (
                <div key={l.id} className="rounded border border-zinc-800/70 px-2 py-1.5">
                  <div className="flex items-center justify-between font-mono text-xs">
                    <span className="text-zinc-200">
                      <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: l.color }} />
                      {l.label}
                    </span>
                    <span className="text-zinc-500">{l.lvns.length} LVN</span>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[10px]">
                    <span className="text-warn">P {fmt(l.poc)}</span>
                    <span className="text-info">H {fmt(l.vah)}</span>
                    <span className="text-info">L {fmt(l.val)}</span>
                  </div>
                </div>
              ))}
              {levels.length === 0 && <p className="font-mono text-xs text-zinc-600">no sheet data</p>}
            </div>
          </details>

          <section className="rounded-md border border-zinc-800 bg-panel p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Alerts</h2>
              <div className="flex items-center gap-2 font-mono text-[10px]">
                <button
                  onClick={() => setTgPush((v) => !v)}
                  className={`rounded border px-1.5 py-0.5 ${tgPush ? "border-info/50 bg-info/10 text-info" : "border-zinc-700 text-zinc-500"}`}
                >
                  TG {tgPush ? "on" : "off"}
                </button>
                <button
                  onClick={async () => {
                    const r = await fetch("/api/notify?test=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                    const j = await r.json();
                    setTgStatus(j.sent ? "test sent ✓" : j.reason.slice(0, 60));
                  }}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200"
                >
                  test
                </button>
              </div>
            </div>
            {tgStatus && <p className="mb-2 font-mono text-[10px] text-zinc-500">{tgStatus}</p>}

            {/* summary first: one chip per kind, the feed is one click away */}
            <div className="mb-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
              {alerts.length === 0 && <p className="font-mono text-xs text-zinc-600">no alerts yet</p>}
              {Object.entries(alertCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => (
                  <span key={kind} className={`rounded border px-1.5 py-0.5 ${KIND_STYLE[kind] ?? "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
                    {kind.replace("DIVERGENCE_", "")} {n}
                  </span>
                ))}
            </div>

            <details className="rounded border border-zinc-800/70 px-2 py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-mono text-[10px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
                <span>feed — most recent first</span>
                <span className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      setShowInit((v) => !v);
                    }}
                    className={`rounded border px-1.5 py-0.5 ${showInit ? "border-zinc-600 text-zinc-300" : "border-zinc-800 text-zinc-600"}`}
                  >
                    initiative {showInit ? "shown" : "hidden"}
                  </button>
                  <span className="text-zinc-600">▸</span>
                </span>
              </summary>
              <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">
                initiative bars = aggression <em>with</em> progress — continuation context, not a reversal signal
              </p>
              <div className="mt-1 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
                {alerts
                  .filter((a) => showInit || a.kind !== "INITIATIVE")
                  .slice(0, 40)
                  .map((a) =>
                    a.kind === "INITIATIVE" ? (
                      <div key={`${a.t}|${a.kind}|${a.price}`} className="flex items-center justify-between gap-2 px-1 font-mono text-[9px] text-zinc-600">
                        <span>{cdtToET(a.t)} · {fmt(a.price)}</span>
                        <span className={a.deltaPct !== null && a.deltaPct >= 0 ? "text-long/70" : "text-short/70"}>
                          Δ {(a.deltaPct ?? 0) >= 0 ? "+" : ""}{a.deltaPct !== null ? `${(a.deltaPct * 100).toFixed(0)}%` : ""} {a.side === "bid" ? "sell init." : "buy init."}
                        </span>
                      </div>
                    ) : (
                      <div key={`${a.t}|${a.kind}|${a.price}`} className="rounded border border-zinc-800/70 px-2 py-1">
                        <div className="flex items-center justify-between font-mono text-[10px]">
                          <span className="text-zinc-400">{cdtToET(a.t)}</span>
                          <span className={`rounded border px-1 py-0.5 text-[9px] ${KIND_STYLE[a.kind] ?? "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
                            {a.kind.replace("DIVERGENCE_", "")}
                          </span>
                        </div>
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="text-zinc-200">{fmt(a.price)}</span>
                          <span className={a.vwapSide === "above" ? "text-long" : "text-short"}>{a.vwapSide}</span>
                        </div>
                        <p className="break-words font-mono text-[10px] leading-snug text-zinc-500">{a.message}</p>
                      </div>
                    ),
                  )}
              </div>
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}
