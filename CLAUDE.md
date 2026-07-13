# CLAUDE.md — TTrades Bot Projektkontext

> Diese Datei wird von Claude Code automatisch gelesen.
> **Immer aktuell halten nach größeren Änderungen.**

---

## Projekt-Übersicht

**Name:** ttrades-bot
**Aktives System:** **Pivot v3.0** — S/R Area-of-Interest Bot (Branch: `v3-pivot`)
**Stack:** Python 3.13, FastAPI + Uvicorn, `MetaTrader5` (in-process, **keine** HTTP-Bridge), SQLAlchemy/SQLite, React-Dashboard
**Repo:** https://github.com/areafx2026/ttrades-bot
**Broker:** Pepperstone UK Demo, Login 62129554 — **Attach-Modus** (hängt sich an ein laufendes, eingeloggtes MT5-Terminal; `.env` MT5_* leer lassen)
**Modus:** Voll-automatisch, Orders aktiv (gated durch `Guard`)
**Dashboard/API:** http://127.0.0.1:8000 (v3) · http://127.0.0.1:8001 (v4, paralleles Modell — siehe unten)

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
                   close_reason(null|"stale_timeout"),
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
- **Zonen-Re-Entry-Sperre** (`_traded_zones`): eine Zone, die bereits einen Entry-Versuch ausgelöst hat,
  wird bis zum nächsten Rescan nicht erneut gehandelt — unabhängig vom (kürzeren) `entry_cooldown_min`
  pro Symbol. Behebt einen live beobachteten Fall: v4 faded EURJPY an einer Zone (WIN), der Kurs lief
  scharf zurück durch dieselbe, noch nicht neu gescannte Zone, und **dieselbe Zone** feuerte 76 Min
  später (nach Ablauf des 60-Min-Cooldowns, aber vor dem nächsten 2h-Rescan) erneut ein identisches
  Signal — das ging auf SL. Ein scharfer Reversal exakt durch eine gerade gehandelte Zone ist eher ein
  Signal gegen die These als eine neue unabhängige Gelegenheit.
- Am Zyklusende: `reconciler.run()` + Heartbeat-Logzeile `[CYCLE]`.

### Executor (`executor.py`)
- `Guard.allow()` → `position_size()` → `broker.order_send()` → **TP nachziehen** → DB-INSERT als OPEN (oder REJECTED).
- Schreibt **`fill_price`** = echter Ausführungspreis aus `order_send` (nicht der Zone-Mid-`entry`!).
- **TP-Re-Anchoring:** Das Signal plant den Entry in der Zonen-Mitte; die Market-Order füllt aber irgendwo
  im Zonenband. Nach dem Fill wird der TP per `broker.modify_position()` so neu gesetzt, dass das **RR
  relativ zum echten Fill** wieder `rr` (1.3) ist. Der **SL bleibt strukturell** (eine Zonenbreite hinter der
  fernen Kante). Ohne das driftet das realisierte RR (z. B. 0.84 statt 1.3, wenn der Preis schnell in die Zone lief).
  Der nachgezogene TP wird in `trades.tp` gespeichert; schlägt das Modify fehl, bleibt der ursprüngliche TP.

### Reconciler (`reconcile.py`) — die andere Hälfte, **MT5 = Single Source of Truth**
- Jeden Zyklus über alle OPEN-Trades:
  - **Noch im Open-Book** → `_track`: aktuellen Preis sampeln, MAE/MFE-Extreme live aktualisieren
    (Pips + %-Anteil von SL/TP werden laufend mitgerechnet, auch für offene Trades fürs Dashboard),
    dann die beiden aktiven Risk-Management-Checks (siehe unten).
  - **Weg aus dem Open-Book** → `_finalize`: `broker.closed_position(ticket)` holt close_price/realisierten P/L
    (Summe profit+swap+commission aller Deal-Legs)/closed_at → Row auf CLOSED, result, hold_duration, finale MAE/MFE.
    Publisht `closed`-Event (Sound + Recorder + `[CLOSE]`-Log).
- MAE/MFE wird zur Scan-Kadenz gesampelt (nicht tick-genau) → kurze Intrabar-Spikes können fehlen (für Trade-Qualitäts-Stats ok).

