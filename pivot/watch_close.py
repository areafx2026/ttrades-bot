"""Watcher: blocks until trade 76042100 closes, then prints the full close-path
verification (DB row + events row + activity.log line) and exits 0. Runs until
the trade closes — no timeout — so it can be launched as a detached process
(see start_watcher.ps1) that outlives any chat session."""
import os
import sqlite3
import sys
import time
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(ROOT, "pivot.db")
LOG = os.path.join(ROOT, "logs", "activity.log")
TICKET = "76042100"
POLL_S = 60


def state():
    c = sqlite3.connect(DB, timeout=10)
    try:
        r = c.execute("SELECT state FROM trades WHERE ticket=?", (TICKET,)).fetchone()
        return r[0] if r else "GONE"
    finally:
        c.close()


def dump():
    c = sqlite3.connect(DB, timeout=10)
    cols = [d[1] for d in c.execute("PRAGMA table_info(trades)")]
    row = c.execute("SELECT * FROM trades WHERE ticket=?", (TICKET,)).fetchone()
    print("=== TRADE ROW (CLOSED) ===")
    for k, v in zip(cols, row):
        if k in ("symbol", "side", "state", "fill_price", "close_price", "pnl_eur",
                 "pnl_pips", "result", "hold_duration_min", "mae_pips", "mfe_pips",
                 "mae_pct_of_sl", "mfe_pct_of_tp", "opened_at", "closed_at"):
            print(f"  {k:18} = {v}")
    print("=== events: closed row ===")
    for r in c.execute("SELECT ts,kind,symbol,payload FROM events "
                       "WHERE kind='closed' ORDER BY id DESC LIMIT 3"):
        print(" ", r)
    print("  (events total:", c.execute("SELECT COUNT(*) FROM events").fetchone()[0], ")")
    c.close()
    print("=== activity.log [CLOSE] lines ===")
    try:
        with open(LOG, encoding="utf-8") as f:
            hits = [ln.rstrip() for ln in f if "[CLOSE]" in ln]
        for ln in hits[-3:]:
            print(" ", ln)
        if not hits:
            print("  (none yet)")
    except FileNotFoundError:
        print("  (log not found)")


print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] watcher started — polling every "
      f"{POLL_S}s until {TICKET} closes (no timeout)", flush=True)
i = 0
while True:
    st = state()
    if st in ("CLOSED", "GONE"):
        print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] DETECTED state={st} "
              f"after ~{i*POLL_S}s", flush=True)
        if st == "CLOSED":
            dump()
        else:
            print("Trade row missing — unexpected.", flush=True)
        sys.stdout.flush()
        raise SystemExit(0)
    i += 1
    time.sleep(POLL_S)
