import 'dotenv/config';
import axios from 'axios';
import { MT5API } from './mt5Api';
import { FractalAnalyzer } from './fractalAnalyzer';
import { TelegramNotifier } from './telegram';
import { MT5TradeExecutor } from './mt5TradeExecutor';
import { isDuplicate, cacheSignal } from './signalCache';
import { isMarketOpen, getActiveSession } from './marketHours';
import { loadRules, isBlockedByRules, getMaxTrades } from './rulesEngine';
import { logOpenTrade, logClosedTrade, loadTrades, savePineScript } from './tradeLogger';
import { sendDailyReport, checkZoneCoverage } from './reporter';
import { getDb, insertTrade, closeTrade, recordPriceTick, getOpenTrades as getDbOpenTrades, getCurrentStrategyVersion } from './database';
import { startDashboard } from './dashboard';
import { logger } from './logger';
import * as fs from 'fs';

function logFilterRejection(symbol: string, reason: string): void {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO filter_rejections (symbol, reason, rejected_at) VALUES (?, ?, ?)`)
      .run(symbol, reason, new Date().toISOString());
  } catch { /* table may not exist yet */ }
}

const SPREAD_LOG = './logs/spread_log.csv';

function loadSpreadLimits(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync('./data/spreads.json', 'utf-8'));
  } catch {
    return { DEFAULT: 3.0 };
  }
}

function logSpread(symbol: string, spreadPips: number, normalPips: number, blocked: boolean): void {
  const ts = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour12: false });
  const line = ts + ',' + symbol + ',' + spreadPips.toFixed(2) + ',' + (normalPips * 2).toFixed(1) + ',' + (blocked ? 'BLOCKED' : 'OK') + '\n';
  try { fs.appendFileSync(SPREAD_LOG, line); } catch { /* ignore */ }
  if (blocked) logger.warn(`Trade ${symbol} nicht eroeffnet | Spread: ${spreadPips.toFixed(2)} Pips (Max: ${(normalPips * 2).toFixed(1)})`);
}

import { getCurrencyStrength, StrengthResult } from './currencyStrength';
import { initZones } from './zoneManager';
import cron from 'node-cron';

const SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD',
  'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'EURCHF',
  'EURAUD', 'EURCAD', 'GBPNZD', 'GBPJPY', 'AUDJPY',
  'CHFJPY', 'GBPCHF', 'AUDNZD', 'AUDCAD', 'CADJPY',
  'GBPCAD', 'GBPAUD'
];

const MT5_SERVER = 'http://127.0.0.1:5000';
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
let marketWasOpen = true;

const activeSymbols = new Set<string>();
const lastScanned = new Map<string, number>();
const FAST_INTERVAL_MS = 30 * 1000;      // 30 seconds
const SLOW_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

function shouldScan(symbol: string): boolean {
  const now = Date.now();
  const last = lastScanned.get(symbol) ?? 0;
  const interval = activeSymbols.has(symbol) ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
  return now - last >= interval;
}

// ─── Sync closed trades ───────────────────────────────────────────────────────

async function syncClosedTrades(): Promise<void> {
  const openTrades = loadTrades().filter(t => !t.closedAt);
  if (openTrades.length === 0) return;

  const executor = new MT5TradeExecutor();
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );

  try {
    const dbOpenTrades = getDbOpenTrades();
    for (const dbTrade of dbOpenTrades) {
      try {
        const tick = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol: dbTrade.symbol } });
        const mid = (tick.data.bid + tick.data.ask) / 2;
        recordPriceTick(dbTrade.id, mid);

        const MAX_HOLD_HOURS = 48;
        const MIN_PROGRESS_PCT = 0.5;
        const pip = dbTrade.symbol.includes('JPY') ? 0.01 : 0.0001;
        const fillPrice = dbTrade.entry_price ?? mid;
        const holdHours = (Date.now() - new Date(dbTrade.opened_at).getTime()) / (1000 * 60 * 60);

        if (holdHours >= MAX_HOLD_HOURS) {
          const tpDist = Math.abs((dbTrade.target1 ?? mid) - fillPrice);
          const currentProfit = dbTrade.type === 'LONG' ? mid - fillPrice : fillPrice - mid;
          const progressPct = tpDist > 0 ? Math.max(currentProfit, 0) / tpDist : 0;

          if (progressPct < MIN_PROGRESS_PCT) {
            const dec2 = dbTrade.symbol.includes('JPY') ? 3 : 5;
            logger.info(`Time-based close: ${dbTrade.symbol} open ${holdHours.toFixed(1)}h, progress ${(progressPct * 100).toFixed(0)}%`);
            try {
              const closeResult = await executor.closePosition(dbTrade.id);
              if (closeResult.success) {
                const pnlPips2 = Math.round((dbTrade.type === 'LONG' ? (mid - fillPrice) / pip : (fillPrice - mid) / pip) * 10) / 10;
                const resultStr = pnlPips2 > 0.5 ? 'WIN' : pnlPips2 < -0.5 ? 'LOSS' : 'BREAKEVEN';
                closeTrade(dbTrade.id, mid, new Date().toISOString(), `TIME_CLOSE (${holdHours.toFixed(0)}h)`, pnlPips2, 0, resultStr);
                logClosedTrade(dbTrade.id, mid, new Date().toISOString());
                savePineScript();
                activeSymbols.delete(dbTrade.symbol);
                await telegram.sendMessage(
                  `⏰ <b>Time-based Close — ${dbTrade.symbol}</b>\n` +
                  `${dbTrade.type === 'LONG' ? '📈' : '📉'} ${dbTrade.type} | ${resultStr}\n` +
                  `Offen seit: <b>${holdHours.toFixed(0)}h</b>\n` +
                  `Fortschritt: <b>${(progressPct * 100).toFixed(0)}%</b> Richtung TP\n` +
                  `Close: <code>${mid.toFixed(dec2)}</code>\n` +
                  `P&L: <b>${pnlPips2 >= 0 ? '+' : ''}${pnlPips2.toFixed(1)} pips</b>`
                );
              }
            } catch (e: any) { logger.error(`Time-based close error: ${e.message}`); }
          }
        }
      } catch { /* skip */ }
    }

    const mt5Positions = await executor.getOpenPositions();
    const openTickets = new Set(mt5Positions.map(p => p.dealId));

    // Sync activeSymbols with real MT5 positions
    for (const p of mt5Positions) activeSymbols.add(p.symbol);

    for (const trade of openTrades) {
      if (!trade.dealId || openTickets.has(trade.dealId)) continue;

      logger.info(`Closed trade detected: ${trade.symbol} [${trade.dealId}]`);

      let closePrice = (trade.entryZone[0] + trade.entryZone[1]) / 2;
      const closedAt = new Date().toISOString();

      try {
        const tick = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol: trade.symbol } });
        closePrice = (tick.data.bid + tick.data.ask) / 2;
      } catch {
        logger.warn(`Could not fetch close price for ${trade.dealId}, using fallback`);
      }

      const closed = logClosedTrade(trade.dealId, closePrice, closedAt);
      savePineScript();

      try {
        const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
        const entryPrice = trade.fillPrice ?? (trade.entryZone[0] + trade.entryZone[1]) / 2;
        const rawPnlPips = trade.type === 'LONG'
          ? (closePrice - entryPrice) / pip
          : (entryPrice - closePrice) / pip;
        const pnlPips = Math.round(rawPnlPips * 10) / 10;
        const result = pnlPips > 0.5 ? 'WIN' : pnlPips < -0.5 ? 'LOSS' : 'BREAKEVEN';
        closeTrade(trade.dealId, closePrice, closedAt, 'SL/TP/Market', pnlPips, closed?.pnlEUR ?? 0, result);
        logger.info(`Trade closed in DB: ${trade.symbol} ${result} ${pnlPips} pips`);
      } catch (dbErr) { logger.error('DB close error:', dbErr); }

      activeSymbols.delete(trade.symbol);

      if (closed) {
        const dec = trade.symbol.includes('JPY') ? 3 : 5;
        const resultEmoji = closed.result === 'WIN' ? '✅' : closed.result === 'LOSS' ? '❌' : '➖';
        await telegram.sendMessage(
          `${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>\n` +
          `${trade.type === 'LONG' ? '📈' : '📉'} ${trade.type} | ${closed.result}\n` +
          `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
          `P&L: <b>${closed.pnlPips && closed.pnlPips >= 0 ? '+' : ''}${closed.pnlPips?.toFixed(1)} pips</b>  ` +
          `(<b>${closed.pnlEUR && closed.pnlEUR >= 0 ? '+' : ''}€${closed.pnlEUR?.toFixed(2)}</b>)`
        );
      }
    }
  } catch (err) {
    logger.error('Error syncing closed trades:', err);
  }
}

