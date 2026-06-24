"""Build the order from a zone + approach state.

Rules encoded:
  - enter in the MIDDLE of the zone (best entry)
  - fade the move: price rising into zone → SELL, falling into zone → BUY
  - stop-loss one zone-width beyond the far edge
        SELL → edge_high + width   |   BUY → edge_low - width
  - take-profit at risk-reward `rr` (default 1.3)
Entry only arms when price is inside the zone and decelerating.
"""
from dataclasses import dataclass
from .zones import Zone


@dataclass
class Signal:
    symbol: str
    side: str            # 'BUY' | 'SELL'
    entry: float
    sl: float
    tp: float
    zone: Zone
    rr: float
    decel: dict


def build_signal(symbol: str, zone: Zone, decel: dict, rr: float = 1.3,
                 round_to: int = 5) -> Signal | None:
    if not decel["decelerating"]:
        return None
    if not (zone.edge_low <= decel["price"] <= zone.edge_high):
        return None

    entry = zone.mid
    if decel["direction"] == "rising":                 # rising into zone → SELL
        side = "SELL"
        sl = zone.edge_high + zone.width
        risk = sl - entry
        tp = entry - risk * rr
    else:                                              # falling into zone → BUY
        side = "BUY"
        sl = zone.edge_low - zone.width
        risk = entry - sl
        tp = entry + risk * rr

    if risk <= 0:
        return None
    return Signal(symbol, side, round(entry, round_to), round(sl, round_to),
                  round(tp, round_to), zone, rr, decel)
