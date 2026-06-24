"""Broker abstraction. Implement this once per venue (MT5 today, cTrader later)
so strategy/engine code never imports a broker SDK directly."""
from abc import ABC, abstractmethod
import pandas as pd


class BrokerAdapter(ABC):
    @abstractmethod
    def connect(self) -> bool:
        ...

    @abstractmethod
    def candles(self, symbol: str, timeframe: str, count: int) -> pd.DataFrame:
        """Return columns: time, open, high, low, close, (tick_volume)."""
        ...

    @abstractmethod
    def tick(self, symbol: str) -> dict:
        """Return {'bid', 'ask', 'time'}."""
        ...

    @abstractmethod
    def positions(self) -> list[dict]:
        ...

    @abstractmethod
    def order_send(self, symbol: str, side: str, lots: float,
                   sl: float, tp: float, comment: str = "") -> dict:
        """Return {'ok', 'ticket', 'fill', 'error', 'retcode'} — 'fill' is the
        real execution price (None when the order was rejected)."""
        ...

    @abstractmethod
    def close(self, ticket: str) -> dict:
        ...

    @abstractmethod
    def closed_position(self, ticket: str) -> dict | None:
        """Closing details for a now-closed position, or None if not yet closed.
        Return {'close_price', 'profit', 'closed_at'} with closed_at in UTC."""
        ...

    @abstractmethod
    def account(self) -> dict:
        """Return {'balance', 'equity', 'margin'}."""
        ...

    @abstractmethod
    def symbol_spec(self, symbol: str) -> dict:
        """Return {'contract_size','volume_min','volume_max','volume_step','digits'}
        — the broker's real contract spec, used for correct per-symbol sizing."""
        ...
