import { getDb, getCurrentStrategyVersion } from './src/database';

const db = getDb();

const openedAt  = '2026-04-27T22:37:47.000Z';
const closedAt  = '2026-04-27T22:37:47.000Z'; // same time = instant TP hit, update if you know close time
const dealId    = 'GBPNZD-20260427-manual';

const entryPrice   = 2.28989;
const stopLoss     = 2.28866;
const takeProfit   = 2.29035;
const closePrice   = 2.29035;
const pip          = 0.0001;
const entryZoneLow = entryPrice - pip;
const entryZoneHigh= entryPrice + pip;
const stopPips     = Math.abs(entryPrice - stopLoss) / pip;
const tpPips       = Math.abs(takeProfit - entryPrice) / pip;
const rr           = Math.round(tpPips / stopPips * 100) / 100;
const pnlPips      = Math.round((closePrice - entryPrice) / pip * 10) / 10;
const pnlEUR       = 17.99;

db.prepare(`
  INSERT OR IGNORE INTO trades (
    id, symbol, type, phase,
    entry_zone_low, entry_zone_high, entry_price, entry_distance_pips,
    stop_loss, stop_pips, target1, target2, risk_reward,
    session, weekday, opened_at, closed_at,
    close_price, close_reason, pnl_pips, pnl_eur, result,
    daily_bias, h4_confirmation, h1_context, m15_setup,
    fvg_present, size_points, strategy_version
  ) VALUES (
    ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?
  )
`).run(
  dealId, 'GBPNZD', 'LONG', 'C3_ENTRY',
  entryZoneLow, entryZoneHigh, entryPrice, 0,
  stopLoss, stopPips, takeProfit, takeProfit, rr,
  'unknown', 1, openedAt, closedAt,
  closePrice, 'TP', pnlPips, pnlEUR, 'WIN',
  'LONG', 'Manual entry', 'Manual entry', 'Manual entry',
  0, 0, 'v1.5'
);

console.log(`Trade inserted: GBPNZD LONG WIN +${pnlPips} pips €${pnlEUR}`);
db.close();
