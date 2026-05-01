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
  // CHF-Paare ausgeschlossen wegen hoher Swap-Kosten (USDCHF, EURCHF, GBPCHF, CHFJPY)
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD',
  'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY',
  'EURAUD', 'EURCAD', 'GBPNZD', 'GBPJPY', 'AUDJPY',
  'AUDNZD', 'AUDCAD', 'CADJPY',
  'GBPCAD', 'GBPAUD'
];

const MT5_SERVER = 'http://127.0.0.1:5000';
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
let marketWasOpen = true;

const activeSymbols = new Set<string>();
const lastScanned = new Map<string, number>();
const FAST_INTERVAL_MS = 30 * 1000;
const SLOW_INTERVAL_MS = 2 * 60 * 1000;

function shouldScan(symbol: string): boolean {
  const now = Date.now();
  const last = lastScanned.get(symbol) ?? 0;
  const interval = activeSymbols.has(symbol) ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
  return now - last >= interval;
}

// ─── Sync closed trades ───────────────────────────────────────────────────────
// Nachhaltige Lösung: MT5 ist die einzige Wahrheit.
// Vergleich läuft über SYMBOL, nicht über IDs (die zwischen Open/Close-Deal unterschiedlich sind).
// Ablauf:
//   1. MT5-offene Positionen holen → Set von offenen Symbolen
//   2. MT5-History holen → Map von symbol → letzter Closing-Deal
//   3. DB-offene Trades prüfen: wenn Symbol nicht mehr in MT5-Positionen → geschlossen
//   4. Close-Preis und P&L aus MT5-History, nie selbst berechnen

