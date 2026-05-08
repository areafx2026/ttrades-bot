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
    // ── 1. MT5: welche Position-Tickets sind noch offen? ─────────────────────
    // Wir merken uns die offenen Tickets (nicht Symbole!) als Set
    const mt5Positions = await executor.getOpenPositions();
    const openTickets  = new Set(mt5Positions.map((p: any) => String(p.dealId)));
    const openSymbols  = new Set(mt5Positions.map((p: any) => p.symbol));

    // activeSymbols aktualisieren
    activeSymbols.clear();
    for (const p of mt5Positions) activeSymbols.add(p.symbol);

    // ── 2. DB-offene Trades prüfen ───────────────────────────────────────────
    const dbOpenTrades = getDbOpenTrades();

    // Tick aufzeichnen + Time-based close für noch offene Trades
    for (const dbTrade of dbOpenTrades) {
      if (!openTickets.has(dbTrade.id)) continue; // wird unten als geschlossen behandelt
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
            try { await executor.closePosition(dbTrade.id); } catch (e: any) { logger.error(`Time-based close error: ${e.message}`); }
          }
        }
      } catch { /* skip */ }
    }

    // ── 3. Geschlossene DB-Trades verarbeiten ────────────────────────────────
    // Korrekte Logik:
    //   - DB speichert das Position-Ticket beim Öffnen (result.order aus order_send)
    //   - GET /history/position?ticket=<id> gibt alle Deals dieser Position zurück
    //   - Opening-Deal: entry=0, profit=0
    //   - Closing-Deal: entry=1, profit=echter P&L  ← das wollen wir
    //   - Verknüpfung läuft über DEAL_POSITION_ID, nicht über Symbol oder Zeit

    for (const dbTrade of dbOpenTrades) {
      // Noch offen in MT5 → nichts tun
      if (openTickets.has(dbTrade.id)) continue;

      const pip = dbTrade.symbol.includes('JPY') ? 0.01 : 0.0001;
      const dec = dbTrade.symbol.includes('JPY') ? 3 : 5;

      logger.info(`Trade geschlossen erkannt: ${dbTrade.symbol} [ticket=${dbTrade.id}]`);

      // Closing-Deal per Position-Ticket holen
      let closePrice: number;
      let pnlEUR: number;
      let closedAt: string;
      let closeReason = 'SL/TP/Market';

      try {
        const histRes = await axios.get(`${MT5_SERVER}/history/position`, {
          params: { ticket: dbTrade.id },
          timeout: 5000,
        });
        const deals: any[] = histRes.data ?? [];

        // Closing-Deal = entry === 1 (OUT)
        const closingDeal = deals.find((d: any) => d.entry === 1);

        if (closingDeal) {
          closePrice  = closingDeal.price;
          pnlEUR      = Math.round((closingDeal.profit + closingDeal.commission + closingDeal.swap) * 100) / 100;
          closedAt    = new Date(closingDeal.time.endsWith('Z') ? closingDeal.time : closingDeal.time + 'Z').toISOString();
          closeReason = closingDeal.comment ?? 'SL/TP/Market';
          logger.info(`Closing-Deal gefunden: ${dbTrade.symbol} close=${closePrice} pnlEUR=${pnlEUR} reason="${closeReason}"`);
        } else {
          // Kein Closing-Deal yet → Trade noch nicht wirklich zu (Race condition)
          logger.warn(`Kein Closing-Deal für ${dbTrade.symbol} [${dbTrade.id}] — übersprungen`);
          continue;
        }
      } catch (e: any) {
        logger.error(`History-Lookup fehlgeschlagen für ${dbTrade.symbol}: ${e.message}`);
        continue;
      }

      // Pips berechnen
      const entryPrice = dbTrade.entry_price ?? closePrice;
      const rawPnlPips = dbTrade.type === 'LONG'
        ? (closePrice - entryPrice) / pip
        : (entryPrice - closePrice) / pip;
      const pnlPips = Math.round(rawPnlPips * 10) / 10;

      // WIN/LOSS immer aus EUR P&L (echte MT5-Werte)
      const result = pnlEUR > 0.5 ? 'WIN' : pnlEUR < -0.5 ? 'LOSS' : 'BREAKEVEN';

      // DB + JSON aktualisieren
      logClosedTrade(dbTrade.id, closePrice, closedAt);
      savePineScript();
      closeTrade(dbTrade.id, closePrice, closedAt, closeReason, pnlPips, pnlEUR, result);
      activeSymbols.delete(dbTrade.symbol);

      logger.info(`Trade abgeschlossen: ${dbTrade.symbol} ${result} | ${pnlPips} pips | €${pnlEUR.toFixed(2)}`);

      const resultEmoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
      await telegram.sendMessage(
        `${resultEmoji} <b>Trade geschlossen — ${dbTrade.symbol}</b>\n` +
        `${dbTrade.type === 'LONG' ? '📈' : '📉'} ${dbTrade.type} | ${result}\n` +
        `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
        `P&L: <b>${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips</b>  ` +
        `(<b>${pnlEUR >= 0 ? '+' : ''}€${pnlEUR.toFixed(2)}</b>)`
      );
    }

    // ── 4. JSON-Fallback: alte Trades die noch nicht in DB sind ─────────────
    // Nur für Trades die vor dem DB-Tracking-System geöffnet wurden
    const dbIds = new Set(dbOpenTrades.map(t => t.id));
    const jsonOpenTrades = loadTrades().filter(t => !t.closedAt && !dbIds.has(t.dealId!));

    for (const trade of jsonOpenTrades) {
      if (openSymbols.has(trade.symbol)) continue;

      const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
      const dec = trade.symbol.includes('JPY') ? 3 : 5;
      const entryPrice = trade.fillPrice ?? (trade.entryZone[0] + trade.entryZone[1]) / 2;

      logger.warn(`JSON-Fallback Close: ${trade.symbol} [${trade.dealId}]`);

      // Auch hier per Position-Ticket suchen
      let closePrice = entryPrice;
      let pnlEUR = 0;
      let closedAt = new Date().toISOString();
      let closeReason = 'SL/TP/Market';

      try {
        const histRes = await axios.get(`${MT5_SERVER}/history/position`, {
          params: { ticket: trade.dealId },
          timeout: 5000,
        });
        const deals: any[] = histRes.data ?? [];
        const closingDeal = deals.find((d: any) => d.entry === 1);
        if (closingDeal) {
          closePrice  = closingDeal.price;
          pnlEUR      = Math.round((closingDeal.profit + closingDeal.commission + closingDeal.swap) * 100) / 100;
          closedAt    = new Date(closingDeal.time.endsWith('Z') ? closingDeal.time : closingDeal.time + 'Z').toISOString();
          closeReason = closingDeal.comment ?? 'SL/TP/Market';
        }
      } catch { /* proceed with fallback */ }

      const rawPnlPips = trade.type === 'LONG'
        ? (closePrice - entryPrice) / pip
        : (entryPrice - closePrice) / pip;
      const pnlPips = Math.round(rawPnlPips * 10) / 10;
      const result  = pnlEUR > 0.5 ? 'WIN' : pnlEUR < -0.5 ? 'LOSS' : 'BREAKEVEN';

      logClosedTrade(trade.dealId!, closePrice, closedAt);
      savePineScript();
      closeTrade(trade.dealId!, closePrice, closedAt, closeReason, pnlPips, pnlEUR, result);
      activeSymbols.delete(trade.symbol);

      const resultEmoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
      await telegram.sendMessage(
        `${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>\n` +
        `${trade.type === 'LONG' ? '📈' : '📉'} ${trade.type} | ${result}\n` +
        `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
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

    // ── DB insert ────────────────────────────────────────────────────────────
    try {
      const pip = symbol.includes('JPY') ? 0.01 : 0.0001;
      const fillPrice = signal.currentPrice;
      const stopPips  = Math.abs(fillPrice - signal.stopLoss) / pip;
      const entryDistPips = Math.abs(fillPrice - ((signal.entryZone?.[0] ?? fillPrice) + (signal.entryZone?.[1] ?? fillPrice)) / 2) / pip;

      insertTrade({
        id:                   String(result.dealId),
        symbol,
        type:                 signal.type,
        phase:                signal.phase,
        entry_zone_low:       signal.entryZone?.[0] ?? fillPrice,
        entry_zone_high:      signal.entryZone?.[1] ?? fillPrice,
        entry_price:          fillPrice,
        entry_distance_pips:  Math.round(entryDistPips * 10) / 10,
        stop_loss:            signal.stopLoss,
        stop_pips:            Math.round(stopPips * 10) / 10,
        target1:              signal.target1 ?? signal.targetPrice,
        target2:              signal.target2 ?? signal.target1 ?? signal.targetPrice,
        risk_reward:          signal.riskReward ?? 1.3,
        size_points:          (result as any).lots ?? 0,
        session:              getActiveSession() ?? undefined,
        weekday:              new Date().getDay(),
        opened_at:            new Date().toISOString(),
        daily_bias:           signal.dailyBias ?? signal.type,
        h4_confirmation:      signal.h4Confirmation ?? undefined,
        h1_context:           signal.h1Context ?? undefined,
        m15_setup:            signal.m15Setup ?? undefined,
        currency_strength:    undefined,
        strength_score:       undefined,
        fvg_present:          0,
      });
      logger.trade(`DB insert OK for ${symbol} [${result.dealId}]`);
    } catch (dbErr: any) {
      logger.error(`insertTrade failed for ${symbol} [${result.dealId}]: ${dbErr.message}`);
    }



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
  // syncClosedTrades mit 20s Timeout — verhindert dass der Scan blockiert
  await Promise.race([
    syncClosedTrades(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('syncClosedTrades timeout')), 20000))
  ]).catch((err: any) => logger.warn(`syncClosedTrades abgebrochen: ${err?.message}`));

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

    // ── Startup-Reconciliation ────────────────────────────────────────────────
    // Für jede offene MT5-Position prüfen ob sie in der DB existiert.
    // Falls nicht → automatisch eintragen (passiert wenn Bot während Trade-Open abstürzt)
    const db = getDb();
    for (const pos of mt5Positions) {
      const existing = db.prepare('SELECT id FROM trades WHERE id = ?').get(pos.dealId);
      if (!existing) {
        logger.sys(`Reconciliation: ${pos.symbol} [${pos.dealId}] nicht in DB — trage nach`);

        const pip = pos.symbol.includes('JPY') ? 0.01 : 0.0001;
        const dec = pos.symbol.includes('JPY') ? 3 : 5;
        const sl   = pos.stopLevel;
        const tp   = pos.profitLevel;
        const entry = pos.openLevel;
        const risk  = Math.abs(entry - sl);
        const reward = Math.abs(tp - entry);
        const rr = risk > 0 ? Math.round((reward / risk) * 100) / 100 : 1.3;
        const type = pos.direction === 'BUY' ? 'LONG' : 'SHORT';
        const target2 = type === 'LONG'
          ? entry + risk * 2.6
          : entry - risk * 2.6;

        // Opened_at aus MT5 History holen
        let openedAt = new Date().toISOString();
        try {
          const histRes = await axios.get(`${MT5_SERVER}/history/position`, {
            params: { ticket: pos.dealId },
            timeout: 5000,
          });
          const deals: any[] = histRes.data ?? [];
          const openDeal = deals.find((d: any) => d.entry === 0);
          if (openDeal) {
            openedAt = new Date(openDeal.time.endsWith('Z') ? openDeal.time : openDeal.time + 'Z').toISOString();
          }
        } catch { /* use current time as fallback */ }

        try {
          db.prepare(`
            INSERT OR IGNORE INTO trades (
              id, symbol, type, phase,
              entry_zone_low, entry_zone_high, entry_price,
              stop_loss, target1, target2, risk_reward,
              opened_at, strategy_version,
              entry_distance_pips, stop_pips,
              size_points, zone_note, zone_status,
              exhaustion_detected, currency_strength,
              strength_score, fvg_present
            ) VALUES (
              @id, @symbol, @type, @phase,
              @entry_zone_low, @entry_zone_high, @entry_price,
              @stop_loss, @target1, @target2, @risk_reward,
              @opened_at, @strategy_version,
              0, @stop_pips,
              0, null, null,
              null, null,
              null, 0
            )
          `).run({
            id:               pos.dealId,
            symbol:           pos.symbol,
            type,
            phase:            'RECONCILED',
            entry_zone_low:   entry,
            entry_zone_high:  entry,
            entry_price:      entry,
            stop_loss:        sl,
            target1:          tp,
            target2,
            risk_reward:      rr,
            opened_at:        openedAt,
            strategy_version: 'v2.4',
            stop_pips:        Math.round((risk / pip) * 10) / 10,
          });
          logger.sys(`Reconciliation OK: ${pos.symbol} [${pos.dealId}] eingetragen`);
        } catch (dbErr: any) {
          logger.error(`Reconciliation DB error for ${pos.symbol}: ${dbErr?.message}`);
        }
      }
    }

    // ── History-Reconciliation ───────────────────────────────────────────────
    // Prüfe MT5-History der letzten 48h auf TTFM-Bot-Trades die nicht in DB sind
    // (passiert wenn Bot abstürzt nachdem Trade geöffnet aber vor DB-Eintrag)
    try {
      const histRes = await axios.get(`${MT5_SERVER}/history`, {
        params: { hours: 48, all: '1' },
        timeout: 5000,
      });
      const allDeals: any[] = histRes.data ?? [];

      // Nur Opening-Deals vom Bot
      const openingDeals = allDeals.filter((d: any) =>
        d.entry === 0 && d.comment === 'TTFM Bot' && d.symbol !== ''
      );

      for (const deal of openingDeals) {
        const existingTrade = db.prepare('SELECT id FROM trades WHERE id = ?').get(deal.ticket);
        if (existingTrade) continue; // bereits in DB

        logger.sys(`History-Reconciliation: ${deal.symbol} [${deal.ticket}] nicht in DB — trage nach`);

        const pip = deal.symbol.includes('JPY') ? 0.01 : 0.0001;
        const entry = deal.price;
        const type = deal.type === 'SELL' ? 'SHORT' : 'LONG';
        const openedAt = new Date(deal.time.endsWith('Z') ? deal.time : deal.time + 'Z').toISOString();

        // Closing-Deal suchen
        const closingDeals = allDeals.filter((d: any) =>
          d.entry === 1 && d.symbol === deal.symbol &&
          new Date(d.time.endsWith('Z') ? d.time : d.time + 'Z').getTime() > new Date(openedAt).getTime()
        );
        const closingDeal = closingDeals.sort((a: any, b: any) =>
          new Date(a.time).getTime() - new Date(b.time).getTime()
        )[0];

        // Position-Details aus MT5 holen (für SL/TP)
        let sl = entry;
        let tp = entry;
        let rr = 1.3;
        try {
          const posHistRes = await axios.get(`${MT5_SERVER}/history/position`, {
            params: { ticket: deal.ticket },
            timeout: 5000,
          });
          const posDeals: any[] = posHistRes.data ?? [];
          // SL/TP aus dem Closing-Deal-Kommentar extrahieren wenn vorhanden
          if (closingDeal?.comment?.includes('[sl ')) {
            sl = parseFloat(closingDeal.comment.replace('[sl ', '').replace(']', ''));
          }
          if (closingDeal?.comment?.includes('[tp ')) {
            tp = parseFloat(closingDeal.comment.replace('[tp ', '').replace(']', ''));
          }
        } catch { /* ignore */ }

        const risk = Math.abs(entry - sl) || pip * 15;
        const reward = Math.abs(tp - entry) || risk * 1.3;
        rr = Math.round((reward / risk) * 100) / 100;
        const target2 = type === 'LONG' ? entry + risk * 2.6 : entry - risk * 2.6;

        try {
          db.prepare(`
            INSERT OR IGNORE INTO trades (
              id, symbol, type, phase,
              entry_zone_low, entry_zone_high, entry_price,
              stop_loss, target1, target2, risk_reward,
              opened_at, strategy_version,
              entry_distance_pips, stop_pips,
              size_points, zone_note, zone_status,
              exhaustion_detected, currency_strength,
              strength_score, fvg_present
            ) VALUES (
              @id, @symbol, @type, @phase,
              @entry, @entry, @entry,
              @sl, @tp, @target2, @rr,
              @opened_at, 'v2.3',
              0, @stop_pips,
              0, null, null,
              null, null, null, 0
            )
          `).run({
            id:        deal.ticket,
            symbol:    deal.symbol,
            type,
            phase:     'RECONCILED',
            entry,
            sl,
            tp,
            target2,
            rr,
            opened_at: openedAt,
            stop_pips: Math.round((risk / pip) * 10) / 10,
          });
          logger.sys(`History-Reconciliation OK: ${deal.symbol} [${deal.ticket}] eingetragen`);
        } catch (dbErr: any) {
          logger.error(`History-Reconciliation DB error: ${dbErr?.message}`);
        }
      }
    } catch (histErr: any) {
      logger.warn(`History-Reconciliation fehler: ${histErr?.message}`);
    }

    // Danach syncClosedTrades für Trades die während Offline geschlossen wurden
    await syncClosedTrades();

  } catch (err) {
    logger.warn('Could not fetch MT5 positions on startup — will sync on first scan');
  }

  const now = Date.now();
  SYMBOLS.forEach((s, i) => lastScanned.set(s, now - (SLOW_INTERVAL_MS - i * 1000)));

  runScan().catch(err => logger.error('Initial scan error:', err));
}

startup();
