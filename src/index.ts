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

// Log filter rejections to SQLite for dashboard stats
function logFilterRejection(symbol: string, reason: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO filter_rejections (symbol, reason, rejected_at)
      VALUES (?, ?, ?)
    `).run(symbol, reason, new Date().toISOString());
  } catch { /* table may not exist yet */ }
}

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

    // ── Step 1: Get all currently open positions + working orders from Capital.com ──
    const openDealIds = new Set<string>();

    // Add working order IDs (pending limit orders are NOT closed)
    try {
      const woRes = await axios.get(`${baseURL}/workingorders`, { headers });
      for (const wo of (woRes.data.workingOrders || [])) {
        if (wo.workingOrderData.dealId) openDealIds.add(wo.workingOrderData.dealId);
      }
    } catch { /* ignore */ }

    // Add open position IDs
    const posRes = await axios.get(`${baseURL}/positions`, { headers });
    for (const p of (posRes.data.positions || [])) {
      if (p.position.dealId)        openDealIds.add(p.position.dealId);
      if (p.position.dealReference) openDealIds.add(p.position.dealReference);
      const oRef = (p.position.dealReference as string)?.replace(/^p_/, 'o_');
      if (oRef) openDealIds.add(oRef);
    }

    // ── Step 2: Update MAE/MFE and check time-based auto-close for open trades ──
    const dbOpenTrades = getDbOpenTrades();
    for (const dbTrade of dbOpenTrades) {
      try {
        const priceRes = await axios.get(`${baseURL}/markets/${dbTrade.symbol}`, { headers });
        const mid = (priceRes.data.snapshot.bid + priceRes.data.snapshot.offer) / 2;
        recordPriceTick(dbTrade.id, mid);

        // Time-based auto-close: >48h open + <50% TP progress
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
            logger.info(`Time-based close: ${dbTrade.symbol} open ${holdHours.toFixed(1)}h, progress ${(progressPct * 100).toFixed(0)}%`);
            try {
              const executor2 = new TradeExecutor(process.env.CAPITAL_API_KEY!, capital.isDemo, capital.cst, capital.securityToken);
              const closeResult = await executor2.closePosition(dbTrade.id);
              if (closeResult.success) {
                const pnlPips2 = Math.round(((dbTrade.type === 'LONG' ? mid - fillPrice : fillPrice - mid) / pip) * 10) / 10;
                const resultStr = pnlPips2 > 0.5 ? 'WIN' : pnlPips2 < -0.5 ? 'LOSS' : 'BREAKEVEN';
                const closeReason = `TIME_CLOSE (${holdHours.toFixed(0)}h, ${(progressPct * 100).toFixed(0)}% progress)`;
                closeTrade(dbTrade.id, mid, new Date().toISOString(), closeReason, pnlPips2, 0, resultStr);
                logClosedTrade(dbTrade.id, mid, new Date().toISOString());
                savePineScript();
                activeSymbols.delete(dbTrade.symbol);
                openDealIds.delete(dbTrade.id); // mark as closed so Step 3 skips it
                const dec2 = dbTrade.symbol.includes('JPY') ? 3 : 5;
                await telegram.sendMessage(
                  `⏰ <b>Time-based Close — ${dbTrade.symbol}</b>\n` +
                  `${dbTrade.type === 'LONG' ? '📈' : '📉'} ${dbTrade.type} | ${resultStr}\n` +
                  `Offen seit: <b>${holdHours.toFixed(0)}h</b> | Fortschritt: <b>${(progressPct*100).toFixed(0)}%</b>\n` +
                  `Close: <code>${mid.toFixed(dec2)}</code> | P&L: <b>${pnlPips2 >= 0 ? '+' : ''}${pnlPips2.toFixed(1)} pips</b>`
                );
              }
            } catch (e: any) { logger.error(`Time-close error ${dbTrade.symbol}:`, e.message); }
          }
        }
      } catch { /* skip */ }
    }

    // ── Step 3: Detect closed trades (not in openDealIds anymore) ──
    // Fetch recent activity once for all closed trade lookups (last 2h — well within 1-day API limit)
    const from2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 19);
    let recentActivities: any[] = [];
    try {
      const actRes = await axios.get(`${baseURL}/history/activity`, {
        headers,
        params: { from: from2h, detailed: true },
      });
      recentActivities = actRes.data.activities || [];
    } catch { logger.warn('Could not fetch activity history'); }

    for (const trade of openTrades) {
      if (!trade.dealId || openDealIds.has(trade.dealId)) continue;

      logger.info(`Closed trade detected: ${trade.symbol} [${trade.dealId}]`);

      // Find close price from recent activity — NO fallback to entry price
      let closePrice: number | null = null;
      let closedAt = new Date().toISOString();
      let closeSource = 'UNKNOWN';

      for (const act of recentActivities) {
        const actDealId  = act.dealId ?? '';
        const actDealRef = act.details?.dealReference ?? '';
        const tradeId    = trade.dealId;
        const matches =
          actDealId  === tradeId ||
          actDealRef === tradeId ||
          actDealRef === tradeId.replace(/^o_/, 'p_') ||
          actDealId  === tradeId.replace(/^o_/, 'p_');

        if (matches && act.type === 'POSITION' &&
            (act.source === 'SL' || act.source === 'TP' || act.source === 'USER' || act.source === 'SYSTEM')) {
          closePrice = parseFloat(act.details?.level);
          closedAt   = act.dateUTC ?? act.date ?? closedAt;
          closeSource = act.source;
          logger.info(`Close found: ${closePrice} via ${act.source} for ${trade.symbol}`);
          break;
        }
      }

      // If close price not found in last 2h, try extending to 23h (still within API limit)
      if (closePrice === null) {
        try {
          const from23h = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString().slice(0, 19);
          const actRes2 = await axios.get(`${baseURL}/history/activity`, {
            headers,
            params: { from: from23h, detailed: true },
          });
          for (const act of (actRes2.data.activities || [])) {
            const actDealId  = act.dealId ?? '';
            const actDealRef = act.details?.dealReference ?? '';
            const tradeId    = trade.dealId;
            const matches =
              actDealId  === tradeId ||
              actDealRef === tradeId ||
              actDealRef === tradeId.replace(/^o_/, 'p_') ||
              actDealId  === tradeId.replace(/^o_/, 'p_');

            if (matches && act.type === 'POSITION' &&
                (act.source === 'SL' || act.source === 'TP' || act.source === 'USER' || act.source === 'SYSTEM')) {
              closePrice = parseFloat(act.details?.level);
              closedAt   = act.dateUTC ?? act.date ?? closedAt;
              closeSource = act.source;
              logger.info(`Close found (23h window): ${closePrice} via ${act.source} for ${trade.symbol}`);
              break;
            }
          }
        } catch { /* ignore */ }
      }

      // Still no close price — skip this trade and log warning (do NOT use entry as fallback)
      if (closePrice === null || isNaN(closePrice)) {
        logger.warn(`Close price not found for ${trade.symbol} [${trade.dealId}] — skipping to avoid BREAKEVEN. Will retry next scan.`);
        continue;
      }

      // Calculate P&L using actual fill price from DB (not entry zone mid)
      const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
      const dbTrade2 = dbOpenTrades.find(d => d.id === trade.dealId);
      const entryPrice = dbTrade2?.entry_price ?? (trade.entryZone[0] + trade.entryZone[1]) / 2;
      const rawPnlPips = trade.type === 'LONG'
        ? (closePrice - entryPrice) / pip
        : (entryPrice - closePrice) / pip;
      const pnlPips = Math.round(rawPnlPips * 10) / 10;
      const result = pnlPips > 0.5 ? 'WIN' : pnlPips < -0.5 ? 'LOSS' : 'BREAKEVEN';

      const closed = logClosedTrade(trade.dealId, closePrice, closedAt);
      savePineScript();

      try {
        closeTrade(trade.dealId, closePrice, closedAt, closeSource, pnlPips, closed?.pnlEUR ?? 0, result);
        logger.info(`Trade closed in DB: ${trade.symbol} ${result} ${pnlPips} pips via ${closeSource}`);
      } catch (dbErr) { logger.error('DB close error:', dbErr); }

      activeSymbols.delete(trade.symbol);

      const dec = trade.symbol.includes('JPY') ? 3 : 5;
      const resultEmoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
      const pnlEUR = closed?.pnlEUR ?? 0;
      await telegram.sendMessage(
        `${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>\n` +
        `${trade.type === 'LONG' ? '📈' : '📉'} ${trade.type} | ${result} | ${closeSource}\n` +
        `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
        `P&L: <b>${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips</b>  ` +
        `(<b>${pnlEUR >= 0 ? '+' : ''}€${pnlEUR.toFixed(2)}</b>)`
      );
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

  const dailyCandles = await capital.getCandles(symbol, 'DAY', 20);
  await new Promise(r => setTimeout(r, 150));
  const h4Candles = await capital.getCandles(symbol, 'HOUR_4', 40);
  await new Promise(r => setTimeout(r, 150));
  const h1Candles = await capital.getCandles(symbol, 'HOUR', 60);
  await new Promise(r => setTimeout(r, 150));
  const m15Candles = await capital.getCandles(symbol, 'MINUTE_15', 80);

  const analyzer = new FractalAnalyzer(symbol, dailyCandles, h4Candles, h1Candles, m15Candles);
  const analyzeResult = analyzer.analyze();
  const signal = analyzeResult.signal;

  // Log rejection if a full setup was found but filtered out
  if (analyzeResult.rejected && analyzeResult.reason) {
    logger.info(`${symbol}: Setup REJECTED — ${analyzeResult.reason}`);
    logFilterRejection(symbol, analyzeResult.reason);
  }

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
              ? fillPrice + risk2 * 1.3
              : fillPrice - risk2 * 1.3;

            // Update TP on Capital.com
            try {
              await axios.put(`${fillBaseURL}/positions/${resolvedDealId}`,
                { stopLevel: signal.stopLoss, profitLevel: parseFloat(newTP.toFixed(pip2 === 0.01 ? 3 : 5)) },
                { headers: fillHeaders }
              );
              signal.target1 = newTP;
              logger.info(`TP adjusted to ${newTP.toFixed(pip2 === 0.01 ? 3 : 5)} for exact 1:1.5 R:R (fill: ${fillPrice})`);
              // Update size_points in DB from actual position size
              try {
                const db = getDb();
                db.prepare('UPDATE trades SET size_points = ? WHERE id = ?').run(matchedPos.position.size, resolvedDealId);
              } catch { /* ignore */ }
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
            size_points: 0,
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

    // Note: syncClosedTrades runs at the START of runScan — no need to run again here

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
