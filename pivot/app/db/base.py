"""Engine + session factory. Swap SQLite↔Postgres with one env var, no code change."""
from contextlib import contextmanager
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings
from app.db.models import Base

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args, future=True)
_Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    Base.metadata.create_all(engine)


@contextmanager
def SessionLocal():
    """Usage: `with SessionLocal() as s: ...`"""
    s = _Session()
    try:
        yield s
    finally:
        s.close()
