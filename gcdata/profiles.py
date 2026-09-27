"""Volume-profile engine: P0-P5 + LVN extraction from collected footprint data.

Numbering = RECENCY: P0 is the most recent profile, P5 the oldest.


Profiles (see NQ_ALERT_SYSTEM_DESIGN.md section 3):
  P0 developing RTH (live, from 9:30) | P1 fixed opening range 9:30-10:00
  P2 full session ETH+RTH (18:00 ET -> now) | P3 overnight 18:00 ET -> 9:30 ET
  P4 prior-day RTH | P5 multi-day composite RTH (oldest)
"""
import collections
import datetime
import json
import math

TICK_CENTS = 25  # 0.25 pt


def load(path):
    with open(path) as f:
        return json.load(f)


def _in_window(c, start_hhmm=None, end_hhmm=None, before=None):
    t = c["t"]  # "2026-09-25T08:30:00-05:00"
    hhmm = t[11:16]
    if before and hhmm >= before:
        return False
    if start_hhmm and hhmm < start_hhmm:
        return False
    if end_hhmm and hhmm > end_hhmm:
        return False
    return True


def profile(candles, row_ticks=4):
    """Aggregate buy+sell volume per price row of row_ticks ticks. Keys = cents."""
    rows = collections.defaultdict(lambda: [0, 0, 0])  # total, buy, sell
    for c in candles:
        for lvl, (tv, bv, sv, _, _) in c["levels"].items():
            # half-UP rounding, to stay bit-identical with the TS engine
            # (Math.round). Python's round() is banker's rounding and pushes
            # prices that land exactly on .5 into a different bucket, which
            # silently changes POC / VAH / VAL / LVN zones for some profiles.
            bucket = math.floor(int(lvl) / (TICK_CENTS * row_ticks) + 0.5) * TICK_CENTS * row_ticks
            rows[bucket][0] += tv
            rows[bucket][1] += bv
            rows[bucket][2] += sv
    return rows


def stats(rows, value_area=0.70, lvn_ratio=0.35):
    buckets = sorted(rows)
    tot = sum(rows[b][0] for b in buckets)
    if not buckets:
        return None
    poc = max(buckets, key=lambda b: rows[b][0])
    order = sorted(buckets, key=lambda b: -rows[b][0])
    va, acc = set(), 0
    for b in order:
        va.add(b)
        acc += rows[b][0]
        if acc >= value_area * tot:
            break
    med = sorted(rows[b][0] for b in buckets)[len(buckets) // 2]
    lvns = [b for b in buckets if rows[b][0] <= max(1, int(lvn_ratio * med))]
    zones = []
    for b in sorted(lvns):
        if zones and b <= zones[-1][1] + TICK_CENTS * 4:
            zones[-1][1] = b
        else:
            zones.append([b, b])
    # a "zone" narrower than the row merge tolerance is a low-volume bucket,
    # not a low-volume node: keep only zones >= 1 pt (same rule as gcdata.ts)
    zones = [z for z in zones if z[1] - z[0] >= TICK_CENTS * 4]
    return {
        "total": tot,
        "poc": poc,
        "poc_volume": rows[poc][0],
        "vah": max(va),
        "val": min(va),
        "lvn_zones": zones,
        "n_rows": len(buckets),
    }


def price_str(cents):
    return f"{cents / 100:,.2f}"


def build_level_sheet(data_dir, today, composite_days=5, symbol_sessions=None):
    """Compute P0-P5 + naked POCs for `today` and return a level sheet dict."""
    D = {}
    for f in os_list(data_dir):
        if f.endswith(".json"):
            D[f[:-5]] = load(f"{data_dir}/{f}")

    def rth(d):
        return D.get(f"{d}_RTH", {}).get("candles", [])

    def eth(d):
        return D.get(f"{d}_ETH", {}).get("candles", [])

    t = datetime.date.fromisoformat(today)
    prev_trading = None
    i = 1
    while prev_trading is None and i < 8:
        d = (t - datetime.timedelta(days=i)).isoformat()
        if f"{d}_RTH" in D:
            prev_trading = d
        i += 1

    or_c = [c for c in rth(today) if _in_window(c, "08:30", "08:59")]
    on_c = [c for c in eth(today) if _in_window(c, before="08:30")]
    comp = []
    days_used = []
    i = 0
    while len(days_used) < composite_days and i < 10:
        d = (t - datetime.timedelta(days=i)).isoformat()
        if f"{d}_RTH" in D:
            comp += rth(d)
            days_used.append(d)
        i += 1

    def sheet(rows, name, row_ticks=4):
        s = stats(rows)
        if not s:
            return {name: None}
        return {
            name: {
                "total": s["total"],
                "POC": price_str(s["poc"]),
                "VAH": price_str(s["vah"]),
                "VAL": price_str(s["val"]),
                # en dash, matching the TS sheet exactly (a consumer that splits on the
                # separator must not have to know which engine produced the sheet)
                "LVNs": [f"{price_str(a)}–{price_str(b)}" for a, b in [z for z in s["lvn_zones"] if z[1] - z[0] >= TICK_CENTS * 4][:10]],
                "rows": s["n_rows"],
                "row_size_ticks": row_ticks,
            }
        }

    out = {"asof": today, "prev_trading_day": prev_trading}
    out.update(sheet(profile(rth(today)), "P0_developing_rth"))
    out.update(sheet(profile(or_c), "P1_opening_range"))
    out.update(sheet(profile(eth(today)), "P2_full_session"))
    out.update(sheet(profile(on_c), "P3_overnight"))
    if prev_trading:
        out.update(sheet(profile(rth(prev_trading)), "P4_prev_day_rth"))
    out.update(sheet(profile(comp), f"P5_{composite_days}day_composite", row_ticks=4))

    # naked POCs: prior-day POC levels not revisited today (within 1pt rows)
    if prev_trading:
        pd_rows = profile(rth(prev_trading), row_ticks=4)
        pd_poc = stats(pd_rows)["poc"]
        today_rows = profile(rth(today), row_ticks=4)
        todays = {b for b in today_rows if today_rows[b][0] > 0}
        naked = []
        step = TICK_CENTS * 4
        for lvl in range(pd_poc - 3 * step, pd_poc + 4 * step, step):
            if lvl not in todays:
                naked.append(price_str(lvl))
        out["naked_POC_zone"] = f"{price_str(pd_poc)} (unrevisited: {', '.join(naked)})" if naked else price_str(pd_poc)
    return out


def os_list(path):
    import os

    return os.listdir(path)
