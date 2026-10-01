/* ------------------------------------------------------------------ *
 * rthOrb.ts — RTH (9:30-16:00 ET) opening-range / developing-value
 * scalping study. Four pattern families, first-touch scored over a
 * 60-bar horizon with 0.5 pt round-trip cost:
 *
 *   A  OPENING-RANGE BREAKOUT CONTINUATION
 *      OR = 9:30-9:59 high/low. 10:00-15:00 a bar CLOSING beyond the
 *      range high (long) with buy-frac >= th and volume >= 1x 60-bar
 *      median -> enter at close, stop under the bar low - 0.5, 1R
 *      target, risk <= 15 pts. Mirror for the low. Variants:
 *      buy-frac 0.55/0.60/0.65, and an "orbNEW" gate requiring the
 *      breakout to make a NEW session extreme (vs merely above the OR).
 *
 *   B  DEVELOPING POC RETEST + ABSORPTION
 *      Rolling RTH footprint profile in 1-pt buckets (every completed
 *      RTH bar's level volume), POC = heaviest bucket, level = center.
 *      A one-sided bar (>=65% one side, >=1x median volume) that pushes
 *      INTO the POC level:
 *        (i)  fade   — closed back on the origin side, within 1 pt of
 *             the POC: absorption at value. Enter OPPOSITE at close,
 *             stop 1 pt beyond the POC, 1R target.
 *        (ii) join   — CLOSED THROUGH the POC by > 1 pt with the
 *             one-sidedness intact: breakout of value. Enter WITH the
 *             push at close, structural stop (bar extreme ∓ 0.5), 1R.
 *
 *   C  MIDDAY RANGE BREAK
 *      Range = 11:00-12:59. Breakouts 13:00-15:00, same mechanics as A
 *      (buy-frac variants + new-session-extreme variant).
 *
 *   D  FOOTPRINT × CANDLE-IMPACT CELLS
 *      Each RTH bar is bucketed by (dominant-cluster side AND count:
 *      footprint rows with >=3 lots and >=2:1 buy/sell imbalance;
 *      dominant side = the side with more such rows) × (|delta| share)
 *      × (range ÷ ATR14, 14-bar median range). Pass 1 measures
 *      next-bar directional accuracy per cell; cells with >=75%
 *      accuracy and n>=300 become 1R strategy variants: enter at the
 *      bar close in the dominant-cluster direction, structural stop,
 *      1R target, same first-touch scoring.
 *
 * Scoring (pessimistic, first-touch) over bars k+1..k+60: stop first ->
 * loss (-risk-0.5); target first -> win (+risk-0.5); neither -> excluded
 * from WR, 0 expectancy. Entries are only taken when a full 60-bar
 * horizon fits inside RTH (so no entries in the final 16:00 ET hour),
 * and a family never holds more than one open trade at a time.
 *
 * MFF grounding: best config runs through dollarize/simulateAccount for
 * the Rapid EOD 50k plan (eval + funded). Best trades dumped to
 * /tmp/rth_orb_trades.json.
 *
 * Run:
 *   cd web && GC_REMOTE_URL=https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev \
 *     node --import ../scripts/ts-loader.mjs scripts/rthOrb.ts
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { closeOf, type MomMinute } from "../lib/momentum";

const COST = 0.5; // pts round trip
const HORIZON = 60; // first-touch scoring bars
const MAX_RISK = 15; // pts
const MIN_RESOLVED = 300; // resolved-trade floor for "best config" eligibility
const WR_TARGET = 75; // %
const CELL_N_MIN = 300; // bar-count floor for a D-cell to become a variant
const CELL_ACC_MIN = 0.75; // next-bar accuracy floor for a D-cell
const PRELOAD_CONCURRENCY = 12;
const PROFILE_WARMUP = 60; // completed RTH bars before B fires
const B_ONESIDE = 0.65;

const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24;
const mmOf = (t: string): number => Number(t.slice(3, 5));
const inRTH = (t: string): boolean => {
	const h = hourET(t);
	const mm = mmOf(t);
	return (h === 9 && mm >= 30) || (h >= 10 && h <= 16);
};

type Outcome = "win" | "loss" | "scratch";
type Trade = {
	date: string;
	et: string; // entry bar end, ET clock
	dir: 1 | -1;
	entry: number;
	stop: number;
	target: number;
	risk: number;
	frac: number; // trade-side fraction of bar volume
	volMult: number; // bar volume / 60-bar median
	outcome: Outcome;
	pnlPts: number;
	extra?: string;
};
type FamilyStats = {
	n: number; // signals fired
	res: number; // resolved (win+loss)
	wins: number;
	grossWin: number;
	grossLoss: number;
	net: number;
	trades: Trade[];
	byYear: Map<number, { res: number; wins: number }>;
};
type CellAcc = { n: number; hits: number };

function med(a: number[]): number {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)];
}

function newStats(): FamilyStats {
	return { n: 0, res: 0, wins: 0, grossWin: 0, grossLoss: 0, net: 0, trades: [], byYear: new Map() };
}

/* ------------------------------------------------------------------ */

