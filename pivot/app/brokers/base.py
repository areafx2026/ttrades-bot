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
        """Return {'ok', 'ticket', 'error', 'retcode'}."""
        ...

    @abstractmethod
    def close(self, ticket: str) -> dict:
        ...

    @abstractmethod
    def account(self) -> dict:
        """Return {'balance', 'equity', 'margin'}."""
        ...
