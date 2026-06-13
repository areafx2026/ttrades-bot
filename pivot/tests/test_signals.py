from app.strategy.zones import Zone
from app.strategy.signals import build_signal


def _zone():
    # zone 1.1000–1.1020, mid 1.1010, width 0.0020
    return Zone(edge_low=1.1000, edge_high=1.1020, touches=4,
                tests_support=2, tests_resist=2, pivots=[])


def test_sell_when_rising_into_zone():
    z = _zone()
    decel = {"price": 1.1010, "decelerating": True, "direction": "rising", "dist_norm": 0.0}
    sig = build_signal("EURUSD", z, decel, rr=1.3)
    assert sig.side == "SELL"
    assert sig.entry == 1.1010
    assert sig.sl == round(1.1020 + 0.0020, 5)          # upper edge + one width
    risk = sig.sl - sig.entry
    assert abs(sig.tp - (sig.entry - risk * 1.3)) < 1e-9


def test_buy_when_falling_into_zone():
    z = _zone()
    decel = {"price": 1.1010, "decelerating": True, "direction": "falling", "dist_norm": 0.0}
    sig = build_signal("EURUSD", z, decel, rr=1.3)
    assert sig.side == "BUY"
    assert sig.sl == round(1.1000 - 0.0020, 5)          # lower edge - one width
    risk = sig.entry - sig.sl
    assert abs(sig.tp - (sig.entry + risk * 1.3)) < 1e-9


def test_no_signal_without_deceleration():
    z = _zone()
    decel = {"price": 1.1010, "decelerating": False, "direction": "rising", "dist_norm": 0.0}
    assert build_signal("EURUSD", z, decel) is None


def test_no_signal_when_price_outside_zone():
    z = _zone()
    decel = {"price": 1.1050, "decelerating": True, "direction": "rising", "dist_norm": 2.0}
    assert build_signal("EURUSD", z, decel) is None