async function preload(dates: string[]): Promise<void> {
	let i = 0;
	const workers = Array.from({ length: Math.min(PRELOAD_CONCURRENCY, dates.length) }, async () => {
		while (i < dates.length) {
			const d = dates[i++];
			try {
				await loadSessionMinutes(d);
			} catch {
				/* next run retries */
			}
		}
	});
	await Promise.all(workers);
}

type SessionCtx = {
	minutes: MomMinute[];
	lastRth: number;
	prefixHigh: number[];
	prefixLow: number[];
	orHigh: number;
	orLow: number;
	mrHigh: number;
	mrLow: number;
};

function buildCtx(minutes: MomMinute[]): SessionCtx | null {
	const n = minutes.length;
	let lastRth = -1;
	let orHigh = -Infinity;
	let orLow = Infinity;
	let mrHigh = -Infinity;
	let mrLow = Infinity;
	for (let i = 0; i < n; i++) {
		const t = minutes[i].t;
		if (!inRTH(t)) continue;
		lastRth = i;
		const h = hourET(t);
		const mm = mmOf(t);
		if (h === 9 && mm >= 30 && mm <= 59) {
			orHigh = Math.max(orHigh, minutes[i].high);
			orLow = Math.min(orLow, minutes[i].low);
		}
		if (h === 11 || h === 12) {
			mrHigh = Math.max(mrHigh, minutes[i].high);
			mrLow = Math.min(mrLow, minutes[i].low);
		}
	}
	if (lastRth < 0) return null;
	// session (full-day) running extremes, exclusive of the current bar
	const prefixHigh: number[] = new Array(n).fill(-Infinity);
	const prefixLow: number[] = new Array(n).fill(Infinity);
	for (let i = 1; i < n; i++) {
		prefixHigh[i] = Math.max(prefixHigh[i - 1], minutes[i - 1].high);
		prefixLow[i] = Math.min(prefixLow[i - 1], minutes[i - 1].low);
	}
	return { minutes, lastRth, prefixHigh, prefixLow, orHigh, orLow, mrHigh, mrLow };
}

/** D-cell classification of bar k: dominant-cluster side × |delta| share
 *  × (range ÷ ATR14). null when no cluster side dominates. */
