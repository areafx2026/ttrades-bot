from fastapi import APIRouter, Query
from app.api import deps
from app.config import settings

router = APIRouter()


@router.get("/zones")
def zones(symbol: str | None = Query(None)):
    """Current in-memory areas-of-interest, optionally filtered by symbol."""
    out = {}
    for sym, zs in deps.scanner._zones.items():
        if symbol and sym != symbol:
            continue
        out[sym] = [{"low": z.edge_low, "high": z.edge_high, "mid": z.mid,
                     "width": z.width, "touches": z.touches,
                     "support": z.tests_support, "resist": z.tests_resist}
                    for z in zs]
    return out


@router.get("/zones/{symbol}/candles")
def zone_candles(symbol: str, timeframe: str = "H4", count: int = 120):
    df = deps.broker.candles(symbol, timeframe, count)
    return [{"time": int(r["time"].timestamp()), "open": r["open"], "high": r["high"],
             "low": r["low"], "close": r["close"]} for _, r in df.iterrows()]
