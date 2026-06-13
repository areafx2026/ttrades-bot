"""ORM models — works identically on SQLite (dev) and Postgres (prod)."""
import enum
from sqlalchemy import (Column, Integer, String, Float, DateTime, ForeignKey,
                        JSON, Enum as SAEnum, func)
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Side(str, enum.Enum):
    BUY = "BUY"
    SELL = "SELL"


class ZoneState(str, enum.Enum):
    WATCH = "WATCH"
    APPROACHING = "APPROACHING"
    ARMED = "ARMED"
    TRADED = "TRADED"
    INVALID = "INVALID"


class TradeState(str, enum.Enum):
    PENDING = "PENDING"
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    REJECTED = "REJECTED"


class Zone(Base):
    __tablename__ = "zones"
    id = Column(Integer, primary_key=True)
    symbol = Column(String, index=True, nullable=False)
    edge_low = Column(Float, nullable=False)
    edge_high = Column(Float, nullable=False)
    mid = Column(Float, nullable=False)
    width = Column(Float, nullable=False)
    touches = Column(Integer, nullable=False)         # total bounces (>= 4)
    tests_support = Column(Integer, nullable=False)    # from above (pivot lows)
    tests_resist = Column(Integer, nullable=False)     # from below (pivot highs)
    pivots = Column(JSON)                              # [{price, time, kind}, ...]
    state = Column(SAEnum(ZoneState), default=ZoneState.WATCH, index=True)
    last_touch_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    trades = relationship("Trade", back_populates="zone")


class Trade(Base):
    __tablename__ = "trades"
    id = Column(Integer, primary_key=True)
    ticket = Column(String, unique=True, index=True)   # MT5 position id
    zone_id = Column(Integer, ForeignKey("zones.id"))
    symbol = Column(String, index=True, nullable=False)
    side = Column(SAEnum(Side), nullable=False)
    state = Column(SAEnum(TradeState), default=TradeState.PENDING, index=True)
    entry = Column(Float)
    sl = Column(Float)
    tp = Column(Float)
    lots = Column(Float)
    risk_eur = Column(Float)
    rr = Column(Float, default=1.3)
    fill_price = Column(Float)
    close_price = Column(Float)
    pnl_eur = Column(Float)
    pnl_pips = Column(Float)
    result = Column(String)                            # WIN / LOSS / BE
    opened_at = Column(DateTime)
    closed_at = Column(DateTime)
    decel_snapshot = Column(JSON)                      # H4 ranges at entry (audit)
    zone = relationship("Zone", back_populates="trades")


class AccountSnapshot(Base):
    __tablename__ = "account_snapshots"
    id = Column(Integer, primary_key=True)
    ts = Column(DateTime, server_default=func.now())
    balance = Column(Float)
    equity = Column(Float)
    margin = Column(Float)
    open_positions = Column(Integer)


class Event(Base):
    __tablename__ = "events"
    id = Column(Integer, primary_key=True)
    ts = Column(DateTime, server_default=func.now(), index=True)
    kind = Column(String, index=True)
    symbol = Column(String)
    payload = Column(JSON)