function classifyBar(minutes: MomMinute[], k: number): { side: 1 | -1; cellKey: string; frac: number } | null {
	const m = minutes[k];
	const vol = m.buy + m.sell;
	if (vol <= 0) return null;
	const arr: number[] = [];
	for (let j = k - 14; j < k; j++) arr.push(minutes[j].high - minutes[j].low);
	const atr = med(arr);
	let nB = 0;
	let nS = 0;
	for (const l of m.levels) {
		const lots = l.buy + l.sell;
		if (lots < 3) continue;
		if (l.buy >= 2 * l.sell) nB++;
		else if (l.sell >= 2 * l.buy) nS++;
	}
	if (nB === nS) return null;
	const side: 1 | -1 = nB > nS ? 1 : -1;
	const cnt = Math.max(nB, nS);
	const cKey = cnt === 1 ? "c1" : cnt === 2 ? "c2" : "c3+";
	const dAbs = Math.abs((m.buy - m.sell) / vol);
	const dKey = dAbs < 0.2 ? "d0-0.2" : dAbs < 0.4 ? "d0.2-0.4" : dAbs < 0.6 ? "d0.4-0.6" : dAbs < 0.8 ? "d0.6-0.8" : "d0.8-1";
	const rNorm = atr > 0 ? (m.high - m.low) / atr : 0;
	const rKey = rNorm < 0.5 ? "r<0.5" : rNorm < 1 ? "r0.5-1" : rNorm < 1.5 ? "r1-1.5" : rNorm < 2 ? "r1.5-2" : "r>2";
	return { side, cellKey: `${side === 1 ? "L" : "S"}|${dKey}|${rKey}|${cKey}`, frac: side === 1 ? m.buy / vol : m.sell / vol };
}

/** Pass 1: next-bar directional accuracy per cell. Only bars whose 60-bar
 *  horizon fits inside RTH are counted, so the eligible cell population
 *  equals the variant's candidate population. */
function accumulateCells(ctx: SessionCtx, cells: Map<string, CellAcc>): void {
	const { minutes, lastRth } = ctx;
	for (let k = 0; k < minutes.length; k++) {
		if (!inRTH(minutes[k].t)) continue;
		if (k + HORIZON > lastRth) continue;
		const c = classifyBar(minutes, k);
		if (!c) continue;
		const up = closeOf(minutes[k + 1]) > closeOf(minutes[k]);
		const hit = c.side === 1 ? up : !up;
		const a = cells.get(c.cellKey) ?? { n: 0, hits: 0 };
		a.n++;
		if (hit) a.hits++;
		cells.set(c.cellKey, a);
	}
}

/** Pass 2: one session's family aggregates (A/B/C always, D only for
 *  eligible cells). */
