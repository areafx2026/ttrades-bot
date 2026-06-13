"""MetaTrader5 in-process adapter. No HTTP, no bridge — direct terminal calls.
Reconnect logic is centralized here (the single source of the v2 bridge bugs)."""
import pandas as pd
from app.brokers.base import BrokerAdapter

try:
    import MetaTrader5 as mt5
    _TF = {"D1": mt5.TIMEFRAME_D1, "H4": mt5.TIMEFRAME_H4, "H1": mt5.TIMEFRAME_H1}
except Exception:  # allows import on machines without MT5 (e.g. CI) — see MockBroker
    mt5 = None
    _TF = {}


class MT5Adapter(BrokerAdapter):
    def __init__(self, login=None, password=None, server=None):
        self._cfg = (login, password, server)

    def connect(self) -> bool:
        if mt5 is None:
            raise RuntimeError("MetaTrader5 package not available on this machine")
        if mt5.initialize():
            return True
        mt5.shutdown()  # one place owns reconnect
        login, pw, srv = self._cfg
        if login:
            return mt5.initialize(login=int(login), password=pw, server=srv)
        return mt5.initialize()

    def _ensure(self):
        if mt5.terminal_info() is None and not self.connect():
            raise ConnectionError(f"MT5 unreachable: {mt5.last_error()}")

    def candles(self, symbol, timeframe, count):
        self._ensure()
        mt5.symbol_select(symbol, True)
        rates = mt5.copy_rates_from_pos(symbol, _TF[timeframe], 0, count)
        if rates is None:
            raise RuntimeError(f"no candles {symbol} {timeframe}: {mt5.last_error()}")
        df = pd.DataFrame(rates)
        df["time"] = pd.to_datetime(df["time"], unit="s")
        return df[["time", "open", "high", "low", "close", "tick_volume"]]

    def tick(self, symbol):
        self._ensure()
        mt5.symbol_select(symbol, True)
        t = mt5.symbol_info_tick(symbol)
        return {"bid": t.bid, "ask": t.ask, "time": t.time}

    def positions(self):
        self._ensure()
        return [{"ticket": str(p.ticket), "symbol": p.symbol,
                 "side": "BUY" if p.type == 0 else "SELL", "lots": p.volume,
                 "sl": p.sl, "tp": p.tp, "price_open": p.price_open, "profit": p.profit}
                for p in (mt5.positions_get() or [])]

    def order_send(self, symbol, side, lots, sl, tp, comment="Pivot v3"):
        self._ensure()
        info = mt5.symbol_info_tick(symbol)
        otype = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        price = info.ask if side == "BUY" else info.bid
        r = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(lots),
            "type": otype, "price": price, "sl": float(sl), "tp": float(tp),
            "deviation": 20, "magic": 30000, "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
        })
        ok = r.retcode == mt5.TRADE_RETCODE_DONE
        return {"ok": ok, "ticket": str(r.order) if ok else None,
                "error": None if ok else r.comment, "retcode": r.retcode}

    def close(self, ticket):
        self._ensure()
        pos = mt5.positions_get(ticket=int(ticket))
        if not pos:
            return {"ok": False, "error": "position not found"}
        p = pos[0]
        info = mt5.symbol_info_tick(p.symbol)
        otype = mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY
        price = info.bid if p.type == 0 else info.ask
        r = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume,
            "type": otype, "position": p.ticket, "price": price, "deviation": 20,
            "magic": 30000, "comment": "Pivot close",
            "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
        })
        return {"ok": r.retcode == mt5.TRADE_RETCODE_DONE, "error": r.comment}

    def account(self):
        self._ensure()
        a = mt5.account_info()
        return {"balance": a.balance, "equity": a.equity, "margin": a.margin}
