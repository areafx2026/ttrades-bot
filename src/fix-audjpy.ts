// Run: cd /var/www/ttrades-bot && node dist/fix-audjpy.js
import 'dotenv/config';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');
const db = new Database(DB_PATH);

// Fix AUDJPY LONG trade — data from Capital.com screenshot
// Bot logged: BE, +0.0 pips, €0.00, close 111.198
// Real: WIN via TP at 112.893, close at 112.894, +€84.58

const trade = db.prepare("SELECT * FROM trades WHERE symbol = 'AUDJPY' AND type = 'LONG' AND opened_at LIKE '2026-04-%'").get() as any;

if (!trade) {
  console.log('AUDJPY trade not found');
  process.exit(1);
}

console.log('Found:', trade.id);
console.log('Before:', { result: trade.result, pnl_pips: trade.pnl_pips, pnl_eur: trade.pnl_eur, close_price: trade.close_price });

const realClosePrice = 112.894;
const realPnlEur = 84.58;
const pip = 0.01;
const entryPrice = trade.entry_price ?? (trade.entry_zone_low + trade.entry_zone_high) / 2;
const realPnlPips = Math.round(((realClosePrice - entryPrice) / pip) * 10) / 10;

db.prepare(`
  UPDATE trades SET
    close_price = ?,
    pnl_pips = ?,
    pnl_eur = ?,
    result = 'WIN',
    close_reason = 'TP',
    closed_at = '2026-04-13T16:28:00.000Z'
  WHERE id = ?
`).run(realClosePrice, realPnlPips, realPnlEur, trade.id);

console.log('After:', { close_price: realClosePrice, pnl_pips: realPnlPips, pnl_eur: realPnlEur, result: 'WIN' });

// Also fix trades.json
const JSON_PATH = path.join(process.cwd(), 'data', 'trades.json');
if (fs.existsSync(JSON_PATH)) {
  const trades = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const idx = trades.findIndex((t: any) => t.id === trade.id || t.dealId === trade.id);
  if (idx !== -1) {
    trades[idx].closePrice = realClosePrice;
    trades[idx].closedAt = '2026-04-13T16:28:00.000Z';
    trades[idx].pnlPips = realPnlPips;
    trades[idx].pnlEUR = realPnlEur;
    trades[idx].result = 'WIN';
    fs.writeFileSync(JSON_PATH, JSON.stringify(trades, null, 2), 'utf-8');
    console.log('trades.json fixed');
  }
}

console.log('Done.');
