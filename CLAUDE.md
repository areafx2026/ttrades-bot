# CLAUDE.md — TTrades Bot Projektkontext

> Diese Datei wird von Claude Code automatisch gelesen.
> Sie enthält den vollständigen Kontext aus der Entwicklungshistorie.
> **Immer aktuell halten nach größeren Änderungen.**

---

## Projekt-Übersicht

**Name:** ttrades-bot (Branch: `v2-mt5`)
**Stack:** TypeScript (Node.js), Python (Flask MT5-Bridge), SQLite, Express Dashboard (Port 3001)
**Repo:** https://github.com/areafx2026/ttrades-bot (Branch: v2-mt5)
**Broker:** Pepperstone UK Demo | Login: 62120008 | Start: €10.000
**Modus:** `TRADING_ENABLED=true` (Orders aktiv)

---

## Architektur

```
src/
  index.ts           — Hauptschleife, Scan-Zyklus, syncClosedTrades, Startup-Reconciliation
  fractalAnalyzer.ts — Strategie-Logik v2.4 (analyze / analyzeWeekend)
  tradeManager.ts    — Resiliente Trade/DB-Mechanik (Write-Ahead) — NOCH NICHT VOLLSTÄNDIG DEPLOYED
  mt5TradeExecutor.ts — MT5 Order-Execution, Lot-Berechnung
  database.ts        — SQLite Schema inkl. asset_class, spreads-Tabelle
  dashboard.ts       — Express Dashboard, Tabs: Trades/Equity/Win-Rate/Analyse/Symbole
  srAnalyzer.ts      — S/R Zonen-Berechnung (portiert von PineScript)
  marketHours.ts     — isMarketOpen(), isCrypto(), brokerToUtc(), utcToDisplay()
  tradeLogger.ts     — SQLite only (trades.json entfernt)
  reporter.ts        — Tagesbericht per Telegram (AI-Analyse deaktiviert)
  logger.ts          — Kategorien: BOOT/SETUP/TRADE/RISK/ERROR/WARN → Konsole + File
                       SYS/SCAN/SYNC/INFO → nur File
  currencyStrength.ts — Currency Strength Berechnung
  signalCache.ts     — 4h Signal-Cache
  rulesEngine.ts     — rules.txt Parser
  marketHours.ts     — Marktzeiten + brokerToUtc + isCrypto
mt5_server.py        — Flask Bridge zu MT5, File-Logging in logs/mt5server-*.log
```

---

## Aktuelle Strategie: v2.4

**Backtestvalidiert:** 957% über 10 Jahre, 72% Win-Rate (YouTube-Backtest-Video)

### Weekday (Mo-Fr, alle Forex-Symbole):
- **D1 Trend:** n=2 Lookback, 2×HH+HL = LONG / 2×LH+LL = SHORT
- **M15 Entry:** MSS (Market Structure Shift) — Close über letztem Swing High (LONG) / unter Swing Low (SHORT), n=6 Lookback
- **Kein H4, kein H1, keine Order Blocks, keine Zonen**

### Weekend (Sa-So, nur BTCUSD):
- **H4 Trend:** n=2 Lookback, 2×HH+HL / 2×LH+LL
- **M5 Entry:** MSS, n=6 Lookback

### Gemeinsame Parameter:
- **SL:** unter/über MSS-Kerze + Buffer (Forex: 2 Pips, BTC: 10 Pips)
- **TP:** 1.3:1 R:R
- **Risiko:** €100/Trade (dynamische Lot-Berechnung)
- **Min-Stop:** 5 Pips (JPY: 8 Pips, BTC: 50 Pips)
- **Max-Stop:** ATR14 × 0.75
- **Max Trades gleichzeitig:** 3 (aus rules.txt)

---

## Symbole

### Forex (Mo-Fr):
EURUSD, GBPUSD, USDJPY, USDCAD, AUDUSD, NZDUSD, EURGBP, EURJPY, EURAUD, EURCAD, GBPNZD, GBPJPY, AUDJPY, AUDNZD, AUDCAD, CADJPY, GBPCAD, GBPAUD

