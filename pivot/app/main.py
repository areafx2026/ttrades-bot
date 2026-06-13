"""Single entrypoint: FastAPI app + WebSocket + static SPA + engine lifespan.
Run with:  uvicorn app.main:app --reload --port 8000
"""
import asyncio
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db.base import init_db, SessionLocal
from app.brokers.mt5_adapter import MT5Adapter
from app.engine.risk import Guard
from app.engine.scanner import Scanner
from app.services.events import bus
from app.api import deps, routes_account, routes_zones, routes_trades, routes_control

broker = MT5Adapter(settings.mt5_login, settings.mt5_password, settings.mt5_server)
guard = Guard()
scanner = Scanner(broker, SessionLocal, guard)
deps.bind(broker, guard, scanner)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    try:
        broker.connect()
    except Exception as e:  # dashboard still serves even if MT5 is down
        print(f"[boot] MT5 connect failed: {e}")
    task = asyncio.create_task(scanner.run_forever())
    yield
    scanner.running = False
    task.cancel()


app = FastAPI(title="Pivot v3.0", version="3.0.0", lifespan=lifespan)
app.include_router(routes_account.router, prefix="/api")
app.include_router(routes_zones.router, prefix="/api")
app.include_router(routes_trades.router, prefix="/api")
app.include_router(routes_control.router, prefix="/api")


@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    q = bus.subscribe()
    try:
        while True:
            msg = await q.get()
            await socket.send_json(msg)
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(q)


# Serve the built React app if present (web/dist). Safe no-op in dev before build.
_dist = os.path.join(os.path.dirname(__file__), "..", "web", "dist")
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="web")
