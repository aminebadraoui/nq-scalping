/* MACRO WATCH parsers (lib/macroWatch.ts) — offline tests over
 * fixtures mirroring the live feed shapes verified Oct 2026. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCnbcBatch,
  vixStats,
  expectedRangePct,
  nextOpex,
  nextFomcMinutes,
  parseTreasuryDirect,
  parseFredCsv,
  fredPoint,
  parseCot,
  AUCTION_FALLBACK_2026Q4,
} from "../lib/macroWatch.ts";
import { impliedFfr } from "../lib/macroFmt.ts";

const CNBC = {
  FormattedQuoteResult: {
    FormattedQuote: [
      { symbol: ".VIX", last: "15.31", change: "-1.08", change_pct: "-6.59%", last_timedate: "10/02/26 EDT" },
      { symbol: ".DXY", last: "101.924", change: "-0.175", change_pct: "-0.17%", last_timedate: "10/02/26 EDT" },
      { symbol: "@GC.1", last: "4,172.10", change: "-30.20", change_pct: "-0.72%", last_timedate: "7:35 PM EDT" },
      { symbol: "BTC.CB=", last: "84,864.75", change: "+550.14", change_pct: "+0.65%", last_timedate: "4:17 PM EDT" },
      { symbol: "US10Y", last: "5.273%", change: "+0.039", change_pct: "+0.75%", last_timedate: "5:05 PM EDT" },
      { symbol: "@FF.1", last: "96.1175", change: "+0.01", change_pct: "+0.01%", last_timedate: "5:05 PM EDT" },
      { symbol: "@CL.1", last: "undefined", change: "undefined", change_pct: "undefined", last_timedate: "" },
    ],
  },
};

test("parseCnbcBatch: strips %/commas, nulls for 'undefined', maps labels/groups", () => {
  const q = parseCnbcBatch(CNBC);
  const vix = q.find((x) => x.symbol === ".VIX");
  assert.equal(vix.label, "VIX");
  assert.equal(vix.group, "risk");
  assert.equal(vix.value, 15.31);
  assert.equal(vix.change, -1.08);
  assert.equal(vix.changePct, -6.59);
  const gc = q.find((x) => x.symbol === "@GC.1");
  assert.equal(gc.value, 4172.1); // comma stripped
  const y10 = q.find((x) => x.symbol === "US10Y");
  assert.equal(y10.value, 5.273); // % stripped
  const cl = q.find((x) => x.symbol === "@CL.1");
  assert.equal(cl.value, null); // "undefined" → null, never NaN
});

test("parseCnbcBatch: every configured symbol is present, missing feeds are null", () => {
  const q = parseCnbcBatch({ FormattedQuoteResult: { FormattedQuote: [] } });
  assert.equal(q.length, 15);
  assert.ok(q.every((x) => x.value == null));
});

test("impliedFfr: 100 − FF futures price", () => {
  assert.equal(impliedFfr(96.1175), 3.88);
  assert.equal(impliedFfr(null), null);
  assert.equal(impliedFfr(Number.NaN), null);
});

const VIX_CSV = [
  "DATE,OPEN,HIGH,LOW,CLOSE",
  "01/02/1990,17.24,17.24,17.24,15.00",
  "10/01/2026,16.15,16.24,15.30,15.31",
  "10/02/2026,16.15,16.24,15.30,15.31",
].join("\n");

test("vixStats: level, percentiles (≤ counting), asOf", () => {
  const s = vixStats(VIX_CSV);
  assert.equal(s.level, 15.31);
  assert.equal(s.at, "2026-10-02");
  assert.equal(s.pctAll, 100); // all closes ≤ last
});

test("vixStats: 1y percentile uses the trailing 252 rows only", () => {
  const rows = ["DATE,OPEN,HIGH,LOW,CLOSE"];
  for (let i = 0; i < 300; i++) rows.push(`01/01/2000,20,20,20,${i % 2 === 0 ? 10 : 30}`); // half below 10
  rows.push("10/02/2026,10,10,10,10");
  const s = vixStats(rows.join("\n"));
  // last 252 rows: 251 old rows (half < 10) + the 10 itself
  assert.equal(s.pct1y, 50);
});

test("expectedRangePct: rule of 16", () => {
  assert.equal(expectedRangePct(16), 1);
  assert.equal(expectedRangePct(15.31), 0.96);
  assert.equal(expectedRangePct(null), null);
});

test("nextOpex: 3rd Friday, quad only in Mar/Jun/Sep/Dec", () => {
  assert.deepEqual(nextOpex("2026-10-03"), { day: "2026-10-16", quad: false, days: 13 });
  assert.deepEqual(nextOpex("2026-10-16"), { day: "2026-10-16", quad: false, days: 0 });
  assert.deepEqual(nextOpex("2026-10-17"), { day: "2026-11-20", quad: false, days: 34 });
  assert.deepEqual(nextOpex("2026-12-01"), { day: "2026-12-18", quad: true, days: 17 });
});

test("nextFomcMinutes: ~3 weeks after the latest decision, flagged approximate", () => {
  // last FOMC decision before 2026-10-03 was 2026-09-16 → minutes ≈ 2026-10-07
  const m = nextFomcMinutes("2026-10-03");
  assert.equal(m.day, "2026-10-07");
  assert.equal(m.approx, true);
  assert.ok(m.days >= 0 && m.days <= 30);
});

const TD = [
  { securityType: "Note", securityTerm: "9-Year 10-Month", originalSecurityTerm: "10-Year", auctionDate: "2026-10-07T00:00:00", tips: "" },
  { securityType: "Note", securityTerm: "3-Year", originalSecurityTerm: "", auctionDate: "2026-10-06T00:00:00", tips: "" },
  { securityType: "Bond", securityTerm: "29-Year 10-Month", originalSecurityTerm: "30-Year", auctionDate: "2026-10-08T00:00:00", tips: "" },
  { securityType: "Note", securityTerm: "4-Year 10-Month", originalSecurityTerm: "5-Year", auctionDate: "2026-09-17T00:00:00", tips: "Y" },
];

test("parseTreasuryDirect: reopen labels normalized, past dates dropped, sorted", () => {
  const a = parseTreasuryDirect(TD, "2026-10-03");
  assert.deepEqual(
    a.map((x) => `${x.label}@${x.day}`),
    ["3Y@2026-10-06", "10Y@2026-10-07", "30Y@2026-10-08"],
  );
  assert.equal(a[0].days, 3);
});

test("parseTreasuryDirect: TIPS flag on the label", () => {
  const a = parseTreasuryDirect(TD, "2026-09-01");
  assert.ok(a.some((x) => x.label === "5Y TIPS"));
});

const FRED_CSV = "DATE,BAMLH0A0HYM2\n2026-07-01,3.10\n2026-08-01,3.20\n2026-09-01,3.24\n";

test("parseFredCsv + fredPoint: latest + change vs lookback", () => {
  const rows = parseFredCsv(FRED_CSV);
  assert.equal(rows.length, 3);
  const p = fredPoint(FRED_CSV, 2);
  assert.equal(p.day, "2026-09-01");
  assert.equal(p.value, 3.24);
  assert.equal(p.delta, 0.14); // 3.24 − 3.10
  assert.equal(fredPoint("DATE,X\n", 1), null);
});

const COT = [
  { report_date_as_yyyy_mm_dd: "2026-09-29T00:00:00.000", noncomm_positions_long_all: "78652", noncomm_positions_short_all: "33256", open_interest_all: "283950" },
  { report_date_as_yyyy_mm_dd: "2026-09-22T00:00:00.000", noncomm_positions_long_all: "70000", noncomm_positions_short_all: "30000", open_interest_all: "280000" },
  { report_date_as_yyyy_mm_dd: "2026-09-15T00:00:00.000", noncomm_positions_long_all: "60000", noncomm_positions_short_all: "40000", open_interest_all: "270000" },
];

test("parseCot: net spec, % of OI, 52w percentile, asOf", () => {
  const c = parseCot(COT);
  assert.equal(c.net, 45396);
  assert.equal(c.netPctOi, 16); // 45396/283950 = 15.99 → 16.0
  assert.equal(c.pct52w, 100); // largest net in the window
  assert.equal(c.asOf, "2026-09-29");
});

test("AUCTION_FALLBACK: sorted weekdays with sane labels", () => {
  const days = AUCTION_FALLBACK_2026Q4.map((a) => a.day);
  assert.deepEqual(days, [...days].sort());
  for (const d of days) {
    const dow = new Date(Date.UTC(...d.split("-").map(Number).map((n, i) => (i === 1 ? n - 1 : n)))).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d} is not a weekday`);
  }
  assert.ok(AUCTION_FALLBACK_2026Q4.some((a) => a.label === "30Y"));
});

/* --- GEX pin (lib/options.ts) --- */
import { computeGamma, pinStrike, gammaProfile } from "../lib/options.ts";

