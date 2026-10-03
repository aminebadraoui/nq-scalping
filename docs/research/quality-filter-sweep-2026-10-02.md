# Quality-filter sweep — ATR vs footprint gates (2026-10-02)

Question: is there a better breakout-bar quality filter than the
ATR-normalized range gate? Ran the full momentum replay head-to-head
(`scripts/momentumStudy.ts --offline --sweep`), 648 sessions, split
2026-01-01, plus the Globex-hour-filtered mirror of the live config.
Outcome: `pnl > 0` = win; PF from summed point P&L; expR = net ÷ trades ÷
mean risk. "rr" = minBreakRangeR (range ÷ ATR14).

## Momentum — all hours

| variant | n | WR | PF | net pts | expR |
|---|---|---|---|---|---|
| prod (no ATR) | 2228 | 74.6% | 2.56 | +4476 | 0.42 |
| prod+rr0.85 (was live) | 2184 | 75.0% | 2.60 | +4468 | 0.42 |
| **prod+rr1.0** | 2129 | **75.5%** | **2.68** | **+4483** | 0.43 |
| prod+rr1.2 | 1970 | 76.4% | 2.84 | +4406 | **0.45** |
| prod+stack | 2147 | 74.8% | 2.60 | +4399 | 0.42 |
| prod+churnVeto | 1961 | 74.5% | 2.48 | +3663 | 0.40 |
| prod+poc / +pocMove / +both | 1610–2089 | 74.3–75.0% | 2.46–2.58 | +3105–4240 | 0.40–0.42 |
| prod+quietBefore | 999 | 72.9% | 2.39 | +1877 | 0.39 |
| prod+diag1 | 1339 | 75.5% | 2.69 | +2888 | 0.43 |
| prod+rr1.0+diag1 | 1268 | 76.6% | 2.83 | +2884 | 0.45 |
| prod+rr1.0+diag2 | 740 | 77.4% | 3.03 | +1864 | 0.48 |
| prod+rr1.0+eff1.5 / eff2 | 223–510 | 71.7–73.5% | 2.31–2.51 | +418–999 | 0.38–0.41 |

## Momentum — Globex-filtered (live-equivalent)

| variant | n | WR | PF | net pts | expR |
|---|---|---|---|---|---|
| prod (no ATR) | 2208 | 74.8% | 2.60 | +4480 | 0.42 |
| prod+rr0.85 (was live) | 2166 | 75.2% | 2.65 | +4475 | 0.43 |
| **prod+rr1.0** | 2114 | **75.6%** | **2.71** | **+4482** | 0.44 |
| prod+rr1.2 | 1959 | 76.5% | 2.87 | +4394 | **0.46** |
| prod+rr1.0+diag1 | 1254 | 76.7% | 2.89 | +2876 | 0.46 |
| prod+rr1.0+diag2 | 733 | 77.5% | 3.05 | +1846 | 0.48 |

## Expansion sweep (same archive)

| variant | n | WR | PF | net pts | expR |
|---|---|---|---|---|---|
| exp1.4s | 6129 | 77.3% | 2.94 | +14441 | 0.47 |
| **exp1.6s (live)** | 4893 | **78.1%** | **3.05** | +12107 | 0.48 |
| exp1.8s / exp2.0s | 2989–3810 | 78.0–78.1% | 3.04 | +7624–9591 | 0.48 |
| exp1.6s+poc / +pocMove | 3453–4652 | 77.8–78.0% | 2.97–2.99 | +8297–11323 | 0.47 |
| exp1.6s+core | 3910 | 78.8% | 3.23 | +10100 | 0.50 |

## Verdict

1. **No footprint gate beats ATR-range as the quality filter.** Stack,
   churn veto, POC position/migration, quiet-before, efficiency density
   and diagonal imbalance all either subtract total net or match ATR at a
   fraction of the sample. ATR-normalized range stays.
2. **The ATR gate itself was set one notch too loose.** rr1.0 strictly
   dominates rr0.85 on WR, PF and total net in both sweeps — applied to
   `MOM_PROD` (2026-10-02). rr1.2 is the "fewer, better trades" option
   (best expR) at a ~90-pt total-net cost.
3. **Diagonal imbalance (diag) is the one footprint gate with real
   quality signal** (+1.5–1.9 pp WR, PF 2.89–3.05 with rr1.0) — but at
   IMB_MIN=10 lots it cuts the sample and total net ~35–60%. It is a
   valid "high-conviction mode", not a replacement. Available as
   `minBreakDiag` (momentum detector), default off.
4. **Expansion config is already at the knee**: 1.6×ATR + stack; POC
   gates subtract trades without quality.
5. New detector knobs (`minBreakEffR`, `minBreakDiag`) ship default-off;
   the self-improvement miner can propose them later when live data
   supports it.
