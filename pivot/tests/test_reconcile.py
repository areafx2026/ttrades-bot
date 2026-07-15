from unittest.mock import Mock

import pytest
from app.config import settings
from app.db.models import Trade, Side
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
