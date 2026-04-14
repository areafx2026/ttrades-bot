// Run: cd /var/www/ttrades-bot && npx tsx src/fix-audcad-pnl.ts
import 'dotenv/config';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');
const db = new Database(DB_PATH);

const trade = db.prepare("SELECT * FROM trades WHERE symbol = 'AUDCAD' AND close_reason LIKE 'TIME_CLOSE%'").get() as any;
if (!trade) { console.log('Not found'); process.exit(1); }

console.log('Before:', { pnl_pips: trade.pnl_pips, pnl_eur: trade.pnl_eur, size_points: trade.size_points });

// Calculate EUR P&L
const sizePoints = trade.size_points || 1000;
const pipValue = 0.08; // non-JPY cross
const pnlEur = Math.round(trade.pnl_pips * pipValue * (sizePoints / 1000) * 100) / 100;

db.prepare('UPDATE trades SET pnl_eur = ? WHERE id = ?').run(pnlEur, trade.id);
console.log('After:', { pnl_eur: pnlEur });
console.log('Done.');
