"""Regression test for a live incident (v4 USDCHF 2026-07-16): a zone's SELL
hit SL at 15:04 and the SAME zone re-fired an identical SELL at 15:11 — the 2h
rescan had rebuilt the zone (clearing _traded_zones) and nothing consulted the
previous trade's outcome. Both trades lost ~€320 each. A zone whose trade
closed as LOSS must stay blocked — across rescans — until price has moved at
least one zone-width clear of the band."""
import asyncio
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import Base, Trade, TradeState, Side
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
    """Like the reentry test's double, but with a movable price so the tests
    can walk price into, out of, and back into the zone."""

    def __init__(self, price: float):
        self.price = price
        self.orders = []
        self._next_ticket = 1

    def candles(self, symbol, timeframe, count):
        import pandas as pd
        return pd.DataFrame({
            "time": pd.date_range("2024-01-01", periods=5, freq="h"),
            "open": [self.price] * 5, "high": [self.price] * 5,
            "low": [self.price] * 5, "close": [self.price] * 5,
            "tick_volume": [1] * 5,
        })

    def tick(self, symbol):
        return {"bid": self.price - 5, "ask": self.price + 5, "time": 0}

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


ZONE_LOW, ZONE_HIGH = 64000.0, 64100.0   # width 100 → clearance band 63900..64200


def _zone() -> Zone:
    return Zone(edge_low=ZONE_LOW, edge_high=ZONE_HIGH, touches=4,
                tests_support=2, tests_resist=2, pivots=[])


def _patch_signal_at_broker_price(monkeypatch, broker):
    """Always decelerating; approach price follows the fake broker's price, so
    build_signal itself decides in-zone vs out-of-zone."""
    monkeypatch.setattr(
        scanner_module.deceleration, "approach",
        lambda h4, zone, lookback=3: {
            "price": broker.price, "dist_norm": 0.0,
            "decelerating": True, "direction": "rising", "ranges": [],
        },
    )


def _insert_closed_trade(db, result: str):
    with db() as s:
        s.add(Trade(symbol="BTCUSD", side=Side.SELL, state=TradeState.CLOSED,
                    result=result, zone_low=ZONE_LOW, zone_high=ZONE_HIGH,
                    closed_at=datetime.utcnow()))
        s.commit()


def _scanner(monkeypatch, broker, db):
    monkeypatch.setattr(settings, "entry_cooldown_min", 0)
    scanner = Scanner(broker, db, Guard())
    scanner._zones["BTCUSD"] = [_zone()]
    return scanner


def test_zone_stays_blocked_after_a_loss_even_across_rescans(monkeypatch):
    broker = FakeBroker(price=64050.0)   # inside the zone
    db = _session_factory()
    _patch_signal_at_broker_price(monkeypatch, broker)
    scanner = _scanner(monkeypatch, broker, db)
    _insert_closed_trade(db, "LOSS")
    scanner._absorb_new_losses()

    asyncio.run(scanner.monitor("BTCUSD"))
    scanner._traded_zones["BTCUSD"] = set()   # what a rescan does
    asyncio.run(scanner.monitor("BTCUSD"))

    assert broker.orders == []


def test_block_lifts_once_price_has_left_the_zone(monkeypatch):
    broker = FakeBroker(price=64050.0)
    db = _session_factory()
    _patch_signal_at_broker_price(monkeypatch, broker)
    scanner = _scanner(monkeypatch, broker, db)
    _insert_closed_trade(db, "LOSS")
    scanner._absorb_new_losses()

    asyncio.run(scanner.monitor("BTCUSD"))          # blocked, no order
    broker.price = 64300.0                          # > high + width → departed
    asyncio.run(scanner.monitor("BTCUSD"))          # lifts the block, no signal here
    broker.price = 64050.0                          # back inside the zone
    scanner._traded_zones["BTCUSD"] = set()         # next rescan
    asyncio.run(scanner.monitor("BTCUSD"))          # thesis reset → may fire again

    assert len(broker.orders) == 1


def test_price_inside_the_clearance_band_does_not_lift_the_block(monkeypatch):
    broker = FakeBroker(price=64050.0)
    db = _session_factory()
    _patch_signal_at_broker_price(monkeypatch, broker)
    scanner = _scanner(monkeypatch, broker, db)
    _insert_closed_trade(db, "LOSS")
    scanner._absorb_new_losses()

    broker.price = 64150.0    # outside the zone, but within one width of it
    asyncio.run(scanner.monitor("BTCUSD"))
    broker.price = 64050.0
    scanner._traded_zones["BTCUSD"] = set()
    asyncio.run(scanner.monitor("BTCUSD"))

    assert broker.orders == []


def test_a_win_does_not_block_the_zone(monkeypatch):
    broker = FakeBroker(price=64050.0)
    db = _session_factory()
    _patch_signal_at_broker_price(monkeypatch, broker)
    scanner = _scanner(monkeypatch, broker, db)
    _insert_closed_trade(db, "WIN")
    scanner._absorb_new_losses()

    asyncio.run(scanner.monitor("BTCUSD"))

    assert len(broker.orders) == 1


def test_blocks_survive_a_restart(monkeypatch):
    broker = FakeBroker(price=64050.0)
    db = _session_factory()
    _patch_signal_at_broker_price(monkeypatch, broker)
    _insert_closed_trade(db, "LOSS")

    scanner = _scanner(monkeypatch, broker, db)   # fresh instance = restart
    scanner._absorb_new_losses()                  # what run_forever does first
    asyncio.run(scanner.monitor("BTCUSD"))

    assert broker.orders == []