### Crypto (24/7):
BTCUSD (kein Cooldown, max 1 offene Position, Pip = $1)

---

## Zeitzone-Konventionen (WICHTIG!)

- **Pepperstone MT5:** UTC+3 während US DST (März-Nov), UTC+2 sonst
- **Intern (DB):** IMMER UTC — `brokerToUtc(deal.time)` beim Einlesen von MT5-Zeiten verwenden
- **Extern (Log/Dashboard):** `Europe/Berlin` (MEZ/MESZ = UTC+1/+2)
- **NIEMALS** `deal.time + 'Z'` direkt verwenden — immer `brokerToUtc(deal.time)`
- `brokerToUtc()` und `utcToDisplay()` sind in `marketHours.ts` exportiert

---

## DB Schema (wichtigste Felder)

```sql
trades: id, symbol, type, phase, entry_zone_low, entry_zone_high, entry_price,
        entry_distance_pips, stop_loss, stop_pips, target1, target2, risk_reward,
        session, weekday, opened_at, closed_at, hold_duration_min,
        daily_bias, h4_confirmation, h1_context, m15_setup,
        close_price, close_reason, pnl_pips, pnl_eur, result,
        mae_pips, mfe_pips, mae_price, mfe_price, mae_pct_of_sl, mfe_pct_of_tp,
        strategy_version, asset_class ('forex'/'crypto'), notes

spreads: symbol, recorded_at, bid, ask, spread_pips  -- alle 15 Min geloggt

strategy_log: version, description, changed_at, win_rate_before/after, trades_before/after
price_ticks: trade_id, recorded_at, price  -- für MAE/MFE Berechnung
filter_rejections: symbol, reason, rejected_at
```

**KRITISCH:** `insertTrade` braucht ALLE diese Felder, sonst wirft better-sqlite3 "Missing named parameter":
`zone_note`, `zone_status`, `exhaustion_detected`, `asset_class`, `strategy_version`, `entry_distance_pips`

---

## Bekannte Bugs & Fixes

### 1. insertTrade "Missing named parameter" (KRITISCH — immer wieder)
**Problem:** `insertTrade` in `index.ts` übergibt nicht alle Felder die im SQL-Statement stehen.
**Fix:** Folgende Felder müssen immer übergeben werden:
```typescript
zone_note: undefined,
zone_status: undefined,
exhaustion_detected: undefined,
asset_class: symbol === 'BTCUSD' ? 'crypto' : 'forex',
strategy_version: 'v2.4',
entry_distance_pips: Math.round(entryDistPips * 10) / 10,
```

### 2. brokerToUtc / Invalid time value
**Problem:** MT5 gibt Zeiten in Broker-Zeit (UTC+3/+2) zurück. Wenn wir `+ 'Z'` anhängen behandeln wir sie als UTC → falsche Zeiten in DB.
**Fix:** IMMER `brokerToUtc(deal.time)` statt `new Date(deal.time + 'Z').toISOString()`

### 3. Trades nicht im Dashboard
**Ursache A:** insertTrade schlägt fehl (siehe Bug 1)
**Ursache B:** syncClosedTrades erkennt Trade nicht weil nie in DB
**Fix:** Live-Reconciliation in syncClosedTrades — prüft bei jedem Zyklus ob MT5-Positionen in DB fehlen

### 4. History-Reconciliation "Invalid time value"
**Problem:** deal.time von MT5 hat kein 'Z' aber wir fügen es doppelt hinzu wenn Z bereits vorhanden.
**Fix:** `deal.time.endsWith('Z') ? deal.time : deal.time + 'Z'` — oder besser: `brokerToUtc(deal.time)`

---

## Resiliente Trade-Mechanik (tradeManager.ts)

**Status:** Implementiert aber noch nicht vollständig in index.ts integriert. Der alte Code läuft noch.

**Write-Ahead Prinzip:**
1. DB INSERT mit temp-id (`SYMBOL-YYYYMMDD-HHMMSS`)
2. MT5 order_send
3. MT5 positions_get → echte dealId + Fill-Preis → DB UPDATE
4. Bei Fehler → DB DELETE (temp-id)

