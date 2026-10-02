# Trade Review — Overnight Session 2026-10-01 18:00 → 2026-10-02 09:30 ET

Data sources: CrossTrade Tradovate REST API (`/v1/api/tv/orders`, `/tv/fills`, `/tv/accounts/snapshot`),
Neon `signals` table, VPS container logs (Coolify API), live 1-min candles (Neon `candles_1m`).
Account: MFF eval `MFFUEVREOD706880006` (MNQZ6). All times ET.

## Account state (2026-10-02 10:08 ET)

| Metric | Value |
|---|---|
| Net liquidation | $50,966.60 |
| Realized P&L, this session | **+$61.40** (net) |
| Realized P&L, this week | +$966.60 |
| Position / working orders | flat / none |

Session gross (fills, FIFO): **+$430** ⇒ implied all-in costs ≈ **$0.95/side** across 388 sides
(≈$368 total). Verify this against MFF's current micro fee schedule — at the usual $0.62+$0.11
the costs should be ≈$299, so either fees are higher than assumed or a ~$70 detail needs a second
look. Commissions matter at this sizing: they consumed ~85% of the session's gross.

## Who traded what

- **18:31–19:22 ET** — 4 bot momentum trades executed by the **Mac's local Playwright browser
  executor** (the CrossTrade webhook path deployed at 19:14 ET, commit `0055cd1`; the VPS has no
  Tradovate creds and no browser, so it could not trade before the deploy).
- **21:18–01:27 ET** — 7 bot momentum trades via the **VPS CrossTrade webhook path**
  (scale-out off; `$170` risk-budget sizing; market orders).
- **19:01/19:22** — 1 manual MES scalp (+$12.5).
- **08:39–08:55** — 4 manual MNQ trades, no signals in the DB and no bot log lines (+$477 gross).

## Signals vs fills — the bot's 11 overnight trades

| Signal | Dir | N | Signal entry/stop/tgt | Fill entry | Exit | Gross | Signal→fill Δ |
|---|---|---|---|---|---|---|---|
| 18:31 | L | 10 | 30796.25 / 30788.25 / 30804.25 | 30796.25 (limit, filled 11.6 min late) | 30804.25 TP | **+$160** | 0.00 |
| 18:44 | S | 18 | 30798.50 / 30803.00 / 30794.00 | 30798.50 | 30798.75 (covered 13 s later) | **−$9** | 0.00 |
| 18:47 | L | 28 | 30802.50 / 30799.50 / 30805.50 | 30798.50 | 5 @ 30796.0 SL + 23 @ 30802.0 TP | **+$136** | −4.00 |
| 19:15 | L | 14 | 30849.75 / 30843.75 / 30855.75 | 30847.00 (limit, filled 4.6 min late) | 30840.75 SL | **−$175** | −2.75 |
| 21:18 | L | 9 | 30844.75 / 30835.50 / 30854.00 | 30839.00 | 30832.6 SL | **−$115.5** | −5.75 |
| 22:26 | L | 10 | 30864.25 / 30856.25 / 30872.25 | 30863.50 | 30870.75 TP | **+$145** | +0.75 |
| 22:50 | S | 8 | 30882.50 / 30892.50 / 30872.50 | 30876.00 | 30888.53 SL | **−$200.5** | −6.50 |
| 23:08 | S | 8 | 30880.75 / 30890.50 / 30871.00 | 30881.00 | 30872.00 TP | **+$144** | −0.25 |
| 00:23 | L | 14 | 30898.00 / 30892.25 / 30903.75 | 30901.00 | 30906.25 TP | **+$147** | −3.00 |
| 00:41 | L | 9 | 30899.50 / 30890.75 / 30908.25 | 30897.75 | 30888.8 SL | **−$161.5** | +1.75 |
| 01:27 | S | 13 | 30887.25 / 30893.75 / 30880.75 | 30886.00 | 30891.00 SL | **−$130** | −1.25 |

Bot: 11 trades, 5W / 6L, **gross −$59.5** (wins +$732, losses −$791.5); ≈299 sides ⇒ ≈−$284
costs ⇒ bot net ≈ **−$343**. Manual trading (+$489.5 gross) carried the session to +$61.4 net.

## Why the 5 losses happened

### 1. 19:15 LONG 14 (−$175) — stopped at the exact low, then +70 pts
The browser path rolled a limit entry ("Buy Bid", 15% chance) → filled 4.6 min after the signal.
Stopped 19:21:06 at 30840.75 — the **low tick of the 19:21 bar** — and the market reversed there
and ran +70 pts to 30920 by 20:23. Direction was right; the stop was run at the flush extreme.
(Even with a perfect signal-price fill the stop would have been hit — this one is an in-model loss.)

### 2. 21:18 LONG 9 (−$115.5) — breakout straight into overhead congestion
Sequence: 21:15 failed flush (low 30822.5) → 21:18 breakout bar (76% buy, high 30847.75).
Fired 3 s after the close; market order filled at 30839 (already fading). The breakout entered the
30840–30858 congestion from the 20:30–20:59 range; sellers re-engaged the next minute (21:19 printed
a 16-pt down bar) and never looked back (30791.5 by 21:37). **Genuine failed breakout** — the
reference high it broke was inside a prior distribution, not above it.

### 3. 22:50 SHORT 8 (−$200.5) — counter-trend short of a buying climax
22:49 printed a 365-ct up bar to a new session high (30893.5); 22:50 reversed with an 82%-sell bar
→ expansion trigger shorted the reversal bar's close. But the night was a **one-way +110-pt
uptrend** (30816 → 30935), and 22:50 was the first counter-bar. The chop (22:51–22:58) then broke
back up through the stop. The expansion detector has **no trend/session-context filter**, so it
shorts (and longs) single huge counter-bars inside dominant trends — this is where its losses
concentrate.