**Aktives Risk-Management auf offene Trades** (beide Checks laufen in `_track`, jeden Zyklus):
- **Breakeven-Trail** (`_maybe_trail_to_breakeven`): sobald `mfe_pct_of_tp >= breakeven_trigger_pct`
  (Default 0.6 = 60% des Weges zum TP erreicht), wird der SL per `broker.modify_position()` auf
  Entry ± aktuellen Spread nachgezogen (BUY: `ref + spread`, SELL: `ref − spread`) — ein Reversal kann
  den Trade danach nicht mehr ins Minus drehen. Nur einmal pro erreichtem Level (idempotent: zieht nur
  nach, wenn der neue SL eine echte Verbesserung wäre). Event `trail` → `[TRAIL]`-Log.
- **Zeit-Stop** (`_maybe_close_stale`): läuft ein Trade länger als `max_hold_min` **Markt-Minuten**
  (`market_hours.market_elapsed_minutes()` — bei Forex zählt das Wochenende **nicht** mit, ein
  Freitagabend-Trade tickt über Sa/So nicht weiter; Crypto zählt roh, da 24/7) UND der **aktuelle**
  Kurs hat noch nicht `stale_mfe_pct` (Default 0.4) des Weges zum TP zurückgelegt, wird per
  `broker.close()` geschlossen — die Deceleration/Fade-These hat sich nicht bestätigt. Bewusst **nicht**
  `mfe_pct_of_tp` (das laufende Maximum) für diesen Check: ein Trade, der einmal auf 40%+ gespiked ist
  und seitdem wieder zurückgefallen ist, wäre sonst für immer von der Zeit-Stop-Prüfung ausgenommen,
  obwohl er faktisch genauso feststeckt. `_live_pct_of_tp()` misst stattdessen live gegen Fill/TP.
  `_finalize()` verbucht den Close im nächsten Zyklus ganz normal (wie ein SL/TP-Hit). Event
  `stale_close` → `[STALE]`-Log.
- **Defaults sind an die jeweilige Entry-Timeframe gekoppelt**, nicht an eine feste Kalenderzeit: v3
  (H4-Entry) `MAX_HOLD_MIN=4800` (~20 H4-Bars ≈ 3,3 Tage), v4 (M15-Entry) `MAX_HOLD_MIN=330`
  (~22 M15-Bars ≈ 5,5 Std.) — in `.env`/`.env.v4` gesetzt.

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
  Event-Kinds: `zones`, `approach`, `fill`, `closed`, `reject`, `skip`, `error`, `trail`, `stale_close`.
- **file_logger** → `logs/<settings.log_file>` (Default `activity.log`, v4: `activity_v4.log`): greppbare
  Zeilen (`[ZONES] [APPROACH] [FILL] [CLOSE] [REJECT] [SKIP] [ERROR] [CYCLE]`).
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

## Pivot v4.0 — paralleles Modell

Zweite Instanz **derselben Codebasis** (`pivot/app` unverändert geforkt — kein Code-Duplikat), gestartet
mit einer zweiten `.env`-Datei. Ziel: Trade-Frequenz von ~1-3/Woche (v3, D1-Zonen/H4-Entry) auf ~1-3/Tag
heben, indem v4 eine Timeframe-Stufe tiefer arbeitet: **H4-Zonen / M15-Entry**, gelockerte Zonen-Validität.

| | v3 (aktiv, Standard) | v4 (parallel) |
|---|---|---|
| Port | 8000 | 8001 |
| `.env`-Datei | `.env` | `.env.v4` |
| DB | `pivot.db` | `pivot_v4.db` |
| `ZONE_TIMEFRAME` / `ENTRY_TIMEFRAME` | D1 / H4 | H4 / M15 |
| `MIN_TOUCHES` / `REQUIRE_BOTH_SIDES` | 4 / true | 2 / false |
| `MAGIC_NUMBER` / `ORDER_COMMENT` | 30000 / "Pivot v3" | 40000 / "Pivot v4" |
| `LOG_FILE` | `activity.log` | `activity_v4.log` |
| Start/Stop/Status | `start.ps1` / `stop.ps1` / `status.ps1` | `start_v4.ps1` / `stop_v4.ps1` / `status_v4.ps1` |

**Konfigurierbar gemacht, Default = exaktes v3-Verhalten:** `config.py` liest `.env` künftig über die
`PIVOT_ENV_FILE`-Umgebungsvariable (Default `.env`) — `start_v4.ps1` setzt sie auf `.env.v4`, bevor es den
Prozess startet. Timeframes/Zonen-Regel/Magic-Number/Log-Datei sind dadurch pro Instanz frei wählbar, ohne
den Code zu forken.

