"""Regression test for a live bug found 2026-07-25 (Saturday): EURUSD is
closed on weekends, so its tick can sit stale for ~2 days once the forex
market reopens. Dividing that gap by 3600 produced a wild, implausible
broker-offset (observed -8 instead of the real +2/+3) that corrupted
closed_position()'s close-time conversion and the dashboard's hour
displays. _broker_utc_offset_h() must fail open to 0 instead."""
import app.brokers.mt5_adapter as adapter_mod
from app.brokers.mt5_adapter import MT5Adapter


class _FakeTick:
    def __init__(self, time):
        self.time = time


def _fake_mt5(tick):
    return type("FakeMT5", (), {"symbol_info_tick": staticmethod(lambda s: tick)})


def test_broker_offset_normal_case(monkeypatch):
    now = 1_700_000_000.0
    monkeypatch.setattr(adapter_mod._time, "time", lambda: now)
    monkeypatch.setattr(adapter_mod, "mt5", _fake_mt5(_FakeTick(now + 3 * 3600)))
    assert MT5Adapter()._broker_utc_offset_h() == 3


def test_broker_offset_fails_open_on_stale_weekend_tick(monkeypatch):
    now = 1_700_000_000.0
    monkeypatch.setattr(adapter_mod._time, "time", lambda: now)
    monkeypatch.setattr(adapter_mod, "mt5", _fake_mt5(_FakeTick(now - 2 * 24 * 3600)))
    assert MT5Adapter()._broker_utc_offset_h() == 0


def test_broker_offset_fails_open_on_the_exact_incident_value(monkeypatch):
    """-8 is a plausible offset for *some* timezone in the world, so the
    generic +-12..14 sanity band (used elsewhere for an arbitrary tick's own
    offset) would let it through -- it must still fail open here, since
    Pepperstone is never anywhere near -8."""
    now = 1_700_000_000.0
    monkeypatch.setattr(adapter_mod._time, "time", lambda: now)
    monkeypatch.setattr(adapter_mod, "mt5", _fake_mt5(_FakeTick(now - 8 * 3600)))
    assert MT5Adapter()._broker_utc_offset_h() == 0


def test_broker_offset_no_tick_returns_zero(monkeypatch):
    monkeypatch.setattr(adapter_mod, "mt5", _fake_mt5(None))
    assert MT5Adapter()._broker_utc_offset_h() == 0
