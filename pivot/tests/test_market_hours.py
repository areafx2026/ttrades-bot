from datetime import datetime, timezone

import app.strategy.market_hours as mh
from app.strategy.market_hours import in_hour_blackout, in_rollover_blackout, market_elapsed_minutes

UTC = timezone.utc


def _tick_time(now: datetime, offset_h: int, monkeypatch) -> float:
    """Fake a broker tick's raw epoch: `offset_h` hours ahead/behind real UTC
    `now`, with `_time.time()` pinned to `now` so in_rollover_blackout's
    internal offset math is deterministic."""
    monkeypatch.setattr(mh._time, "time", lambda: now.timestamp())
    return now.timestamp() + offset_h * 3600


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


def test_rollover_blackout_inside_window(monkeypatch):
    now = datetime(2026, 7, 16, 20, 30, tzinfo=UTC)   # broker (+3h) = 23:30
    tt = _tick_time(now, 3, monkeypatch)
    assert in_rollover_blackout(tt, now) is True


def test_rollover_blackout_outside_window(monkeypatch):
    now = datetime(2026, 7, 16, 18, 0, tzinfo=UTC)    # broker (+3h) = 21:00
    tt = _tick_time(now, 3, monkeypatch)
    assert in_rollover_blackout(tt, now) is False


def test_rollover_blackout_wraps_past_midnight(monkeypatch):
    now = datetime(2026, 7, 16, 21, 30, tzinfo=UTC)   # broker (+3h) = 00:30
    tt = _tick_time(now, 3, monkeypatch)
    assert in_rollover_blackout(tt, now) is True


def test_rollover_blackout_ends_at_boundary(monkeypatch):
    now = datetime(2026, 7, 16, 22, 5, tzinfo=UTC)    # broker (+3h) = 01:05
    tt = _tick_time(now, 3, monkeypatch)
    assert in_rollover_blackout(tt, now) is False


def test_rollover_blackout_fails_open_on_implausible_offset(monkeypatch):
    now = datetime(2026, 7, 16, 21, 30, tzinfo=UTC)   # would be "inside" at +3h
    monkeypatch.setattr(mh._time, "time", lambda: now.timestamp())
    assert in_rollover_blackout(0.0, now) is False   # dummy epoch -> offset absurd -> fail open


def test_hour_blackout_matches_listed_hour(monkeypatch):
    now = datetime(2026, 7, 22, 13, 0, tzinfo=UTC)    # broker (+3h) = 16:00
    tt = _tick_time(now, 3, monkeypatch)
    assert in_hour_blackout(tt, [16], now) is True


def test_hour_blackout_does_not_match_other_hours(monkeypatch):
    now = datetime(2026, 7, 22, 14, 0, tzinfo=UTC)    # broker (+3h) = 17:00
    tt = _tick_time(now, 3, monkeypatch)
    assert in_hour_blackout(tt, [16], now) is False


def test_hour_blackout_empty_list_blocks_nothing(monkeypatch):
    now = datetime(2026, 7, 22, 13, 0, tzinfo=UTC)    # broker (+3h) = 16:00
    tt = _tick_time(now, 3, monkeypatch)
    assert in_hour_blackout(tt, [], now) is False


def test_hour_blackout_fails_open_on_implausible_offset(monkeypatch):
    now = datetime(2026, 7, 22, 13, 0, tzinfo=UTC)
    monkeypatch.setattr(mh._time, "time", lambda: now.timestamp())
    assert in_hour_blackout(0.0, [16], now) is False