test("computeGamma: pin = strike with the largest total OI", () => {
  // synthetic chain: strikes 100/105/110 — OI concentrated at 105
  const rows = [
    { symbol: "QQQ250905C00100000", expiry: "2025-09-05", side: "call", strike: 100, bid: 1, ask: 1.1, iv: 0.2, open_interest: 10, volume: 0, delta: 0.5, gamma: 0.01, theta: -0.01, vega: 0.1, last: 1, spot: 103 },
    { symbol: "QQQ250905C00105000", expiry: "2025-09-05", side: "call", strike: 105, bid: 1, ask: 1.1, iv: 0.2, open_interest: 100, volume: 0, delta: 0.5, gamma: 0.02, theta: -0.01, vega: 0.1, last: 1, spot: 103 },
    { symbol: "QQQ250905P00105000", expiry: "2025-09-05", side: "put", strike: 105, bid: 1, ask: 1.1, iv: 0.2, open_interest: 60, volume: 0, delta: -0.5, gamma: 0.02, theta: -0.01, vega: 0.1, last: 1, spot: 103 },
    { symbol: "QQQ250905C00110000", expiry: "2025-09-05", side: "call", strike: 110, bid: 1, ask: 1.1, iv: 0.2, open_interest: 5, volume: 0, delta: 0.5, gamma: 0.01, theta: -0.01, vega: 0.1, last: 1, spot: 103 },
  ];
  const parsed = rows.map((r) => ({ ...r, oi: r.open_interest }));
  const g = computeGamma(parsed, 103);
  assert.equal(g.pin.strike, 105); // 100+60 = 160 OI at 105
  assert.equal(g.pin.oi, 160);
  const prof = gammaProfile(parsed);
  assert.equal(pinStrike(prof).strike, 105);
  assert.equal(pinStrike([]), null);
});

