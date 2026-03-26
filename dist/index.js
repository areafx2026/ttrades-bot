"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const capitalApi_1 = require("./capitalApi");
const fractalAnalyzer_1 = require("./fractalAnalyzer");
const telegram_1 = require("./telegram");
const tradeExecutor_1 = require("./tradeExecutor");
const signalCache_1 = require("./signalCache");
const marketHours_1 = require("./marketHours");
const rulesEngine_1 = require("./rulesEngine");
const tradeLogger_1 = require("./tradeLogger");
const reporter_1 = require("./reporter");
const database_1 = require("./database");
const dashboard_1 = require("./dashboard");
const logger_1 = require("./logger");
const currencyStrength_1 = require("./currencyStrength");
const zoneManager_1 = require("./zoneManager");
const node_cron_1 = __importDefault(require("node-cron"));
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
const activeSymbols = new Set();
// Track last scan time per symbol
const lastScanned = new Map();
const FAST_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const SLOW_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
function shouldScan(symbol) {
    const now = Date.now();
    const last = lastScanned.get(symbol) ?? 0;
    const interval = activeSymbols.has(symbol) ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
    return now - last >= interval;
}
// ─── Sync closed trades ───────────────────────────────────────────────────────
async function syncClosedTrades() {
    const openTrades = (0, tradeLogger_1.loadTrades)().filter(t => !t.closedAt);
    if (openTrades.length === 0)
        return;
    const capital = new capitalApi_1.CapitalAPI(process.env.CAPITAL_API_KEY, process.env.CAPITAL_IDENTIFIER, process.env.CAPITAL_PASSWORD, process.env.CAPITAL_DEMO === 'true');
    const telegram = new telegram_1.TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
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
        const dbOpenTrades = (0, database_1.getOpenTrades)();
        for (const dbTrade of dbOpenTrades) {
            try {
                const priceRes = await axios_1.default.get(`${baseURL}/markets/${dbTrade.symbol}`, { headers });
                const mid = (priceRes.data.snapshot.bid + priceRes.data.snapshot.offer) / 2;
                (0, database_1.recordPriceTick)(dbTrade.id, mid);
            }
            catch { /* skip */ }
        }
        const posRes = await axios_1.default.get(`${baseURL}/positions`, { headers });
        const openDealIds = new Set((posRes.data.positions || []).map((p) => p.position.dealId));
        for (const trade of openTrades) {
            if (!trade.dealId || openDealIds.has(trade.dealId))
                continue;
            logger_1.logger.info(`Closed trade detected: ${trade.symbol} [${trade.dealId}]`);
            let closePrice = (trade.entryZone[0] + trade.entryZone[1]) / 2;
            let closedAt = new Date().toISOString();
            try {
                const from = new Date(trade.openedAt).toISOString().slice(0, 19);
                const actRes = await axios_1.default.get(`${baseURL}/history/activity`, {
                    headers,
                    params: { from, detailed: true },
                });
                const activities = actRes.data.activities || [];
                for (const act of activities) {
                    if (act.details?.dealId === trade.dealId || act.dealId === trade.dealId) {
                        const actions = act.details?.actions || [];
                        const closeAction = actions.find((a) => a.actionType === 'POSITION_CLOSED' || a.actionType === 'POSITION_DELETED');
                        if (closeAction) {
                            closePrice = parseFloat(closeAction.level ?? closePrice);
                            closedAt = act.date ?? closedAt;
                            break;
                        }
                    }
                }
            }
            catch {
                logger_1.logger.warn(`Could not fetch close price for ${trade.dealId}, using fallback`);
            }
            const closed = (0, tradeLogger_1.logClosedTrade)(trade.dealId, closePrice, closedAt);
            (0, tradeLogger_1.savePineScript)();
            // Update SQLite DB with close data
            if (closed) {
                try {
                    const pip = trade.symbol.includes('JPY') ? 0.01 : 0.0001;
                    (0, database_1.closeTrade)(trade.dealId, closePrice, closedAt, 'SL/TP/Market', closed.pnlPips ?? 0, closed.pnlEUR ?? 0, closed.result ?? 'BREAKEVEN');
                }
                catch (dbErr) {
                    logger_1.logger.error('DB close error:', dbErr);
                }
            }
            // Remove from active symbols
            activeSymbols.delete(trade.symbol);
            if (closed) {
                const dec = trade.symbol.includes('JPY') ? 3 : 5;
                const resultEmoji = closed.result === 'WIN' ? '✅' : closed.result === 'LOSS' ? '❌' : '➖';
                const dirEmoji = trade.type === 'LONG' ? '📈' : '📉';
                await telegram.sendMessage(`${resultEmoji} <b>Trade geschlossen — ${trade.symbol}</b>\n` +
                    `${dirEmoji} ${trade.type} | ${closed.result}\n` +
                    `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
                    `P&L: <b>${closed.pnlPips && closed.pnlPips >= 0 ? '+' : ''}${closed.pnlPips?.toFixed(1)} pips</b>  ` +
                    `(<b>${closed.pnlEUR && closed.pnlEUR >= 0 ? '+' : ''}€${closed.pnlEUR?.toFixed(2)}</b>)`);
            }
        }
    }
    catch (err) {
        logger_1.logger.error('Error syncing closed trades:', err);
    }
}
// ─── Analyze single symbol ────────────────────────────────────────────────────
async function analyzeSymbol(symbol, capital, executor, telegram, strength = null) {
    lastScanned.set(symbol, Date.now());
    // Only scan during active trading sessions (London Open / NY Open)
    if (!(0, marketHours_1.isActiveTradingSession)()) {
        const session = (0, marketHours_1.getActiveSession)();
        logger_1.logger.info(`${symbol}: outside active session \u2014 skipping`);
        return;
    }
    const dailyCandles = await capital.getCandles(symbol, 'DAY', 20);
    await new Promise(r => setTimeout(r, 150));
    const h4Candles = await capital.getCandles(symbol, 'HOUR_4', 40);
    await new Promise(r => setTimeout(r, 150));
    const h1Candles = await capital.getCandles(symbol, 'HOUR', 60);
    await new Promise(r => setTimeout(r, 150));
    const m15Candles = await capital.getCandles(symbol, 'MINUTE_15', 80);
    const analyzer = new fractalAnalyzer_1.FractalAnalyzer(symbol, dailyCandles, h4Candles, h1Candles, m15Candles);
    const signal = analyzer.analyze();
    if (signal) {
        // Mark as active — will be polled every 3 min
        activeSymbols.add(symbol);
        if ((0, signalCache_1.isDuplicate)(signal.symbol, signal.type, signal.phase)) {
            logger_1.logger.info(`${symbol}: signal already sent recently, skipping.`);
            return;
        }
        // Currency strength filter
        if (strength) {
            const strengthCheck = (0, currencyStrength_1.isStrengthAligned)(symbol, signal.type, strength);
            if (!strengthCheck.aligned) {
                logger_1.logger.info(`${symbol}: strength filter blocked — ${strengthCheck.reason}`);
                activeSymbols.delete(symbol);
                return;
            }
            logger_1.logger.info(`${symbol}: strength aligned — ${strengthCheck.reason}`);
        }
        logger_1.logger.info(`Signal found for ${symbol}: ${signal.type}`);
        await telegram.sendSignal(signal);
        (0, signalCache_1.cacheSignal)(signal.symbol, signal.type, signal.phase);
        if (PAPER_TRADING) {
            const maxTrades = (0, rulesEngine_1.getMaxTrades)();
            const openPositions = await executor.getOpenPositions();
            if (openPositions.length >= maxTrades) {
                logger_1.logger.warn(`Max trades limit reached (${maxTrades}) — skipping ${symbol}`);
                return;
            }
            const result = await executor.openTrade(signal);
            const dec = signal.symbol.includes('JPY') ? 3 : 5;
            if (result.success && result.dealId) {
                logger_1.logger.info(`Trade opened for ${symbol}: ${result.dealId}`);
                (0, tradeLogger_1.logOpenTrade)(signal, result.dealId);
                (0, tradeLogger_1.savePineScript)();
                // Insert full signal context into SQLite DB
                try {
                    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
                    const entryMid2 = (signal.entryZone[0] + signal.entryZone[1]) / 2;
                    const stopPips2 = Math.abs(entryMid2 - signal.stopLoss) / pip;
                    const entryDistPips = Math.abs(signal.currentPrice - entryMid2) / pip;
                    const openedDate = new Date();
                    (0, database_1.insertTrade)({
                        id: result.dealId,
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
                        session: (0, marketHours_1.getActiveSession)() ?? 'unknown',
                        weekday: openedDate.getUTCDay(),
                        opened_at: openedDate.toISOString(),
                        daily_bias: signal.dailyBias,
                        h4_confirmation: signal.h4Confirmation,
                        h1_context: signal.h1Context,
                        m15_setup: signal.m15Setup,
                        fvg_present: signal.fvgLevel != null ? 1 : 0,
                        strategy_version: (0, database_1.getCurrentStrategyVersion)(),
                    });
                }
                catch (dbErr) {
                    logger_1.logger.error('DB insert error:', dbErr);
                }
                const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
                await telegram.sendMessage(`✅ <b>Trade geöffnet — ${symbol}</b>\n` +
                    `${signal.type === 'LONG' ? '📈' : '📉'} ${signal.type} | ${result.dealId}\n` +
                    `Entry: <code>${entryMid.toFixed(dec)}</code>\n` +
                    `SL: <code>${signal.stopLoss.toFixed(dec)}</code> | ` +
                    `TP: <code>${signal.target1.toFixed(dec)}</code>`);
            }
            else {
                logger_1.logger.warn(`Trade skipped for ${symbol}: ${result.message}`);
                if (result.message.includes('Cooldown')) {
                    await telegram.sendMessage(`⏳ <b>${symbol}</b> — ${result.message}`);
                }
                // If entry missed, remove from active
                if (result.message.includes('verpasst')) {
                    activeSymbols.delete(symbol);
                }
            }
        }
    }
    else {
        // No signal — if was active but no longer has signal, downgrade to slow polling
        if (activeSymbols.has(symbol)) {
            logger_1.logger.info(`${symbol}: signal gone — switching to slow polling`);
            activeSymbols.delete(symbol);
        }
        else {
            logger_1.logger.info(`No setup for ${symbol} yet.`);
        }
    }
}
// ─── Main scan ────────────────────────────────────────────────────────────────
async function runScan() {
    if (!(0, marketHours_1.isMarketOpen)()) {
        if (marketWasOpen) {
            logger_1.logger.info('Market closed — scans paused until next open.');
            marketWasOpen = false;
        }
        return;
    }
    if (!marketWasOpen) {
        logger_1.logger.info('Market open — resuming scans.');
        marketWasOpen = true;
    }
    const nowMEZ = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const rulesCheck = (0, rulesEngine_1.isBlockedByRules)(nowMEZ);
    if (rulesCheck.blocked) {
        logger_1.logger.info(`Scan skipped — ${rulesCheck.reason}`);
        return;
    }
    // Determine which symbols to scan this round
    const toScan = SYMBOLS.filter(s => shouldScan(s));
    if (toScan.length === 0)
        return;
    const fastCount = toScan.filter(s => activeSymbols.has(s)).length;
    const slowCount = toScan.length - fastCount;
    logger_1.logger.info(`Scanning ${toScan.length} symbols (${fastCount} fast / ${slowCount} slow)`);
    const capital = new capitalApi_1.CapitalAPI(process.env.CAPITAL_API_KEY, process.env.CAPITAL_IDENTIFIER, process.env.CAPITAL_PASSWORD, process.env.CAPITAL_DEMO === 'true');
    const telegram = new telegram_1.TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    try {
        await capital.createSession();
        // Calculate currency strength once per scan (cached for 1h)
        let strength = null;
        try {
            strength = await (0, currencyStrength_1.getCurrencyStrength)(capital);
        }
        catch (err) {
            logger_1.logger.warn('Currency strength calculation failed — filter disabled for this scan');
        }
        const executor = new tradeExecutor_1.TradeExecutor(capital.apiKey, capital.isDemo, capital.cst, capital.securityToken);
        // Scan active symbols first (fast lane)
        const active = toScan.filter(s => activeSymbols.has(s));
        const passive = toScan.filter(s => !activeSymbols.has(s));
        for (const symbol of [...active, ...passive]) {
            try {
                await analyzeSymbol(symbol, capital, executor, telegram);
            }
            catch (err) {
                logger_1.logger.error(`Error analyzing ${symbol}:`, err);
            }
            await new Promise(r => setTimeout(r, 200));
        }
        // Sync closed trades
        if (PAPER_TRADING) {
            await syncClosedTrades();
        }
    }
    catch (err) {
        logger_1.logger.error('Scan error:', err);
    }
}
// ─── Cron: every 3 minutes ────────────────────────────────────────────────────
node_cron_1.default.schedule('*/3 * * * *', () => {
    runScan().catch(err => logger_1.logger.error('Cron error:', err));
});
// Daily report at 08:00 UTC (09:00 MEZ)
node_cron_1.default.schedule('0 8 * * *', () => {
    const telegram = new telegram_1.TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    (0, reporter_1.sendDailyReport)(telegram).catch(err => logger_1.logger.error('Report error:', err));
});
// Zone coverage check at 22:05 UTC (after daily close)
node_cron_1.default.schedule('5 22 * * 1-5', () => {
    const telegram = new telegram_1.TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    (0, reporter_1.checkZoneCoverage)(telegram).catch(err => logger_1.logger.error('Zone check error:', err));
});
// ─── Startup ──────────────────────────────────────────────────────────────────
logger_1.logger.info('TTrades Fractal Model Bot started');
logger_1.logger.info(`Monitoring: ${SYMBOLS.join(', ')}`);
logger_1.logger.info(`Paper trading: ${PAPER_TRADING ? 'ENABLED' : 'DISABLED'}`);
logger_1.logger.info('Fast poll: 3 min (active signals) | Slow poll: 10 min (others)');
(0, rulesEngine_1.loadRules)();
(0, zoneManager_1.initZones)();
(0, database_1.getDb)(); // init SQLite
(0, dashboard_1.startDashboard)();
// Seed open trades as active symbols on startup
const openTrades = (0, tradeLogger_1.loadTrades)().filter(t => !t.closedAt);
for (const t of openTrades)
    activeSymbols.add(t.symbol);
if (openTrades.length > 0) {
    logger_1.logger.info(`Restored ${openTrades.length} active symbol(s) from trades.json: ${openTrades.map(t => t.symbol).join(', ')}`);
}
// Prevent double-scanning on startup by staggering initial scan times
const now = Date.now();
SYMBOLS.forEach((s, i) => lastScanned.set(s, now - (SLOW_INTERVAL_MS - i * 1000)));
runScan().catch(err => logger_1.logger.error('Initial scan error:', err));
