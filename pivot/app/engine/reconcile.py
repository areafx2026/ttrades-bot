"""Position reconciliation — the other half of the executor.

MT5 is the single source of truth. The executor only ever INSERTs OPEN rows;
this watches every OPEN trade each cycle and:

  - while it is still on MT5's open book → samples the current price and keeps
    the running MAE (max adverse excursion) and MFE (max favourable excursion);
  - once it has left the open book → pulls the closing deal and finalises the
    row: close_price, realised P/L, result, closed_at, hold time, and the
    excursion stats (pips + % of the SL/TP distance).

MAE/MFE are sampled at the scan cadence, not tick-by-tick, so brief intrabar
spikes between samples can be missed — accurate enough for trade-quality stats.
"""
from app.db.models import Trade, TradeState
from app.services.events import bus
from app.strategy.market_hours import pip_size


class Reconciler:
    def __init__(self, broker, session_factory):
        self.broker = broker
        self.db = session_factory

    def run(self) -> None:
        open_tickets = {p["ticket"] for p in self.broker.positions()}
        with self.db() as s:
            for t in s.query(Trade).filter(Trade.state == TradeState.OPEN).all():
                if t.ticket and t.ticket in open_tickets:
                    self._track(t)        # still open → keep extremes current
                else:
                    self._finalize(t)     # gone from MT5 → it closed
            s.commit()

    # ── helpers ──────────────────────────────────────────────────────────────
    @staticmethod
    def _ref(t: Trade) -> float:
        """The price P/L and excursions are measured from — the real fill if we
        captured it, otherwise the intended entry."""
        return t.fill_price or t.entry

    def _update_extremes(self, t: Trade, price: float) -> None:
        if t.mfe_price is None:
            t.mfe_price = self._ref(t)
        if t.mae_price is None:
            t.mae_price = self._ref(t)
        if t.side.value == "BUY":
            t.mfe_price = max(t.mfe_price, price)   # favourable = price up
            t.mae_price = min(t.mae_price, price)   # adverse    = price down
        else:                                       # SELL
            t.mfe_price = min(t.mfe_price, price)   # favourable = price down
            t.mae_price = max(t.mae_price, price)   # adverse    = price up

    def _track(self, t: Trade) -> None:
        try:
            tk = self.broker.tick(t.symbol)
        except Exception:
            return
        self._update_extremes(t, (tk["bid"] + tk["ask"]) / 2)
        self._compute_stats(t)   # keep pips/% live so the dashboard shows them now

    def _finalize(self, t: Trade) -> None:
        info = self.broker.closed_position(t.ticket) if t.ticket else None
        if not info:
            return  # close deal not visible yet — retry next cycle
        self._update_extremes(t, info["close_price"])   # capture gap/close spike
        t.close_price = info["close_price"]
        t.pnl_eur = info["profit"]
        t.closed_at = info["closed_at"]
        t.state = TradeState.CLOSED
        t.result = "WIN" if t.pnl_eur > 0 else "LOSS" if t.pnl_eur < 0 else "BE"
        if t.opened_at and t.closed_at:
            t.hold_duration_min = round((t.closed_at - t.opened_at).total_seconds() / 60)
        self._compute_stats(t)
        bus.publish("closed", {
            "symbol": t.symbol, "side": t.side.value, "ticket": t.ticket,
            "pnl_eur": round(t.pnl_eur, 2), "result": t.result,
            "close": t.close_price,
            "sound": "win" if t.result == "WIN" else "loss",
        })

    def _compute_stats(self, t: Trade) -> None:
        ref, pip = self._ref(t), pip_size(t.symbol)
        if t.close_price is not None and ref:
            gain = (t.close_price - ref) if t.side.value == "BUY" else (ref - t.close_price)
            t.pnl_pips = round(gain / pip, 1)
        if t.mae_price is not None and ref:
            adverse = abs(ref - t.mae_price)
            t.mae_pips = round(adverse / pip, 1)
            sl_dist = abs(ref - t.sl) if t.sl else 0
            t.mae_pct_of_sl = round(adverse / sl_dist, 3) if sl_dist else None
        if t.mfe_price is not None and ref:
            favour = abs(t.mfe_price - ref)
            t.mfe_pips = round(favour / pip, 1)
            tp_dist = abs(t.tp - ref) if t.tp else 0
            t.mfe_pct_of_tp = round(favour / tp_dist, 3) if tp_dist else None