**TLOG Logging:** Jeder DB-Schreibvorgang geloggt mit `[TLOG]` Prefix.

**TODO:** tradeManager.ts vollständig in index.ts integrieren (openTradeResilient, closeTradeResilient, reconcile)

---

## Startup-Reconciliation

Beim Bot-Start:
1. Temp-IDs in DB → MT5 positions_get → UPDATE mit echter dealId
2. MT5-Positionen ohne DB-Eintrag → INSERT
3. History der letzten 48h → TTFM Bot Trades die nicht in DB → INSERT + schließen falls zu

---

## syncClosedTrades

- Läuft bei jedem Scan-Zyklus (alle 2 Min für inaktive, 30s für aktive Symbole)
- MT5 ist Single Source of Truth
- History per `/history/position?ticket=X` (zuverlässiger als Zeitfenster)
- Live-Reconciliation: prüft ob MT5-Positionen in DB fehlen
- 20s Timeout damit der Scan nicht blockiert wird

---

## S/R Analyzer (srAnalyzer.ts)

**Parameter:** prd=5, loopback=250 D1-Kerzen, channelW=6%, minStrength=2, max 6 Zonen
**Filter-Regeln:**
- Preis IN Zone → Trade blockiert
- LONG + Resistance innerhalb 15 Pips → blockiert
- SHORT + Support innerhalb 15 Pips → blockiert
- LONG nahe Support → erlaubt (bestärkt, geloggt)
- SHORT nahe Resistance → erlaubt (bestärkt, geloggt)
- BTCUSD → S/R ausgenommen
- D1-Kerzen: 250 für Forex, 40 für BTCUSD

---

## Dashboard

- Port 3001
- Tabs: TRADES / EQUITY / WIN-RATE / ⏱ ANALYSE / SYMBOLE
- Asset-Filter: `?asset=forex` / `?asset=crypto`
- Licht-Theme (hell)
- S/R Zonen im Symbole-Tab (alle 60s aktualisiert)
- Analyse-Tab: Ø Haltedauer WIN/LOSS, MFE/MAE Ratio
- MT5-Status alle 10s gepollt
- "Offline" Status → rot

---

## MT5 Server (mt5_server.py)

**Port:** 5000
**Endpoints:**
- `GET /health` — Balance, Login
- `GET /candles?symbol=X&resolution=Y&count=N`
- `GET /tick?symbol=X`
- `GET /positions`
- `POST /positions/open` — Order senden (comment: "TTFM Bot")
- `DELETE /positions/<ticket>` — Position schließen (comment: "TTFM Close")
- `GET /history?hours=N&all=1` — History (lokale Zeit verwenden!)
- `GET /history/position?ticket=X` — History per Position-Ticket (zuverlässigster Endpoint)

**Logging:** `logs/mt5server-DD-MM-YYYY.log` — Werkzeug + eigene Logs
**Zeitzone:** `d.time` ist Broker-Zeit (UTC+3/+2) — beim Ausgeben `.isoformat()` + kein 'Z'

---

## Spread Logger

- Alle 15 Minuten: Bid/Ask/Spread für alle Forex-Symbole in `spreads` Tabelle
- Query für Statistiken: `getSpreadStats(days)` aus database.ts
- Ziel: Spread-Verhalten nach Tageszeit analysieren (London Open, NY Open, Nacht)

---

## Lot-Berechnung

```typescript
// Ziel: ~€100 Risiko pro Trade
// pip = 0.0001 (Forex), 0.01 (JPY), 1.0 (BTC)
// quoteEurRate = 1 / EURQUOTE (z.B. für USDCAD: 1/EURCAD)
// pipValuePer001Lot = pip × 1000 × quoteEurRate
// lots = (100 / (stopPips × pipValuePer001Lot)) × 0.01
// Min: 0.01, Max: 1.00 (Forex) / 0.10 (BTC)
```

---

## Coding-Konventionen

