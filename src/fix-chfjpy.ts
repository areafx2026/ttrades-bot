// Run: cd /var/www/ttrades-bot && node dist/fix-chfjpy.js
import 'dotenv/config';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');
const db = new Database(DB_PATH);

// Fix CHFJPY trade — data from Capital.com screenshot
// Bot logged: BE, +0.0 pips, +€0.00
// Real: WIN via TP at 202.128, close at 202.130, +€81.56

// Find the CHFJPY trade
const trade = db.prepare("SELECT * FROM trades WHERE symbol = 'CHFJPY' AND type = 'LONG' AND opened_at LIKE '2026-04-08%'").get() as any;

if (!trade) {
  console.log('CHFJPY trade not found in DB');
  process.exit(1);
}

console.log('Found trade:', trade.id);
console.log('Current state:', {
  result: trade.result,
  pnl_pips: trade.pnl_pips,
  pnl_eur: trade.pnl_eur,
  close_price: trade.close_price,
  entry_price: trade.entry_price,
});

// Real values from Capital.com
const realClosePrice = 202.130;
const realPnlEur = 81.56;
const pip = 0.01; // JPY pair
const entryMid = (trade.entry_zone_low + trade.entry_zone_high) / 2;
const realPnlPips = Math.round(((realClosePrice - entryMid) / pip) * 10) / 10;

db.prepare(`
  UPDATE trades SET
    close_price = ?,
    pnl_pips = ?,
    pnl_eur = ?,
    result = 'WIN',
    close_reason = 'TP'
  WHERE id = ?
`).run(realClosePrice, realPnlPips, realPnlEur, trade.id);

console.log('Fixed:', {
  close_price: realClosePrice,
  pnl_pips: realPnlPips,
  pnl_eur: realPnlEur,
  result: 'WIN',
});

// Also fix trades.json
const JSON_PATH = path.join(process.cwd(), 'data', 'trades.json');
if (fs.existsSync(JSON_PATH)) {
  const trades = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const idx = trades.findIndex((t: any) => t.id === trade.id || t.dealId === trade.id);
  if (idx !== -1) {
    trades[idx].closePrice = realClosePrice;
    trades[idx].pnlPips = realPnlPips;
    trades[idx].pnlEUR = realPnlEur;
    trades[idx].result = 'WIN';
    fs.writeFileSync(JSON_PATH, JSON.stringify(trades, null, 2), 'utf-8');
    console.log('trades.json also fixed');
  }
}

console.log('Done.');
