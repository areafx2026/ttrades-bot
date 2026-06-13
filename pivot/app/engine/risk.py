"""Position sizing + guardrails. The Guard is the safety layer that makes
'fully auto' responsible — kill-switch and exposure limits live here."""
from app.config import settings
from app.strategy.market_hours import is_crypto

_FALLBACK_EUR = {"USD": 0.92, "JPY": 0.0064, "GBP": 1.17, "CHF": 1.05,
                 "AUD": 0.60, "NZD": 0.55, "CAD": 0.68}


def _quote_to_eur(broker, symbol: str) -> float:
    """1 unit of the quote currency expressed in EUR."""
    quote = symbol[-3:]
    if quote == "EUR":
        return 1.0
    try:
        t = broker.tick(f"EUR{quote}")
        return 1 / ((t["bid"] + t["ask"]) / 2)
    except Exception:
        return _FALLBACK_EUR.get(quote, 0.85)


def position_size(broker, symbol: str, entry: float, sl: float, risk_eur: float) -> float:
    """Generic, broker-accurate sizing that works for forex AND crypto.

    risk_per_lot(€) = stop_distance(price) × contract_size × (quote→EUR)
    lots            = risk_eur / risk_per_lot, snapped to the symbol's volume step
                      and clamped to the broker's volume_min/max.
    No pip math — uses the symbol's real contract spec, so BTC (1 coin/lot) and
    DOGE (huge contract) and EURUSD (100k/lot) are all sized correctly."""
    dist = abs(entry - sl)
    if dist <= 0:
        return 0.0

    try:
        spec = broker.symbol_spec(symbol)
        contract = spec["contract_size"]
        vmin, vmax, step = spec["volume_min"], spec["volume_max"], spec["volume_step"]
    except Exception:
        contract, vmin, vmax, step = 100_000, 0.01, 100.0, 0.01

    q2e = _quote_to_eur(broker, symbol)
    risk_per_lot = dist * contract * q2e
    if risk_per_lot <= 0:
        return vmin

    lots = risk_eur / risk_per_lot
    lots = round(lots / step) * step

    # Forex keeps the configurable max_lots safety cap; crypto uses the broker's
    # real volume_max (a single forex-style "1.0 lot" cap would mis-size crypto).
    ceiling = min(vmax, settings.max_lots) if not is_crypto(symbol) else vmax
    return round(max(vmin, min(lots, ceiling)), 2)


class Guard:
    """Checked before every auto order. `enabled=False` is the kill-switch."""

    def __init__(self):
        self.enabled = True

    def allow(self, broker, symbol: str) -> tuple[bool, str]:
        if not self.enabled:
            return False, "kill-switch active"
        pos = broker.positions()
        if len(pos) >= settings.max_open_trades:
            return False, "max open trades"
        if any(p["symbol"] == symbol for p in pos):
            return False, "position already open"
        cur = {symbol[:3], symbol[3:6]}
        exposed = sum(1 for p in pos if cur & {p["symbol"][:3], p["symbol"][3:6]})
        if exposed >= 2:
            return False, "currency exposure limit"
        return True, "ok"