### 4. 00:41 LONG 9 (−$161.5) — bought the exact double top, stopped at the exact low
00:41 bar high = 30899.50 = the 00:37 high to the tick (double top). Stopped 00:46 at
30888.75/30889 — the **low tick zone** — then the market reversed and ran +35 pts to 30935 by
01:02. Another stop-run at the extreme: entry at resistance, stop exactly at the probe low.

### 5. 01:27 SHORT 13 (−$130) — quote-anchored stop ran by 0.25 pt; would have been a winner
The failed-rally short fired at 30887.25 with the **structural stop at 30893.75** (breakout bar
high + 0.5). CrossTrade builds the bracket from its live reference quote at webhook arrival, not
from the signal stop: the effective stop landed at ≈30891.0. The bounce printed 01:29 high
**30891.25** — ran the quote-stop by 0.25 pt (fills 30891.0) — and the market then collapsed
15 pts to 30872.5 by 01:30 (target 30880.75). With the designed stop this trade wins +6.5 pts.
**A ~$300 swing caused purely by bracket anchoring.**

## Systemic findings (refinement targets)

1. **Bracket anchoring (biggest lever).** The webhook format is tick-based, so stops/targets are
   always `live-quote ± ticks`, never the signal's structural prices. Entry drift (median ~2 pts
   adverse on losers) shifts the whole bracket. Cost last night: flipped the 01:27 winner into a
   −$130 loss (−$299 swing), shrank the 22:26/23:08/00:23 winners by ≈$40, offset by ≈$51 saved on
   21:18 and ≈$40 on 22:50. Net ≈ −$250 vs designed brackets.
   Fix options: (a) REST place (`/v1/api/tv/accounts/{acct}/orders/place`) with **absolute**
   `stopLoss`/`takeProfit` at the signal prices; or (b) keep the webhook but attach our `order_id`
   to every entry and send a CHANGE to the structural stop right after the ack (the CHANGE path
   already exists for scale-out). Note: with the webhook, `require_market_position=flat` and
   isAutomated tagging stay; REST mutations bypass Alert History but keep the same broker gates.
2. **Expansion trigger needs a context filter.** Both expansion losses (22:50, 00:41) were entries
   into an extreme: one against the session trend, one at an exact double top. Candidates to
   backtest in the lab: require expansion direction == session cumulative-delta/VWAP side; veto
   entries whose bar high/low equals the prior swing extreme within 0.25; distance-to-overhead
   (prior POC/resistance stack) veto for failed-flush breakouts (the 21:18 case).
3. **Stop-run clustering.** 3 of 5 losses (19:15, 00:41, 01:27) were stopped within a tick of the
   exact swing extreme, and the market then moved hard in the trade direction. The signal-bar
   stop is the backtested optimum, so most of these are in-model — but check whether stop-runs
   cluster by hour/context (00:00–02:00 ET Globex?) or by trigger type (expansion vs failed-flush)
   in the 568-session replay before touching stop placement.
4. **Entry drift is asymmetric against us on losers.** On winners the market continues our way and
   we fill near the signal close; on losers it reverses in the 1–4 s before the market order lands
   and we fill worse. The backtest's close-price fill assumption overstates live expectancy by
   roughly the average adverse drift on losing trades. Quantify it in the lab (fill ≈ close ± first
   N seconds of the next bar) so live expectancy is forecast honestly.
5. **First-of-day discipline.** The 18:31 card (first of the session) won; the next 7 went 3W/4L —
   consistent with the 77.2% first-card vs ~74.5% rest split in the research. If fewer, better
   cards is preferred over more cards: consider trading only the first momentum card + A+ (both
   triggers) cards per session, or half size after the first. Trade-off: fewer signals, higher
   edge per signal.
6. **Playwright-era issues are closed** (path replaced by CrossTrade) but recorded: 15% random
   limit entries produced 11.6-min and 4.6-min delayed fills; the Tradovate ticket's persisted
   "Flatten" state covered the 18:44 short 13 s after entry (verify intent — it saved ≈$77 that
   time, but the behavior was uncontrolled); 2–3 min signal→order latency. None of these apply to
   the webhook path.
7. **Operational.** CrossTrade durable fill history (`/tv/fills/history`) was **empty** — journal
   capture is periodic (90 s debounce / 10 min interval / 5–6 pm ET window) and the Tradovate link
   was re-established at 19:01 ET; session-scoped lists (`/tv/fills`, `/tv/orders`) reset at the
   ~17:00 ET daily close. Verify Tradovate journal import is enabled in CrossTrade, and re-pull
   `/tv/fills/history` after 18:00 ET to confirm last night's fills got captured for the durable
   record.
8. **Data hygiene.** Store the A+ flag, the trigger bar, and the actual fill (entry/exit) on the
   signal row, or reconcile signals↔fills in a small nightly job — last night's post-mortem needed
   three systems (DB, CrossTrade API, container logs) to reconstruct. A `trades` table joined to
   `signals` would make these reviews a one-query job.

## Bottom line

Last night was a small-sample drawdown inside the model's noise band (11 trades; the 77% edge
produces 4–6 loss streaks regularly), with three fixable execution/concept leaks on top:
quote-anchored brackets (~−$250), expansion entries at extremes with no trend/context veto, and
entry drift against us on the trades that fail. The manual morning trading (+$477 gross) was the
only reason the session closed green after commissions. The momentum engine itself behaved as
designed: 5 of 6 losers were triggered correctly; the discipline question is which of the 7
post-open signals should have been skipped.
