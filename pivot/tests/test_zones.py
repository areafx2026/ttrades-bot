from app.strategy.pivots import Pivot
from app.strategy.zones import build_zones
import pandas as pd

T = pd.Timestamp("2024-01-01")


def _p(price, kind):
    return Pivot(0, price, kind, T)


def test_valid_zone_needs_both_sides_and_four_touches():
    # 2 highs (resistance) + 2 lows (support) clustered tightly → valid
    pivots = [_p(1.1000, "high"), _p(1.1002, "low"),
              _p(1.1001, "high"), _p(1.0999, "low")]
    zones = build_zones(pivots, tolerance=0.0010, min_touches=4)
    assert len(zones) == 1
    z = zones[0]
    assert z.tests_support == 2 and z.tests_resist == 2 and z.touches == 4
    assert z.valid()


def test_rejected_when_only_one_side():
    # 4 highs only → never tested from above → invalid
    pivots = [_p(1.1000, "high"), _p(1.1001, "high"),
              _p(1.1002, "high"), _p(1.0999, "high")]
    zones = build_zones(pivots, tolerance=0.0010, min_touches=4)
    assert zones == []


def test_one_side_allowed_when_require_both_sides_false():
    # Same one-sided pivots as above, but with the rule relaxed (v4-style
    # config) — touches alone must be enough.
    pivots = [_p(1.1000, "high"), _p(1.1001, "high"),
              _p(1.1002, "high"), _p(1.0999, "high")]
    zones = build_zones(pivots, tolerance=0.0010, min_touches=4, require_both_sides=False)
    assert len(zones) == 1
    assert zones[0].tests_support == 0 and zones[0].tests_resist == 4


def test_rejected_when_too_few_touches():
    pivots = [_p(1.1000, "high"), _p(1.0999, "low")]
    assert build_zones(pivots, tolerance=0.0010, min_touches=4) == []


def test_separate_clusters_split():
    pivots = [_p(1.1000, "high"), _p(1.1000, "low"),
              _p(1.2000, "high"), _p(1.2000, "low")]
    # tolerance too small to merge the two price areas → no 4-touch zone
    assert build_zones(pivots, tolerance=0.0010, min_touches=4) == []


def test_chain_does_not_merge_into_one_blob():
    # A ladder of pivots each within `tolerance` of the previous must NOT chain
    # into a single range-spanning zone (the 468-pip-blob bug). Anchoring the
    # cluster to its lowest pivot caps each zone width at ~tolerance.
    prices = [1.1000, 1.1008, 1.1016, 1.1024, 1.1032, 1.1040, 1.1048, 1.1056]
    pivots = [_p(pr, "high" if i % 2 else "low") for i, pr in enumerate(prices)]
    zones = build_zones(pivots, tolerance=0.0010, min_touches=4)
    # No single zone may span the whole ladder
    assert all(z.width <= 0.0011 for z in zones)
    assert all(z.edge_high - z.edge_low < (prices[-1] - prices[0]) for z in zones)
