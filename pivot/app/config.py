"""Central configuration — every tunable parameter lives here (12-factor / .env)."""
import os
from pydantic_settings import BaseSettings, SettingsConfigDict

# Selectable via PIVOT_ENV_FILE so a second bot instance (e.g. v4) can run the
# exact same codebase against a different .env, without forking anything.
_ENV_FILE = os.environ.get("PIVOT_ENV_FILE", ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_file_encoding="utf-8")

    # ── database ──────────────────────────────────────────────────────────────
    database_url: str = "sqlite:///./pivot.db"

    # ── instruments ───────────────────────────────────────────────────────────
    # Forex (Mon–Fri): majors + EUR crosses — but ONLY those for which the broker
    # serves historical candles. On this Pepperstone demo, NZDUSD / EURCHF / EURAUD
    # / EURCAD / EURNZD have live ticks but copy_rates returns nothing (no D1
    # history feed), which the zone strategy can't use and which stalls the scanner
    # ~4.5 min/symbol — so they are excluded until their history is available.
    # Plus the 5 most-traded cryptos (24/7, incl. weekends).
    symbols: list[str] = [
        # majors (with usable history)
        "EURUSD", "USDJPY", "GBPUSD", "USDCHF", "AUDUSD", "USDCAD",
        # EUR crosses (with usable history)
        "EURGBP", "EURJPY",
        # crypto
        "BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "DOGEUSD",
    ]

    # ── strategy ──────────────────────────────────────────────────────────────
    pivot_left: int = 3            # fractal lookback left
    pivot_right: int = 3           # fractal lookback right
    zone_tolerance_atr: float = 0.5  # cluster band half-width = ATR(D1) * this
    min_touches: int = 4           # your rule: ≥4 bounces to be an area-of-interest
    require_both_sides: bool = True  # zone must be tested as support AND resistance
    approach_zones: float = 1.0    # alert when within N zone-widths of the edge
    entry_cooldown_min: int = 240  # after an entry attempt, wait this long (1 H4 bar)
    rr: float = 1.3                # take-profit risk-reward ratio
    d1_count: int = 300
    h4_count: int = 120
    zone_rescan_hours: int = 6     # how often to rebuild zones
    # Timeframes the strategy runs on — v3 stays D1/H4 (defaults below); a
    # parallel instance (e.g. v4) can point these at H4/M15 via its own .env
    # without any code fork. zone_count/entry_count are the candle lookbacks
    # for scan_zones()/monitor() respectively (generalized d1_count/h4_count).
    zone_timeframe: str = "D1"
    entry_timeframe: str = "H4"
    zone_count: int = 300
    entry_count: int = 120

    # ── risk / guardrails ─────────────────────────────────────────────────────
    risk_eur: float = 300.0
    max_lots: float = 10.0
    max_open_trades: int = 3
    # A zone geometry that's too tight relative to the live spread produces
    # SL/TP the broker rejects as "invalid stops" (or that are already inside
    # the spread at fill). Require the stop distance to clear the spread by
    # this multiple before even attempting the order.
    min_stop_spread_mult: float = 3.0
    # Active risk management on open trades (checked every reconcile cycle):
    breakeven_trail_enabled: bool = True  # kill switch for the breakeven trail below
    breakeven_trigger_pct: float = 0.6   # MFE % of TP -> trail SL to breakeven+spread
    max_hold_min: int = 4800             # time-stop, in MARKET minutes (see market_hours)
    stale_mfe_pct: float = 0.4           # below this MFE %, max_hold_min triggers a close
    scan_interval_s: int = 60
    snapshot_interval_s: int = 300   # account_snapshots cadence (equity curve)

    # ── broker (MT5) ──────────────────────────────────────────────────────────
    mt5_login: int | None = None
    mt5_password: str | None = None
    mt5_server: str | None = None
    # Order tag — distinguishes this instance's positions on a shared account
    # (e.g. v3 vs. a parallel v4) both in the MT5 terminal and for the
    # kill-switch's flatten, which only ever touches its own magic number.
    magic_number: int = 30000
    order_comment: str = "Pivot v3"
    bot_name: str = "Pivot v3.0"
    log_file: str = "activity.log"   # a parallel instance (e.g. v4) points this at its own file


settings = Settings()
