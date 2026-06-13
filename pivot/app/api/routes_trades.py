from fastapi import APIRouter, Query
from app.db.base import SessionLocal
from app.db.models import Trade

router = APIRouter()


@router.get("/trades")
def trades(state: str | None = Query(None), limit: int = 100):
    with SessionLocal() as s:
        q = s.query(Trade).order_by(Trade.opened_at.desc())
        if state:
            q = q.filter(Trade.state == state)
        rows = q.limit(limit).all()
        return [{
            "id": t.id, "ticket": t.ticket, "symbol": t.symbol,
            "side": t.side.value if t.side else None,
            "state": t.state.value if t.state else None,
            "entry": t.entry, "sl": t.sl, "tp": t.tp, "lots": t.lots,
            "pnl_eur": t.pnl_eur, "result": t.result,
            "opened_at": t.opened_at.isoformat() if t.opened_at else None,
            "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        } for t in rows]
