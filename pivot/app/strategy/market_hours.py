"""Forex session gating. Crypto trades 24/7; forex is closed on weekends, so the
engine must not fire (and rack up rejected orders) when the market is shut."""
from datetime import datetime, timedelta, timezone

CRYPTO = {"BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD"}


def is_crypto(symbol: str) -> bool:
    return symbol in CRYPTO


def pip_size(symbol: str) -> float:
    """One pip in price terms. Crypto uses $1 (matches the v2 convention);
    JPY pairs use 0.01; all other forex 0.0001."""
    if is_crypto(symbol):
        return 1.0
    return 0.01 if "JPY" in symbol else 0.0001


def is_forex_open(now: datetime | None = None) -> bool:
    """Approximate FX session: open Sun 21:00 UTC → Fri 21:00 UTC.
    Ignores bank holidays (MT5 will still reject those — handled by cooldown)."""
    now = now or datetime.now(timezone.utc)
    wd = now.weekday()          # Mon=0 … Sun=6
    h = now.hour
    if wd == 5:                 # Saturday
        return False
    if wd == 4 and h >= 21:     # Friday after close
        return False
    if wd == 6 and h < 21:      # Sunday before open
        return False
    return True


def market_open(symbol: str, now: datetime | None = None) -> bool:
    return True if is_crypto(symbol) else is_forex_open(now)


def _weekend_closure_minutes(start: datetime, end: datetime) -> float:
    """Sum of FX-closed time (Fri 21:00 UTC -> Sun 21:00 UTC) within [start, end]."""
    total = 0.0
    cur = start
    while cur < end:
        this_friday = (cur - timedelta(days=cur.weekday())) + timedelta(days=4)
        fri_close = this_friday.replace(hour=21, minute=0, second=0, microsecond=0)
        sun_open = fri_close + timedelta(days=2)
        if cur >= sun_open:              # already past this week's window -> next week's
            fri_close += timedelta(days=7)
            sun_open += timedelta(days=7)
        seg_start, seg_end = max(fri_close, cur), min(sun_open, end)
        if seg_start < seg_end:
            total += (seg_end - seg_start).total_seconds() / 60
        if sun_open <= cur:               # safety net, should not happen
            break
        cur = sun_open
    return total


def market_elapsed_minutes(symbol: str, opened_at: datetime, now: datetime | None = None) -> float:
    """Minutes of actual market time between opened_at and now — for forex,
    weekend closure doesn't count (price can't move, so the trade's thesis
    gets no chance to develop). Crypto trades 24/7, so this is just the raw
    elapsed time. Used for the time-stop: a stale-idea close should be judged
    against market activity, not calendar time a Friday-opened trade merely
    sat through a closed weekend for."""
    now = now or datetime.now(timezone.utc)
    if opened_at.tzinfo is None:
        opened_at = opened_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    raw = (now - opened_at).total_seconds() / 60
    if is_crypto(symbol):
        return raw
    return raw - _weekend_closure_minutes(opened_at, now)
