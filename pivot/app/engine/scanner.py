"""Orchestration loop:
  - D1 scan rebuilds areas-of-interest (every `zone_rescan_hours`)
  - H4 monitor checks approach + deceleration each cycle and arms entries
"""
import asyncio
import time
from app.config import settings
from app.strategy import pivots, zones as zmod, deceleration, signals
from app.strategy.market_hours import market_open
from app.services.events import bus
from app.services.file_logger import get_activity_logger
from app.engine.executor import Executor


class Scanner:
    def __init__(self, broker, session_factory, guard):
        self.broker = broker
        self.db = session_factory
        self.exec = Executor(broker, session_factory, guard)
        self._zones: dict[str, list] = {}
        self._last_zone_scan = 0.0
        self._last_attempt: dict[str, float] = {}   # symbol → ts of last entry attempt
        self.running = True
        self.log = get_activity_logger()

    def _cooling(self, symbol: str) -> bool:
        last = self._last_attempt.get(symbol, 0.0)
        return time.time() - last < settings.entry_cooldown_min * 60

    # ── D1: rebuild zones ────────────────────────────────────────────────────
    def scan_zones(self, symbol: str) -> None:
        d1 = self.broker.candles(symbol, "D1", settings.d1_count)
        atr = (d1["high"] - d1["low"]).rolling(14).mean().iloc[-1]
        tol = float(atr) * settings.zone_tolerance_atr
        zs = zmod.build_zones(
            pivots.find_pivots(d1, settings.pivot_left, settings.pivot_right),
            tol, settings.min_touches,
        )
        self._zones[symbol] = zs
        bus.publish("zones", {"symbol": symbol, "zones": [
            {"low": z.edge_low, "high": z.edge_high, "mid": z.mid,
             "width": z.width, "touches": z.touches,
             "support": z.tests_support, "resist": z.tests_resist}
            for z in zs]})

    # ── H4: monitor + arm ────────────────────────────────────────────────────
    async def monitor(self, symbol: str) -> None:
        zs = self._zones.get(symbol, [])
        if not zs:
            return
        # Don't arm entries when the market is closed (avoids rejected-order spam).
        if not market_open(symbol):
            return
        h4 = self.broker.candles(symbol, "H4", settings.h4_count)
        for z in zs:
            ap = deceleration.approach(h4, z)
            if ap["dist_norm"] <= settings.approach_zones:
                bus.publish("approach", {"symbol": symbol, "mid": z.mid, **ap})
            sig = signals.build_signal(symbol, z, ap, settings.rr)
            if sig and not self._cooling(symbol):
                self._last_attempt[symbol] = time.time()   # one attempt per cooldown
                await self.exec.execute(sig)

    def _due_zone_scan(self) -> bool:
        if time.time() - self._last_zone_scan >= settings.zone_rescan_hours * 3600:
            self._last_zone_scan = time.time()
            return True
        return False

    async def run_forever(self) -> None:
        while self.running:
            due = self._due_zone_scan()
            for s in settings.symbols:
                try:
                    if due or s not in self._zones:
                        self.scan_zones(s)
                    await self.monitor(s)
                except Exception as e:
                    bus.publish("error", {"symbol": s, "msg": str(e)})
                await asyncio.sleep(0.2)
            # Heartbeat: proves the loop is alive even when nothing triggers.
            open_n = sum(1 for s in settings.symbols if market_open(s))
            zones_n = sum(len(z) for z in self._zones.values())
            self.log.info(f"[CYCLE]    {len(settings.symbols)} symbols | "
                          f"{zones_n} zones held | {open_n} markets open")
            await asyncio.sleep(settings.scan_interval_s)
