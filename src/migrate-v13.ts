// Run on server: cd /var/www/ttrades-bot && node dist/migrate-v13.js
import 'dotenv/config';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');
const db = new Database(DB_PATH);

// Insert v1.3 strategy log entry
const trades = db.prepare('SELECT result FROM trades WHERE closed_at IS NOT NULL').all() as any[];
const wins = trades.filter((t: any) => t.result === 'WIN').length;
const winRate = trades.length > 0 ? Math.round(wins / trades.length * 100) : null;

db.prepare(`INSERT INTO strategy_log (changed_at, version, description, changed_by, win_rate_before, trades_before)
VALUES (?, ?, ?, ?, ?, ?)`).run(
  new Date().toISOString(),
  'v1.3',
  [
    'v1.3 (151 Trading Strategies): ',
    '1) ATR(14)-normiertes Position Sizing — volatile Pairs (z.B. GBP/JPY) bekommen kleinere Positionsgroesse, ruhige Pairs (z.B. EUR/CHF) groessere. Referenz-ATR 80 Pips, Faktor 0.3–2.0. ',
    '2) HP-Filter fuer D1 Bias — Hodrick-Prescott-Glaettung der D1 Closes filtert High-Frequency-Noise. LONG nur wenn HP-Trend nicht BEARISH, SHORT nur wenn nicht BULLISH. Verhindert Fehlsignale durch einzelne Gegenkerzen. ',
    '3) Relative Mean-Reversion — statt fester 150-Pip-Schwelle jetzt z-Score basiert: (Return_i - Durchschnitt_alle) / Volatilitaet_i. Bei |z| > 1.5 wird Trade in ueberextendierter Richtung blockiert. Wirkt cross-pair-relativ.',
  ].join(''),
  'bot',
  winRate,
  trades.length
);

// Update all open trades to v1.3
db.prepare("UPDATE trades SET strategy_version = 'v1.3' WHERE closed_at IS NULL").run();

console.log('v1.3 migration done.');
console.log('Strategy log:');
console.log(db.prepare('SELECT * FROM strategy_log ORDER BY id DESC LIMIT 3').all());
