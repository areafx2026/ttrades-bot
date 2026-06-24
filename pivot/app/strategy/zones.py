"""Cluster pivots into 'areas of interest' and apply the validity rule:
a valid zone is confirmed at least once from above (support test) AND at least
once from below (resistance test), with at least `min_touches` bounces in total."""
from dataclasses import dataclass, field
from .pivots import Pivot


@dataclass
class Zone:
    edge_low: float
    edge_high: float
    touches: int
    tests_support: int       # pivot LOWS  in band → bounced up   → tested "from above"
    tests_resist: int        # pivot HIGHS in band → bounced down → tested "from below"
    pivots: list[Pivot] = field(default_factory=list)

    @property
    def mid(self) -> float:
        return (self.edge_low + self.edge_high) / 2

    @property
    def width(self) -> float:
        return self.edge_high - self.edge_low

    def valid(self, min_touches: int = 4) -> bool:
        return (self.tests_support >= 1 and self.tests_resist >= 1
                and self.touches >= min_touches)

    @property
    def last_touch_time(self):
        return max((p.time for p in self.pivots), default=None)


def build_zones(pivots: list[Pivot], tolerance: float, min_touches: int = 4) -> list[Zone]:
    """Greedy 1-D agglomerative clustering by price.

    `tolerance` is the max gap between consecutive pivot prices to keep them in the
    same cluster — pass ATR(D1) * k so the band scales per instrument. Only zones
    that pass `valid()` are returned (i.e. the function emits areas-of-interest)."""
    if not pivots:
        return []
    ps = sorted(pivots, key=lambda p: p.price)
    clusters: list[list[Pivot]] = [[ps[0]]]
    for p in ps[1:]:
        # Bound the cluster to the ANCHOR (its lowest pivot), not the last one.
        # Comparing to the last pivot lets clusters chain across the whole range
        # (a string of pivots each within `tolerance` of the previous merges into
        # one giant blob). Anchoring caps each zone's width at ~tolerance.
        if p.price - clusters[-1][0].price <= tolerance:
            clusters[-1].append(p)
        else:
            clusters.append([p])

    zones: list[Zone] = []
    for c in clusters:
        lows = sum(1 for p in c if p.kind == "low")
        highs = sum(1 for p in c if p.kind == "high")
        z = Zone(edge_low=min(p.price for p in c), edge_high=max(p.price for p in c),
                 touches=len(c), tests_support=lows, tests_resist=highs, pivots=c)
        if z.valid(min_touches):
            zones.append(z)
    return zones
