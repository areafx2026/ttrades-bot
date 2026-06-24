"""Fully-auto order placement: guardrail check → size → send → persist → emit."""
from datetime import datetime
from app.db.models import Trade, TradeState, Side
from app.services.events import bus
from app.engine.risk import position_size
from app.config import settings


class Executor:
    def __init__(self, broker, session_factory, guard):
        self.broker = broker
        self.db = session_factory
        self.guard = guard

    async def execute(self, sig) -> None:
        ok, reason = self.guard.allow(self.broker, sig.symbol)
        if not ok:
            bus.publish("skip", {"symbol": sig.symbol, "reason": reason})
            return

        lots = position_size(self.broker, sig.symbol, sig.entry, sig.sl, settings.risk_eur)
        r = self.broker.order_send(sig.symbol, sig.side, lots, sig.sl, sig.tp)

        with self.db() as s:
            s.add(Trade(
                ticket=r.get("ticket"), symbol=sig.symbol, side=Side(sig.side),
                state=TradeState.OPEN if r["ok"] else TradeState.REJECTED,
                entry=sig.entry, sl=sig.sl, tp=sig.tp, lots=lots,
                fill_price=r.get("fill"),   # real MT5 execution price, not the zone-mid
                risk_eur=settings.risk_eur, rr=sig.rr,
                decel_snapshot=sig.decel, opened_at=datetime.utcnow(),
            ))
            s.commit()

        if r["ok"]:
            bus.publish("fill", {"symbol": sig.symbol, "side": sig.side,
                                 "entry": sig.entry, "fill": r.get("fill"),
                                 "sl": sig.sl, "tp": sig.tp,
                                 "lots": lots, "ticket": r["ticket"], "sound": "open"})
        else:
            bus.publish("reject", {"symbol": sig.symbol, "error": r["error"]})