**Gleiches MT5-Konto, zwei Prozesse — das ist sicher, weil `Guard.allow()` (`risk.py`) den echten, geteilten
Broker-Positionsstand liest statt eines prozesslokalen Zählers:**
- "1 Position pro Symbol" und das Währungs-Exposure-Limit gelten **kontoweit** (bewusst geteilt — v4 kann
  kein Symbol öffnen, das v3 schon hält, und umgekehrt; live beobachtet: `[SKIP] BTCUSD: position already
  open`, `[SKIP] XRPUSD: currency exposure limit`, ausgelöst durch die jeweils andere Instanz).
- `max_open_trades` wird gegen dieselbe geteilte Zahl geprüft → das kontoweite Maximum ist effektiv
  `max(v3.max_open_trades, v4.max_open_trades)`, **nicht** die Summe.
- **Kill-Switch-Flatten ist pro Bot scharf gestellt:** `POST /control/kill?flatten=true` schließt nur noch
  Positionen mit dem eigenen `magic_number` (`routes_control.py`) — sonst hätte ein Klick auf v3s Kill-Switch
  auch v4s offene Trades mitgeschlossen.

**Vergleichsansicht:** `/compare` (neue Seite in der bestehenden SPA, `web/src/pages/ComparePage.tsx`,
über den Link oben rechts im Dashboard erreichbar) holt `GET /api/trades` + `GET /api/control/status` von
**beiden** Ports per Cross-Origin-Fetch (`CORSMiddleware` in `main.py` erlaubt `127.0.0.1:8000`/`8001`) und
zeigt Win-Rate/Trades-pro-Tag/Gesamt-P/L/Ø-R nebeneinander plus eine kumulierte-P/L-Kurve
(**nicht** Account-Equity — die wäre kontoweit geteilt und würde v3/v4 nicht trennbar machen).

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

# v4 (paralleles Modell, Port 8001) — analog
powershell -File start_v4.ps1
powershell -File stop_v4.ps1
powershell -File status_v4.ps1

# Dev direkt
cd pivot && uvicorn app.main:app --reload --port 8000

# DB-Abfrage (letzte Trades)
cd pivot && python -c "import sqlite3; c=sqlite3.connect('pivot.db'); [print(r) for r in c.execute('SELECT ticket,symbol,side,state,result,pnl_eur FROM trades ORDER BY id DESC LIMIT 5')]"

# Live mitlesen
Get-Content pivot\logs\activity.log -Wait        # PowerShell
```

---

## Aktueller Stand (Stand 2026-07-10)

- **Close-Sync + MAE/MFE + Fill-Writeback + DB-Recorder** gebaut, committed (`a5a0968`) und mit einem echten
  Trade durchgängig live verifiziert (GBPUSD SELL WIN, TP exakt getroffen, +€150.50; alle Pfade bestätigt:
  Finalisierung → `closed`-Event → `[CLOSE]`-Log → Broker→UTC-Konversion).
- Detachter Close-Watcher als Tooling committed (`64a03cf`).
- PR #1 hat `v3-pivot` in `v2-mt5` gemergt; weiterentwickelt wird auf **`v3-pivot`**.
- **Pivot v4.0** (paralleles H4/M15-Modell, Port 8001) gebaut und live verifiziert: beide Instanzen laufen
  gleichzeitig gegen dasselbe MT5-Terminal, geteilte Guard-Checks (Symbol/Exposure/max_open_trades) live
  bestätigt, getrennte Logs (`activity.log`/`activity_v4.log`), `/compare`-Seite lädt beide Backends per
  CORS. v4 hat in den ersten Minuten bereits ein Signal armiert (vs. v3s ~1-3/Woche) — Frequenz-Ziel damit
  strukturell erreichbar, Signalqualität (Win-Rate) noch nicht über echte Trades verifiziert.

## Offene TODOs

1. **Dashboard** auf die neuen Trade-Felder (fill/close/pnl_pips/MAE/MFE/hold_duration) ausbauen.
2. **Equity-Kurve** aus `account_snapshots` im Dashboard rendern.
3. **`v2-mt5`-Branch** löschen, sobald sicher nicht mehr gebraucht (optional).
4. **Backtest/Validierung** der Pivot-Strategie über längeren Zeitraum sammeln.
5. **v4-Signalqualität beobachten:** `/compare` regelmäßig prüfen (Win-Rate, Ø-R) — die gelockerten
   Kriterien (`MIN_TOUCHES=2`, `REQUIRE_BOTH_SIDES=false`) sind eine unvalidierte Annahme aus der
   Frequenz-Diskussion, nicht getestet gegen historische Daten.
