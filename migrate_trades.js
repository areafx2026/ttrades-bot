require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const JSON_FILE = './data/trades.json';
const DB_FILE   = './data/trades.db';

if (!fs.existsSync(JSON_FILE)) {
  console.log('trades.json not found');
  process.exit(1);
}

const trades = JSON.parse(fs.readFileSync(JSON_FILE, 'utf-8'));
const db = new Database(DB_FILE);

let imported = 0;
let skipped  = 0;

for (const t of trades) {
  const existing = db.prepare('SELECT id FROM trades WHERE id = ?').get(t.id);
  if (existing) { skipped++; continue; }

  try {
    db.prepare(`
      INSERT INTO trades (
        id, symbol, type, phase,
        entry_zone_low, entry_zone_high, entry_price,
        stop_loss, target1, target2, risk_reward,
        opened_at, closed_at, close_price,
        pnl_pips, pnl_eur, result,
        strategy_version
      ) VALUES (
        @id, @symbol, @type, @phase,
        @entry_zone_low, @entry_zone_high, @entry_price,
        @stop_loss, @target1, @target2, @risk_reward,
        @opened_at, @closed_at, @close_price,
        @pnl_pips, @pnl_eur, @result,
        @strategy_version
      )
    `).run({
      id:              t.id,
      symbol:          t.symbol,
      type:            t.type,
      phase:           t.phase,
      entry_zone_low:  t.entryZone?.[0] ?? null,
      entry_zone_high: t.entryZone?.[1] ?? null,
      entry_price:     t.entryZone ? (t.entryZone[0] + t.entryZone[1]) / 2 : null,
      stop_loss:       t.stopLoss,
      target1:         t.target1,
      target2:         t.target2,
      risk_reward:     t.riskReward,
      opened_at:       t.openedAt,
      closed_at:       t.closedAt ?? null,
      close_price:     t.closePrice ?? null,
      pnl_pips:        t.pnlPips ?? null,
      pnl_eur:         t.pnlEUR ?? null,
      result:          t.result ?? null,
      strategy_version: 'v1.0',
    });
    imported++;
    console.log(`Imported: ${t.symbol} ${t.type} [${t.result ?? 'OPEN'}] ${t.openedAt}`);
  } catch (err) {
    console.error(`Error importing ${t.id}:`, err.message);
  }
}

console.log(`\nDone: ${imported} imported, ${skipped} skipped`);
db.close();
