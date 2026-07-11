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

        # A zone narrower than a few spreads produces SL/TP the broker will
        # reject as "invalid stops" (or that are already inside the current
        # bid/ask at fill) — catch it before wasting an order attempt. Mainly
        # bites relaxed-validity configs (e.g. v4) on wide-spread crypto pairs.
        try:
            tick = self.broker.tick(sig.symbol)
            spread = abs(tick["ask"] - tick["bid"])
        except Exception:
            spread = 0.0
        risk_dist = abs(sig.entry - sig.sl)
        if spread and risk_dist < spread * settings.min_stop_spread_mult:
            bus.publish("skip", {"symbol": sig.symbol,
                                 "reason": f"stop distance {risk_dist:.6g} too tight "
                                           f"vs spread {spread:.6g}"})
            return

        lots = position_size(self.broker, sig.symbol, sig.entry, sig.sl, settings.risk_eur)
        r = self.broker.order_send(sig.symbol, sig.side, lots, sig.sl, sig.tp)

        # The signal plans entry at the zone mid; the market order fills wherever
        # price is inside the zone. Re-anchor the TP to the REAL fill so the
        # risk-reward stays the configured `rr` (SL is structural — it stays one
        # zone-width behind the far edge). If the fill drifted far from the mid
        # (a fast move into the zone), this is where the TP gets corrected.
        tp = sig.tp
        fill = r.get("fill")
        if r["ok"] and fill:
            risk = (sig.sl - fill) if sig.side == "SELL" else (fill - sig.sl)
            if risk > 0:
                tp = (fill - risk * sig.rr) if sig.side == "SELL" else (fill + risk * sig.rr)
                m = self.broker.modify_position(r["ticket"], sig.sl, tp)
                if not m.get("ok"):
                    bus.publish("error", {"symbol": sig.symbol,
                                          "msg": f"TP re-anchor failed: {m.get('error')}"})
                    tp = sig.tp   # broker still holds the original TP

        with self.db() as s:
            s.add(Trade(
                ticket=r.get("ticket"), symbol=sig.symbol, side=Side(sig.side),
                state=TradeState.OPEN if r["ok"] else TradeState.REJECTED,
                entry=sig.entry, sl=sig.sl, tp=tp, lots=lots,
                fill_price=fill,   # real MT5 execution price, not the zone-mid
                risk_eur=settings.risk_eur, rr=sig.rr,
                decel_snapshot=sig.decel, opened_at=datetime.utcnow(),
            ))
            s.commit()

        if r["ok"]:
            bus.publish("fill", {"symbol": sig.symbol, "side": sig.side,
                                 "entry": sig.entry, "fill": fill,
                                 "sl": sig.sl, "tp": tp,
                                 "lots": lots, "ticket": r["ticket"], "sound": "open"})
        else:
            bus.publish("reject", {"symbol": sig.symbol, "error": r["error"]})
