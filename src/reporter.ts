import { loadTrades, TradeRecord } from './tradeLogger';
import { analyzeTradesWithAI } from './aiAnalyzer';
import { loadZones } from './zoneManager';
import { TelegramNotifier } from './telegram';
import { logger } from './logger';

const MONITORED_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
  'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD',
  'GBPNZD', 'GBPJPY', 'GBPCHF', 'GBPCAD', 'GBPAUD',
  'AUDJPY', 'CHFJPY', 'AUDNZD', 'AUDCAD', 'CADJPY',
];

export async function checkZoneCoverage(telegram: TelegramNotifier): Promise<void> {
  const zones = loadZones();
  const warnings: string[] = [];

  for (const symbol of MONITORED_SYMBOLS) {
    const symbolZones = zones.filter(z => z.symbol === symbol);
    const hasSupport    = symbolZones.some(z => z.type === 'support');
    const hasResistance = symbolZones.some(z => z.type === 'resistance');

    if (!hasSupport && !hasResistance) {
      // No zones at all — only warn for symbols user has started defining zones for
      continue;
    }
    if (!hasSupport) {
      warnings.push(`⚠️ <b>${symbol}</b> — keine Support-Zone definiert`);
    }
    if (!hasResistance) {
      warnings.push(`⚠️ <b>${symbol}</b> — keine Resistance-Zone definiert`);
    }
  }

  if (warnings.length === 0) return;

  const msg = `🗺 <b>Zonen-Warnung</b>\n━━━━━━━━━━━━━━━━━━━━\nFolgende Zonen fehlen oder sind veraltet:\n\n` +
    warnings.join('\n') +
    `\n\n<i>Bitte zones.json aktualisieren.</i>`;

  await telegram.sendMessage(msg);
  logger.info(`Zone coverage warning sent: ${warnings.length} missing zones`);
}

export async function sendDailyReport(telegram: TelegramNotifier): Promise<void> {
  logger.info('Generating daily report...');

  const allTrades = loadTrades();
  const now = new Date();

  // Yesterday 09:00 UTC+1 → today 09:00 UTC+1 = 08:00 UTC window
  const windowStart = new Date(now);
  windowStart.setUTCHours(windowStart.getUTCHours() - 24);

  const openTrades    = allTrades.filter(t => !t.closedAt);
  const closedToday   = allTrades.filter(t => {
    if (!t.closedAt) return false;
    return new Date(t.closedAt) >= windowStart;
  });

  const wins      = closedToday.filter(t => t.result === 'WIN');
  const losses    = closedToday.filter(t => t.result === 'LOSS');
  const breakeven = closedToday.filter(t => t.result === 'BREAKEVEN');
  const longs     = closedToday.filter(t => t.type === 'LONG');
  const shorts    = closedToday.filter(t => t.type === 'SHORT');

  const totalPnlEUR  = closedToday.reduce((sum, t) => sum + (t.pnlEUR  ?? 0), 0);
  const totalPnlPips = closedToday.reduce((sum, t) => sum + (t.pnlPips ?? 0), 0);
  const winRate      = closedToday.length > 0
    ? Math.round((wins.length / closedToday.length) * 100)
    : 0;

  const pnlEmoji = totalPnlEUR >= 0 ? '🟢' : '🔴';
  const dateStr  = now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

  let msg = `📋 <b>TTFM Tagesbericht — ${dateStr}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Closed trades summary
  msg += `<b>📊 Abgeschlossene Trades (letzte 24h)</b>\n`;
  msg += `Gesamt:    <b>${closedToday.length}</b>  (${longs.length} Long | ${shorts.length} Short)\n`;
  msg += `Gewinn:    <b>${wins.length}</b>  |  Verlust: <b>${losses.length}</b>  |  BE: <b>${breakeven.length}</b>\n`;
  msg += `Win Rate:  <b>${winRate}%</b>\n`;
  msg += `${pnlEmoji} P&amp;L:     <b>${totalPnlEUR >= 0 ? '+' : ''}€${totalPnlEUR.toFixed(2)}</b>  (${totalPnlPips >= 0 ? '+' : ''}${totalPnlPips.toFixed(1)} pips)\n`;

  // Individual closed trades
  if (closedToday.length > 0) {
    msg += `\n<b>Trades im Detail:</b>\n`;
    closedToday.forEach(t => {
      const resultEmoji = t.result === 'WIN' ? '✅' : t.result === 'LOSS' ? '❌' : '➖';
      const dir = t.type === 'LONG' ? '📈' : '📉';
      msg += `${resultEmoji} ${dir} ${t.symbol}  ${t.pnlPips && t.pnlPips >= 0 ? '+' : ''}${t.pnlPips?.toFixed(1)} pips  (${t.pnlEUR && t.pnlEUR >= 0 ? '+' : ''}€${t.pnlEUR?.toFixed(2)})\n`;
    });
  } else {
    msg += `\nKeine abgeschlossenen Trades in den letzten 24h.\n`;
  }

  // Open positions
  msg += `\n<b>📂 Offene Positionen (${openTrades.length})</b>\n`;
  if (openTrades.length > 0) {
    openTrades.forEach(t => {
      const dir = t.type === 'LONG' ? '📈' : '📉';
      const since = new Date(t.openedAt).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
      const dec = t.symbol.includes('JPY') ? 3 : 5;
      msg += `${dir} ${t.symbol}  SL: <code>${t.stopLoss.toFixed(dec)}</code>  TP: <code>${t.target1.toFixed(dec)}</code>  seit ${since}\n`;
    });
  } else {
    msg += `Keine offenen Positionen.\n`;
  }

  // All-time stats
  const allClosed  = allTrades.filter(t => t.closedAt);
  const allWins    = allClosed.filter(t => t.result === 'WIN');
  const allPnlEUR  = allClosed.reduce((sum, t) => sum + (t.pnlEUR ?? 0), 0);
  const allWinRate = allClosed.length > 0 ? Math.round((allWins.length / allClosed.length) * 100) : 0;
  const allPnlEmoji = allPnlEUR >= 0 ? '🟢' : '🔴';

  msg += `\n<b>📈 Gesamt (alle Trades)</b>\n`;
  msg += `Trades:   <b>${allClosed.length}</b>  |  Win Rate: <b>${allWinRate}%</b>\n`;
  msg += `${allPnlEmoji} P&amp;L:   <b>${allPnlEUR >= 0 ? '+' : ''}€${allPnlEUR.toFixed(2)}</b>\n`;

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<i>🤖 TTFM Bot | ${now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })} MEZ</i>`;

  await telegram.sendMessage(msg);
  logger.info('Daily report sent.');

  // Zone coverage check
  await checkZoneCoverage(telegram);

  // AI analysis — only if there were closed trades
  const closedToday2 = loadTrades().filter(t => {
    if (!t.closedAt) return false;
    return new Date(t.closedAt) >= windowStart;
  });

  if (closedToday2.length > 0) {
    logger.info('Requesting AI trade analysis...');
    const analysis = await analyzeTradesWithAI();
    if (analysis) {
      await telegram.sendMessage(
        `🤖 <b>KI-Analyse — ${dateStr}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` + analysis
      );
    }
  }
}