/* --- Yahoo spark parsing --- */
import { parseSparks } from "../lib/macroWatch.ts";

test("parseSparks: closes mapped to symbol keys, junk filtered", () => {
  const s = parseSparks({
    spark: {
      result: [
        { symbol: "^VIX", response: [{ indicators: { quote: [{ close: [15.1, null, 15.3, 15.31] }] } }] },
        { symbol: "DX-Y.NYB", response: [{ indicators: { quote: [{ close: [101.5, 101.9, "bad", 101.924] }] } }] },
        { symbol: "EMPTY", response: [{ indicators: { quote: [{ close: [null, null] }] } }] },
        { symbol: "NODATA" },
      ],
    },
  });
  assert.deepEqual(s["^VIX"], [15.1, 15.3, 15.31]);
  assert.deepEqual(s["DX-Y.NYB"], [101.5, 101.9, 101.924]);
  assert.equal(s["EMPTY"], undefined);
  assert.equal(s["NODATA"], undefined);
  assert.deepEqual(parseSparks(null), {});
});

/* --- live realized-vol band + Coinbase BTC --- */
import { realizedDailyBandPct } from "../lib/macroFmt.ts";
import { parseCoinbaseBtc } from "../lib/macroWatch.ts";

test("realizedDailyBandPct: stdev of log returns × √390, in percent", () => {
  // 10 bars of +0.1% each → stdev 0 → null-safe? needs >=5 closes; returns 0
  const up = Array.from({ length: 11 }, (_, i) => ({ c: 100 * Math.pow(1.001, i) }));
  assert.equal(realizedDailyBandPct(up), 0);
  // alternating ±0.1% → positive band (≈0.1%×√390 ≈ 1.97%... stdev of ±0.1% log rets)
  const alt = Array.from({ length: 11 }, (_, i) => ({ c: 100 * (i % 2 === 0 ? 1.001 : 0.999) }));
  const band = realizedDailyBandPct(alt);
  assert.ok(band != null && band > 0 && band < 5);
  assert.equal(realizedDailyBandPct([{ c: 0 }, { c: 0 }]), null);
});

test("parseCoinbaseBtc: amount parsed, non-USD rejected", () => {
  assert.equal(parseCoinbaseBtc({ data: { amount: "84883.025", base: "BTC", currency: "USD" } }), 84883.025);
  assert.equal(parseCoinbaseBtc({ data: { amount: "1", base: "BTC", currency: "EUR" } }), null);
  assert.equal(parseCoinbaseBtc(null), null);
  assert.equal(parseCoinbaseBtc({ data: { amount: "0", base: "BTC", currency: "USD" } }), null);
});
