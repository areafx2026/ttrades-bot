from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.strategy.market_hours as mh
from app.config import settings
from app.db.models import Base, Trade, Side, SpreadSample
from app.engine.reconcile import Reconciler


def _t(side, fill, tp):
    return Trade(side=Side(side), fill_price=fill, entry=fill, tp=tp)


def test_live_pct_of_tp_buy_partial_progress():
    t = _t("BUY", 100.0, 110.0)
    assert Reconciler._live_pct_of_tp(t, 105.0) == pytest.approx(0.5)


def test_live_pct_of_tp_buy_negative_when_price_is_adverse():
    t = _t("BUY", 100.0, 110.0)
    assert Reconciler._live_pct_of_tp(t, 95.0) == pytest.approx(-0.5)


def test_live_pct_of_tp_sell_partial_progress():
    t = _t("SELL", 100.0, 90.0)
    assert Reconciler._live_pct_of_tp(t, 95.0) == pytest.approx(0.5)


def test_live_pct_ignores_the_historical_mfe_high_water_mark():
    # The trade spiked to 40% favourable at some point (mfe_pct_of_tp still
    # remembers that), but price has since drifted back near entry. The
    # time-stop must judge the CURRENT position, not the stale peak.
    t = _t("BUY", 100.0, 110.0)
    t.mfe_pct_of_tp = 0.4
    assert Reconciler._live_pct_of_tp(t, 100.5) == pytest.approx(0.05)


def _tradeable_t():
    t = _t("BUY", 100.0, 110.0)
    t.ticket = "1"
    t.mfe_pct_of_tp = 0.9   # well past the 60% default trigger
    t.sl = 90.0
    return t


def test_breakeven_trail_disabled_by_flag(monkeypatch):
    monkeypatch.setattr(settings, "breakeven_trail_enabled", False)
    broker = Mock()
    reconciler = Reconciler(broker, None)
    reconciler._maybe_trail_to_breakeven(_tradeable_t(), {"bid": 104.99, "ask": 105.01})
    broker.modify_position.assert_not_called()


def test_breakeven_trail_fires_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "breakeven_trail_enabled", True)
    broker = Mock()
    broker.modify_position.return_value = {"ok": True}
    reconciler = Reconciler(broker, None)
    reconciler._maybe_trail_to_breakeven(_tradeable_t(), {"bid": 104.99, "ask": 105.01})
    broker.modify_position.assert_called_once()


# ── stale-close spread guard (rollover/news protection) ──────────────────────
# Crypto symbol on purpose: market_elapsed_minutes counts raw minutes there,
# so the tests don't depend on what weekday they run on.

def _stale_t(minutes_open: int) -> Trade:
    t = _t("BUY", 100.0, 110.0)
    t.symbol = "BTCUSD"
    t.ticket = "1"
    t.sl = 90.0
    t.opened_at = datetime.utcnow() - timedelta(minutes=minutes_open)
    return t


def _stale_settings(monkeypatch):
    monkeypatch.setattr(settings, "max_hold_min", 330)
    monkeypatch.setattr(settings, "stale_mfe_pct", 0.4)
    monkeypatch.setattr(settings, "stale_spread_guard_mult", 3.0)
    monkeypatch.setattr(settings, "stale_close_max_defer_min", 120)


def test_stale_close_fires_at_normal_spread(monkeypatch):
    _stale_settings(monkeypatch)
    broker = Mock()
    broker.close.return_value = {"ok": True}
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: 0.02
    r._maybe_close_stale(_stale_t(400), 100.5, {"bid": 100.49, "ask": 100.51})
    broker.close.assert_called_once()


def test_stale_close_deferred_while_spread_is_blown_out(monkeypatch):
    _stale_settings(monkeypatch)
    broker = Mock()
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: 0.02   # live spread 0.5 = 25x baseline
    r._maybe_close_stale(_stale_t(400), 100.5, {"bid": 100.25, "ask": 100.75})
    broker.close.assert_not_called()