async function syncClosedTrades(): Promise<void> {
  const executor = new MT5TradeExecutor();
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );

  try {
    // ── 1. MT5: welche Symbole sind noch offen? ──────────────────────────────
    const mt5Positions = await executor.getOpenPositions();
    const openSymbols = new Set(mt5Positions.map(p => p.symbol));

    // activeSymbols aktualisieren
    activeSymbols.clear();
    for (const p of mt5Positions) activeSymbols.add(p.symbol);

    // ── 2. MT5 History: letzter Closing-Deal pro Symbol ─────────────────────
    let historyDeals: any[] = [];
    try {
      const histRes = await axios.get(`${MT5_SERVER}/history`, { params: { hours: 168 }, timeout: 10000 });
      historyDeals = histRes.data ?? [];
    } catch {
      logger.sync('Could not fetch MT5 history');
    }

    // Pro Symbol den neuesten echten Closing-Deal merken
    // Closing-Deal = hat profit != 0 ODER commission != 0 (Opening-Deals haben beides = 0 ausser commission)
    // Bei Pepperstone: Opening-Deals haben profit=0, Closing-Deals haben profit!=0
    const latestDealBySymbol = new Map<string, any>();
    for (const deal of historyDeals) {
      const isClosingDeal = deal.profit !== 0 || deal.entry === 1 || deal.entry === 2 || deal.entry === 3;
      if (!isClosingDeal) continue;
      const existing = latestDealBySymbol.get(deal.symbol);
      if (!existing || new Date(deal.time).getTime() > new Date(existing.time).getTime()) {
        latestDealBySymbol.set(deal.symbol, deal);
      }
    }

    // ── 3. DB-offene Trades prüfen ───────────────────────────────────────────
    const dbOpenTrades = getDbOpenTrades();

    // Tick aufzeichnen + Time-based close für noch offene Trades
    for (const dbTrade of dbOpenTrades) {
      if (!openSymbols.has(dbTrade.symbol)) continue; // wird unten behandelt
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
            logger.sync(`Time-based close: ${dbTrade.symbol} open ${holdHours.toFixed(1)}h`);
            try {
              await executor.closePosition(dbTrade.id);
            } catch (e: any) { logger.error(`Time-based close error: ${e.message}`); }
          }
        }
      } catch { /* skip */ }
    }

    // ── 4. Geschlossene Trades verarbeiten ───────────────────────────────────
    const openTrades = loadTrades().filter(t => !t.closedAt);

    for (const trade of openTrades) {
      // Symbol noch in MT5 offen → nichts tun
      if (openSymbols.has(trade.symbol)) continue;

      logger.info(`Trade geschlossen erkannt (Symbol-Sync): ${trade.symbol}`);

      const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
      const dec = trade.symbol.includes('JPY') ? 3 : 5;
      const entryPrice = trade.fillPrice ?? (trade.entryZone[0] + trade.entryZone[1]) / 2;

      // MT5 History für dieses Symbol suchen — Deal muss nach Trade-Open liegen
      const tradeOpenMs = new Date(trade.openedAt).getTime();
      const deal = latestDealBySymbol.get(trade.symbol);
      const dealIsAfterOpen = deal && new Date(deal.time + 'Z').getTime() > tradeOpenMs;

      let closePrice: number;
      let pnlEUR: number;
      let closedAt: string;

      if (deal && dealIsAfterOpen) {
        // Echte Werte aus MT5
        closePrice = deal.price;
        pnlEUR = Math.round((deal.profit + deal.commission + deal.swap) * 100) / 100;
        closedAt = new Date(deal.time + 'Z').toISOString();
        logger.info(`MT5 deal gefunden für ${trade.symbol}: close=${closePrice} pnlEUR=${pnlEUR}`);
      } else {
        // Fallback: aktuellen Tick nehmen
        logger.warn(`Kein MT5 Deal für ${trade.symbol} — Tick-Fallback`);
        try {
          const tick = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol: trade.symbol } });
          closePrice = (tick.data.bid + tick.data.ask) / 2;
        } catch {
          closePrice = entryPrice;
        }
        pnlEUR = 0;
        closedAt = new Date().toISOString();
      }

      // Pips nach Richtung
      const rawPnlPips = trade.type === 'LONG'
        ? (closePrice - entryPrice) / pip
        : (entryPrice - closePrice) / pip;
      const pnlPips = Math.round(rawPnlPips * 10) / 10;

      // WIN/LOSS: aus EUR P&L wenn vorhanden, sonst Pips
      const result = pnlEUR !== 0
        ? (pnlEUR > 0.5 ? 'WIN' : pnlEUR < -0.5 ? 'LOSS' : 'BREAKEVEN')
        : (pnlPips > 0.5 ? 'WIN' : pnlPips < -0.5 ? 'LOSS' : 'BREAKEVEN');

      // DB aktualisieren
      logClosedTrade(trade.dealId!, closePrice, closedAt);
      savePineScript();
      closeTrade(trade.dealId!, closePrice, closedAt, 'SL/TP/Market', pnlPips, pnlEUR, result);
      activeSymbols.delete(trade.symbol);

      logger.info(`Trade abgeschlossen: ${trade.symbol} ${result} | ${pnlPips} pips | €${pnlEUR.toFixed(2)}`);

      const resultEmoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
      await telegram.sendMessage(
        `${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>
` +
        `${trade.type === 'LONG' ? '📈' : '📉'} ${trade.type} | ${result}
` +
        `Close: <code>${closePrice.toFixed(dec)}</code>
` +
        `P&L: <b>${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips</b>  ` +
        `(<b>${pnlEUR >= 0 ? '+' : ''}€${pnlEUR.toFixed(2)}</b>)`
      );
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

  try {
    const tick = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol } });
    const spreadPips = (tick.data.ask - tick.data.bid) / pip;
    const spreadLimits = loadSpreadLimits();
    const normalPips = spreadLimits[symbol] ?? spreadLimits['DEFAULT'] ?? 3.0;
    logSpread(symbol, spreadPips, normalPips, spreadPips > normalPips * 2);
    if (spreadPips > normalPips * 2) { activeSymbols.delete(symbol); return; }
  } catch { /* proceed anyway */ }

  const openPositions = await executor.getOpenPositions();
  if (openPositions.length >= getMaxTrades()) {
    logger.warn(`Max trades limit reached (${getMaxTrades()}) — skipping ${symbol}`);
    return;
  }

  const currencies = symbol.length === 6 ? [symbol.slice(0, 3), symbol.slice(3, 6)] : [];
  for (const currency of currencies) {
    if (openPositions.filter((p: any) => p.symbol?.includes(currency)).length >= 2) {
      logger.scan(`${symbol}: currency exposure limit reached for ${currency}`);
      return;
    }
  }

  const result = await executor.openTrade(signal);
  logger.trade(`openTrade result: ${JSON.stringify(result)}`);

  if (result.success && result.dealId) {
    logger.trade(`Trade opened for ${symbol}: ${result.dealId}`);
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
// Returns 'no_setup' | 'signal' | 'open' | 'cached' | 'rejected'

async function analyzeSymbol(
  symbol: string,
  mt5: MT5API,
  executor: MT5TradeExecutor,
  telegram: TelegramNotifier,
  openPositionSymbols: Set<string>
): Promise<'no_setup' | 'signal' | 'open' | 'cached' | 'rejected'> {
  lastScanned.set(symbol, Date.now());

  if (openPositionSymbols.has(symbol)) {
    return 'open';
  }

  const dailyCandles = await mt5.getCandles(symbol, 'DAY', 20);
  await new Promise(r => setTimeout(r, 100));
  const h4Candles = await mt5.getCandles(symbol, 'HOUR_4', 40);
  await new Promise(r => setTimeout(r, 100));
  const h1Candles = await mt5.getCandles(symbol, 'HOUR', 60);
  await new Promise(r => setTimeout(r, 100));
  const m15Candles = await mt5.getCandles(symbol, 'MINUTE_15', 80);

  const analyzer = new FractalAnalyzer(symbol, dailyCandles, h4Candles, h1Candles, m15Candles);
  const analyzeResult = analyzer.analyze();
  const signal = analyzeResult.signal;

  if (analyzeResult.rejected && analyzeResult.reason) {
    logFilterRejection(symbol, analyzeResult.reason);
    if (activeSymbols.has(symbol)) activeSymbols.delete(symbol);
    return 'rejected';
  }

  if (signal) {
    activeSymbols.add(symbol);

    if (isDuplicate(signal.symbol, signal.type, signal.phase)) {
      return 'cached';
    }

    logger.setup(`Signal found for ${symbol}: ${signal.type} ${signal.phase}`);
    cacheSignal(signal.symbol, signal.type, signal.phase);

    if (PAPER_TRADING) {
      await executeTrade(signal, symbol, executor, telegram);
    }
    return 'signal';
  } else {
    if (activeSymbols.has(symbol)) activeSymbols.delete(symbol);
    return 'no_setup';
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
  logger.sys(`Scanning ${toScan.length} symbols (${fastCount} fast / ${toScan.length - fastCount} slow)`);

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

    // Get open positions once for the whole scan
    const mt5Positions = await executor.getOpenPositions();
    const openPositionSymbols = new Set(mt5Positions.map(p => p.symbol));

    const active  = toScan.filter(s => activeSymbols.has(s));
    const passive = toScan.filter(s => !activeSymbols.has(s));

    const noSetupSymbols: string[] = [];

    for (const symbol of [...active, ...passive]) {
      try {
        const outcome = await analyzeSymbol(symbol, mt5, executor, telegram, openPositionSymbols);
        if (outcome === 'no_setup') noSetupSymbols.push(symbol);
      } catch (err) {
        logger.error(`Error analyzing ${symbol}:`, err);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    // Log all no-setup symbols in one line
    if (noSetupSymbols.length > 0) {
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
  logger.sys('TTrades Fractal Model Bot started');
  logger.sys(`Monitoring: ${SYMBOLS.join(', ')}`);
  logger.sys(`Paper trading: ${PAPER_TRADING ? 'ENABLED' : 'DISABLED'}`);
  logger.sys('Fast poll: 30s (active) | Slow poll: 2min (others)');
  logger.sys('Sweep Zone: DISABLED | Fractal Analyzer: ENABLED');

  loadRules();
  initZones();
  getDb();
  startDashboard();

  try {
    const executor = new MT5TradeExecutor();
    const mt5Positions = await executor.getOpenPositions();
    for (const p of mt5Positions) activeSymbols.add(p.symbol);
    if (mt5Positions.length > 0) {
      logger.sys(`Restored ${mt5Positions.length} open MT5 position(s): ${mt5Positions.map(p => p.symbol).join(', ')}`);
    }
  } catch (err) {
    logger.warn('Could not fetch MT5 positions on startup — will sync on first scan');
  }

  const now = Date.now();
  SYMBOLS.forEach((s, i) => lastScanned.set(s, now - (SLOW_INTERVAL_MS - i * 1000)));

  runScan().catch(err => logger.error('Initial scan error:', err));
}

startup();
