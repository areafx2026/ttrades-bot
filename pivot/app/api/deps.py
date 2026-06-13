"""Shared singletons, wired once in main.py and read by the routers.
Avoids circular imports between main and the api package."""

broker = None
guard = None
scanner = None


def bind(b, g, s):
    global broker, guard, scanner
    broker, guard, scanner = b, g, s
