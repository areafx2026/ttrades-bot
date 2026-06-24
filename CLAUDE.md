# CLAUDE.md — TTrades Bot Projektkontext

> Diese Datei wird von Claude Code automatisch gelesen.
> **Immer aktuell halten nach größeren Änderungen.**

---

## Projekt-Übersicht

**Name:** ttrades-bot
**Aktives System:** **Pivot v3.0** — S/R Area-of-Interest Bot (Branch: `v3-pivot`)
**Stack:** Python 3.13, FastAPI + Uvicorn, `MetaTrader5` (in-process, **keine** HTTP-Bridge), SQLAlchemy/SQLite, React-Dashboard
**Repo:** https://github.com/areafx2026/ttrades-bot
**Broker:** Pepperstone UK Demo, Login 62120008 — **Attach-Modus** (hängt sich an ein laufendes, eingeloggtes MT5-Terminal; `.env` MT5_* leer lassen)
**Modus:** Voll-automatisch, Orders aktiv (gated durch `Guard`)
**Dashboard/API:** http://127.0.0.1:8000

> **Hinweis zu „v2":** Der alte TypeScript/Node-Bot (`src/`, `mt5_server.py`, Flask-Bridge) ist **abgelöst**. Er bleibt im Repo liegen, wird aber nicht mehr weiterentwickelt oder betrieben. Alles Neue passiert im Verzeichnis `pivot/` auf Branch `v3-pivot`. Der frühere Branch `v2-mt5` wird nicht mehr genutzt.

---

## Architektur

Alles liegt unter `pivot/`. Ein einziger Python-Prozess (FastAPI) hält Engine, Broker, DB und serviert das Dashboard.

```
React SPA ──WS/REST──► FastAPI ──in-proc──► Engine ──► Strategy / Risk
                          │                    │
                          └── Broker (MT5 ABC) └── SQLAlchemy (SQLite→Postgres)

pivot/app/
  main.py              — FastAPI-Entrypoint, Lifespan startet: scanner-Loop,
                         file_logger, event_recorder, account_snapshots; WS /ws
  config.py            — alle Parameter (pydantic-settings, .env)
  api/
    deps.py            — Singletons (broker/guard/scanner), in main.py gebunden
    routes_account.py  — GET /api/account (Balance/Equity/Margin + Positionen)
    routes_trades.py   — GET /api/trades (inkl. fill/close/pnl/MAE/MFE)
    routes_zones.py    — GET /api/zones
    routes_control.py  — POST /api/control/kill|resume|scan, GET /status
  brokers/
    base.py            — BrokerAdapter ABC (venue-agnostisch)
    mt5_adapter.py     — MetaTrader5 direkt; order_send, positions, closed_position,
                         candles, tick, account, symbol_spec; Reconnect zentral hier
  db/
    base.py            — Engine + SessionLocal + init_db + SQLite-Migration
    models.py          — Zone, Trade, AccountSnapshot, Event
  engine/
    scanner.py         — Hauptschleife: D1-Zonen bauen, H4 monitoren, Reconcile
    executor.py        — Order platzieren: Guard → Sizing → order_send → DB-INSERT
    reconcile.py       — Reconciler: Close-Detection + Live-MAE/MFE (MT5 = Truth)
    risk.py            — position_size() + Guard (Kill-Switch, Exposure-Limits)
  services/
    events.py          — In-Process Event-Bus (pub/sub, fan-out an WS + Logger + Recorder)
    file_logger.py     — Event-Stream → logs/activity.log (greppbare Zeilen)
    recorder.py        — Event-Stream → events-Tabelle; periodische account_snapshots
  strategy/
    pivots.py          — Fraktal-Pivots (strikte Extrema, left/right=3)
    zones.py           — Pivots → Zonen clustern + Validitätsregel
    deceleration.py    — H4 Approach + Deceleration (Range-Kontraktion)
    signals.py         — Zone + Approach → Signal (Fade-the-move)
    market_hours.py    — market_open(), is_crypto(), pip_size()
  web/                 — React-Dashboard (gebaut nach web/dist, von FastAPI serviert)
```

---

## Strategie (Pivot v3.0)

Eine reine S/R-Area-of-Interest-Strategie — **kein** MSS/Trend-Modell mehr (das war v2).

