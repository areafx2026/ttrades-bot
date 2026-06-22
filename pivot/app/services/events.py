"""In-process pub/sub. The engine publishes; the WebSocket hub and the file
logger subscribe. Decouples producers from consumers — fan-out is async-safe."""
import asyncio


class EventBus:
    def __init__(self):
        self._subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def publish(self, kind: str, payload: dict) -> None:
        msg = {"kind": kind, **payload}
        for q in list(self._subs):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass


bus = EventBus()
