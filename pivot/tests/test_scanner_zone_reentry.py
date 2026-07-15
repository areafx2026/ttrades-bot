"""Regression test for a live incident: v4 faded EURJPY at a zone (WIN), price
whipped straight back through the same un-rescanned zone, and the exact same
zone re-armed and hit SL 76min later. The per-symbol cooldown had already
expired by then, so nothing stopped it. Scanner.monitor() must not fire a
second entry attempt on a zone that already produced one, until the next
scan_zones() rebuild."""
import asyncio
from contextlib import contextmanager

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import Base
from app.engine import scanner as scanner_module
from app.engine.risk import Guard
from app.engine.scanner import Scanner
from app.strategy.zones import Zone


def _session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

    @contextmanager
    def factory():
        s = Session()
        try:
            yield s
        finally:
            s.close()
    return factory


class FakeBroker:
    """Minimal broker double: fixed tight spread, always-fillable orders, no
    pre-existing positions (Guard's symbol/exposure checks are deliberately
    left permissive here — this test isolates the zone-reentry guard, not
    Guard itself, which already has its own coverage elsewhere)."""

    def __init__(self):
        self.orders = []
        self._next_ticket = 1

    def candles(self, symbol, timeframe, count):
        return pd.DataFrame({
            "time": pd.date_range("2024-01-01", periods=5, freq="h"),
            "open": [1.0] * 5, "high": [1.0] * 5, "low": [1.0] * 5,
            "close": [1.0] * 5, "tick_volume": [1] * 5,
        })

    def tick(self, symbol):
        return {"bid": 64045.0, "ask": 64055.0, "time": 0}

    def symbol_spec(self, symbol):
        return {"contract_size": 1.0, "volume_min": 0.01, "volume_max": 100.0,
                "volume_step": 0.01, "digits": 2}

    def order_send(self, symbol, side, lots, sl, tp, comment=None):
        fill = self.tick(symbol)["ask"] if side == "BUY" else self.tick(symbol)["bid"]
        ticket = str(self._next_ticket)
        self._next_ticket += 1
        self.orders.append({"symbol": symbol, "side": side, "sl": sl, "tp": tp})
        return {"ok": True, "ticket": ticket, "fill": fill, "error": None, "retcode": 0}

    def modify_position(self, ticket, sl, tp):
        return {"ok": True, "error": None, "retcode": 0}

    def positions(self):
        return []


def _zone(mid: float) -> Zone:
    return Zone(edge_low=mid - 50, edge_high=mid + 50, touches=4,
                tests_support=2, tests_resist=2, pivots=[])


def _patch_price_at_zone_mid(monkeypatch):
    """Stub deceleration.approach so every zone looks like a decelerating,
    in-zone approach — the candle data itself is irrelevant to this test."""
    monkeypatch.setattr(
        scanner_module.deceleration, "approach",
        lambda h4, zone, lookback=3: {
            "price": zone.mid, "dist_norm": 0.0,
            "decelerating": True, "direction": "rising", "ranges": [],
        },
    )


def test_same_zone_is_not_retraded_before_the_next_rescan(monkeypatch):
    monkeypatch.setattr(settings, "entry_cooldown_min", 0)  # isolate the zone-level guard
    _patch_price_at_zone_mid(monkeypatch)
    broker = FakeBroker()
    scanner = Scanner(broker, _session_factory(), Guard())
    scanner._zones["BTCUSD"] = [_zone(64050.0)]

    asyncio.run(scanner.monitor("BTCUSD"))
    asyncio.run(scanner.monitor("BTCUSD"))   # price whipped back through the same zone

    assert len(broker.orders) == 1


def test_zone_reentry_guard_clears_on_rescan(monkeypatch):
    monkeypatch.setattr(settings, "entry_cooldown_min", 0)
    _patch_price_at_zone_mid(monkeypatch)
    broker = FakeBroker()
    scanner = Scanner(broker, _session_factory(), Guard())
    scanner._zones["BTCUSD"] = [_zone(64050.0)]

    asyncio.run(scanner.monitor("BTCUSD"))
    scanner._traded_zones["BTCUSD"] = set()   # what scan_zones() does on a fresh rebuild
    asyncio.run(scanner.monitor("BTCUSD"))

    assert len(broker.orders) == 2


def test_a_different_zone_on_the_same_symbol_still_fires(monkeypatch):
    monkeypatch.setattr(settings, "entry_cooldown_min", 0)
    _patch_price_at_zone_mid(monkeypatch)
    broker = FakeBroker()
    scanner = Scanner(broker, _session_factory(), Guard())
    scanner._zones["BTCUSD"] = [_zone(64050.0), _zone(63000.0)]

    asyncio.run(scanner.monitor("BTCUSD"))

    assert len(broker.orders) == 2
