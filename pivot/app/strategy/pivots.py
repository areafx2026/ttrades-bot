"""Fractal pivot detection (step 1 of zone identification)."""
from dataclasses import dataclass, asdict
import pandas as pd


@dataclass
class Pivot:
    index: int
    price: float
    kind: str            # 'high' | 'low'
    time: pd.Timestamp

    def dict(self) -> dict:
        d = asdict(self)
        d["time"] = self.time.isoformat() if hasattr(self.time, "isoformat") else str(self.time)
        return d


def find_pivots(df: pd.DataFrame, left: int = 3, right: int = 3) -> list[Pivot]:
    """A pivot high/low is the strict extreme over the window [i-left, i+right]."""
    highs, lows = df["high"].values, df["low"].values
    out: list[Pivot] = []
    for i in range(left, len(df) - right):
        win_h = highs[i - left:i + right + 1]
        if highs[i] == win_h.max() and (win_h == highs[i]).sum() == 1:
            out.append(Pivot(i, float(highs[i]), "high", df["time"].iloc[i]))
        win_l = lows[i - left:i + right + 1]
        if lows[i] == win_l.min() and (win_l == lows[i]).sum() == 1:
            out.append(Pivot(i, float(lows[i]), "low", df["time"].iloc[i]))
    return out
