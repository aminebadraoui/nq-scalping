"""NQ quarterly contract calendar: the single source of truth for which
contract symbol was the front month on any date.

NQ futures expire on the 3rd Friday of H/M/U/Z (AM-settled). A contract is
the front month from the day after the previous expiry through its own
expiry day — the same convention the old hardcoded backfill_contracts.sh
table used (NQH24 2023-12-18 .. 2024-03-15). Volume rolls a few days
earlier, but expiry tenure is the front-month truth and matches how the
vendor retains per-contract data.
"""

import datetime as dt

MONTH_LETTERS = "HMUZ"


def third_friday(year: int, month: int) -> dt.date:
    """Expiry of the quarterly contract expiring in `month` of `year`."""
    d = dt.date(year, month, 15)
    d += dt.timedelta(days=(4 - d.weekday()) % 7)
    return d


def symbol(year: int, month: int) -> str:
    """NQH24, NQM25, ... for the contract expiring in `month` of `year`."""
    return "NQ" + MONTH_LETTERS[(month // 3) - 1] + f"{year % 100:02d}"


def tenures(start: dt.date | str, end: dt.date | str | None = None) -> list[tuple[str, dt.date, dt.date]]:
    """Yield (symbol, from, to) front-month tenure rows covering [start, end].

    Rows are clamped to the requested range and ordered oldest first, so a
    backfill that walks them in order never lets a newer (less liquid at that
    date) contract overwrite the true front month.
    """
    start = dt.date.fromisoformat(start) if isinstance(start, str) else start
    end = dt.date.fromisoformat(end) if isinstance(end, str) else end
    if end is None:
        end = dt.date.today() + dt.timedelta(days=100)  # complete the current tenure

    # quarter containing `start` (H/M/U/Z months map to 3/6/9/12)
    q = ((start.month - 1) // 3) * 3 + 3
    y = start.year
    out: list[tuple[str, dt.date, dt.date]] = []
    prev_exp: dt.date | None = None
    while True:
        exp = third_friday(y, q)
        fr = prev_exp + dt.timedelta(days=1) if prev_exp else start
        while fr.weekday() >= 5:  # tenure starts on the next trading day
            fr += dt.timedelta(days=1)
        fr = max(fr, start)
        to = min(exp, end)
        if fr <= to:
            out.append((symbol(y, q), fr, to))
        prev_exp = exp
        if (y, q) >= (end.year, end.month):
            break
        q += 3
        if q > 12:
            q -= 12
            y += 1
    return out


def contract_for(date: dt.date | str) -> str:
    """Front-month symbol for a single date."""
    date = dt.date.fromisoformat(date) if isinstance(date, str) else date
    for sym, fr, to in tenures(date, date):
        return sym
    raise ValueError(f"no contract tenure for {date}")
