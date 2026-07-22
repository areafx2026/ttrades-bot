from fastapi import APIRouter, Query
from app.api import deps

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
