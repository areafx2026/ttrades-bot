const db = require('better-sqlite3')('/var/www/ttrades-bot/data/trades.db');

const updates = [
  // EURUSD - Size 1000, Entry 1.14776, Close 1.14771
  { symbol: 'EURUSD', size: 1000, entry: 1.14776, close: 1.14771, pnl_eur: -0.04, pnl_pips: -0.5, result: 'LOSS' },
  // EURCAD - Size 59500, Entry 1.58082, Close 1.57841
  { symbol: 'EURCAD', size: 59500, entry: 1.58082, close: 1.57841, pnl_eur: -90.83, pnl_pips: -24.1, result: 'LOSS' },
  // AUDNZD - Size 100000, Entry 1.21206, Close 1.21018
  { symbol: 'AUDNZD', size: 100000, entry: 1.21206, close: 1.21018, pnl_eur: -95.12, pnl_pips: -18.8, result: 'LOSS' },
  // EURJPY - Size 22300, Entry 183.590, Close 182.936
  { symbol: 'EURJPY', size: 22300, entry: 183.590, close: 182.936, pnl_eur: -79.71, pnl_pips: -65.4, result: 'LOSS' },
  // CHFJPY SHORT - Size 21900, Entry 200.709, Close 200.378
  { symbol: 'CHFJPY', size: 21900, entry: 200.709, close: 200.378, pnl_eur: 39.70, pnl_pips: 33.1, result: 'WIN' },
  // GBPAUD - Size 21500, Entry 1.88971, Close 1.89482
  { symbol: 'GBPAUD', size: 21500, entry: 1.88971, close: 1.89482, pnl_eur: 67.11, pnl_pips: 51.1, result: 'WIN' },
  // GBPCHF 1 (Bug) - Size 59900, Entry 1.05761, Close 1.05515
  { symbol: 'GBPCHF', size: 59900, entry: 1.05761, close: 1.05515, pnl_eur: -161.46, pnl_pips: -24.6, result: 'LOSS', id: 'o_212c552b-06e5-4e6f-a36e-344e7b83a464' },
  // GBPCHF 2 - Size 5000, Entry 1.05828, Close 1.05912
  { symbol: 'GBPCHF', size: 5000, entry: 1.05828, close: 1.05912, pnl_eur: 4.58, pnl_pips: 8.4, result: 'WIN', id: 'o_70c3b505-6a2d-4b75-96e5-a1ddf7c98047' },
  // GBPCAD SHORT - Size 5000, Entry 1.83981, Close 1.84646
  { symbol: 'GBPCAD', size: 5000, entry: 1.83981, close: 1.84646, pnl_eur: -20.82, pnl_pips: -15.2, result: 'LOSS' },
];

for (const u of updates) {
  let result;
  if (u.id) {
    result = db.prepare(`
      UPDATE trades SET
        size_points = @size,
        entry_price = @entry,
        close_price = @close,
        pnl_eur = @pnl_eur,
        pnl_pips = @pnl_pips,
        result = @result
      WHERE id = @id
    `).run({ size: u.size, entry: u.entry, close: u.close, pnl_eur: u.pnl_eur, pnl_pips: u.pnl_pips, result: u.result, id: u.id });
  } else {
    result = db.prepare(`
      UPDATE trades SET
        size_points = @size,
        entry_price = @entry,
        close_price = @close,
        pnl_eur = @pnl_eur,
        pnl_pips = @pnl_pips,
        result = @result
      WHERE symbol = @symbol AND result != 'WIN' OR symbol = @symbol AND result != 'LOSS'
    `).run({ size: u.size, entry: u.entry, close: u.close, pnl_eur: u.pnl_eur, pnl_pips: u.pnl_pips, result: u.result, symbol: u.symbol });
  }
  console.log(`${u.symbol}: ${result.changes} row(s) updated`);
}

// Verify
const all = db.prepare('SELECT symbol, type, size_points, entry_price, close_price, pnl_eur, result FROM trades ORDER BY opened_at').all();
console.log('\nFinal state:');
all.forEach(t => console.log(`${t.symbol} ${t.type} | Size: ${t.size_points} | Entry: ${t.entry_price} | Close: ${t.close_price} | P&L: €${t.pnl_eur} | ${t.result}`));
db.close();
