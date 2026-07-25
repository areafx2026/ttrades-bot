"""Regression test for a live incident: lots were sized off the planned
zone-mid entry, not the real fill price. When price moved a few pips between
signal and execution, the realized loss at SL ran 25-40% over the configured
risk_eur (e.g. USDCHF -415.82€ against a 300€ target). Executor must size off
a live tick (a close proxy for the actual fill) instead."""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.strategy.market_hours as mh
from app.config import settings
from app.db.models import Base, Trade, TradeState
from app.engine.executor import Executor
from app.engine.risk import Guard, position_size
from app.strategy.signals import Signal


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
    def __init__(self, bid, ask):
        self.bid, self.ask = bid, ask

    def tick(self, symbol):
        return {"bid": self.bid, "ask": self.ask, "time": 0}

    def symbol_spec(self, symbol):
        return {"contract_size": 100_000, "volume_min": 0.01, "volume_max": 100.0,
                "volume_step": 0.01, "digits": 5}

    def order_send(self, symbol, side, lots, sl, tp, comment=None):
        fill = self.ask if side == "BUY" else self.bid
        return {"ok": True, "ticket": "1", "fill": fill, "error": None, "retcode": 0}

    def modify_position(self, ticket, sl, tp):
        return {"ok": True, "error": None, "retcode": 0}

    def positions(self):
        return []


def test_position_size_uses_live_tick_not_the_stale_planned_entry():
    # Planned entry (the zone mid at signal time) sits well away from where
    # price actually is by execution time — the exact shape of the live
    # incident this fixes.
    broker = FakeBroker(bid=1.1050, ask=1.1052)
    executor = Executor(broker, _session_factory(), Guard())

    sig = Signal(symbol="EURUSD", side="BUY", entry=1.1000, sl=1.0980,
                 tp=1.1026, zone=None, rr=1.3, decel={})

    asyncio.run(executor.execute(sig))

    with executor.db() as s:
        trade = s.query(Trade).filter(Trade.state == TradeState.OPEN).one()

    correct_lots = position_size(broker, "EURUSD", 1.1052, 1.0980, settings.risk_eur)
    stale_entry_lots = position_size(broker, "EURUSD", 1.1000, 1.0980, settings.risk_eur)

    assert trade.lots == correct_lots
    assert trade.lots != stale_entry_lots


def _freeze_now(monkeypatch, now: datetime) -> None:
    """in_rollover_blackout() defaults `now` to datetime.now(timezone.utc) when
    the caller (executor.py) doesn't pass one -- freeze both that AND
    time.time() (used for the tick-time offset calc) so the test controls
    what the function sees as "now" end to end."""
    monkeypatch.setattr(mh._time, "time", lambda: now.timestamp())

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return now if tz else now.replace(tzinfo=None)
    monkeypatch.setattr(mh, "datetime", _FixedDatetime)


def test_execute_blocks_new_entries_during_rollover_blackout(monkeypatch):
    now = datetime(2026, 7, 16, 21, 30, tzinfo=timezone.utc)   # broker (+3h) = 00:30
    _freeze_now(monkeypatch, now)
    blackout_tick_time = now.timestamp() + 3 * 3600

    class BlackoutBroker(FakeBroker):
        def tick(self, symbol):
            return {"bid": self.bid, "ask": self.ask, "time": blackout_tick_time}

    broker = BlackoutBroker(bid=1.1050, ask=1.1052)
    executor = Executor(broker, _session_factory(), Guard())
    sig = Signal(symbol="EURUSD", side="BUY", entry=1.1000, sl=1.0980,
                 tp=1.1026, zone=None, rr=1.3, decel={})

    asyncio.run(executor.execute(sig))

    with executor.db() as s:
        assert s.query(Trade).count() == 0   # no order attempted, nothing persisted


def test_execute_blocks_new_entries_during_hour_blackout(monkeypatch):
    # Hour blackout is read off the OPERATOR's own clock (Europe/Berlin), not
    # a broker tick -- _freeze_now's datetime.now() patch is all that's needed.
    monkeypatch.setattr(settings, "hour_blackout_enabled", True)
    monkeypatch.setattr(settings, "hour_blackout_hours", [15])
    now = datetime(2026, 7, 22, 13, 0, tzinfo=timezone.utc)   # Berlin (CEST, +2) = 15:00
    _freeze_now(monkeypatch, now)

    broker = FakeBroker(bid=1.1050, ask=1.1052)
    executor = Executor(broker, _session_factory(), Guard())
    sig = Signal(symbol="EURUSD", side="BUY", entry=1.1000, sl=1.0980,
                 tp=1.1026, zone=None, rr=1.3, decel={})

    asyncio.run(executor.execute(sig))

    with executor.db() as s:
        assert s.query(Trade).count() == 0


def test_execute_allows_entries_outside_hour_blackout(monkeypatch):
    monkeypatch.setattr(settings, "hour_blackout_enabled", True)
    monkeypatch.setattr(settings, "hour_blackout_hours", [15])
    now = datetime(2026, 7, 22, 14, 0, tzinfo=timezone.utc)   # Berlin (CEST, +2) = 16:00
    _freeze_now(monkeypatch, now)

    broker = FakeBroker(bid=1.1050, ask=1.1052)
    executor = Executor(broker, _session_factory(), Guard())
    sig = Signal(symbol="EURUSD", side="BUY", entry=1.1000, sl=1.0980,
                 tp=1.1026, zone=None, rr=1.3, decel={})

    asyncio.run(executor.execute(sig))

    with executor.db() as s:
        assert s.query(Trade).filter(Trade.state == TradeState.OPEN).count() == 1