### Logger-Kategorien:
- `logger.boot()` — Startup (Konsole + File)
- `logger.setup()` — Signal gefunden (Konsole + File)
- `logger.trade()` — Trade geöffnet/geschlossen (Konsole + File)
- `logger.risk()` — Lot-Berechnung, R:R (Konsole + File)
- `logger.warn()` — Warnungen (Konsole + File)
- `logger.error()` — Fehler (Konsole + File)
- `logger.sys()` — System-Events (nur File)
- `logger.scan()` — Scan-Ergebnisse (nur File)
- `logger.sync()` — DB-Sync (nur File)
- `logger.info()` — Sonstiges (nur File)

### Zeitzone-Regel:
```typescript
// FALSCH:
new Date(deal.time + 'Z').toISOString()

// RICHTIG:
brokerToUtc(deal.time)  // aus './marketHours'
```

### insertTrade-Pflichtfelder:
Immer alle Felder übergeben — bei undefined explizit `undefined` setzen, nicht weglassen.

---

## Versionshistorie

| Version | Trades | WR | P&L | Zeitraum |
|---------|--------|-----|-----|----------|
| v1.5 | 1 | 100% | +€17.99 | — |
| v2.0 | 7 | 0% | -€517.50 | — |
| v2.1 | 10 | 50% | +€149.78 | — |
| v2.2 | 1 | 0% | -€56.04 | — |
| v2.3 | 4 | 25% | -€150.32 | — |
| v2.4 | 13 | 31% | — | bis 18.05.2026 |
| v2.5 | laufend | 75% (4 Trades) | +€136.58 | ab 20.05.2026 |

### v2.5 — TEST: Richtungs-Inversion
- **Kernidee:** D1+M15 MSS-Strategie identisch zu v2.4 — aber LONG↔SHORT invertiert
- **Hintergrund:** v2.4 zeigte nur 31% WR → Test ob Gegenteil profitabler ist
- **SL/TP:** werden symmetrisch um den Entry gespiegelt (`fix(v2.5): mirror SL and TP around entry price on inversion`)
- **TREND_TF:** konfigurierbar via Env-Variable, aktuell H4
- **Log-Kennzeichnung:** `[TEST INVERSION v2.5]` im SETUP-Log
- **Start:** Bot bootet mit `TTrades Bot v2.5 gestartet — [TEST: Richtungs-Inversion aktiv]`
- **Commits:** `3b26028`, `1f98fc2`, `6133428`

---

## Offene TODOs

1. **tradeManager.ts vollständig integrieren** — openTradeResilient statt direktem insertTrade in index.ts
2. **Spread-Analyse nach 2 Tagen** — `getSpreadStats(2)` auswerten, ggf. Nacht-Trading-Regel einbauen
3. **S/R Cache im Dashboard** — `setSrCacheRef` und `/api/sr-zones` in dashboard.ts, srCache aus index.ts übergeben
4. **D1 Kerzen für BTCUSD erhöhen** — aktuell 40, für bessere Swing-Erkennung auf 60-80 erhöhen

---

## Fix-Scripts (Root-Verzeichnis)

Für manuell nachzutragende Trades:
```
npx ts-node fix_eurjpy_13may.ts
npx ts-node fix_usdcad_14may.ts
npx ts-node fix_usdcad_15may.ts
```

---

## Wichtige Befehle

```bash
# Bot starten
npx ts-node src/index.ts

# MT5 Server starten (separates Terminal)
python mt5_server.py

# DB-Abfrage
npx ts-node -e "import {getDb} from './src/database'; const db=getDb(); console.log(JSON.stringify(db.prepare('SELECT id,symbol,closed_at,result,pnl_eur FROM trades ORDER BY opened_at DESC LIMIT 5').all(),null,2));"

# Spread-Statistiken
npx ts-node -e "import {getSpreadStats} from './src/database'; console.log(JSON.stringify(getSpreadStats(2),null,2));"

# Suchen im Log (Windows)
findstr /C:"TRADE" /C:"ERROR" /C:"SETUP" logs\bot-16-05-2026.log
```
