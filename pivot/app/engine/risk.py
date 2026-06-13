"""Position sizing + guardrails. The Guard is the safety layer that makes
'fully auto' responsible — kill-switch and exposure limits live here."""
from app.config import settings

_FALLBACK_EUR = {"USD": 0.92, "JPY": 0.0064, "GBP": 1.17, "CHF": 1.05,
                 "AUD": 0.60, "NZD": 0.55, "CAD": 0.68}


def pip_size(symbol: str) -> float:
    return 0.01 if "JPY" in symbol else 1.0 if symbol == "BTCUSD" else 0.0001


def position_size(broker, symbol: str, entry: float, sl: float, risk_eur: float) -> float:
    pip = pip_size(symbol)
    stop_pips = abs(entry - sl) / pip
    if stop_pips <= 0:
        return 0.0

    quote = symbol[-3:]
    rate = 1.0
    if quote != "EUR":
        try:
            t = broker.tick(f"EUR{quote}")
            rate = 1 / ((t["bid"] + t["ask"]) / 2)
        except Exception:
            rate = _FALLBACK_EUR.get(quote, 0.85)

    pip_val = pip * 1000 * rate                     # € per pip @ 0.01 lot
    lots = (risk_eur / (stop_pips * pip_val)) * 0.01
    return max(0.01, min(round(lots / 0.01) * 0.01, settings.max_lots))


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
