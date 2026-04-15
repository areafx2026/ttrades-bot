import 'dotenv/config';
import axios from 'axios';
import { CapitalAPI, throttle } from './capitalApi';
import { FractalAnalyzer, TradeSignal } from './fractalAnalyzer';
import { TelegramNotifier } from './telegram';
import { TradeExecutor } from './tradeExecutor';
import { isDuplicate, cacheSignal } from './signalCache';
import { isMarketOpen, isActiveTradingSession, getActiveSession } from './marketHours';
import { loadRules, isBlockedByRules, getMaxTrades } from './rulesEngine';
import { logOpenTrade, logClosedTrade, loadTrades, savePineScript } from './tradeLogger';
import { sendDailyReport, checkZoneCoverage } from './reporter';
import { getDb, insertTrade, closeTrade, recordPriceTick, getOpenTrades as getDbOpenTrades, getCurrentStrategyVersion, getTrade } from './database';
import { startDashboard } from './dashboard';
import { logger } from './logger';
import * as fs from 'fs';

// Spread limits loaded from spreads.json (no restart needed after edit)
const SPREAD_LOG = './logs/spread_log.csv';

function loadSpreadLimits(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync('./data/spreads.json', 'utf-8'));
  } catch {
    logger.warn('spreads.json not found, using defaults');
    return { DEFAULT: 3.0 };
  }
}

function logSpread(symbol: string, spreadPips: number, normalPips: number, blocked: boolean): void {
  const now = new Date();
  const ts = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour12: false });
  const status = blocked ? 'BLOCKED' : 'OK';
  const line = ts + ',' + symbol + ',' + spreadPips.toFixed(2) + ',' + (normalPips * 2).toFixed(1) + ',' + status + '\n';
  try { fs.appendFileSync(SPREAD_LOG, line); } catch { /* ignore */ }
  if (blocked) {
    logger.warn('Trade ' + symbol + ' nicht eroeffnet | Spread: ' + spreadPips.toFixed(2) + ' Pips (Max: ' + (normalPips * 2).toFixed(1) + ') | ' + ts);
  }
}
import { getCurrencyStrength, isStrengthAligned, StrengthResult } from './currencyStrength';
import { checkZone, initZones } from './zoneManager';
import cron from 'node-cron';

const SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD',
  'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'EURCHF',
  'EURAUD', 'EURCAD', 'GBPNZD', 'GBPJPY', 'AUDJPY',
  'CHFJPY', 'GBPCHF', 'AUDNZD', 'AUDCAD', 'CADJPY',
  'GBPCAD', 'GBPAUD'
];

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
let marketWasOpen = true;