1. **Zonen (D1):** Fraktal-Pivots finden, nach Preis clustern. Eine Zone ist nur dann
   ein gültiger *Area of Interest*, wenn sie **≥1× als Support** (Pivot-Low) **und
   ≥1× als Resistance** (Pivot-High) getestet wurde, mit **≥`min_touches` (4) Bounces** gesamt.
   Cluster-Bandbreite = `ATR(D1) × zone_tolerance_atr (0.5)`, am tiefsten Pivot verankert
   (verhindert „durchkettende" Riesen-Zonen).
2. **Approach (H4):** Kommt der Preis bis ~`approach_zones` (1) Zonenbreite heran, werden
   die H4-Kerzen-Ranges geprüft. **Strikt schrumpfende Ranges = Deceleration** → Entry armen.
   Richtung = `rising`/`falling` (Close vs. Close vor `lookback` Kerzen).
3. **Entry:** Move faden, in die **Mitte der Zone** (`zone.mid`):
   - Preis **steigt** in die Zone → **SELL**
   - Preis **fällt** in die Zone → **BUY**
   - Armt nur, wenn Preis **in** der Zone **und** decelerating ist.
4. **Stop:** eine **Zonenbreite hinter der fernen Kante** (SELL: `edge_high + width`, BUY: `edge_low - width`).
5. **Target:** R:R **1.3**.
6. **Cooldown:** nach einem Entry-Versuch `entry_cooldown_min` (240 = 1 H4-Bar) warten.

Jeder Auto-Trade speichert den auslösenden H4-Deceleration-Snapshot in `trades.decel_snapshot` (Audit).

---

## Konfiguration (`app/config.py` / `.env`)

| Parameter | Default | Bedeutung |
|---|---|---|
| `pivot_left` / `pivot_right` | 3 / 3 | Fraktal-Lookback |
| `zone_tolerance_atr` | 0.5 | Cluster-Bandbreite = ATR(D1) × dies |
| `min_touches` | 4 | Mindest-Bounces für gültige Zone |
| `approach_zones` | 1.0 | Alert ab N Zonenbreiten Distanz |
| `entry_cooldown_min` | 240 | Pause nach Entry-Versuch |
| `rr` | 1.3 | Take-Profit Risk-Reward |
| `d1_count` / `h4_count` | 300 / 120 | Kerzenanzahl |
| `zone_rescan_hours` | 6 | wie oft D1-Zonen neu gebaut werden |
| `risk_eur` | 100 | Risiko pro Trade |
| `max_lots` | 1.0 | Lot-Cap (nur Forex; Crypto nutzt volume_max) |
| `max_open_trades` | 3 | gleichzeitig offene Trades |
| `scan_interval_s` | 60 | Loop-Intervall |
| `snapshot_interval_s` | 300 | account_snapshots-Kadenz |

### Symbole (12)
**Forex (Mo–Fr):** EURUSD, GBPUSD, USDJPY, AUDUSD, EURGBP, EURJPY, USDCAD
**Crypto (24/7, auch Wochenende):** BTCUSD, ETHUSD, SOLUSD, XRPUSD, DOGEUSD

---

## DB-Schema (`app/db/models.py`)

```
zones:             id, symbol, edge_low, edge_high, mid, width, touches,
                   tests_support, tests_resist, pivots(JSON), state, last_touch_at, ...
trades:            id, ticket(MT5-Position), zone_id, symbol, side, state(PENDING/OPEN/CLOSED/REJECTED),
                   entry, sl, tp, lots, risk_eur, rr,
                   fill_price, close_price, pnl_eur, pnl_pips, result(WIN/LOSS/BE),
                   opened_at, closed_at, hold_duration_min,
                   mae_price, mfe_price, mae_pips, mfe_pips, mae_pct_of_sl, mfe_pct_of_tp,
                   decel_snapshot(JSON)
account_snapshots: id, ts, balance, equity, margin, open_positions
events:            id, ts, kind, symbol, payload(JSON)
```

**Migration (SQLite):** `create_all()` legt fehlende Tabellen an, **ALTERt aber keine bestehenden**.
Neue Spalten werden deshalb in `db/base.py::_migrate_sqlite()` idempotent per `ALTER TABLE … ADD COLUMN`
nachgezogen (geprüft via `PRAGMA table_info`). Beim Hinzufügen neuer Spalten: dort **und** im Model eintragen.

---

## Engine

### Scanner-Loop (`scanner.py`)
- Pro Zyklus (`scan_interval_s`): für jedes Symbol Zonen bauen (alle `zone_rescan_hours`), dann H4 monitoren.
- `market_open(symbol)` gated: Forex Mo–Fr (ca. So 21:00 → Fr 21:00 UTC), Crypto 24/7. Verhindert Reject-Spam.
- Am Zyklusende: `reconciler.run()` + Heartbeat-Logzeile `[CYCLE]`.

### Executor (`executor.py`)
- `Guard.allow()` → `position_size()` → `broker.order_send()` → DB-INSERT als OPEN (oder REJECTED).
- Schreibt **`fill_price`** = echter Ausführungspreis aus `order_send` (nicht der Zone-Mid-`entry`!).

### Reconciler (`reconcile.py`) — die andere Hälfte, **MT5 = Single Source of Truth**
- Jeden Zyklus über alle OPEN-Trades:
  - **Noch im Open-Book** → `_track`: aktuellen Preis sampeln, MAE/MFE-Extreme live aktualisieren
    (Pips + %-Anteil von SL/TP werden laufend mitgerechnet, auch für offene Trades fürs Dashboard).
  - **Weg aus dem Open-Book** → `_finalize`: `broker.closed_position(ticket)` holt close_price/realisierten P/L
    (Summe profit+swap+commission aller Deal-Legs)/closed_at → Row auf CLOSED, result, hold_duration, finale MAE/MFE.
    Publisht `closed`-Event (Sound + Recorder + `[CLOSE]`-Log).
- MAE/MFE wird zur Scan-Kadenz gesampelt (nicht tick-genau) → kurze Intrabar-Spikes können fehlen (für Trade-Qualitäts-Stats ok).

### Risk / Guard (`risk.py`)
- `position_size()`: broker-genau via `symbol_spec` (contract_size/volume_step/min/max), **kein** Pip-Math →
  korrekt für Forex **und** Crypto. `risk_per_lot = stop_distance × contract × (quote→EUR)`.
- `Guard.allow()`: Kill-Switch (`enabled=False`), `max_open_trades`, 1 Position/Symbol, Währungs-Exposure-Limit (≥2 blockt).

---

## Broker-Adapter (`mt5_adapter.py`)

- **In-Process** `MetaTrader5`-Calls, kein HTTP. Reconnect zentral in `connect()`/`_ensure()`.
- `closed_position(ticket)`: liest Closing-Deal aus History, summiert P/L über alle Legs.
- `symbol_spec`, `candles` (D1/H4/H1), `tick`, `positions`, `account`.

### Zeitzone-Konvention (WICHTIG)
- MT5 liefert Server-Zeit (Pepperstone = UTC+2/+3, DST). **Nicht hardcoden.**
- `mt5_adapter._broker_utc_offset_h()` leitet den Offset **live aus einem Tick** ab (Epoch ist TZ-frei →
  Differenz Broker-Tick-Zeit zu echtem UTC = Offset). `closed_at` wird damit korrekt nach **UTC** umgerechnet.
- `opened_at`/Recorder-Zeiten sind UTC (`datetime.utcnow()` / SQLite `func.now()`). Dashboard/Logfile zeigen lokal (Berlin).

---

## Services / Logging

- **Event-Bus** (`events.py`): Producer = Engine; Consumer = WebSocket-Hub, file_logger, recorder.
  Event-Kinds: `zones`, `approach`, `fill`, `closed`, `reject`, `skip`, `error`.
- **file_logger** → `logs/activity.log`: greppbare Zeilen (`[ZONES] [APPROACH] [FILL] [CLOSE] [REJECT] [SKIP] [ERROR] [CYCLE]`).
- **recorder** → DB: persistiert sinnvolle Events in `events` (`approach`/`zones` werden als Rauschen übersprungen)
  und schreibt alle `snapshot_interval_s` einen `account_snapshots`-Eintrag (Equity-Kurve).

---

## Steuerung (Windows, detached)

Aus `pivot\` — laufen als eigenständige Hintergrundprozesse (nicht an eine Terminal-Session gebunden):

| Script | Funktion |
|---|---|
| `start.cmd` / `start.ps1` | Engine hidden starten, PID → `run\server.pid`, Logs → `logs\server.*.log` |
| `stop.cmd` / `stop.ps1` | Engine per PID stoppen |
| `status.cmd` / `status.ps1` | RUNNING/STOPPED + Live-API/Account-Check |
| `start_watcher.ps1` | Detachter Trade-Close-Watcher (`watch_close.py`) → `logs/close_verify.log`, kein Timeout |

Dashboard: http://127.0.0.1:8000 · Kill-Switch: `POST /api/control/kill` (roter Button im Dashboard).

---

## Tests

```bash
cd pivot && pytest      # Strategie-IP: pivots, zone validity, signal geometry — kein MT5 nötig
```

---

## Wichtige Befehle

```bash
# Engine starten/stoppen/status (aus pivot\)
powershell -File start.ps1
powershell -File stop.ps1
powershell -File status.ps1

# Dev direkt
cd pivot && uvicorn app.main:app --reload --port 8000

# DB-Abfrage (letzte Trades)
cd pivot && python -c "import sqlite3; c=sqlite3.connect('pivot.db'); [print(r) for r in c.execute('SELECT ticket,symbol,side,state,result,pnl_eur FROM trades ORDER BY id DESC LIMIT 5')]"

# Live mitlesen
Get-Content pivot\logs\activity.log -Wait        # PowerShell
```

---

## Aktueller Stand (Stand 2026-06-24)

- **Close-Sync + MAE/MFE + Fill-Writeback + DB-Recorder** gebaut, committed (`a5a0968`) und mit einem echten
  Trade durchgängig live verifiziert (GBPUSD SELL WIN, TP exakt getroffen, +€150.50; alle Pfade bestätigt:
  Finalisierung → `closed`-Event → `[CLOSE]`-Log → Broker→UTC-Konversion).
- Detachter Close-Watcher als Tooling committed (`64a03cf`).
- PR #1 hat `v3-pivot` in `v2-mt5` gemergt; weiterentwickelt wird auf **`v3-pivot`**.

## Offene TODOs

1. **Dashboard** auf die neuen Trade-Felder (fill/close/pnl_pips/MAE/MFE/hold_duration) ausbauen.
2. **Equity-Kurve** aus `account_snapshots` im Dashboard rendern.
3. **`v2-mt5`-Branch** löschen, sobald sicher nicht mehr gebraucht (optional).
4. **Backtest/Validierung** der Pivot-Strategie über längeren Zeitraum sammeln.