function analyzeSession(date: string, ctx: SessionCtx, fams: Map<string, FamilyStats>, eligibleCells: Set<string>): void {
	const { minutes, lastRth, prefixHigh, prefixLow, orHigh, orLow, mrHigh, mrLow } = ctx;
	const n = minutes.length;

	// rolling 60-bar median volume over raw minutes
	const medVol = (k: number): number => {
		const arr: number[] = [];
		for (let j = k - 60; j < k; j++) arr.push(minutes[j].buy + minutes[j].sell);
		return med(arr);
	};

	// B: rolling RTH footprint profile in 1-pt buckets (level volume of
	// completed RTH bars only — bar k is fed AFTER its own signals)
	const profile = new Map<number, number>();
	let profCount = 0;
	const pocOf = (): number => {
		let bestKey = 0;
		let bestVol = -1;
		for (const [key, v] of profile) {
			if (v > bestVol) {
				bestVol = v;
				bestKey = key;
			}
		}
		return bestKey + 0.5;
	};

	// one open trade per family: next entry allowed from openUntil
	const openUntil = new Map<string, number>();

	const fire = (key: string, k: number, dir: 1 | -1, entry: number, stop: number, frac: number, volMult: number, extra?: string) => {
		if (k < (openUntil.get(key) ?? 0)) return;
		const risk = Math.abs(entry - stop);
		if (!(risk > 0) || risk > MAX_RISK) return;
		const end = k + HORIZON; // callers guarantee k + HORIZON <= lastRth
		const target = dir === 1 ? entry + risk : entry - risk;
		let outcome: Outcome = "scratch";
		for (let j = k + 1; j <= end; j++) {
			const b = minutes[j];
			if (dir === 1 ? b.low <= stop : b.high >= stop) {
				outcome = "loss";
				break;
			}
			if (dir === 1 ? b.high >= target : b.low <= target) {
				outcome = "win";
				break;
			}
		}
		const pnl = outcome === "win" ? risk - COST : outcome === "loss" ? -risk - COST : 0;
		const fam = fams.get(key) ?? newStats();
		fam.n++;
		if (outcome !== "scratch") {
			fam.res++;
			if (outcome === "win") {
				fam.wins++;
				fam.grossWin += risk - COST;
			} else {
				fam.grossLoss += risk + COST;
			}
		}
		fam.net += pnl;
		const h = hourET(minutes[k].t);
		fam.trades.push({
			date,
			et: `${String(h).padStart(2, "0")}:${minutes[k].t.slice(3, 5)}`,
			dir,
			entry: Math.round(entry * 100) / 100,
			stop: Math.round(stop * 100) / 100,
			target: Math.round(target * 100) / 100,
			risk: Math.round(risk * 100) / 100,
			frac: Math.round(frac * 1000) / 1000,
			volMult: Math.round(volMult * 100) / 100,
			outcome,
			pnlPts: Math.round(pnl * 100) / 100,
			extra,
		});
		const y = Number(date.slice(0, 4));
		if (outcome !== "scratch") {
			const by = fam.byYear.get(y) ?? { res: 0, wins: 0 };
			by.res++;
			if (outcome === "win") by.wins++;
			fam.byYear.set(y, by);
		}
		fams.set(key, fam);
		openUntil.set(key, end + 1);
	};

	// iterate RTH signal bars; profile lags by construction (bars < k only)
	for (let k = 0; k < n; k++) {
		const t = minutes[k].t;
		if (!inRTH(t)) continue;
		if (k + HORIZON > lastRth) continue; // full horizon must fit inside RTH
		const m = minutes[k];
		const vol = m.buy + m.sell;
		if (vol <= 0) continue;
		const buyFrac = m.buy / vol;
		const sellFrac = m.sell / vol;
		const close = closeOf(m);
		const h = hourET(t);
		const mv = medVol(k);

		// ---- A: opening-range breakout continuation -------------------
		if (h >= 10 && orHigh > orLow) {
			for (const th of [0.55, 0.6, 0.65]) {
				if (vol < mv) continue;
				if (buyFrac >= th && close > orHigh) {
					fire(`orb-L-${th}`, k, 1, close, m.low - 0.5, buyFrac, vol / mv);
					if (m.high > prefixHigh[k]) fire(`orbNEW-L-${th}`, k, 1, close, m.low - 0.5, buyFrac, vol / mv, "new-session-high");
				} else if (sellFrac >= th && close < orLow) {
					fire(`orb-S-${th}`, k, -1, close, m.high + 0.5, sellFrac, vol / mv);
					if (m.low < prefixLow[k]) fire(`orbNEW-S-${th}`, k, -1, close, m.high + 0.5, sellFrac, vol / mv, "new-session-low");
				}
			}
		}

		// ---- B: developing POC retest + absorption --------------------
		if (profCount >= PROFILE_WARMUP) {
			const poc = pocOf();
			const oneSide = buyFrac >= B_ONESIDE || sellFrac >= B_ONESIDE;
			if (oneSide && vol >= mv) {
				// buy push into the POC from below
				if (buyFrac >= B_ONESIDE && m.low < poc && m.high >= poc) {
					if (close < poc && close >= poc - 1) {
						// absorbed at value -> fade short
						fire("poc-fade-S", k, -1, close, poc + 1, buyFrac, vol / mv, "absorption");
					} else if (close > poc + 1) {
						// closed through -> join long
						fire("poc-join-L", k, 1, close, m.low - 0.5, buyFrac, vol / mv, "breakout-of-value");
					}
				}
				// sell push into the POC from above
				if (sellFrac >= B_ONESIDE && m.high > poc && m.low <= poc) {
					if (close > poc && close <= poc + 1) {
						fire("poc-fade-L", k, 1, close, poc - 1, sellFrac, vol / mv, "absorption");
					} else if (close < poc - 1) {
						fire("poc-join-S", k, -1, close, m.high + 0.5, sellFrac, vol / mv, "breakout-of-value");
					}
				}
			}
		}

		// ---- C: midday range break ------------------------------------
		if (h >= 13 && mrHigh > mrLow) {
			for (const th of [0.55, 0.6, 0.65]) {
				if (vol < mv) continue;
				if (buyFrac >= th && close > mrHigh) {
					fire(`mr-L-${th}`, k, 1, close, m.low - 0.5, buyFrac, vol / mv);
					if (m.high > prefixHigh[k]) fire(`mrNEW-L-${th}`, k, 1, close, m.low - 0.5, buyFrac, vol / mv, "new-session-high");
				} else if (sellFrac >= th && close < mrLow) {
					fire(`mr-S-${th}`, k, -1, close, m.high + 0.5, sellFrac, vol / mv);
					if (m.low < prefixLow[k]) fire(`mrNEW-S-${th}`, k, -1, close, m.high + 0.5, sellFrac, vol / mv, "new-session-low");
				}
			}
		}

		// ---- D: footprint × candle-impact cells (eligible only) -------
		if (eligibleCells.size) {
			const c = classifyBar(minutes, k);
			if (c && eligibleCells.has(c.cellKey)) {
				fire(`d-${c.cellKey}`, k, c.side, close, c.side === 1 ? m.low - 0.5 : m.high + 0.5, c.frac, vol / mv);
			}
		}

		// feed bar k into the B profile for subsequent bars
		for (const l of m.levels) {
			const key = Math.floor(l.price);
			profile.set(key, (profile.get(key) ?? 0) + l.buy + l.sell);
		}
		profCount++;
	}
}

