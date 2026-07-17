"""Orchestration loop:
  - zone-timeframe scan rebuilds areas-of-interest (every `zone_rescan_hours`)
  - entry-timeframe monitor checks approach + deceleration each cycle and arms entries
  (timeframes are configurable via settings.zone_timeframe/entry_timeframe — v3 runs
  D1/H4 by default, a parallel instance like v4 can run e.g. H4/M15 via its own .env)
"""
import asyncio
import time
from datetime import datetime, timedelta

from app.config import settings
from app.db.models import Trade
from app.strategy import pivots, zones as zmod, deceleration, signals
from app.strategy.market_hours import market_open
from app.services.events import bus
from app.services.file_logger import get_activity_logger
from app.engine.executor import Executor
from app.engine.reconcile import Reconciler

# How far back closed losses are (re)loaded into the loss-zone block list —
# mainly bounds what a restart resurrects; the price-departure rule is what
# actually lifts a block, so anything stale clears within one cycle anyway.
_LOSS_LOOKBACK_DAYS = 7


class Scanner:
    def __init__(self, broker, session_factory, guard):
        self.broker = broker
        self.db = session_factory
        self.exec = Executor(broker, session_factory, guard)
        self.reconciler = Reconciler(broker, session_factory)
        self._zones: dict[str, list] = {}
        self._last_zone_scan = 0.0
        self._last_attempt: dict[str, float] = {}   # symbol → ts of last entry attempt
        self._traded_zones: dict[str, set] = {}     # symbol → zone keys already attempted this rescan
        # Loss-zone block: bands whose trade closed as LOSS. Unlike
        # _traded_zones this survives rescans — it only lifts once price has
        # moved at least one zone-width clear of the band (thesis reset).
        self._loss_zones: dict[str, list[dict]] = {}   # symbol → [{low, high}]
        self._loss_absorbed: set[int] = set()          # trade ids already turned into blocks
        self.running = True
        self.log = get_activity_logger()

    def _cooling(self, symbol: str) -> bool:
        last = self._last_attempt.get(symbol, 0.0)
        return time.time() - last < settings.entry_cooldown_min * 60

    # ── loss-zone block: distrust a zone whose trade just lost ───────────────
    # Live incident (v4 USDCHF 2026-07-16): a zone's SELL hit SL at 15:04 and
    # the SAME zone re-fired an identical SELL at 15:11 — the rescan had
    # rebuilt the zone and cleared _traded_zones, and nothing consulted the
    # previous trade's outcome. An SL hit means price traversed the whole zone
    # plus a width — the strongest possible evidence against the zone.

    def _absorb_new_losses(self) -> None:
        """Turn newly-closed LOSS trades into blocks on their zone bands.
        Runs at the top of every cycle; on a fresh start the empty absorbed-
        set makes it re-load recent history, so blocks survive restarts."""
        since = datetime.utcnow() - timedelta(days=_LOSS_LOOKBACK_DAYS)
        with self.db() as s:
            rows = (s.query(Trade.id, Trade.symbol, Trade.zone_low, Trade.zone_high)
                    .filter(Trade.result == "LOSS",
                            Trade.zone_low.isnot(None),
                            Trade.closed_at >= since).all())
        for tid, sym, low, high in rows:
            if tid in self._loss_absorbed:
                continue
            self._loss_absorbed.add(tid)
            bands = self._loss_zones.setdefault(sym, [])
            if not any(b["low"] == low and b["high"] == high for b in bands):
                bands.append({"low": low, "high": high})

    def _clear_departed_blocks(self, symbol: str, price: float) -> None:
        """A block lifts once price sits at least one zone-width beyond either
        edge — only a proper departure from the area resets the thesis; time
        alone doesn't."""
        bands = self._loss_zones.get(symbol)
        if not bands:
            return
        self._loss_zones[symbol] = [
            b for b in bands
            if b["low"] - (b["high"] - b["low"]) <= price <= b["high"] + (b["high"] - b["low"])
        ]

    def _blocked_by_loss(self, symbol: str, z) -> bool:
        """Overlap test against the blocked bands — a rescan may rebuild the
        zone with slightly shifted edges, so exact-key matching (what
        _traded_zones uses) would let it slip through."""
        return any(z.edge_low <= b["high"] and z.edge_high >= b["low"]
                   for b in self._loss_zones.get(symbol, []))

    # ── zone timeframe: rebuild areas-of-interest ───────────────────────────
    def scan_zones(self, symbol: str) -> None:
        d1 = self.broker.candles(symbol, settings.zone_timeframe, settings.zone_count)
        atr = (d1["high"] - d1["low"]).rolling(14).mean().iloc[-1]
        tol = float(atr) * settings.zone_tolerance_atr
        zs = zmod.build_zones(
            pivots.find_pivots(d1, settings.pivot_left, settings.pivot_right),
            tol, settings.min_touches, settings.require_both_sides,
        )
        self._zones[symbol] = zs
        self._traded_zones[symbol] = set()   # fresh pivots -> forget what already fired
        bus.publish("zones", {"symbol": symbol, "zones": [
            {"low": z.edge_low, "high": z.edge_high, "mid": z.mid,
             "width": z.width, "touches": z.touches,
             "support": z.tests_support, "resist": z.tests_resist}
            for z in zs]})

    # ── entry timeframe: monitor + arm ──────────────────────────────────────
    async def monitor(self, symbol: str) -> None:
        zs = self._zones.get(symbol, [])
        if not zs:
            return
        # Don't arm entries when the market is closed (avoids rejected-order spam).
        if not market_open(symbol):
            return
        h4 = self.broker.candles(symbol, settings.entry_timeframe, settings.entry_count)
        self._clear_departed_blocks(symbol, float(h4["close"].iloc[-1]))
        traded = self._traded_zones.setdefault(symbol, set())
        for z in zs:
            ap = deceleration.approach(h4, z)
            if ap["dist_norm"] <= settings.approach_zones:
                bus.publish("approach", {"symbol": symbol, "mid": z.mid, **ap})
            sig = signals.build_signal(symbol, z, ap, settings.rr)
            zone_key = (round(z.edge_low, 6), round(z.edge_high, 6))
            # A zone that already produced an entry attempt this rescan cycle
            # doesn't get a second one — a sharp reversal straight back through
            # a level you just faded is evidence against the thesis, not a
            # fresh independent setup. Separate from (and stricter than) the
            # per-symbol cooldown, which alone let this happen live: EURJPY
            # WIN at 08:15, then the same zone re-armed and hit SL at 09:32,
            # 76min later — past cooldown but the very same, un-rescanned zone.
            if sig and self._blocked_by_loss(symbol, z):
                if zone_key not in traded:
                    # Consume this zone's one shot per rescan period: skips
                    # the entry AND keeps the log at one line per rescan
                    # instead of one per cycle while the signal persists.
                    traded.add(zone_key)
                    bus.publish("skip", {"symbol": symbol, "reason":
                                         f"zone {z.edge_low:.6g}-{z.edge_high:.6g} blocked "
                                         f"after a LOSS until price clears it"})
                continue
            if sig and not self._cooling(symbol) and zone_key not in traded:
                self._last_attempt[symbol] = time.time()   # one attempt per cooldown
                traded.add(zone_key)
                await self.exec.execute(sig)

    def _due_zone_scan(self) -> bool:
        if time.time() - self._last_zone_scan >= settings.zone_rescan_hours * 3600:
            self._last_zone_scan = time.time()
            return True
        return False

    async def run_forever(self) -> None:
        while self.running:
            # First thing each cycle — a loss finalized at the end of the
            # previous cycle must be blocking before any entry check runs.
            try:
                self._absorb_new_losses()
            except Exception as e:
                bus.publish("error", {"symbol": "LOSSBLOCK", "msg": str(e)})
            due = self._due_zone_scan()
            for s in settings.symbols:
                try:
                    if due or s not in self._zones:
                        self.scan_zones(s)
                    await self.monitor(s)
                except Exception as e:
                    bus.publish("error", {"symbol": s, "msg": str(e)})
                await asyncio.sleep(0.2)
            # Reconcile MT5 closes + update live MAE/MFE on the open book.
            try:
                self.reconciler.run()
            except Exception as e:
                bus.publish("error", {"symbol": "RECONCILE", "msg": str(e)})
            # Heartbeat: proves the loop is alive even when nothing triggers.
            open_n = sum(1 for s in settings.symbols if market_open(s))
            zones_n = sum(len(z) for z in self._zones.values())
            self.log.info(f"[CYCLE]    {len(settings.symbols)} symbols | "
                          f"{zones_n} zones held | {open_n} markets open")
            await asyncio.sleep(settings.scan_interval_s)
