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
        for p in deps.broker.positions():
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
    return {"auto_enabled": deps.guard.enabled,
            "symbols": settings.symbols,
            "risk_eur": settings.risk_eur,
            "rr": settings.rr,
            "min_touches": settings.min_touches}
