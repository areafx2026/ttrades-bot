# Pivot v3.0 — S/R Area-of-Interest Trading Bot

A fully-automated support/resistance trading bot for MetaTrader 5, rebuilt from
scratch as a **single Python process** (FastAPI + `MetaTrader5` in-process +
React dashboard). No HTTP bridge — the v2 source of latency and disconnects is gone.

## Strategy

1. **Zones (D1):** detect fractal pivots, cluster them into price bands.
   A band is a valid *area of interest* only if it was tested **≥1× as support**
   (pivot low) **and ≥1× as resistance** (pivot high), with **≥4 bounces total**.
2. **Approach (H4):** when price comes within ~1 zone-width, watch the H4 candle
   ranges. **Contracting ranges = deceleration** → arm an entry.
3. **Entry:** fade the move into the **middle of the zone**
   (rising → SELL, falling → BUY).
4. **Stop:** one **zone-width beyond the far edge**.
5. **Target:** risk-reward **1.3**.

All parameters live in `app/config.py` / `.env`.

## Architecture

```
React SPA ──WS/REST──► FastAPI ──in-proc──► Engine ──► Strategy / Risk
                          │                    │
                          └── Broker (MT5 ABC) └── SQLAlchemy (SQLite→Postgres)
```

The `BrokerAdapter` ABC means cTrader/OANDA can be added without touching strategy code.

## Run (dev)

```bash
cd pivot
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -r requirements.txt
cp .env.example .env                                 # fill MT5 creds if needed
uvicorn app.main:app --reload --port 8000            # backend + engine

cd web && npm install && npm run dev                 # dashboard on :5173 (proxies API/WS)
```

## Run (prod, single artifact)

```bash
cd web && npm run build      # → web/dist
cd .. && uvicorn app.main:app --host 0.0.0.0 --port 8000   # serves API + SPA
```

## Tests

```bash
pytest          # strategy IP: pivots, zone validity, signal geometry — no MT5 needed
```

## Safety

Fully-auto execution is gated by `Guard`: kill-switch (`POST /api/control/kill`,
red button in the dashboard), max concurrent trades, one position per symbol, and a
per-currency exposure cap. Every auto trade stores the H4 deceleration snapshot that
triggered it (`trades.decel_snapshot`) for full auditability.
