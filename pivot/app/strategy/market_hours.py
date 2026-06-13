"""Forex session gating. Crypto trades 24/7; forex is closed on weekends, so the
engine must not fire (and rack up rejected orders) when the market is shut."""
from datetime import datetime, timezone

CRYPTO = {"BTCUSD", "ETHUSD", "SOLUSD"}


def is_crypto(symbol: str) -> bool:
    return symbol in CRYPTO


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