async function main() {
	const t0 = Date.now();
	const dates = await archiveDates();
	console.log(`RTH ORB study over ${dates.length} sessions (${dates[0]} → ${dates[dates.length - 1]})`);
	await preload(dates);
	console.log(`cache warm in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	// pass 1: interaction cells (next-bar direction)
	const cells = new Map<string, CellAcc>();
	for (const date of dates) {
		const minutes = await loadSessionMinutes(date);
		if (!minutes) continue;
		const ctx = buildCtx(minutes);
		if (!ctx) continue;
		accumulateCells(ctx, cells);
	}
	const eligibleCells = new Set<string>();
	for (const [key, a] of cells) {
		if (a.n >= CELL_N_MIN && a.hits / a.n >= CELL_ACC_MIN) eligibleCells.add(key);
	}
	console.log(`D-cells: ${cells.size} populated, ${eligibleCells.size} eligible (n>=${CELL_N_MIN}, nextBar>=${100 * CELL_ACC_MIN}%)`);

	// pass 2: strategies
	const fams = new Map<string, FamilyStats>();
	let used = 0;
	for (const date of dates) {
		const minutes = await loadSessionMinutes(date);
		if (!minutes) continue;
		const ctx = buildCtx(minutes);
		if (!ctx) continue;
		used++;
		analyzeSession(date, ctx, fams, eligibleCells);
	}
	console.log(`sessions analyzed: ${used}\n`);

	// ---- interaction table -------------------------------------------
	const cellRows = [...cells.entries()]
		.map(([key, a]) => ({ key, n: a.n, acc: a.hits / a.n }))
		.filter((r) => r.n >= 20)
		.sort((x, y) => y.acc - x.acc || y.n - x.n);
	console.log("=== FOOTPRINT × CANDLE-IMPACT CELLS (next-bar direction) ===");
	console.log("cell                        |    n | nextBar% | 1R variant");
	for (const r of cellRows) {
		const elig = r.n >= CELL_N_MIN && r.acc >= CELL_ACC_MIN;
		const f = elig ? fams.get(`d-${r.key}`) : undefined;
		const vStr = elig && f ? `d-${r.key} res=${f.res} WR=${f.res ? ((100 * f.wins) / f.res).toFixed(1) : "—"}%` : elig ? "d-*" : "";
		console.log(`${r.key.padEnd(26)} | ${String(r.n).padStart(4)} | ${(100 * r.acc).toFixed(1).padStart(7)}% | ${vStr}`);
	}

	// ---- variant table ------------------------------------------------
	const rows = [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	console.log("\nvariant            |   n |  res |   WR% |   PF |    net |   exp | avgRisk");
	for (const [key, f] of rows) {
		const wr = f.res ? (100 * f.wins) / f.res : 0;
		const pf = f.grossLoss > 0 ? f.grossWin / f.grossLoss : f.grossWin > 0 ? Infinity : 0;
		const avgRisk = f.trades.length ? f.trades.reduce((a, t) => a + t.risk, 0) / f.trades.length : 0;
		console.log(
			`${key.padEnd(18)} | ${String(f.n).padStart(3)} | ${String(f.res).padStart(4)} | ${wr.toFixed(1).padStart(5)}% | ${pf === Infinity ? "  ∞" : pf.toFixed(2).padStart(4)} | ${f.net.toFixed(0).padStart(6)} | ${(f.net / f.n).toFixed(3).padStart(5)} | ${avgRisk.toFixed(1).padStart(6)}`,
		);
	}

	// ---- best config selection ---------------------------------------
	const eligible = rows.filter(([, f]) => f.res >= MIN_RESOLVED);
	if (!eligible.length) {
		console.log("\nno variant reached res>=300");
		return;
	}
	const over = eligible.filter(([, f]) => (100 * f.wins) / f.res >= WR_TARGET);
	const [bestKey, best] = over.length
		? over.sort((a, b) => b[1].net - a[1].net || b[1].res - a[1].res)[0]
		: eligible.sort((a, b) => b[1].wins / b[1].res - a[1].wins / a[1].res || b[1].net - a[1].net)[0];
	const wr = (100 * best.wins) / best.res;
	const pf = best.grossLoss > 0 ? best.grossWin / best.grossLoss : Infinity;
	console.log(`\n=== BEST CONFIG: ${bestKey} (n=${best.n}, resolved=${best.res}, WR=${wr.toFixed(1)}%, PF=${pf.toFixed(2)}, net=${best.net.toFixed(0)} pts, exp=${(best.net / best.n).toFixed(3)}) ===`);

	console.log("\nper-year (resolved first-touch):");
	for (const [y, by] of [...best.byYear.entries()].sort((a, b) => a[0] - b[0])) {
		const ywr = by.res ? (100 * by.wins) / by.res : 0;
		console.log(`  ${y}  n=${String(by.res).padStart(4)}  WR=${ywr.toFixed(1).padStart(5)}%`);
	}

	// ---- MFF grounding -------------------------------------------------
	const acctTrades = best.trades.map((t) => ({ date: t.date, pnlPts: t.pnlPts, riskPts: t.risk }));
	const dollared = dollarize(acctTrades);
	console.log(`\nACCOUNT (Rapid EOD 50k · ${bestKey}, ${acctTrades.length} trades):`);
	console.log("  eval  ", accountLine(simulateAccount(dollared, "eval")));
	console.log("  funded", accountLine(simulateAccount(dollared, "funded")));
	console.log("  net $ (budget-sized):", dollared.reduce((a, t) => a + t.pnl, 0).toFixed(0));

	// ---- trades dump ---------------------------------------------------
	const dump = {
		key: bestKey,
		config: "see scripts/rthOrb.ts header",
		stats: {
			n: best.n,
			resolved: best.res,
			wins: best.wins,
			wrPct: Math.round((1000 * best.wins) / best.res) / 10,
			pf: Math.round(pf * 100) / 100,
			netPts: Math.round(best.net * 100) / 100,
			expPts: Math.round((1000 * best.net) / best.n) / 1000,
			perYear: Object.fromEntries(
				[...best.byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, by]) => [y, { n: by.res, wins: by.wins, wrPct: Math.round((1000 * by.wins) / by.res) / 10 }]),
			),
			account: {
				eval: accountLine(simulateAccount(dollared, "eval")),
				funded: accountLine(simulateAccount(dollared, "funded")),
				netDollars: Math.round(dollared.reduce((a, t) => a + t.pnl, 0) * 100) / 100,
			},
		},
		trades: best.trades,
	};
	await fs.writeFile(path.join("/tmp", "rth_orb_trades.json"), JSON.stringify(dump, null, 2));
	console.log(`\ntrades dumped → /tmp/rth_orb_trades.json (${best.trades.length} trades)`);
	console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