def test_defer_cap_closes_even_at_a_wide_spread(monkeypatch):
    # 500min open > max_hold(330) + max_defer(120): a permanently wide market
    # must not park a dead trade forever.
    _stale_settings(monkeypatch)
    broker = Mock()
    broker.close.return_value = {"ok": True}
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: 0.02
    r._maybe_close_stale(_stale_t(500), 100.5, {"bid": 100.25, "ask": 100.75})
    broker.close.assert_called_once()


def test_stale_close_proceeds_without_a_baseline(monkeypatch):
    # Fresh deploy, no spread history yet — the guard stands down rather than
    # defer on a guess.
    _stale_settings(monkeypatch)
    broker = Mock()
    broker.close.return_value = {"ok": True}
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: None
    r._maybe_close_stale(_stale_t(400), 100.5, {"bid": 100.25, "ask": 100.75})
    broker.close.assert_called_once()


def _freeze_now(monkeypatch, now: datetime) -> None:
    """in_rollover_blackout() defaults `now` to datetime.now(timezone.utc) when
    the caller (reconcile.py) doesn't pass one -- freeze both that AND
    time.time() (used for the tick-time offset calc) so the test controls
    what the function sees as "now" end to end."""
    monkeypatch.setattr(mh._time, "time", lambda: now.timestamp())

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now if tz else now.replace(tzinfo=None)
    monkeypatch.setattr(mh, "datetime", _FixedDatetime)


def test_stale_close_deferred_during_rollover_blackout(monkeypatch):
    # No spread baseline at all (None) -- the clock-based blackout is the
    # ONLY thing deferring here, proving it doesn't depend on spread_samples.
    _stale_settings(monkeypatch)
    now = datetime(2026, 7, 16, 21, 30, tzinfo=timezone.utc)   # broker (+3h) = 00:30
    _freeze_now(monkeypatch, now)
    blackout_tick_time = now.timestamp() + 3 * 3600
    t = _stale_t(400)
    t.opened_at = now.replace(tzinfo=None) - timedelta(minutes=400)  # relative to frozen "now"
    broker = Mock()
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: None
    r._maybe_close_stale(t, 100.5, {"bid": 100.49, "ask": 100.51, "time": blackout_tick_time})
    broker.close.assert_not_called()


def test_stale_close_not_deferred_outside_blackout(monkeypatch):
    _stale_settings(monkeypatch)
    now = datetime(2026, 7, 16, 18, 0, tzinfo=timezone.utc)    # broker (+3h) = 21:00
    _freeze_now(monkeypatch, now)
    normal_tick_time = now.timestamp() + 3 * 3600
    t = _stale_t(400)
    t.opened_at = now.replace(tzinfo=None) - timedelta(minutes=400)  # relative to frozen "now"
    broker = Mock()
    broker.close.return_value = {"ok": True}
    r = Reconciler(broker, None)
    r._spread_baseline = lambda sym: None
    r._maybe_close_stale(t, 100.5, {"bid": 100.49, "ask": 100.51, "time": normal_tick_time})
    broker.close.assert_called_once()


def _mem_session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

    @contextmanager
    def factory():
        s = Session()
        try:
            yield s
        finally:
            s.close()
    return factory


def test_spread_baseline_is_the_median_of_recent_samples():
    db = _mem_session_factory()
    with db() as s:
        for spread in [0.01] * 6 + [0.02] * 6 + [5.0]:   # one rollover outlier
            s.add(SpreadSample(symbol="BTCUSD", bid=100.0, ask=100.0 + spread,
                               spread=spread, ts=datetime.utcnow()))
        s.commit()
    r = Reconciler(Mock(), db)
    assert r._spread_baseline("BTCUSD") == pytest.approx(0.02)


def test_spread_baseline_none_below_minimum_samples():
    db = _mem_session_factory()
    with db() as s:
        for _ in range(3):
            s.add(SpreadSample(symbol="BTCUSD", bid=100.0, ask=100.02,
                               spread=0.02, ts=datetime.utcnow()))
        s.commit()
    r = Reconciler(Mock(), db)
    assert r._spread_baseline("BTCUSD") is None
