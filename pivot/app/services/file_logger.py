"""File logging of engine activity.

Strategy activity flows through the in-process event bus (zones / approach /
fill / reject / skip / error). The WebSocket hub forwards it to the dashboard;
this module forwards the same stream to a rotating text file so the run can be
followed with `Get-Content logs\activity.log -Wait` (or `tail -f`) — no browser
needed. The scanner also writes a per-cycle heartbeat directly via the same
logger so the file shows liveness even when no signal fires.
"""
import json
import logging
import os
from logging.handlers import RotatingFileHandler

from app.config import settings
from app.services.events import bus

_LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")


def get_activity_logger() -> logging.Logger:
    """Singleton logger writing readable one-liners to logs/<settings.log_file>.

    log_file defaults to activity.log (v3); a parallel instance (e.g. v4)
    points it at its own file via .env so the two bots' activity never
    interleaves in one log."""
    log = logging.getLogger("pivot.activity")
    if log.handlers:                       # already configured
        return log
    log.setLevel(logging.INFO)
    log.propagate = False
    os.makedirs(_LOG_DIR, exist_ok=True)
    handler = RotatingFileHandler(
        os.path.join(_LOG_DIR, settings.log_file),
        maxBytes=5_000_000, backupCount=5, encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%d %H:%M:%S"))
    log.addHandler(handler)
    return log


def format_event(msg: dict) -> str:
    """Turn a bus event into a compact, greppable line."""
    kind = msg.get("kind", "?")
    sym = msg.get("symbol", "")
    if kind == "zones":
        return f"[ZONES]    {sym}: {len(msg.get('zones', []))} valid area(s)"
    if kind == "approach":
        return (f"[APPROACH] {sym} mid={msg.get('mid')} price={msg.get('price')} "
                f"dist={msg.get('dist_norm')}w decel={msg.get('decelerating')} "
                f"dir={msg.get('direction')}")
    if kind == "fill":
        return (f"[FILL]     {sym} {msg.get('side')} {msg.get('lots')} lots @ "
                f"{msg.get('fill', msg.get('entry'))} SL={msg.get('sl')} "
                f"TP={msg.get('tp')} ticket={msg.get('ticket')}")
    if kind == "closed":
        return (f"[CLOSE]    {sym} {msg.get('side')} {msg.get('result')} "
                f"pnl={msg.get('pnl_eur')} @ {msg.get('close')} "
                f"ticket={msg.get('ticket')}")
    if kind == "reject":
        return f"[REJECT]   {sym}: {msg.get('error')}"
    if kind == "skip":
        return f"[SKIP]     {sym}: {msg.get('reason')}"
    if kind == "error":
        return f"[ERROR]    {sym}: {msg.get('msg')}"
    rest = {k: v for k, v in msg.items() if k != "kind"}
    return f"[{kind.upper()}] {json.dumps(rest, default=str)}"


async def run_file_logger() -> None:
    """Subscribe to the bus and append every event to the activity log.

    Runs for the app's lifetime; cancelled on shutdown by the lifespan handler.
    """
    log = get_activity_logger()
    q = bus.subscribe()
    log.info("[BOOT]     file logger attached")
    try:
        while True:
            msg = await q.get()
            log.info(format_event(msg))
    finally:
        bus.unsubscribe(q)
