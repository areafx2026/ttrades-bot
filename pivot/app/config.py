"""Central configuration — every tunable parameter lives here (12-factor / .env)."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # ── database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./pivot.db"

    # ── instruments ───────────────────────────────────────────────────────────
    symbols: list[str] = [
        "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "EURGBP", "EURJPY", "USDCAD",
    ]

    # ── strategy ──────────────────────────────────────────────────────────────
    pivot_left: int = 3            # fractal lookback left
    pivot_right: int = 3           # fractal lookback right
    zone_tolerance_atr: float = 0.5  # cluster band half-width = ATR(D1) * this
    min_touches: int = 4           # your rule: ≥4 bounces to be an area-of-interest
    approach_zones: float = 1.0    # alert when within N zone-widths of the edge
    entry_cooldown_min: int = 240  # after an entry attempt, wait this long (1 H4 bar)
    rr: float = 1.3                # take-profit risk-reward ratio
    d1_count: int = 300
    h4_count: int = 120
    zone_rescan_hours: int = 6     # how often to rebuild D1 zones

    # ── risk / guardrails ─────────────────────────────────────────────────────
    risk_eur: float = 100.0
    max_lots: float = 1.0
    max_open_trades: int = 3
    scan_interval_s: int = 60

    # ── broker (MT5) ──────────────────────────────────────────────────────────
    mt5_login: int | None = None
    mt5_password: str | None = None
    mt5_server: str | None = None

    # ── notifications ─────────────────────────────────────────────────────────
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None


settings = Settings()
