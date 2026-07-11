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
            "entry": t.entry, "fill_price": t.fill_price,
            "sl": t.sl, "tp": t.tp, "lots": t.lots,
            "close_price": t.close_price,
            "pnl_eur": t.pnl_eur, "pnl_pips": t.pnl_pips, "result": t.result,
            "close_reason": t.close_reason,
            "risk_eur": t.risk_eur, "rr": t.rr,
            "mae_pips": t.mae_pips, "mfe_pips": t.mfe_pips,
            "mae_pct_of_sl": t.mae_pct_of_sl, "mfe_pct_of_tp": t.mfe_pct_of_tp,
            "hold_duration_min": t.hold_duration_min,
            "opened_at": t.opened_at.isoformat() if t.opened_at else None,
            "closed_at": t.closed_at.isoformat() if t.closed_at else None,
        } for t in rows]