// ─── Helper: execute trade + log + notify ────────────────────────────────────

async function executeTrade(
  signal: any,
  symbol: string,
  executor: MT5TradeExecutor,
  telegram: TelegramNotifier
): Promise<void> {
  const dec = symbol.includes('JPY') ? 3 : 5;
  const pip = symbol.includes('JPY') ? 0.01 : 0.0001;

  // Spread check
  try {
    const tick = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol } });
    const spreadPips = (tick.data.ask - tick.data.bid) / pip;
    const spreadLimits = loadSpreadLimits();
    const normalPips = spreadLimits[symbol] ?? spreadLimits['DEFAULT'] ?? 3.0;
    logSpread(symbol, spreadPips, normalPips, spreadPips > normalPips * 2);
    if (spreadPips > normalPips * 2) { activeSymbols.delete(symbol); return; }
  } catch { /* proceed anyway */ }

  // Max trades check
  const openPositions = await executor.getOpenPositions();
  if (openPositions.length >= getMaxTrades()) {
    logger.warn(`Max trades limit reached (${getMaxTrades()}) — skipping ${symbol}`);
    return;
  }

  // Currency exposure check
  const currencies = symbol.length === 6 ? [symbol.slice(0, 3), symbol.slice(3, 6)] : [];
  for (const currency of currencies) {
    if (openPositions.filter((p: any) => p.symbol?.includes(currency)).length >= 2) {
      logger.info(`${symbol}: currency exposure limit reached for ${currency}`);
      return;
    }
  }

  const result = await executor.openTrade(signal);
  logger.info(`openTrade result: ${JSON.stringify(result)}`);

  if (result.success && result.dealId) {
    logger.info(`Trade opened for ${symbol}: ${result.dealId}`);
    logOpenTrade(signal, result.dealId);
    savePineScript();
    activeSymbols.add(symbol);

    try {
      const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
      const stopPips = Math.abs(entryMid - signal.stopLoss) / pip;
      const entryDistPips = Math.abs(signal.currentPrice - entryMid) / pip;
      const openedDate = new Date();
      insertTrade({
        id: result.dealId,
        symbol: signal.symbol,
        type: signal.type,
        phase: signal.phase,
        entry_zone_low: signal.entryZone[0],
        entry_zone_high: signal.entryZone[1],
        entry_price: signal.currentPrice,
        entry_distance_pips: Math.round(entryDistPips * 10) / 10,
        stop_loss: signal.stopLoss,
        stop_pips: Math.round(stopPips * 10) / 10,
        target1: signal.target1,
        target2: signal.target2,
        risk_reward: Math.round(signal.riskReward * 100) / 100,
        session: getActiveSession() ?? 'unknown',
        weekday: openedDate.getUTCDay(),
        opened_at: openedDate.toISOString(),
        daily_bias: signal.dailyBias,
        h4_confirmation: signal.h4Confirmation,
        h1_context: signal.h1Context,
        m15_setup: signal.m15Setup,
        fvg_present: signal.fvgLevel != null ? 1 : 0,
        size_points: 0,
        currency_strength: undefined,
        strength_score: undefined,
        zone_note: undefined,
        zone_status: undefined,
        exhaustion_detected: undefined,
        strategy_version: getCurrentStrategyVersion(),
      });
    } catch (dbErr) { logger.error('DB insert error:', dbErr); }

    // Send Telegram AFTER trade is open — with real fill levels
    const fillPrice = signal.currentPrice;
    const realRisk = Math.abs(fillPrice - signal.stopLoss);
    const realTP = signal.type === 'LONG'
      ? fillPrice + realRisk * 1.3
      : fillPrice - realRisk * 1.3;

    await telegram.sendMessage(
      `✅ <b>Trade geöffnet — ${symbol}</b>\n` +
      `${signal.type === 'LONG' ? '📈' : '📉'} ${signal.type} | ${signal.phase} | #${result.dealId}\n` +
      `Entry: <code>${fillPrice.toFixed(dec)}</code>\n` +
      `SL: <code>${signal.stopLoss.toFixed(dec)}</code> | TP: <code>${realTP.toFixed(dec)}</code>\n` +
      `R:R: <b>1.30:1</b>`
    );
  } else {
    logger.warn(`Trade skipped for ${symbol}: ${result.message}`);
    if (result.message.includes('verpasst')) activeSymbols.delete(symbol);
  }
}

