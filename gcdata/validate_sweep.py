#!/usr/bin/env python3
"""validate_sweep.py — overfitting audit for one exportSweep.ts JSON.

Computes, for the whole config grid of one family (all sessions):
  * PBO  — Probability of Backtest Overfitting via CSCV (purgedcv)
  * DSR  — Deflated Sharpe Ratio of the pick, deflated by every config tried
  * PSR  — Probabilistic Sharpe Ratio of the pick vs benchmark 0
  * MinTRL — sessions needed to establish the observed Sharpe at 95%
  * MinBTL — backtest years below which the annualised Sharpe is selection luck
  * year table, top-session concentration, and a verdict line

Returns are PER-SESSION return-on-risk (netUsd / riskUsd, 0 on no-trade
sessions) so configs with different stop widths are comparable; one session
= one observation = one CSCV block unit.

Usage (from gcdata/):
  ./.venv/bin/python validate_sweep.py data/sweeps/rth-<stamp>.json \
      [--pick s0.45_t1.75_x45] [--n-splits 16] [--sessions-per-year 250] \
      [--holdout-last 40]

Frozen holdout: --holdout-last N reserves the last N sessions as a
SINGLE-USE out-of-sample window. The first run that declares a holdout for
a family pins {N, pick} in data/holdouts.json; later runs must reuse the
same window and pick (goalpost-moving is refused). DSR/PBO/PSR/MinTRL are
computed on the pre-holdout sessions only; the holdout result is reported
separately and never feeds selection.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from purgedcv import (
    deflated_sharpe_ratio_full,
    effective_n_trials,
    min_track_record_length,
    minimum_backtest_length,
    probabilistic_sharpe_ratio,
    probability_of_backtest_overfitting,
)

SESSIONS_PER_YEAR = 250  # ~5 RTH days/wk x 50 wk
# small JSON artifacts live inside the validation route's folder (committed)
# so they ship inside the deployed server bundle; the big sweep JSONs stay
# local in gcdata/data/sweeps (gitignored).
VALIDATION_DIR = (
    Path(__file__).resolve().parent.parent
    / "web" / "app" / "api" / "backtest" / "validation" / "reports"
)
HOLDOUTS_PATH = VALIDATION_DIR / "holdouts.json"
LEDGER_PATH = VALIDATION_DIR / "trials.json"


def sharpe(row: np.ndarray) -> float:
    """Sharpe of one per-session return row (ddof=1, degenerate -> 0)."""
    if row.size < 2 or float(np.ptp(row)) == 0.0:
        return 0.0
    std = float(row.std(ddof=1))
    if std == 0.0 or not np.isfinite(std):
        return 0.0
    return float(row.mean() / std)


def load_matrix(payload: dict) -> tuple[np.ndarray, list[str], list[str]]:
    """(n_configs x n_sessions) return-on-risk matrix, config ids, session dates."""
    dates = payload["sessions"]
    ids, rows = [], []
    for cfg in payload["configs"]:
        ids.append(cfg["id"])
        row = []
        for d in dates:
            s = cfg["perSession"][d]
            # return-on-risk per session; 0 when the config never traded it
            row.append(s["netUsd"] / s["riskUsd"] if s["riskUsd"] > 0 else 0.0)
        rows.append(row)
    return np.asarray(rows, dtype=float), ids, dates


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sweep", help="path to an exportSweep.ts JSON")
    ap.add_argument("--pick", help="config id to audit (default: best pre-holdout Sharpe)")
    ap.add_argument("--n-splits", type=int, default=16, help="CSCV blocks (even, >=2)")
    ap.add_argument("--sessions-per-year", type=int, default=SESSIONS_PER_YEAR)
    ap.add_argument("--holdout-last", type=int, default=0, help="single-use frozen holdout: last N sessions")
    args = ap.parse_args()

    sweep_path = Path(args.sweep)
    payload = json.loads(sweep_path.read_text())
    family = payload["family"]
    matrix, ids, dates = load_matrix(payload)
    n_cfg, n_obs = matrix.shape
    print(f"family {family} · {n_cfg} configs × {n_obs} sessions · cost {payload['costPts']}pt · {sweep_path.name}")

    # ---- frozen single-use holdout: pin {N, pick} on first declaration ----
    holdouts = json.loads(HOLDOUTS_PATH.read_text()) if HOLDOUTS_PATH.exists() else {}
    holdout_rec: dict | None = None
    holdout_N = 0
    if args.holdout_last > 0:
        if family in holdouts:
            pinned = holdouts[family]
            holdout_N = int(pinned["sessions"])
            if args.holdout_last != holdout_N:
                print(f"WARNING: --holdout-last {args.holdout_last} ignored — {family} is pinned at {holdout_N} sessions (single-use window; see data/holdouts.json)")
            if args.pick and args.pick != pinned["pickId"]:
                print(f"WARNING: --pick {args.pick} ignored for holdout — {family} is pinned to {pinned['pickId']}")
        else:
            holdout_N = args.holdout_last
    if holdout_N >= n_obs - 10:
        print(f"holdout of {holdout_N} sessions leaves {n_obs - holdout_N} for validation — too few; abort")
        return 2

    train_dates = dates[:-holdout_N] if holdout_N else dates
    holdout_dates = dates[-holdout_N:] if holdout_N else []
    train_matrix = matrix[:, : len(train_dates)]

    trial_sharpes = np.array([sharpe(train_matrix[j]) for j in range(n_cfg)])

    pick_id = args.pick or ids[int(np.argmax(trial_sharpes))]
    if family in holdouts and holdout_N:
        pick_id = holdouts[family]["pickId"]  # pinned pick wins over CLI
    if pick_id not in ids:
        print(f"unknown --pick {pick_id} (valid: {ids[0]} .. {ids[-1]})")
        return 2
    pick_idx = ids.index(pick_id)
    pick_row = train_matrix[pick_idx]

    n_eff = effective_n_trials(trial_sharpes, "autocorr")
    var_sharpe = float(np.var(trial_sharpes, ddof=1))
    diag = deflated_sharpe_ratio_full(pick_row, n_trials=int(n_eff), var_sharpe=var_sharpe)
    psr = probabilistic_sharpe_ratio(pick_row, benchmark_skill=0.0)
    skew = float(diag.skew)
    kurt = float(diag.kurt)
    mtrl = min_track_record_length(diag.observed_sr, 0.0, 0.05, skew, kurt)
    minbtl = minimum_backtest_length(int(n_eff), target_sharpe=1.0)
    pbo = probability_of_backtest_overfitting(train_matrix, n_splits=args.n_splits)

    # ---- frozen holdout result (selection never touches these sessions) ----
    cfg = payload["configs"][pick_idx]
    if holdout_N:
        h_n = h_wins = h_net_usd = h_net_pts = h_risk_usd = 0
        for d in holdout_dates:
            s = cfg["perSession"][d]
            h_n += s["trades"]
            h_wins += s["wins"]
            h_net_usd += s["netUsd"]
            h_net_pts += s["netPts"]
            h_risk_usd += s["riskUsd"]
        h_row = matrix[pick_idx, len(train_dates):]
        holdout_rec = {
            "sessions": holdout_N,
            "from": holdout_dates[0],
            "to": holdout_dates[-1],
            "pickId": pick_id,
            "n": h_n,
            "wins": h_wins,
            "wr": h_wins / h_n if h_n else None,
            "netUsd": h_net_usd,
            "netPts": h_net_pts,
            "riskUsd": h_risk_usd,
            "sharpe": sharpe(h_row),
        }
        if family in holdouts:
            # window is single-use: never overwrite the pinned result's spirit —
            # recompute for display, but the PIN (window + pick) is immutable
            pinned = holdouts[family]
            pinned["lastReport"] = sweep_path.name
            print(f"holdout pinned (existing): {family} · {holdout_N} sessions {holdout_dates[0]}→{holdout_dates[-1]} · pick {pick_id}")
        else:
            holdouts[family] = {
                "frozenAt": payload.get("generatedAt", ""),
                "sessions": holdout_N,
                "from": holdout_dates[0],
                "to": holdout_dates[-1],
                "pickId": pick_id,
                "note": "single-use: the first declaration pins the window and pick; re-running must reuse them",
            }
            print(f"holdout frozen: {family} · {holdout_N} sessions {holdout_dates[0]}→{holdout_dates[-1]} · pick {pick_id}")
        HOLDOUTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        HOLDOUTS_PATH.write_text(json.dumps(holdouts, indent=1))

    # ---- pick detail: totals, per-year, concentration ----
    cfg = payload["configs"][pick_idx]
    tot = cfg["totals"]
    by_year: dict[str, dict] = {}
    per_day = []
    for d in dates:
        s = cfg["perSession"][d]
        y = d[:4]
        yb = by_year.setdefault(y, {"netUsd": 0.0, "netPts": 0.0, "trades": 0, "wins": 0, "sessions": 0})
        yb["netUsd"] += s["netUsd"]
        yb["netPts"] += s["netPts"]
        yb["trades"] += s["trades"]
        yb["wins"] += s["wins"]
        yb["sessions"] += 1 if s["trades"] else 0
        per_day.append((d, s["netUsd"]))

    pos_days = sorted([v for _, v in per_day if v > 0], reverse=True)
    total_net = tot["netUsd"]
    top10_share = sum(pos_days[:10]) / total_net if total_net > 0 else float("nan")
    half_share, acc = None, 0.0
    for i, v in enumerate(pos_days, 1):
        acc += v
        if acc >= total_net * 0.5:
            half_share = i
            break

    # ---- pre-holdout totals for the pick (the numbers statistics used) ----
    tr_n = tr_wins = 0
    tr_net_usd = tr_net_pts = tr_risk_usd = tr_risk_pts = 0.0
    for d in train_dates:
        s = cfg["perSession"][d]
        tr_n += s["trades"]
        tr_wins += s["wins"]
        tr_net_usd += s["netUsd"]
        tr_net_pts += s["netPts"]
        tr_risk_usd += s["riskUsd"]
        tr_risk_pts += s["riskPts"]
    train_totals = {
        "n": tr_n, "wins": tr_wins,
        "wr": tr_wins / tr_n if tr_n else 0.0,
        "netPts": tr_net_pts, "netUsd": tr_net_usd,
        "riskPts": tr_risk_pts, "riskUsd": tr_risk_usd,
    }

    n_train_obs = len(train_dates)

    # ---- verdict flags ----
    # slope interpretation: when PBO is low the IS-best config is the SAME
    # config across combos, and its IS/OOS Sharpes are complementary halves
    # of a fixed total -> negative slope is mechanical, not diagnostic.
    flags: list[str] = []
    if diag.dsr >= 0.95:
        flags.append("DSR strong (>=0.95)")
    elif diag.dsr >= 0.80:
        flags.append("DSR moderate (0.80-0.95)")
    else:
        flags.append(f"DSR weak ({diag.dsr:.2f} < 0.80)")
    if pbo.pbo <= 0.20:
        flags.append(f"selection stable (PBO {pbo.pbo:.3f})")
    else:
        flags.append(f"PBO high ({pbo.pbo:.2f} > 0.20)")
        flags.append("IS->OOS slope positive" if pbo.slope > 0 else "IS->OOS slope <= 0 (selection unstable)")
    flags.append("track record sufficient" if mtrl <= n_train_obs else f"track record short: need {mtrl:.0f} sessions, have {n_train_obs}")
    if holdout_rec is not None:
        if holdout_rec["netUsd"] > 0:
            flags.append(f"holdout PASS (${holdout_rec['netUsd']:.0f}, WR {holdout_rec['wr']*100:.0f}%)")
        else:
            flags.append(f"holdout FAIL (${holdout_rec['netUsd']:.0f}, WR {holdout_rec['wr']*100:.0f}%)")

    report = {
        "family": payload["family"],
        "sweep": sweep_path.name,
        "costPts": payload["costPts"],
        "nConfigs": n_cfg,
        "nSessions": n_train_obs,
        "nSessionsFull": n_obs,
        "nEffectiveTrials": int(n_eff),
        "pick": {
            "id": pick_id,
            "params": cfg["params"],
            "totals": train_totals,
            "totalsFull": tot,
            "perYear": {
                y: {**b, "wr": b["wins"] / b["trades"] if b["trades"] else None}
                for y, b in sorted(by_year.items())
            },
            "concentration": {
                "top10SessionShare": top10_share,
                "sessionsForHalfNet": half_share,
                "nPositiveSessions": len(pos_days),
            },
        },
        "holdout": holdout_rec,
        "statistics": {
            "observedSharpe": diag.observed_sr,
            "trialSharpeMean": float(trial_sharpes.mean()),
            "trialSharpeMax": float(trial_sharpes.max()),
            "varSharpe": var_sharpe,
            "nTrialsRaw": n_cfg,
            "nTrialsEffective": int(n_eff),
            "deflatedBenchmark": diag.sr_star,
            "dsr": diag.dsr,
            "psr": psr,
            "minTrackRecordSessions": mtrl,
            "minBacktestYears": minbtl,
            "skew": skew,
            "kurtosis": kurt,
            "pbo": {
                "pbo": pbo.pbo,
                "slope": pbo.slope,
                "nCombos": pbo.n_combos,
                "nSplits": args.n_splits,
            },
        },
        "verdict": flags,
    }

    # ---- UI digest: modal-x Sharpe heatmap, top-20 rows, pick series ----
    xs = [cfg["params"]["x"] for cfg in payload["configs"]]
    modal_x = max(set(xs), key=xs.count)
    stops = sorted({cfg["params"]["s"] for cfg in payload["configs"]})
    targets = sorted({cfg["params"]["t"] for cfg in payload["configs"]})
    hm = np.full((len(stops), len(targets)), np.nan)
    for cfg in payload["configs"]:
        if cfg["params"]["x"] != modal_x:
            continue
        i = stops.index(cfg["params"]["s"])
        j = targets.index(cfg["params"]["t"])
        hm[i, j] = sharpe(train_matrix[ids.index(cfg["id"])])
    ranked = sorted(
        range(n_cfg), key=lambda j: float(trial_sharpes[j]), reverse=True
    )[:20]
    report["digest"] = {
        "heatmap": {
            "x": modal_x,
            "stops": stops,
            "targets": targets,
            "values": [[None if np.isnan(v) else round(float(v), 3) for v in row] for row in hm],
        },
        "topConfigs": [
            {
                "id": ids[j],
                "params": payload["configs"][j]["params"],
                "sharpe": round(float(trial_sharpes[j]), 3),
                **payload["configs"][j]["totals"],
            }
            for j in ranked
        ],
        "pickSeries": [
            {"date": d, "netUsd": round(cfg["perSession"][d]["netUsd"], 2), "riskUsd": round(cfg["perSession"][d]["riskUsd"], 2)}
            for d in dates
        ],
    }

    VALIDATION_DIR.mkdir(parents=True, exist_ok=True)
    out_path = VALIDATION_DIR / (sweep_path.stem + ".validation.json")
    out_path.write_text(json.dumps(report, indent=1))

    # ---- stamp the verdict onto the trial ledger entry for this sweep ----
    ledger_path = LEDGER_PATH
    if ledger_path.exists():
        try:
            ledger = json.loads(ledger_path.read_text())
            for entry in ledger.get("entries", []):
                if entry.get("file") == sweep_path.name:
                    entry["validation"] = {
                        "pick": pick_id,
                        "dsr": round(diag.dsr, 4),
                        "pbo": round(pbo.pbo, 4),
                        "slope": round(pbo.slope, 4),
                        "observedSharpe": round(diag.observed_sr, 4),
                        "nEffectiveTrials": int(n_eff),
                        "verdict": flags,
                        **({"holdout": holdout_rec} if holdout_rec else {}),
                    }
            ledger_path.write_text(json.dumps(ledger, indent=1))
        except Exception as exc:  # ledger is bookkeeping, never fatal
            print(f"ledger stamp failed: {exc}")

    # ---- console ----
    print(f"\nPICK {pick_id}  params={cfg['params']}")
    print(f"  pre-holdout trades {train_totals['n']} · WR {train_totals['wr']*100:.1f}% · net {train_totals['netUsd']:.0f}$ (1-lot) · full-history net {tot['netUsd']:.0f}$")
    print(f"\nSharpe landscape over {n_cfg} configs (per-session return-on-risk, pre-holdout):")
    print(f"  mean {trial_sharpes.mean():.3f} · max {trial_sharpes.max():.3f} (pick {diag.observed_sr:.3f}) · var {var_sharpe:.4f}")
    print(f"  effective independent trials: {n_eff} / {n_cfg} tried")
    print(f"\nDSR: {diag.dsr:.3f}   (deflated benchmark {diag.sr_star:.3f} vs observed {diag.observed_sr:.3f})")
    print(f"PSR: {psr:.3f}   MinTRL: {mtrl:.0f} sessions (have {n_train_obs})   MinBTL: {minbtl:.2f} years @SR1")
    print(f"PBO: {pbo.pbo:.3f} over {pbo.n_combos} CSCV combos · slope {pbo.slope:+.3f}")
    if holdout_rec is not None:
        h = holdout_rec
        hwr = h["wr"] * 100 if h["wr"] is not None else float("nan")
        print(f"\nFROZEN HOLDOUT ({h['sessions']} sessions {h['from']}→{h['to']}): {h['n']} trades · WR {hwr:.1f}% · net ${h['netUsd']:.0f} · Sharpe {h['sharpe']:.3f}")
    print(f"\nPer year (1-lot USD, full history — display only):")
    for y, b in sorted(by_year.items()):
        wr = b["wins"] / b["trades"] if b["trades"] else 0
        print(f"  {y}: net ${b['netUsd']:>9.0f} · {b['trades']:>5} trades · WR {wr*100:5.1f}% · {b['sessions']} sessions")
    print(f"\nConcentration: top-10 sessions = {top10_share*100:.1f}% of net · {half_share} sessions hold 50% of net")
    print(f"\nVERDICT: " + " · ".join(flags))
    print(f"report: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
