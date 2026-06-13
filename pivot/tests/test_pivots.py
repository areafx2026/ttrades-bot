import pandas as pd
from app.strategy.pivots import find_pivots


def _df(highs, lows):
    return pd.DataFrame({
        "time": pd.date_range("2024-01-01", periods=len(highs), freq="D"),
        "high": highs, "low": lows,
        "open": lows, "close": highs,
    })


def test_detects_single_peak():
    df = _df([1, 2, 3, 2, 1], [0, 1, 2, 1, 0])
    piv = find_pivots(df, left=2, right=2)
    highs = [p for p in piv if p.kind == "high"]
    assert len(highs) == 1 and highs[0].price == 3


def test_detects_trough():
    df = _df([3, 2, 1, 2, 3], [2, 1, 0, 1, 2])
    lows = [p for p in find_pivots(df, 2, 2) if p.kind == "low"]
    assert len(lows) == 1 and lows[0].price == 0
