import 'dotenv/config';
import axios from 'axios';
import { CapitalAPI } from './capitalApi';
import { FractalAnalyzer } from './fractalAnalyzer';
import { TelegramNotifier } from './telegram';
import { TradeExecutor } from './tradeExecutor';
import { isDuplicate, cacheSignal } from './signalCache';
import { isMarketOpen, isActiveTradingSession, getActiveSession } from './marketHours';
import { loadRules, isBlockedByRules, getMaxTrades } from './rulesEngine';
import { logOpenTrade, logClosedTrade, loadTrades, savePineScript } from './tradeLogger';
import { sendDailyReport, checkZoneCoverage } from './reporter';
import { getDb, insertTrade, closeTrade, recordPriceTick, getOpenTrades as getDbOpenTrades, getCurrentStrategyVersion } from './database';
import { startDashboard } from './dashboard';
import { logger } from './logger';
import * as fs from 'fs';

// Max normal spread per pair (pips) -- blocked if > 2x normal
const SPREAD_LIMITS: Record<string, number> = {
  EURUSD: 1.2, GBPUSD: 2.0, USDJPY: 1.5, USDCHF: 1.5, USDCAD: 2.0,
  AUDUSD: 1.5, NZDUSD: 2.0, EURGBP: 1.5, EURJPY: 2.0, EURCHF: 2.5,
  EURAUD: 3.0, EURCAD: 3.0, GBPNZD: 4.0, GBPJPY: 3.0, GBPCHF: 3.0,
  GBPCAD: 4.0, GBPAUD: 4.0, AUDJPY: 2.5, CHFJPY: 2.5, AUDNZD: 3.0,
  AUDCAD: 3.0, CADJPY: 3.0, EURNZD: 4.0,
};
const SPREAD_LOG = './logs/spread_log.csv';

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
        const priceRes = await axios.get(`${baseURL}/markets/${dbTrade.symbol}`, { headers });
        const mid = (priceRes.data.snapshot.bid + priceRes.data.snapshot.offer) / 2;
        recordPriceTick(dbTrade.id, mid);
      } catch { /* skip */ }
    }

    const posRes = await axios.get(`${baseURL}/positions`, { headers });
    // Build set of ALL known IDs — Capital.com uses dealId internally
    // but bot stores dealReference (o_xxx) from the order response
    const openDealIds = new Set<string>();
    for (const p of (posRes.data.positions || [])) {
      if (p.position.dealId)        openDealIds.add(p.position.dealId);
      if (p.position.dealReference) openDealIds.add(p.position.dealReference);
      // Convert p_xxx → o_xxx to match bot's stored dealReference format
      const oRef = (p.position.dealReference as string)?.replace(/^p_/, 'o_');
      if (oRef) openDealIds.add(oRef);
    }

    for (const trade of openTrades) {
      if (!trade.dealId || openDealIds.has(trade.dealId)) continue;

      logger.info(`Closed trade detected: ${trade.symbol} [${trade.dealId}]`);

      let closePrice = (trade.entryZone[0] + trade.entryZone[1]) / 2;
      let closedAt   = new Date().toISOString();

      try {
        const from = new Date(trade.openedAt).toISOString().slice(0, 19);
        const actRes = await axios.get(`${baseURL}/history/activity`, {
          headers,
          params: { from, detailed: true },
        });

        const activities = actRes.data.activities || [];
        for (const act of activities) {
          if (act.details?.dealId === trade.dealId || act.dealId === trade.dealId) {
            const actions = act.details?.actions || [];
            const closeAction = actions.find((a: any) =>
              a.actionType === 'POSITION_CLOSED' || a.actionType === 'POSITION_DELETED'
            );
            if (closeAction) {
              closePrice = parseFloat(closeAction.level ?? closePrice);
              closedAt   = act.date ?? closedAt;
              break;
            }
          }
        }
      } catch {
        logger.warn(`Could not fetch close price for ${trade.dealId}, using fallback`);
      }

      const closed = logClosedTrade(trade.dealId, closePrice, closedAt);
      savePineScript();

      // Update SQLite DB with close data
      if (closed) {
        try {
          const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
          closeTrade(
            trade.dealId,
            closePrice,
            closedAt,
            'SL/TP/Market',
            closed.pnlPips ?? 0,
            closed.pnlEUR ?? 0,
            closed.result ?? 'BREAKEVEN'
          );
        } catch (dbErr) { logger.error('DB close error:', dbErr); }
      }

      // Remove from active symbols
      activeSymbols.delete(trade.symbol);

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

// ─── Analyze single symbol ────────────────────────────────────────────────────

async function analyzeSymbol(
  symbol: string,
  capital: CapitalAPI,
  executor: TradeExecutor,
  telegram: TelegramNotifier,
  strength: import('./currencyStrength').StrengthResult | null = null
): Promise<void> {
  lastScanned.set(symbol, Date.now());

  // Only scan during active trading sessions (London Open / NY Open)
  if (!isActiveTradingSession()) {
    const session = getActiveSession();
    logger.info(`${symbol}: outside active session \u2014 skipping`);
    return;
  }

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

    logger.info(`Signal found for ${symbol}: ${signal.type}`);
    await telegram.sendSignal(signal);
    cacheSignal(signal.symbol, signal.type, signal.phase);

    if (PAPER_TRADING) {
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
        const mktInfo = await axios.get(
          `${capital.isDemo ? 'https://demo-api-capital.backend-capital.com' : 'https://api-capital.backend-capital.com'}/api/v1/markets/${symbol}`,
          { headers: { CST: capital.cst, 'X-SECURITY-TOKEN': capital.securityToken } }
        );
        const bid = mktInfo.data.snapshot?.bid ?? 0;
        const offer = mktInfo.data.snapshot?.offer ?? 0;
        const pip = symbol.includes('JPY') ? 0.01 : 0.0001;
        const spreadPips = (offer - bid) / pip;
        const normalPips = SPREAD_LIMITS[symbol] ?? 3.0;
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
        // Resolve real Capital.com dealId by fetching open positions
        // The bot stores dealReference (o_xxx) but Capital.com uses a different dealId
        let resolvedDealId = result.dealId;
        try {
          await new Promise(r => setTimeout(r, 1500)); // wait for position to appear
          const fillCapital = new CapitalAPI(
            process.env.CAPITAL_API_KEY!,
            process.env.CAPITAL_IDENTIFIER!,
            process.env.CAPITAL_PASSWORD!,
            process.env.CAPITAL_DEMO === 'true'
          );
          await fillCapital.createSession();
          const fillBaseURL = fillCapital.isDemo
            ? 'https://demo-api-capital.backend-capital.com/api/v1'
            : 'https://api-capital.backend-capital.com/api/v1';
          const fillHeaders = { 'CST': fillCapital.cst, 'X-SECURITY-TOKEN': fillCapital.securityToken };
          const posCheck = await axios.get(`${fillBaseURL}/positions`, { headers: fillHeaders });
          const matchedPos = (posCheck.data.positions || []).find((p: any) =>
            p.market.epic === symbol &&
            p.position.direction === (signal.type === 'LONG' ? 'BUY' : 'SELL')
          );
          if (matchedPos) {
            resolvedDealId = matchedPos.position.dealId;
            logger.info(`Resolved Capital.com dealId: ${resolvedDealId}`);

            // Recalculate TP based on actual fill price for exact 1:1.5 R:R
            const fillPrice = matchedPos.position.level;
            const pip2 = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
            const risk2 = Math.abs(fillPrice - signal.stopLoss);
            const newTP = signal.type === 'LONG'
              ? fillPrice + risk2 * 1.5
              : fillPrice - risk2 * 1.5;

            // Update TP on Capital.com
            try {
              await axios.put(`${fillBaseURL}/positions/${resolvedDealId}`,
                { stopLevel: signal.stopLoss, profitLevel: parseFloat(newTP.toFixed(pip2 === 0.01 ? 3 : 5)) },
                { headers: fillHeaders }
              );
              signal.target1 = newTP;
              logger.info(`TP adjusted to ${newTP.toFixed(pip2 === 0.01 ? 3 : 5)} for exact 1:1.5 R:R (fill: ${fillPrice})`);
            } catch { logger.warn('Could not update TP after fill'); }
          }
        } catch { /* use original dealId */ }

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
  if (!isMarketOpen()) {
    if (marketWasOpen) {
      logger.info('Market closed — scans paused until next open.');
      marketWasOpen = false;
    }
    return;
  }
  if (!marketWasOpen) {
    logger.info('Market open — resuming scans.');
    marketWasOpen = true;
  }

  const nowMEZ = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const rulesCheck = isBlockedByRules(nowMEZ);
  if (rulesCheck.blocked) {
    logger.info(`Scan skipped — ${rulesCheck.reason}`);
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
        await analyzeSymbol(symbol, capital, executor, telegram);
      } catch (err) {
        logger.error(`Error analyzing ${symbol}:`, err);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Sync closed trades
    if (PAPER_TRADING) {
      await syncClosedTrades();
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
