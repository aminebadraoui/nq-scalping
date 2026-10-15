# Vendor redundancy evaluation — can the signal engine survive a GoCharting bad day? (2026-10-15)

> Question: *"The GoCharting feed has stalled or frozen four times in five
> days (10-11, 10-12, 10-14 overnight, 10-15 morning) and the CrossTrade
> snapshot has flaked repeatedly — every incident killed the session's
> signals. What does vendor redundancy actually require, and what's the
> honest cheapest path?"*

## The hard dependency

The detectors are footprint detectors: momentum flush/expansion read
per-bar **buy/sell attribution + per-price cluster levels**
(`MomMinute.levels`), and the RTH soft-momentum card requires dominant
cluster counts (`domClusters ≥ 3`). OHLC is NOT enough — the entire
detector stack was validated on vendor-aggregated footprint candles, and
the 2026-10-05 live-vs-backtest post-mortem measured what happens when
you run them on degraded data (76% vs 41% buy attribution; 7+4 live
signals vs 1+1 backtested).

So a redundant data path must supply **footprint-grade data**, not just
prices. That rules out every free OHLC source (Yahoo, Polygon, Alpha
Vantage, Twelve Data, etc.) as a drop-in backup for the current
detectors.

## The three real options

| # | Option | Footprint-grade? | Cost / effort | Verdict |
|---|---|---|---|---|
| 1 | **Full CME market-by-order data** (Databento MBO for NQ) and build the footprint ourselves | Yes — per-price buy/sell clusters from real MBO | data license (~$50–150/mo for NQ MBO) + a footprint builder (the live tick path already does this at reduced fidelity — a full feed makes it exact) | **The strategic fix.** The footprint becomes vendor-independent; GoCharting demoted to a display/backup. This is the only option that removes the single point of failure. |
| 2 | A second footprint vendor (Sierra Chart data, NinjaTrader, Quantower, ATAS data feeds) | Yes, if their candle API exposes footprint levels | license + a second FOOTPRINT-style adapter | Viable but swaps one vendor for another — same failure class (a vendor's data pipeline freezes), just two chances instead of one. |
| 3 | Degraded-mode detectors on an OHLC secondary feed (flush/expansion families only — they mostly need OHLC+vol+delta estimates; RTH cluster gates stay off) | No — attribution estimated from tick direction (the 76%/41% divergence returns) | cheapest | Only as a STOPGAP for family-level availability; would need its own backtest before it ever trades. |

## CrossTrade (the execution vendor)

The second single point: `account snapshot unreadable` / `unknown_account`
halts. Mitigations shipped 2026-10-15:

- **Snapshot auto-retry**: cards that pass every gate but die on the
  snapshot read are re-attempted for 90 s (3 tries) — inside the
  staleness veto, so a retried card is never a stale card.
- The guard stays fail-closed otherwise (never trades without a
  confirmed snapshot — that part is correct by design).

A true second execution vendor (broker) is a much larger lift and out of
scope: CrossTrade is the account's webhook executor tied to the prop
account itself.

## Recommendation

1. **Now (shipped):** the feed-frozen watchdog + tick-fire fallback +
   canary + smoke + runbook — the system degrades loudly instead of
   silently, and recovers automatically when the vendor returns.
2. **Next (evaluate this quarter):** Databento NQ MBO — build the
   footprint in-house; keep GoCharting as the incumbent until the
   in-house footprint passes a 30-day shadow comparison against the
   vendor's candles (the same discipline as the confirm-race probe, but
   for a whole session).
3. **Not recommended:** a second footprint vendor (same failure class),
   or trading degraded OHLC detectors without a dedicated backtest.

*Educational research only — not financial advice.*
