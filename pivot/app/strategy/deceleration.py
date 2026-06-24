"""H4 approach-speed analysis. As price nears a zone you watch whether the
candles get shorter (momentum fading) — that's the cue to prepare an entry."""
import pandas as pd
from .zones import Zone


def approach(df_h4: pd.DataFrame, zone: Zone, lookback: int = 3) -> dict:
    """Return approach metrics for `zone` from the latest H4 candles."""
    last = df_h4.iloc[-1]
    price = float(last["close"])

    if zone.edge_low <= price <= zone.edge_high:
        dist = 0.0
    else:
        dist = min(abs(price - zone.edge_low), abs(price - zone.edge_high))
    norm = dist / zone.width if zone.width else 999.0

    ranges = (df_h4["high"] - df_h4["low"]).tail(lookback).values
    decel = len(ranges) == lookback and all(
        ranges[i] > ranges[i + 1] for i in range(len(ranges) - 1)
    )

    ref_idx = -(lookback + 1)
    prior_close = float(df_h4["close"].iloc[ref_idx]) if len(df_h4) > lookback else float(df_h4["close"].iloc[0])
    direction = "rising" if price > prior_close else "falling"

    return {
        "price": price,
        "dist_norm": round(norm, 2),
        "decelerating": bool(decel),
        "direction": direction,
        "ranges": [float(x) for x in ranges],
    }
