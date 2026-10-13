# Missed-fill ledger incident — 2026-10-13 10:16 RTH card

> Question: *"Why did the 10:16 RTH short trade for −$83.30 without a
> single live ledger record, and how is it fixed?"* Fix: commit `bdc27b8`
> (`[backtested: npm test — 981 pass / 0 fail; pure bugfix]`).

## The incident

The 2026-10-13 10:16 RTH card (`rth|2026-10-13|short|09:16`) placed a
resting limit (7 MNQ short @ 30786.13, stop 30792.44). The broker record
shows a complete round trip:

- 10:24:34.2 ET — limit filled @ 30787.75 (+1.62 pts, better side)
- 10:24:35.2 ET — stop filled @ 30792.75 (0.31 past trigger)
- −35.00 pts · −$83.30 net (commissions 13.30)

The live executor recorded **nothing**: `exec_trades` stayed `placed`
with no order id, no fill, no exit; `exec_log` has one row
("REST placed mv6rmkmm-z9e7p7-lmt"); no `limit_filled`, no
`limit_expired`. Only the 16:50 reconcile found the round trip
(`trades` row day 2026-10-12 · status matched · result loss). The
protection watchdog even misattributed the 30792.75 stop fill to the
NEXT card ("stop 30780.94 filled at 30792.75 — 11.8 pts beyond the
trigger", 10:26:56).

## Root causes (three stacked bugs)

1. **Match window shorter than the limit's TTL.** `findMatchingFill`
   matched fills only within `MATCH_WINDOW_MS` = 5 min of the card.
   A resting limit is designed to wait — its TTL is ~9 min
   (`rthLimitParams.ttlMs`). The fill printed +6m51s after the card,
   111s past the window → no match, no `openExecs` registration, no
   close tracking. The expiry pass at 10:26:44 then tried to cancel an
   order that had already filled and stopped.
2. **orderId attach race.** `attachLimitOrderId` ran in the placement
   promise's `.then`, which resolves BEFORE `registerExpectation` (the
   feed awaits the Telegram push + the signal DB record first). The id
   landed on an unregistered card and was dropped → the expiry cancel
   had nothing to address ("no order id — cannot cancel") → the resting
   limit outlived the card that placed it.
3. **No boot/orphan reconciliation.** Anything the in-process paths miss
   (late fill, redeploy wiping `pending`/`openExecs`) stayed unresolved
   until the nightly reconcile — `exec_trades` and the broker disagreed
   for a full day.

## The fix (commit bdc27b8)

1. Limit-aware matching: for resting-limit cards the match window runs
   to `min(expireAtMs, cardTs + GIVE_UP_MS)` and the fill must sit
   within 5 pts of the limit price (manual-fill guard — the account
   carries manual trading). Non-limit cards keep the 5-min window.
2. The placement-resolved order id parks in `pendingLimitIds` and
   attaches whenever the card registers — order-independent.
3. `sweepOrphanLedger` (30s-throttled, display-only): unresolved
   `placed`/`filled` rows from today/yesterday get re-attached to the
   broker fill list (entry fill + order id) and closed from the
   opposite-side fills when the account is flat. Never touches orders,
   never registers `openExecs`, never feeds the protection watchdog or
   the counter-signal gate.

## Honest bounds

- The sweep's entry match is side+size+time+price-near-signal; a manual
  fill coinciding with all four could be misattributed to a stale row.
  The ledger is display-only (the nightly reconcile remains the
  historical authority), which bounds the harm; the price tolerance and
  the 80%-size floor make the coincidence narrow.
- The exit leg of an orphan that entered before a 17:00 session reset
  and exited after it is invisible to the fills list; such rows stay
  open for the nightly reconcile.

## Regenerate (the incident itself — read-only)

```bash
cd web
node --env-file=.env.local -e "
const postgres=require('postgres');
const sql=postgres(process.env.DATABASE_URL,{ssl:'require',max:1});
(async()=>{
  console.log(await sql\`select * from exec_trades where key='rth|2026-10-13|short|09:16'\`);
  console.log(await sql\`select * from trades where day='2026-10-12' and time_et='10:16'\`);
  await sql.end();
})();
"
```