// ─── Analyze single symbol ────────────────────────────────────────────────────

async function analyzeSymbol(
  symbol: string,
  mt5: MT5API,
  executor: MT5TradeExecutor,
  telegram: TelegramNotifier,
  strength: StrengthResult | null = null
): Promise<void> {
  lastScanned.set(symbol, Date.now());

  // Skip scan if position already open — syncClosedTrades monitors it
  const openPositions = await executor.getOpenPositions();
  if (openPositions.some(p => p.symbol === symbol)) {
    logger.info(`${symbol}: position open — skipping scan`);
    return;
  }

  const dailyCandles = await mt5.getCandles(symbol, 'DAY', 20);
  await new Promise(r => setTimeout(r, 100));
  const h4Candles = await mt5.getCandles(symbol, 'HOUR_4', 40);
  await new Promise(r => setTimeout(r, 100));
  const h1Candles = await mt5.getCandles(symbol, 'HOUR', 60);
  await new Promise(r => setTimeout(r, 100));
  const m15Candles = await mt5.getCandles(symbol, 'MINUTE_15', 80);

  // ── Fractal Analyzer only — Sweep Zone disabled ────────────────────────────
  const analyzer = new FractalAnalyzer(symbol, dailyCandles, h4Candles, h1Candles, m15Candles);
  const analyzeResult = analyzer.analyze();
  const signal = analyzeResult.signal;

  if (analyzeResult.rejected && analyzeResult.reason) {
    logger.info(`${symbol}: REJECTED — ${analyzeResult.reason}`);
    logFilterRejection(symbol, analyzeResult.reason);
  }

  if (signal) {
    activeSymbols.add(symbol);

    if (isDuplicate(signal.symbol, signal.type, signal.phase)) {
      logger.info(`${symbol}: signal already cached, skipping.`);
      return;
    }

    logger.info(`Signal found for ${symbol}: ${signal.type} ${signal.phase}`);
    cacheSignal(signal.symbol, signal.type, signal.phase);

    if (PAPER_TRADING) {
      await executeTrade(signal, symbol, executor, telegram);
    }
  } else {
    if (activeSymbols.has(symbol)) {
      logger.info(`${symbol}: signal gone — switching to slow polling`);
      activeSymbols.delete(symbol);
    } else {
      logger.info(`No setup for ${symbol} yet.`);
    }
  }
}

