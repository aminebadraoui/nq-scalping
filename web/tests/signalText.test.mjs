/* Telegram signal card formatter tests: the message is the product, so its
 * layout (trade ticket + full reasoning) and HTML safety are pinned. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSignalHtml } from "../lib/signalText.ts";

const mech = {
  side: "long",
  verdict: "ALIGNED LONG — every box agrees",
  trigger: "wait for price to break below 100.00 and trade back inside within 2 bars",
  invalidation: "a 1-minute close below 99.75 invalidates the read",
  target: "P0 POC 101.00 · 1.0 pts away",
  narrative: "Buyers pushed 100 contracts into 99.75 and price did not move (absorption)",
  ingredients: [
    { n: "1", name: "Location", state: "yes", short: "at P1 LVN edge 99.75" },
    { n: "2", name: "Mechanism", state: "yes", short: "sell aggression 100 ct @ 99.75 held" },
    { n: "3", name: "Fuel", state: "partial", short: "D2 bull — price LL / CVD HL" },
    { n: "4", name: "Trigger", state: "yes", short: "failed low reclaimed @ 100.00" },
    { n: "5", name: "Footprint", state: "no", short: "no stack" },
    { n: "6", name: "Context", state: "yes", short: "above VWAP 100.25 · no release" },
  ],
};

const pa = {
  verdict: "LONG LOCATION — price is in discount on 5/6 timeframes",
  narrative: "discount on 1d, 4h, 1h, 15m, 5m.",
};

const opt = {
  note: "dealers net LONG gamma — chop",
  callWallNq: 120,
  putWallNq: 80,
  flipNq: 100,
};

function mkSignal(side) {
  return {
    side,
    tone: side ?? "neutral",
    agree: !!side,
    verdict:
      side === "long" ? "ALIGNED LONG — every box agrees" : "NO SIGNAL — no box has a directional read yet",
    headline: "headline",
    boxes: [
      { id: "orderflow", name: "Order flow", side, tone: side ?? "neutral", score: side ? 1 : 0, verdict: "", kind: "directional" },
      { id: "priceaction", name: "Price action", side, tone: side ?? "neutral", score: side ? 1 : 0, verdict: "", kind: "directional" },
      { id: "options", name: "Options / gamma", side: null, tone: "neutral", score: 0, verdict: "", kind: "context", label: "CHOP" },
    ],
    contexts: [],
    contextNotes: ["dealers net LONG gamma — chop"],
  };
}

test("long card includes the trade ticket and the full reasoning", () => {
  const html = formatSignalHtml(mkSignal("long"), mech, pa, opt, {
    symbol: "NQZ26",
    price: 100.25,
    timeET: "10:30",
    source: "live",
  });
  assert.match(html, /NQ SCALP SIGNAL/);
  assert.match(html, /LONG/);
  assert.match(html, /ENTRY \/ TRIGGER/);
  assert.match(html, /STOP/);
  assert.match(html, /TARGET/);
  assert.match(html, /REASONING/);
  assert.match(html, /PRICE ACTION/);
  assert.match(html, /OPTIONS \/ GAMMA/);
  assert.match(html, /✅ <code>1 Location/);
  assert.match(html, /◐ <code>3 Fuel/);
  assert.match(html, /✗ <code>5 Footprint/);
  assert.match(html, /dealers net LONG gamma — chop/);
});

test("escapes HTML in dynamic values", () => {
  const evil = { ...mech, invalidation: "close below 99.75 <break> & stop" };
  const html = formatSignalHtml(mkSignal("long"), evil, pa, opt, {
    symbol: "NQZ26",
    price: 100.25,
    timeET: "10:30",
    source: "live",
  });
  assert.match(html, /&lt;break&gt;/);
  assert.match(html, /&amp; stop/);
  assert.doesNotMatch(html, /<break>/);
});

test("no-trade card announces NO TRADE", () => {
  const html = formatSignalHtml(mkSignal(null), { ...mech, side: null, verdict: "NO SIGNAL — no box has a directional read yet" }, pa, opt, {
    symbol: "NQZ26",
    price: 100.25,
    timeET: "10:30",
    source: "live",
  });
  assert.match(html, /NO TRADE/);
});
