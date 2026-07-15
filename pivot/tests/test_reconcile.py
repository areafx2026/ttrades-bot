import pytest
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
