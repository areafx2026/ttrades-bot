# TTrades Fractal Model Bot — Deployment Guide
## Hetzner CX23 | PM2 | Telegram

---

## 1. Telegram Bot einrichten (einmalig)

### Bot erstellen:
1. Telegram öffnen → @BotFather schreiben
2. `/newbot` → Name: `TTrades Signal Bot` → Username: `ttrades_signal_bot`
3. **Token** kopieren → in `.env` als `TELEGRAM_BOT_TOKEN`

### Chat ID herausfinden:
```bash
# Bot einmal anschreiben, dann:
curl https://api.telegram.org/bot<TOKEN>/getUpdates
# "chat":{"id": 123456789} → das ist deine TELEGRAM_CHAT_ID
```

---

## 2. Capital.com API Key

1. Capital.com → Settings → API integrations → Generate new key
2. 2FA muss aktiv sein
3. API Key + dein Login-Passwort in `.env` eintragen
4. **Demo empfohlen** zum Testen: `CAPITAL_DEMO=true`

---

## 3. Server Setup

```bash
# Als user550398 auf Hetzner einloggen
ssh user550398@204.168.129.141

# Bot-Verzeichnis anlegen
mkdir -p /var/www/ttrades-bot
mkdir -p /var/log/ttrades-bot

# Dateien hochladen (von lokal aus):
scp -r ./ttrades-bot/* user550398@204.168.129.141:/var/www/ttrades-bot/

# Auf dem Server:
cd /var/www/ttrades-bot

# .env anlegen (nie ins Git!)
cp .env.example .env
nano .env   # Werte eintragen

# Dependencies installieren & bauen
npm install
npm run build

# PM2 starten
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # damit es nach Reboot startet
```

---

## 4. Testen

```bash
# Direkt ausführen (ohne Cron):
cd /var/www/ttrades-bot
node dist/index.js

# Logs live beobachten:
pm2 logs ttrades-bot

# Status:
pm2 status
```

---

## 5. Telegram Nachricht testen (ohne Capital API)

```bash
# Direkt testen ob Bot funktioniert:
curl -X POST https://api.telegram.org/bot<TOKEN>/sendMessage \
  -d chat_id=<CHAT_ID> \
  -d text="✅ TTrades Bot ist online"
```

---

## 6. Symbols erweitern

In `src/index.ts`:
```typescript
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY'];
```
Capital.com Epics: EURUSD, GBPUSD, USDJPY, GBPNZD, GBPAUD, EURCAD, OIL_CRUDE

---

## 7. Scan-Zeiten anpassen

Standard: 5 Minuten nach jedem 4H-Close + Daily Close (UTC).

Für mehr Granularität (z.B. auch 1H-Scans):
```typescript
// In index.ts, schedules array ergänzen:
'5 * * * *',  // jede Stunde
```

---

## 8. Git Integration (optional)

```bash
cd /var/www/ttrades-bot
git init
git remote add origin git@github.com:areafx2026/ttrades-bot.git
echo ".env" >> .gitignore
echo "node_modules/" >> .gitignore
echo "dist/" >> .gitignore
git add . && git commit -m "Initial TTrades Bot"
git push -u origin main
```

---

## Beispiel-Telegram Nachricht

```
🟢 TTFM Signal — EURUSD
📈 LONG | C4 Retest Entry
━━━━━━━━━━━━━━━━━━━━

📊 Daily Context
C4 Retest — wick into upper 50% of C3

🕐 4H Confirmation
4H CISD: bullish close above 1.14200 after sweep

⏱ 15M Setup
15M Protected Swing Low @ 1.14150 | FVG @ 1.14180

━━━━━━━━━━━━━━━━━━━━
🎯 Trade Levels
Current:      1.14200
Entry Zone:   1.14160 – 1.14175
Stop Loss:    1.14050  (−11.0 pips)
Target 1:     1.14380  (+22.0 pips)
Target 2:     1.14600  (+44.0 pips)
R:R           2.0:1

🔑 Key Levels
  • Recent D1 High: 1.19500
  • Recent D1 Low:  1.14120
  • 4H CISD Level:  1.14200
  • Protected Swing: 1.14150

❌ Invalidation
Close beyond: 1.14150

━━━━━━━━━━━━━━━━━━━━
🕐 Sun, 15 Mar 2026 22:05:00 GMT
```
