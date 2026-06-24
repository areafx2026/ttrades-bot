@echo off
echo Starting TTFM Bot...

:: MT5 starten (falls nicht schon offen)
start "" "C:\Program Files\Pepperstone MetaTrader 5\terminal64.exe"

:: Kurz warten bis MT5 hochgefahren ist
timeout /t 12 /nobreak

:: Python MT5 Server starten
start "MT5 Server" cmd /k "cd /d C:\Users\User123\ttrades-bot && python mt5_server.py"

:: Kurz warten bis Server bereit ist
timeout /t 5 /nobreak

:: TTFM Bot starten
start "TTFM Bot" cmd /k "cd /d C:\Users\User123\ttrades-bot && npx ts-node src/index.ts"

echo Done. Zwei Fenster sollten sich geöffnet haben.