// ─── Main scan ────────────────────────────────────────────────────────────────

async function runScan() {
  await syncClosedTrades();

  if (!isMarketOpen()) {
    if (marketWasOpen) { logger.info('Market closed — signal scanning paused.'); marketWasOpen = false; }
    return;
  }
  if (!marketWasOpen) { logger.info('Market open — signal scanning resumed.'); marketWasOpen = true; }

  const nowMEZ = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const rulesCheck = isBlockedByRules(nowMEZ);
  if (rulesCheck.blocked) { logger.info(`Signal scan skipped — ${rulesCheck.reason}`); return; }

  const toScan = SYMBOLS.filter(s => shouldScan(s));
  if (toScan.length === 0) return;

  const fastCount = toScan.filter(s => activeSymbols.has(s)).length;
  logger.info(`Scanning ${toScan.length} symbols (${fastCount} fast / ${toScan.length - fastCount} slow)`);

  const mt5 = new MT5API();
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );

  try {
    await mt5.createSession();

    let strength: StrengthResult | null = null;
    try { strength = await getCurrencyStrength(mt5); } catch {
      logger.warn('Currency strength calculation failed — filter disabled');
    }

    const executor = new MT5TradeExecutor();
    const active  = toScan.filter(s => activeSymbols.has(s));
    const passive = toScan.filter(s => !activeSymbols.has(s));

    for (const symbol of [...active, ...passive]) {
      try {
        await analyzeSymbol(symbol, mt5, executor, telegram, strength);
      } catch (err) {
        logger.error(`Error analyzing ${symbol}:`, err);
      }
      await new Promise(r => setTimeout(r, 150));
    }
  } catch (err) {
    logger.error('Scan error:', err);
  }
}

// ─── Cron ────────────────────────────────────────────────────────────────────

cron.schedule('*/1 * * * *', () => {
  runScan().catch(err => logger.error('Cron error:', err));
});

cron.schedule('0 8 * * *', () => {
  const telegram = new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
  sendDailyReport(telegram).catch(err => logger.error('Report error:', err));
});

cron.schedule('5 22 * * 1-5', () => {
  const telegram = new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
  checkZoneCoverage(telegram).catch(err => logger.error('Zone check error:', err));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startup() {
  logger.info('TTrades Fractal Model Bot started');
  logger.info(`Monitoring: ${SYMBOLS.join(', ')}`);
  logger.info(`Paper trading: ${PAPER_TRADING ? 'ENABLED' : 'DISABLED'}`);
  logger.info('Fast poll: 30s (active) | Slow poll: 2min (others)');
  logger.info('Sweep Zone: DISABLED | Fractal Analyzer: ENABLED');

  loadRules();
  initZones();
  getDb();
  startDashboard();

  // Restore open positions directly from MT5
  try {
    const executor = new MT5TradeExecutor();
    const mt5Positions = await executor.getOpenPositions();
    for (const p of mt5Positions) activeSymbols.add(p.symbol);
    if (mt5Positions.length > 0) {
      logger.info(`Restored ${mt5Positions.length} open MT5 position(s): ${mt5Positions.map(p => p.symbol).join(', ')}`);
    }
  } catch (err) {
    logger.warn('Could not fetch MT5 positions on startup — will sync on first scan');
  }

  const now = Date.now();
  SYMBOLS.forEach((s, i) => lastScanned.set(s, now - (SLOW_INTERVAL_MS - i * 1000)));

  runScan().catch(err => logger.error('Initial scan error:', err));
}

startup();