// Track which symbols have active signals or open trades — these get polled every 3 min
const activeSymbols = new Set<string>();
// Track which trades already had their SL moved to breakeven (avoid repeated API calls)
const trailingApplied = new Set<string>();
// Track last scan time per symbol
const lastScanned = new Map<string, number>();
const FAST_INTERVAL_MS = 3  * 60 * 1000; // 3 minutes
const SLOW_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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

  const capital = new CapitalAPI(
    process.env.CAPITAL_API_KEY!,
    process.env.CAPITAL_IDENTIFIER!,
    process.env.CAPITAL_PASSWORD!,
    process.env.CAPITAL_DEMO === 'true'
  );

  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );

  try {
    await capital.createSession();

    const baseURL = capital.isDemo
      ? 'https://demo-api-capital.backend-capital.com/api/v1'
      : 'https://api-capital.backend-capital.com/api/v1';

    const headers = {
      'CST': capital.cst,
      'X-SECURITY-TOKEN': capital.securityToken,
    };

    // Update MAE/MFE for open trades via price ticks
    const dbOpenTrades = getDbOpenTrades();
    for (const dbTrade of dbOpenTrades) {
      try {
        await throttle();
        const priceRes = await axios.get(`${baseURL}/markets/${dbTrade.symbol}`, { headers });
        const mid = (priceRes.data.snapshot.bid + priceRes.data.snapshot.offer) / 2;
        recordPriceTick(dbTrade.id, mid);

        // v1.3: Breakeven trailing stop
        // When price reaches 80% of TP distance, move SL to fill price + 5 pips
        const pip = dbTrade.symbol.includes('JPY') ? 0.01 : 0.0001;
        // Use real fill price if available, fall back to entry zone midpoint
        const fillPrice = dbTrade.entry_price ?? (dbTrade.entry_zone_low + dbTrade.entry_zone_high) / 2;
        const tpDist = Math.abs(dbTrade.target1 - fillPrice);
        const threshold = tpDist * 0.8;
        const breakevenSL = dbTrade.type === 'LONG'
          ? fillPrice + pip * 5
          : fillPrice - pip * 5;

        // Check if price has reached 80% of TP
        const currentProfit = dbTrade.type === 'LONG'
          ? mid - fillPrice
          : fillPrice - mid;

        if (currentProfit >= threshold) {
          // Only move SL if it hasn't been moved yet (current SL is worse than breakeven)
          const slNeedsUpdate = dbTrade.type === 'LONG'
            ? dbTrade.stop_loss < breakevenSL
            : dbTrade.stop_loss > breakevenSL;

          if (slNeedsUpdate && !trailingApplied.has(dbTrade.id)) {
            const dec = dbTrade.symbol.includes('JPY') ? 3 : 5;
            try {
              await throttle();
              await axios.put(`${baseURL}/positions/${dbTrade.id}`,
                { stopLevel: parseFloat(breakevenSL.toFixed(dec)), profitLevel: dbTrade.target1 },
                { headers }
              );
              trailingApplied.add(dbTrade.id);

              // Update DB
              const db = getDb();
              db.prepare('UPDATE trades SET stop_loss = ? WHERE id = ?').run(breakevenSL, dbTrade.id);

              logger.info(`BE-Trailing: ${dbTrade.symbol} SL moved to ${breakevenSL.toFixed(dec)} (+5 pips over entry) — price at 80% of TP`);
              await telegram.sendMessage(
                `🔒 <b>SL nachgezogen — ${dbTrade.symbol}</b>\n` +
                `${dbTrade.type === 'LONG' ? '📈' : '📉'} ${dbTrade.type}\n` +
                `Neuer SL: <code>${breakevenSL.toFixed(dec)}</code> (+5 Pips über Entry)\n` +
                `Preis: <code>${mid.toFixed(dec)}</code> (80% Richtung TP erreicht)`
              );
            } catch (slErr: any) {
              logger.warn(`BE-Trailing failed for ${dbTrade.symbol}: ${slErr.response?.data?.errorCode || slErr.message}`);
            }
          }
        }

        // v1.3: Time-based auto-close
        // If trade is open >48h and hasn't reached 50% of TP distance, close at market
        const MAX_HOLD_HOURS = 48;
        const MIN_PROGRESS_PCT = 0.5; // must have reached 50% of TP distance
        const openedMs = new Date(dbTrade.opened_at).getTime();
        const holdHours = (Date.now() - openedMs) / (1000 * 60 * 60);

        if (holdHours >= MAX_HOLD_HOURS) {
          const progressPct = tpDist > 0 ? Math.max(currentProfit, 0) / tpDist : 0;

          if (progressPct < MIN_PROGRESS_PCT) {
            const dec2 = dbTrade.symbol.includes('JPY') ? 3 : 5;
            logger.info(`Time-based close: ${dbTrade.symbol} open ${holdHours.toFixed(1)}h, progress ${(progressPct * 100).toFixed(0)}% of TP — closing`);

            try {
              // Close on Capital.com
              const executor2 = new TradeExecutor(
                process.env.CAPITAL_API_KEY!,
                capital.isDemo,
                capital.cst,
                capital.securityToken
              );
              const closeResult = await executor2.closePosition(dbTrade.id);

              if (closeResult.success) {
                // Calculate P&L
                const pnlPips2 = Math.round((dbTrade.type === 'LONG'
                  ? (mid - fillPrice) / pip
                  : (fillPrice - mid) / pip) * 10) / 10;
                const resultStr = pnlPips2 > 0.5 ? 'WIN' : pnlPips2 < -0.5 ? 'LOSS' : 'BREAKEVEN';

                // Calculate EUR P&L from position size
                const sizePoints = dbTrade.size_points ?? 1000;
                let pipValuePer1000 = 0.08;
                if (dbTrade.symbol.includes('JPY')) pipValuePer1000 = 0.07;
                else if (dbTrade.symbol.startsWith('USD') || dbTrade.symbol.endsWith('USD')) pipValuePer1000 = 0.09;
                const pnlEur2 = Math.round(pnlPips2 * pipValuePer1000 * (sizePoints / 1000) * 100) / 100;

                // Update trades.json first (so logClosedTrade has the data)
                logClosedTrade(dbTrade.id, mid, new Date().toISOString());
                savePineScript();

                // Update DB with calculated EUR P&L
                closeTrade(
                  dbTrade.id,
                  mid,
                  new Date().toISOString(),
                  `TIME_CLOSE (${holdHours.toFixed(0)}h, ${(progressPct * 100).toFixed(0)}% progress)`,
                  pnlPips2,
                  pnlEur2,
                  resultStr
                );

                activeSymbols.delete(dbTrade.symbol);
                trailingApplied.delete(dbTrade.id);

                const resultEmoji = resultStr === 'WIN' ? '✅' : resultStr === 'LOSS' ? '❌' : '➖';
                await telegram.sendMessage(
                  `⏰ <b>Time-based Close — ${dbTrade.symbol}</b>\n` +
                  `${dbTrade.type === 'LONG' ? '📈' : '📉'} ${dbTrade.type} | ${resultStr}\n` +
                  `Offen seit: <b>${holdHours.toFixed(0)}h</b> (Max: ${MAX_HOLD_HOURS}h)\n` +
                  `Fortschritt: <b>${(progressPct * 100).toFixed(0)}%</b> Richtung TP (Min: ${MIN_PROGRESS_PCT * 100}%)\n` +
                  `Close: <code>${mid.toFixed(dec2)}</code>\n` +
                  `P&L: <b>${pnlPips2 >= 0 ? '+' : ''}${pnlPips2.toFixed(1)} pips</b>`
                );
                logger.info(`Time-based close done: ${dbTrade.symbol} ${resultStr} ${pnlPips2} pips after ${holdHours.toFixed(0)}h`);
              } else {
                logger.warn(`Time-based close failed for ${dbTrade.symbol}: ${closeResult.message}`);
              }
            } catch (timeCloseErr: any) {
              logger.error(`Time-based close error for ${dbTrade.symbol}:`, timeCloseErr.message);
            }
          }
        }
      } catch { /* skip */ }
    }

    await throttle();
    const posRes = await axios.get(`${baseURL}/positions`, { headers });
    const openApiPositions = (posRes.data.positions || []) as any[];

    // Build map: symbol+direction → position (what Capital.com currently has open)
    const openBySymbolDir = new Map<string, any>();
    for (const p of openApiPositions) {
      const key = `${p.market.epic}_${p.position.direction}`;
      openBySymbolDir.set(key, p);
    }

    for (const trade of openTrades) {
      if (!trade.dealId) continue;

      // v1.3 fix: Check if already closed in SQLite — if so, force-update trades.json and skip
      try {
        const dbCheck = getTrade(trade.dealId);
        if (dbCheck?.closed_at) {
          const allJsonTrades = loadTrades();
          const idx = allJsonTrades.findIndex(t => t.id === trade.dealId || t.dealId === trade.dealId);
          if (idx !== -1 && !allJsonTrades[idx].closedAt) {
            allJsonTrades[idx].closedAt = dbCheck.closed_at;
            allJsonTrades[idx].closePrice = dbCheck.close_price;
            allJsonTrades[idx].pnlPips = dbCheck.pnl_pips;
            allJsonTrades[idx].pnlEUR = dbCheck.pnl_eur;
            allJsonTrades[idx].result = dbCheck.result as any;
            const fs2 = require('fs');
            const path2 = require('path');
            fs2.writeFileSync(path2.join(process.cwd(), 'data', 'trades.json'), JSON.stringify(allJsonTrades, null, 2), 'utf-8');
            logger.info(`Fixed trades.json for ${trade.symbol} [${trade.dealId}] — was closed in DB but open in JSON`);
          }
          activeSymbols.delete(trade.symbol);
          continue;
        }
      } catch { /* DB check failed, proceed with normal close flow */ }

      // Match by symbol + direction — no dealId matching needed
      const direction = trade.type === 'LONG' ? 'BUY' : 'SELL';
      const key = `${trade.symbol}_${direction}`;
      if (openBySymbolDir.has(key)) continue; // still open on Capital.com

      logger.info(`Closed trade detected: ${trade.symbol} [${trade.dealId}]`);

      // Get close price from Capital.com transaction history
      const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
      const dbTradeData = getTrade(trade.dealId!);
      const entryPrice = dbTradeData?.entry_price ?? (trade.entryZone[0] + trade.entryZone[1]) / 2;
      let closePrice: number | null = null;
      let closedAt = new Date().toISOString();
      let closeSource = 'unknown';

      try {
        const from = new Date(trade.openedAt).toISOString().slice(0, 19);
        await throttle();
        const actRes = await axios.get(`${baseURL}/history/activity`, {
          headers,
          params: { from, detailed: true },
        });

        const activities = actRes.data.activities || [];

        // Match by symbol — find the most recent close for this symbol+direction
        const matchingCloses = activities.filter((act: any) => {
          const epic = act.details?.epic ?? act.epic ?? '';
          const actDir = act.details?.direction ?? '';
          const isClose = act.type === 'POSITION' &&
            (act.source === 'SL' || act.source === 'TP' || act.source === 'USER' || act.source === 'SYSTEM');
          // Match by symbol — direction in activity is the original trade direction
          return epic === trade.symbol && isClose && act.details?.level;
        });

        if (matchingCloses.length > 0) {
          // Take the most recent
          const latest = matchingCloses[matchingCloses.length - 1];
          closePrice = parseFloat(latest.details.level);
          closedAt = latest.dateUTC ?? latest.date ?? closedAt;
          closeSource = latest.source;
          logger.info(`Close found: ${closePrice} via ${closeSource} for ${trade.symbol}`);
        }
      } catch {
        logger.warn(`Could not fetch activity history for ${trade.symbol}`);
      }

      // Fallback: determine from TP/SL proximity or MFE
      if (closePrice === null) {
        try {
          await throttle();
          const priceRes = await axios.get(`${baseURL}/markets/${trade.symbol}`, { headers });
          const currentMid = (priceRes.data.snapshot.bid + priceRes.data.snapshot.offer) / 2;
          const tpDist = Math.abs(currentMid - trade.target1);
          const slDist = Math.abs(currentMid - trade.stopLoss);

          if (tpDist < pip * 5) {
            closePrice = trade.target1;
            closeSource = 'TP (price-inferred)';
          } else if (slDist < pip * 5) {
            closePrice = trade.stopLoss;
            closeSource = 'SL (price-inferred)';
          } else {
            closePrice = currentMid;
            closeSource = 'market-price';
          }
        } catch {
          // Last resort: use MFE to guess
          const mfe = dbTradeData?.mfe_pips ?? 0;
          const tpPips = Math.abs(trade.target1 - entryPrice) / pip;
          if (mfe >= tpPips * 0.9) {
            closePrice = trade.target1;
            closeSource = 'TP (MFE-inferred)';
          } else {
            closePrice = trade.stopLoss;
            closeSource = 'SL (MFE-inferred)';
          }
        }
        logger.info(`Close inferred: ${closePrice} via ${closeSource} for ${trade.symbol}`);
      }

      // Calculate P&L from fill price
      const rawPnlPips = trade.type === 'LONG'
        ? (closePrice - entryPrice) / pip
        : (entryPrice - closePrice) / pip;
      const pnlPips = Math.round(rawPnlPips * 10) / 10;
      const result = pnlPips > 0.5 ? 'WIN' : pnlPips < -0.5 ? 'LOSS' : 'BREAKEVEN';

      const closed = logClosedTrade(trade.dealId, closePrice, closedAt);
      savePineScript();

      try {
        closeTrade(
          trade.dealId,
          closePrice,
          closedAt,
          closeSource,
          pnlPips,
          closed?.pnlEUR ?? 0,
          result
        );
        logger.info(`Trade closed in DB: ${trade.symbol} ${result} ${pnlPips} pips via ${closeSource}`);
      } catch (dbErr) { logger.error('DB close error:', dbErr); }

      // Remove from active symbols
      activeSymbols.delete(trade.symbol);
      trailingApplied.delete(trade.dealId!);

      if (closed) {
        const dec = trade.symbol.includes('JPY') ? 3 : 5;
        const resultEmoji = closed.result === 'WIN' ? '✅' : closed.result === 'LOSS' ? '❌' : '➖';
        const dirEmoji = trade.type === 'LONG' ? '📈' : '📉';
        await telegram.sendMessage(
          `${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>\n` +
          `${dirEmoji} ${trade.type} | ${closed.result}\n` +
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

// ─── v1.3: Cached weekly returns for mean-reversion z-score ──────────────────

let cachedWeeklyReturns: { symbol: string; returnPips: number; volatility: number }[] = [];
let weeklyReturnsCacheTime = 0;
const WEEKLY_RETURNS_CACHE_TTL = 60 * 60 * 1000; // 1 hour
// Offset initial cache by 30 min so it doesn't refresh at the same time as currency strength
const WEEKLY_RETURNS_INITIAL_OFFSET = 30 * 60 * 1000;

async function getCachedWeeklyReturns(capital: CapitalAPI): Promise<{ symbol: string; returnPips: number; volatility: number }[]> {
  const effectiveCacheTime = weeklyReturnsCacheTime || (Date.now() - WEEKLY_RETURNS_CACHE_TTL + WEEKLY_RETURNS_INITIAL_OFFSET);
  if (cachedWeeklyReturns.length > 0 && Date.now() - effectiveCacheTime < WEEKLY_RETURNS_CACHE_TTL) {
    return cachedWeeklyReturns;
  }

  const results: { symbol: string; returnPips: number; volatility: number }[] = [];
  for (const sym of SYMBOLS) {
    try {
      const d1 = await capital.getCandles(sym, 'DAY', 7);
      await new Promise(r => setTimeout(r, 300)); // 300ms to stay under rate limit
      if (d1.length >= 2) {
        const pip = sym.includes('JPY') ? 0.01 : 0.0001;
        const weekReturn = (d1[d1.length - 1].close - d1[0].open) / pip;
        const ranges = d1.slice(-6).map(c => (c.high - c.low) / pip);
        const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;
        results.push({ symbol: sym, returnPips: weekReturn, volatility: avgRange });
      }
    } catch { /* skip pair */ }
  }

  if (results.length >= 5) {
    cachedWeeklyReturns = results;
    weeklyReturnsCacheTime = Date.now();
    logger.info(`Mean-reversion data cached: ${results.length} pairs`);
  }
  return results;
}

// ─── Analyze single symbol ────────────────────────────────────────────────────

async function analyzeSymbol(
  symbol: string,
  capital: CapitalAPI,
  executor: TradeExecutor,
  telegram: TelegramNotifier,
  strength: import('./currencyStrength').StrengthResult | null = null,
  weeklyReturns: { symbol: string; returnPips: number; volatility: number }[] = []
): Promise<void> {
  lastScanned.set(symbol, Date.now());

  const dailyCandles = await capital.getCandles(symbol, 'DAY', 20);
  await new Promise(r => setTimeout(r, 150));
  const h4Candles = await capital.getCandles(symbol, 'HOUR_4', 40);
  await new Promise(r => setTimeout(r, 150));
  const h1Candles = await capital.getCandles(symbol, 'HOUR', 60);
  await new Promise(r => setTimeout(r, 150));
  const m15Candles = await capital.getCandles(symbol, 'MINUTE_15', 80);

  const analyzer = new FractalAnalyzer(symbol, dailyCandles, h4Candles, h1Candles, m15Candles);
  const signal = analyzer.analyze();

  if (signal) {
    // Mark as active — will be polled every 3 min
    activeSymbols.add(symbol);

    if (isDuplicate(signal.symbol, signal.type, signal.phase)) {
      logger.info(`${symbol}: signal already sent recently, skipping.`);
      return;
    }

    // Currency strength filter
    if (strength) {
      const strengthCheck = isStrengthAligned(symbol, signal.type, strength);
      if (!strengthCheck.aligned) {
        logger.info(`${symbol}: strength filter blocked — ${strengthCheck.reason}`);
        activeSymbols.delete(symbol);
        return;
      }
      logger.info(`${symbol}: strength aligned — ${strengthCheck.reason}`);
    }

    // v1.3: Relative mean-reversion filter (cross-pair z-score)
    if (weeklyReturns.length >= 5) {
      const symbolData = weeklyReturns.find(r => r.symbol === symbol);
      if (symbolData) {
        const zScore = FractalAnalyzer.calculateMeanReversionZScore(
          symbolData.returnPips,
          weeklyReturns
        );
        signal.meanRevZScore = zScore;
        const mrCheck = FractalAnalyzer.isMeanReversionBlocked(signal.type, zScore);
        if (mrCheck.blocked) {
          logger.info(`${symbol}: ${mrCheck.reason}`);
          activeSymbols.delete(symbol);
          return;
        }
        logger.info(`${symbol}: mean-reversion ${mrCheck.reason}`);
      }
    }

    logger.info(`Signal found for ${symbol}: ${signal.type}`);

    // Don't send signal or open trade if position already open for this symbol
    const openJsonTrades = loadTrades().filter(t => !t.closedAt);
    if (openJsonTrades.some(t => t.symbol === symbol)) {
      logger.info(`${symbol}: trade already open — skipping signal and execution`);
      return;
    }

    await telegram.sendSignal(signal);
    cacheSignal(signal.symbol, signal.type, signal.phase);

    if (PAPER_TRADING) {
      // Session filter — no new trades during London Open or NY Open
      if (isActiveTradingSession()) {
        const session = getActiveSession();
        logger.info(`${symbol}: ${session} active — no new trades during session open`);
        return;
      }

      // Currency exposure filter — max 2 open trades per currency
      const openPositions2 = await executor.getOpenPositions();
      const currencies = symbol.length === 6
        ? [symbol.slice(0, 3), symbol.slice(3, 6)]
        : [];
      for (const currency of currencies) {
        const exposedTrades = openPositions2.filter((p: any) => {
          const epic = p.market?.epic ?? p.epic ?? '';
          return epic.includes(currency);
        });
        if (exposedTrades.length >= 2) {
          logger.info(`${symbol}: currency exposure limit reached for ${currency} (${exposedTrades.length} open trades)`);
          return;
        }
      }

      // v1.3: Directional conflict filter — no contradicting exposure on same currency
      // AUDJPY LONG = AUD long-exposed, JPY short-exposed
      // AUDCAD SHORT = AUD short-exposed, CAD long-exposed
      // → AUD both LONG and SHORT = conflict → block
      const newBase = symbol.slice(0, 3);
      const newQuote = symbol.slice(3, 6);
      // New trade implies: base is LONG-exposed if LONG, SHORT-exposed if SHORT
      // Quote is the opposite
      const newBaseDir = signal.type; // LONG = base goes up
      const newQuoteDir = signal.type === 'LONG' ? 'SHORT' : 'LONG';

      for (const pos of openPositions2) {
        const posEpic = pos.epic ?? '';
        if (posEpic.length !== 6) continue;
        const posBase = posEpic.slice(0, 3);
        const posQuote = posEpic.slice(3, 6);
        const posDir = pos.direction === 'BUY' ? 'LONG' : 'SHORT';
        const posBaseDir = posDir;
        const posQuoteDir = posDir === 'LONG' ? 'SHORT' : 'LONG';

        // Check if any shared currency has opposing direction
        if (newBase === posBase && newBaseDir !== posBaseDir) {
          logger.info(`${symbol}: directional conflict — ${newBase} already ${posBaseDir} via ${posEpic}, new trade wants ${newBaseDir}`);
          return;
        }
        if (newBase === posQuote && newBaseDir !== posQuoteDir) {
          logger.info(`${symbol}: directional conflict — ${newBase} already ${posQuoteDir} via ${posEpic} (quote), new trade wants ${newBaseDir}`);
          return;
        }
        if (newQuote === posBase && newQuoteDir !== posBaseDir) {
          logger.info(`${symbol}: directional conflict — ${newQuote} already ${posBaseDir} via ${posEpic}, new trade wants ${newQuoteDir}`);
          return;
        }
        if (newQuote === posQuote && newQuoteDir !== posQuoteDir) {
          logger.info(`${symbol}: directional conflict — ${newQuote} already ${posQuoteDir} via ${posEpic} (quote), new trade wants ${newQuoteDir}`);
          return;
        }
      }

      const maxTrades = getMaxTrades();
      const openPositions = await executor.getOpenPositions();

      if (openPositions.length >= maxTrades) {
        logger.warn(`Max trades limit reached (${maxTrades}) — skipping ${symbol}`);
        return;
      }

      // Spread check before opening trade
      let spreadBlocked = false;
      try {
        const mktRes = await capital.getCandles(symbol, 'MINUTE', 1);
        await throttle();
        const mktInfo = await axios.get(
          `${capital.isDemo ? 'https://demo-api-capital.backend-capital.com' : 'https://api-capital.backend-capital.com'}/api/v1/markets/${symbol}`,
          { headers: { CST: capital.cst, 'X-SECURITY-TOKEN': capital.securityToken } }
        );
        const bid = mktInfo.data.snapshot?.bid ?? 0;
        const offer = mktInfo.data.snapshot?.offer ?? 0;
        const pip = symbol.includes('JPY') ? 0.01 : 0.0001;
        const spreadPips = (offer - bid) / pip;
        const spreadLimits = loadSpreadLimits();
        const normalPips = spreadLimits[symbol] ?? spreadLimits['DEFAULT'] ?? 3.0;
        const maxPips = normalPips * 2;
        logSpread(symbol, spreadPips, normalPips, spreadPips > maxPips);
        if (spreadPips > maxPips) {
          spreadBlocked = true;
          activeSymbols.delete(symbol);
        }
      } catch { /* spread check failed, proceed anyway */ }

      if (spreadBlocked) return;

      const result = await executor.openTrade(signal);
      const dec = signal.symbol.includes('JPY') ? 3 : 5;

      if (result.success && result.dealId) {
        const dealReference = result.dealId;
        let resolvedDealId = dealReference;
        let confirmedSize = 0;
        const baseURL2 = capital.isDemo
          ? 'https://demo-api-capital.backend-capital.com/api/v1'
          : 'https://api-capital.backend-capital.com/api/v1';
        const headers2 = { 'CST': capital.cst, 'X-SECURITY-TOKEN': capital.securityToken };

        // Use GET /confirms/{dealReference} — the official Capital.com way
        // to get the real dealId, fill price and status
        try {
          await new Promise(r => setTimeout(r, 1000)); // brief wait for order processing
          await throttle();
          const confirmRes = await axios.get(`${baseURL2}/confirms/${dealReference}`, { headers: headers2 });
          const confirm = confirmRes.data;

          if (confirm.dealStatus === 'ACCEPTED' && confirm.status === 'OPEN') {
            resolvedDealId = confirm.dealId;
            const fillPrice = confirm.level;
            logger.info(`Trade confirmed: dealId=${resolvedDealId}, fill=${fillPrice}, size=${confirm.size}, direction=${confirm.direction}`);

            // Store real fill price
            signal.currentPrice = fillPrice;

            // Check affectedDeals FIRST — the position dealId can differ from the order dealId
            if (confirm.affectedDeals?.length > 0) {
              const openedDeal = confirm.affectedDeals.find((d: any) => d.status === 'OPENED');
              if (openedDeal && openedDeal.dealId !== resolvedDealId) {
                logger.info(`AffectedDeals: position dealId=${openedDeal.dealId} (differs from order dealId=${resolvedDealId})`);
                resolvedDealId = openedDeal.dealId;
              }
            }

            // Store confirmed size for later use
            confirmedSize = confirm.size ?? 0;

            // Recalculate TP based on actual fill price for exact 1:1.5 R:R
            const pip2 = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
            const risk2 = Math.abs(fillPrice - signal.stopLoss);
            const newTP = signal.type === 'LONG'
              ? fillPrice + risk2 * 1.5
              : fillPrice - risk2 * 1.5;

            // Update TP on Capital.com using the resolved position dealId
            try {
              await throttle();
              await axios.put(`${baseURL2}/positions/${resolvedDealId}`,
                { stopLevel: signal.stopLoss, profitLevel: parseFloat(newTP.toFixed(pip2 === 0.01 ? 3 : 5)) },
                { headers: headers2 }
              );
              signal.target1 = newTP;
              logger.info(`TP adjusted to ${newTP.toFixed(pip2 === 0.01 ? 3 : 5)} for exact 1:1.5 R:R (fill: ${fillPrice})`);
            } catch { logger.warn('Could not update TP after fill'); }
          } else {
            logger.warn(`Trade not confirmed: status=${confirm.dealStatus}, reason=${confirm.reason ?? 'unknown'}`);
          }
        } catch (confirmErr: any) {
          logger.warn(`GET /confirms/${dealReference} failed: ${confirmErr.response?.data?.errorCode || confirmErr.message} — using dealReference as fallback`);
        }

        logger.info(`Trade opened for ${symbol}: ${resolvedDealId}`);
        logOpenTrade(signal, resolvedDealId);
        savePineScript();

        // Insert full signal context into SQLite DB
        try {
          const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
          const entryMid2 = (signal.entryZone[0] + signal.entryZone[1]) / 2;
          const stopPips2 = Math.abs(entryMid2 - signal.stopLoss) / pip;
          const entryDistPips = Math.abs(signal.currentPrice - entryMid2) / pip;
          const openedDate = new Date();
          insertTrade({
            id: resolvedDealId,
            symbol: signal.symbol,
            type: signal.type,
            phase: signal.phase,
            entry_zone_low: signal.entryZone[0],
            entry_zone_high: signal.entryZone[1],
            entry_price: signal.currentPrice,
            entry_distance_pips: Math.round(entryDistPips * 10) / 10,
            stop_loss: signal.stopLoss,
            stop_pips: Math.round(stopPips2 * 10) / 10,
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
            size_points: confirmedSize,
            currency_strength: undefined,
            strength_score: undefined,
            zone_note: undefined,
            zone_status: undefined,
            exhaustion_detected: undefined,
            strategy_version: getCurrentStrategyVersion(),
          });
        } catch (dbErr) { logger.error('DB insert error:', dbErr); }
        const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
        await telegram.sendMessage(
          `✅ <b>Trade geöffnet — ${symbol}</b>\n` +
          `${signal.type === 'LONG' ? '📈' : '📉'} ${signal.type} | ${result.dealId}\n` +
          `Entry: <code>${entryMid.toFixed(dec)}</code>\n` +
          `SL: <code>${signal.stopLoss.toFixed(dec)}</code> | ` +
          `TP: <code>${signal.target1.toFixed(dec)}</code>`
        );
      } else {
        logger.warn(`Trade skipped for ${symbol}: ${result.message}`);
        if (result.message.includes('Cooldown')) {
          await telegram.sendMessage(`⏳ <b>${symbol}</b> — ${result.message}`);
        }
        // If entry missed, remove from active
        if (result.message.includes('verpasst')) {
          activeSymbols.delete(symbol);
        }
      }
    }
  } else {
    // No signal — if was active but no longer has signal, downgrade to slow polling
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
  // Position tracking always runs 24/5 — independent of session
  await syncClosedTrades();

  if (!isMarketOpen()) {
    if (marketWasOpen) {
      logger.info('Market closed — signal scanning paused.');
      marketWasOpen = false;
    }
    return;
  }
  if (!marketWasOpen) {
    logger.info('Market open — signal scanning resumed.');
    marketWasOpen = true;
  }

  const nowMEZ = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const rulesCheck = isBlockedByRules(nowMEZ);
  if (rulesCheck.blocked) {
    logger.info(`Signal scan skipped — ${rulesCheck.reason}`);
    return;
  }

  // Determine which symbols to scan this round
  const toScan = SYMBOLS.filter(s => shouldScan(s));
  if (toScan.length === 0) return;

  const fastCount = toScan.filter(s => activeSymbols.has(s)).length;
  const slowCount = toScan.length - fastCount;
  logger.info(`Scanning ${toScan.length} symbols (${fastCount} fast / ${slowCount} slow)`);

  const capital = new CapitalAPI(
    process.env.CAPITAL_API_KEY!,
    process.env.CAPITAL_IDENTIFIER!,
    process.env.CAPITAL_PASSWORD!,
    process.env.CAPITAL_DEMO === 'true'
  );

  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );

  try {
    await capital.createSession();

    // Calculate currency strength once per scan (cached for 1h)
    let strength: StrengthResult | null = null;
    try {
      strength = await getCurrencyStrength(capital);
    } catch (err) {
      logger.warn('Currency strength calculation failed — filter disabled for this scan');
    }

    // v1.3: Calculate weekly returns + ATR for relative mean-reversion filter
    // Cached for 1 hour, staggered 30 min after currency strength to avoid burst
    let weeklyReturns: { symbol: string; returnPips: number; volatility: number }[] = [];
    try {
      weeklyReturns = await getCachedWeeklyReturns(capital);
    } catch {
      logger.warn('Weekly returns calculation failed — mean-reversion filter disabled');
    }

    const executor = new TradeExecutor(
      capital.apiKey,
      capital.isDemo,
      capital.cst,
      capital.securityToken
    );

    // Scan active symbols first (fast lane)
    const active = toScan.filter(s => activeSymbols.has(s));
    const passive = toScan.filter(s => !activeSymbols.has(s));

    for (const symbol of [...active, ...passive]) {
      try {
        await analyzeSymbol(symbol, capital, executor, telegram, strength, weeklyReturns);
      } catch (err) {
        logger.error(`Error analyzing ${symbol}:`, err);
      }
      await new Promise(r => setTimeout(r, 200));
    }

  } catch (err) {
    logger.error('Scan error:', err);
  }
}

// ─── Cron: every 3 minutes ────────────────────────────────────────────────────

cron.schedule('*/3 * * * *', () => {
  runScan().catch(err => logger.error('Cron error:', err));
});

// Daily report at 08:00 UTC (09:00 MEZ)
cron.schedule('0 8 * * *', () => {
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );
  sendDailyReport(telegram).catch(err => logger.error('Report error:', err));
});

// Zone coverage check at 22:05 UTC (after daily close)
cron.schedule('5 22 * * 1-5', () => {
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN!,
    process.env.TELEGRAM_CHAT_ID!
  );
  checkZoneCoverage(telegram).catch(err => logger.error('Zone check error:', err));
});

// ─── Startup ──────────────────────────────────────────────────────────────────

logger.info('TTrades Fractal Model Bot started');
logger.info(`Monitoring: ${SYMBOLS.join(', ')}`);
logger.info(`Paper trading: ${PAPER_TRADING ? 'ENABLED' : 'DISABLED'}`);
logger.info('Fast poll: 3 min (active signals) | Slow poll: 10 min (others)');

loadRules();
initZones();
getDb(); // init SQLite
startDashboard();

// Seed open trades as active symbols on startup
const openTrades = loadTrades().filter(t => !t.closedAt);
for (const t of openTrades) activeSymbols.add(t.symbol);
if (openTrades.length > 0) {
  logger.info(`Restored ${openTrades.length} active symbol(s) from trades.json: ${openTrades.map(t => t.symbol).join(', ')}`);
}

// Prevent double-scanning on startup by staggering initial scan times
const now = Date.now();
SYMBOLS.forEach((s, i) => lastScanned.set(s, now - (SLOW_INTERVAL_MS - i * 1000)));

runScan().catch(err => logger.error('Initial scan error:', err));
