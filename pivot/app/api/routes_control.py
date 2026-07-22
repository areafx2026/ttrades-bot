"""Operational controls. The kill-switch is the most important endpoint in a
fully-auto bot — halt auto-execution instantly, optionally flatten everything."""
from fastapi import APIRouter
from app.api import deps
from app.config import settings

router = APIRouter()


@router.post("/control/kill")
def kill(flatten: bool = False):
    deps.guard.enabled = False
    flattened = 0
    if flatten:
        # Scoped to this instance's own magic number — on a shared account
        # (e.g. v3 + v4 both trading it) this must never touch the other
        # bot's open positions.
        for p in deps.broker.positions():
            if p.get("magic") != settings.magic_number:
                continue
            r = deps.broker.close(p["ticket"])
            flattened += 1 if r.get("ok") else 0
    return {"enabled": deps.guard.enabled, "flattened": flattened}


@router.post("/control/resume")
def resume():
    deps.guard.enabled = True
    return {"enabled": True}


@router.post("/control/scan")
def force_scan():
    for s in settings.symbols:
        deps.scanner.scan_zones(s)
    return {"rescanned": settings.symbols}


@router.get("/control/status")
def status():
    try:
        broker_offset_h = deps.broker._broker_utc_offset_h()
    except Exception:
        broker_offset_h = 0   # e.g. MT5 unreachable — dashboard falls back to UTC labels
    return {"auto_enabled": deps.guard.enabled,
            "symbols": settings.symbols,
            "risk_eur": settings.risk_eur,
            "rr": settings.rr,
            "min_touches": settings.min_touches,
            "bot_name": settings.bot_name,
            "zone_timeframe": settings.zone_timeframe,
            "entry_timeframe": settings.entry_timeframe,
            "broker_utc_offset_h": broker_offset_h,
            "hour_blackout_hours": settings.hour_blackout_hours if settings.hour_blackout_enabled else []}
