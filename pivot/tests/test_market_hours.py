from datetime import datetime, timezone
from app.strategy.market_hours import market_elapsed_minutes

UTC = timezone.utc


def test_no_weekend_span_counts_raw_time():
    opened = datetime(2026, 7, 6, 10, 0, tzinfo=UTC)   # Monday
    now = datetime(2026, 7, 6, 14, 0, tzinfo=UTC)
    assert market_elapsed_minutes("EURUSD", opened, now) == 240


def test_weekend_is_excluded_for_forex():
    opened = datetime(2026, 7, 10, 18, 0, tzinfo=UTC)  # Friday 18:00
    now = datetime(2026, 7, 13, 10, 0, tzinfo=UTC)     # Monday 10:00
    # raw = 64h; weekend closure (Fri 21:00 -> Sun 21:00) = 48h -> 16h market time
    assert market_elapsed_minutes("EURUSD", opened, now) == 16 * 60


def test_weekend_counts_fully_for_crypto():
    opened = datetime(2026, 7, 10, 18, 0, tzinfo=UTC)
    now = datetime(2026, 7, 13, 10, 0, tzinfo=UTC)
    raw = (now - opened).total_seconds() / 60
    assert market_elapsed_minutes("BTCUSD", opened, now) == raw


def test_entirely_within_weekend_closure_is_near_zero_for_forex():
    opened = datetime(2026, 7, 11, 8, 0, tzinfo=UTC)   # Saturday
    now = datetime(2026, 7, 12, 8, 0, tzinfo=UTC)      # Sunday, still closed
    assert market_elapsed_minutes("EURUSD", opened, now) == 0


def test_two_weekends_both_excluded():
    opened = datetime(2026, 7, 10, 18, 0, tzinfo=UTC)  # Friday
    now = datetime(2026, 7, 20, 18, 0, tzinfo=UTC)     # Monday-after-next, same time
    raw = (now - opened).total_seconds() / 60
    assert market_elapsed_minutes("EURUSD", opened, now) == raw - 2 * 48 * 60


def test_naive_datetimes_are_treated_as_utc():
    opened = datetime(2026, 7, 6, 10, 0)   # naive, Monday
    now = datetime(2026, 7, 6, 14, 0)      # naive
    assert market_elapsed_minutes("EURUSD", opened, now) == 240
