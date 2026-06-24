"""Engine + session factory. Swap SQLite↔Postgres with one env var, no code change."""
from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings
from app.db.models import Base

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args, future=True)
_Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


# Columns added after the first schema went live. create_all() never ALTERs an
# existing table, so on SQLite we add them by hand (idempotent). Prod (Postgres)
# would use a real migration tool.
_TRADE_ADD_COLUMNS = {
    "hold_duration_min": "INTEGER",
    "mae_price": "FLOAT", "mfe_price": "FLOAT",
    "mae_pips": "FLOAT", "mfe_pips": "FLOAT",
    "mae_pct_of_sl": "FLOAT", "mfe_pct_of_tp": "FLOAT",
}


def _migrate_sqlite() -> None:
    with engine.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(trades)")}
        for name, typ in _TRADE_ADD_COLUMNS.items():
            if name not in cols:
                conn.exec_driver_sql(f"ALTER TABLE trades ADD COLUMN {name} {typ}")


def init_db() -> None:
    Base.metadata.create_all(engine)
    if settings.database_url.startswith("sqlite"):
        _migrate_sqlite()


@contextmanager
def SessionLocal():
    """Usage: `with SessionLocal() as s: ...`"""
    s = _Session()
    try:
        yield s
    finally:
        s.close()
