"""Persist the live stream to the structured DB tables.

The file logger (file_logger.py) writes a human-readable activity.log; this
module writes the machine-readable tables the dashboard/analytics read from:

  - `events`            — every meaningful bus event (fill / reject / skip / error)
  - `account_snapshots` — balance / equity / margin, sampled on an interval,
                          so the equity curve can be drawn over time.

High-frequency noise (per-zone `approach` ticks and the `zones` rebuild dumps)
is intentionally NOT persisted — it would bloat the table and is already
captured in activity.log / the zones table.
"""
import asyncio
from datetime import datetime, timedelta

from app.db.base import SessionLocal
from app.db.models import Event, AccountSnapshot, SpreadSample
from app.services.events import bus
from app.strategy.market_hours import market_open
from app.config import settings

_SKIP_KINDS = {"approach", "zones"}


async def run_event_recorder() -> None:
    """Subscribe to the bus and append meaningful events to the `events` table.

    Runs for the app's lifetime; cancelled on shutdown by the lifespan handler.
    """
    q = bus.subscribe()
    try:
        while True:
            msg = await q.get()
            kind = msg.get("kind", "?")
            if kind in _SKIP_KINDS:
                continue
            try:
                with SessionLocal() as s:
                    s.add(Event(
                        kind=kind,
                        symbol=msg.get("symbol"),
                        payload={k: v for k, v in msg.items() if k != "kind"},
                    ))
                    s.commit()
            except Exception:  # never let a logging failure kill the recorder
                pass
    finally:
        bus.unsubscribe(q)


async def run_account_snapshots(broker) -> None:
    """Write a balance/equity/margin snapshot every `snapshot_interval_s`."""
    while True:
        try:
            a = broker.account()
            pos = broker.positions()
            with SessionLocal() as s:
                s.add(AccountSnapshot(
                    balance=a.get("balance"),
                    equity=a.get("equity"),
                    margin=a.get("margin"),
                    open_positions=len(pos),
                ))
                s.commit()
        except Exception as e:
            bus.publish("error", {"symbol": "ACCOUNT", "msg": f"snapshot failed: {e}"})
        await asyncio.sleep(settings.snapshot_interval_s)


async def run_spread_monitor(broker) -> None:
    """Sample bid/ask/spread for every open-market symbol into spread_samples,
    every `spread_sample_interval_s`.

    Two consumers: (a) evidence when a close/fill happened at an abnormal
    spread (rollover, news), (b) the per-symbol baseline the reconciler's
    stale-close spread guard compares the live spread against. Old samples
    are pruned past `spread_retention_days` to keep the table bounded."""
    while True:
        try:
            with SessionLocal() as s:
                for sym in settings.symbols:
                    if not market_open(sym):
                        continue   # closed market = stale tick, not a real spread
                    try:
                        tk = broker.tick(sym)
                    except Exception:
                        continue
                    s.add(SpreadSample(symbol=sym, bid=tk["bid"], ask=tk["ask"],
                                       spread=abs(tk["ask"] - tk["bid"])))
                cutoff = datetime.utcnow() - timedelta(days=settings.spread_retention_days)
                s.query(SpreadSample).filter(SpreadSample.ts < cutoff).delete()
                s.commit()
        except Exception as e:
            bus.publish("error", {"symbol": "SPREAD", "msg": f"spread sample failed: {e}"})
        await asyncio.sleep(settings.spread_sample_interval_s)
