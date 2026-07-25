"""Fully-auto order placement: guardrail check → size → send → persist → emit."""
from datetime import datetime
from app.db.models import Trade, TradeState, Side
from app.services.events import bus
from app.engine.risk import position_size
from app.config import settings
from app.strategy.market_hours import in_hour_blackout, in_rollover_blackout


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

        # Size off a LIVE tick, not the static zone-mid sig.entry: the market
        # order fills at ~this same price a moment later, so it's a far
        # closer proxy to the real fill than the planned entry — which can
        # already be several pips off by execution time, silently blowing
        # the risk_eur budget (observed live: a 2-5 pip planned-vs-fill gap
        # turned a €300-target loss into €400+, since lots were sized for a
        # smaller SL distance than what actually applied at the real fill).
        try:
            tick = self.broker.tick(sig.symbol)
            spread = abs(tick["ask"] - tick["bid"])
            sizing_price = tick["ask"] if sig.side == "BUY" else tick["bid"]
        except Exception:
            tick = None
            spread = 0.0
            sizing_price = sig.entry

        # No new entries in the daily rollover blackout — this broker's spread
        # reliably blows out right around its server-midnight rollover (~70pt
        # vs ~1pt normal on USDJPY, live-observed 2026-07-16), which would
        # blow the risk_eur budget on entry just like it did on the exit side.
        if settings.rollover_blackout_enabled and tick and in_rollover_blackout(tick.get("time", 0)):
            bus.publish("skip", {"symbol": sig.symbol, "reason": "rollover blackout window"})
            return

        # Per-instance "historically our worst entry hour" block (see
        # config.hour_blackout_hours) — new entries only, doesn't touch a
        # trade that's already running. Read off the system clock in the
        # operator's own timezone, not the broker's (see in_hour_blackout).
        if settings.hour_blackout_enabled and in_hour_blackout(settings.hour_blackout_hours):
            bus.publish("skip", {"symbol": sig.symbol, "reason": "hour blackout window"})
            return

        # A zone narrower than a few spreads produces SL/TP the broker will
        # reject as "invalid stops" (or that are already inside the current
        # bid/ask at fill) — catch it before wasting an order attempt. Mainly
        # bites relaxed-validity configs (e.g. v4) on wide-spread crypto pairs.
        risk_dist = abs(sizing_price - sig.sl)
        if spread and risk_dist < spread * settings.min_stop_spread_mult:
            bus.publish("skip", {"symbol": sig.symbol,
                                 "reason": f"stop distance {risk_dist:.6g} too tight "
                                           f"vs spread {spread:.6g}"})
            return

        lots = position_size(self.broker, sig.symbol, sizing_price, sig.sl, settings.risk_eur)
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
                zone_low=sig.zone.edge_low if sig.zone else None,
                zone_high=sig.zone.edge_high if sig.zone else None,
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
