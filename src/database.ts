import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';

const DB_PATH = path.join(process.cwd(), 'data', 'trades.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    logger.info(`SQLite database initialized: ${DB_PATH}`);
  }
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      phase TEXT NOT NULL,
      entry_zone_low REAL NOT NULL,
      entry_zone_high REAL NOT NULL,
      entry_price REAL,
      stop_loss REAL NOT NULL,
      target1 REAL NOT NULL,
      target2 REAL NOT NULL,
      risk_reward REAL NOT NULL,
      size_points INTEGER,
      daily_bias TEXT,
      h4_confirmation TEXT,
      h1_setup TEXT,
      currency_strength TEXT,
      zone_note TEXT,
      strategy_version TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT,
      close_price REAL,
      close_reason TEXT,
      pnl_pips REAL,
      pnl_eur REAL,
      result TEXT,
      mae_pips REAL,
      mfe_pips REAL,
      mae_price REAL,
      mfe_price REAL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS strategy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      changed_at TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT NOT NULL,
      changed_by TEXT DEFAULT 'manual',
      win_rate_before REAL,
      win_rate_after REAL,
      trades_before INTEGER,
      trades_after INTEGER
    );

    CREATE TABLE IF NOT EXISTS price_ticks (
      trade_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      price REAL NOT NULL,
      PRIMARY KEY (trade_id, recorded_at)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_result ON trades(result);
    CREATE INDEX IF NOT EXISTS idx_trades_opened ON trades(opened_at);
    CREATE INDEX IF NOT EXISTS idx_trades_version ON trades(strategy_version);
  `);
}

// ─── Trade Operations ─────────────────────────────────────────────────────────

export interface DbTrade {
  id: string;
  symbol: string;
  type: 'LONG' | 'SHORT';
  phase: string;
  entry_zone_low: number;
  entry_zone_high: number;
  entry_price?: number;
  stop_loss: number;
  target1: number;
  target2: number;
  risk_reward: number;
  size_points?: number;
  daily_bias?: string;
  h4_confirmation?: string;
  h1_setup?: string;
  currency_strength?: string;
  zone_note?: string;
  strategy_version?: string;
  opened_at: string;
  closed_at?: string;
  close_price?: number;
  close_reason?: string;
  pnl_pips?: number;
  pnl_eur?: number;
  result?: string;
  mae_pips?: number;
  mfe_pips?: number;
  mae_price?: number;
  mfe_price?: number;
  notes?: string;
}

export function insertTrade(trade: DbTrade): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO trades (
      id, symbol, type, phase, entry_zone_low, entry_zone_high, entry_price,
      stop_loss, target1, target2, risk_reward, size_points,
      daily_bias, h4_confirmation, h1_setup, currency_strength, zone_note,
      strategy_version, opened_at
    ) VALUES (
      @id, @symbol, @type, @phase, @entry_zone_low, @entry_zone_high, @entry_price,
      @stop_loss, @target1, @target2, @risk_reward, @size_points,
      @daily_bias, @h4_confirmation, @h1_setup, @currency_strength, @zone_note,
      @strategy_version, @opened_at
    )
  `).run(trade);
}

export function closeTrade(
  id: string,
  closePrice: number,
  closedAt: string,
  closeReason: string,
  pnlPips: number,
  pnlEur: number,
  result: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE trades SET
      closed_at = @closedAt,
      close_price = @closePrice,
      close_reason = @closeReason,
      pnl_pips = @pnlPips,
      pnl_eur = @pnlEur,
      result = @result
    WHERE id = @id
  `).run({ id, closedAt, closePrice, closeReason, pnlPips, pnlEur, result });
}

export function updateMAEMFE(id: string, maePips: number, mfePips: number, maePrice: number, mfePrice: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE trades SET mae_pips = @maePips, mfe_pips = @mfePips, mae_price = @maePrice, mfe_price = @mfePrice
    WHERE id = @id
  `).run({ id, maePips, mfePips, maePrice, mfePrice });
}

export function recordPriceTick(tradeId: string, price: number): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO price_ticks (trade_id, recorded_at, price)
    VALUES (@tradeId, @recordedAt, @price)
  `).run({ tradeId, recordedAt: new Date().toISOString(), price });

  // Update MAE/MFE
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as DbTrade | undefined;
  if (!trade || trade.closed_at) return;

  const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
  const entryMid = (trade.entry_zone_low + trade.entry_zone_high) / 2;
  const diff = price - entryMid;
  const pips = trade.type === 'LONG' ? diff / pip : -diff / pip;

  const current = db.prepare('SELECT mae_pips, mfe_pips FROM trades WHERE id = ?').get(tradeId) as any;
  const maePips = Math.min(current?.mae_pips ?? 0, pips);
  const mfePips = Math.max(current?.mfe_pips ?? 0, pips);
  const maePrice = trade.type === 'LONG'
    ? Math.min(current?.mae_price ?? price, price)
    : Math.max(current?.mae_price ?? price, price);
  const mfePrice = trade.type === 'LONG'
    ? Math.max(current?.mfe_price ?? price, price)
    : Math.min(current?.mfe_price ?? price, price);

  updateMAEMFE(tradeId, maePips, mfePips, maePrice, mfePrice);
}

export function getOpenTrades(): DbTrade[] {
  return getDb().prepare('SELECT * FROM trades WHERE closed_at IS NULL ORDER BY opened_at DESC').all() as DbTrade[];
}

export function getAllTrades(): DbTrade[] {
  return getDb().prepare('SELECT * FROM trades ORDER BY opened_at DESC').all() as DbTrade[];
}

export function getTrade(id: string): DbTrade | undefined {
  return getDb().prepare('SELECT * FROM trades WHERE id = ?').get(id) as DbTrade | undefined;
}

// ─── Strategy Log Operations ──────────────────────────────────────────────────

export interface StrategyLogEntry {
  id?: number;
  changed_at: string;
  version: string;
  description: string;
  changed_by?: string;
  win_rate_before?: number;
  win_rate_after?: number;
  trades_before?: number;
  trades_after?: number;
}

export function getCurrentStrategyVersion(): string {
  const db = getDb();
  const last = db.prepare('SELECT version FROM strategy_log ORDER BY id DESC LIMIT 1').get() as any;
  return last?.version ?? 'v1.0';
}

export function insertStrategyLog(entry: StrategyLogEntry): void {
  const db = getDb();

  // Calculate win rate before this change
  const trades = getAllTrades().filter(t => t.closed_at);
  const wins = trades.filter(t => t.result === 'WIN').length;
  const winRateBefore = trades.length > 0 ? Math.round((wins / trades.length) * 100) : null;

  db.prepare(`
    INSERT INTO strategy_log (changed_at, version, description, changed_by, win_rate_before, trades_before)
    VALUES (@changed_at, @version, @description, @changed_by, @win_rate_before, @trades_before)
  `).run({
    changed_at: entry.changed_at,
    version: entry.version,
    description: entry.description,
    changed_by: entry.changed_by ?? 'manual',
    win_rate_before: winRateBefore,
    trades_before: trades.length,
  });
}

export function getStrategyLog(): StrategyLogEntry[] {
  return getDb().prepare('SELECT * FROM strategy_log ORDER BY id DESC').all() as StrategyLogEntry[];
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  const all = getAllTrades().filter(t => t.closed_at);

  const bySymbol = db.prepare(`
    SELECT symbol,
      COUNT(*) as total,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
      ROUND(SUM(pnl_eur), 2) as pnl_eur,
      ROUND(AVG(mae_pips), 1) as avg_mae,
      ROUND(AVG(mfe_pips), 1) as avg_mfe
    FROM trades WHERE closed_at IS NOT NULL
    GROUP BY symbol ORDER BY total DESC
  `).all();

  const byVersion = db.prepare(`
    SELECT strategy_version,
      COUNT(*) as total,
      SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
      ROUND(SUM(pnl_eur), 2) as pnl_eur
    FROM trades WHERE closed_at IS NOT NULL AND strategy_version IS NOT NULL
    GROUP BY strategy_version ORDER BY strategy_version
  `).all();

  const equity = db.prepare(`
    SELECT closed_at, pnl_eur,
      SUM(pnl_eur) OVER (ORDER BY closed_at ROWS UNBOUNDED PRECEDING) as cumulative
    FROM trades WHERE closed_at IS NOT NULL ORDER BY closed_at
  `).all();

  return { all, bySymbol, byVersion, equity };
}
