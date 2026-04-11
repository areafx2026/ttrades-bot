import { analyzeTradesWithAI } from './aiAnalyzer';
import { loadZones } from './zoneManager';
import { getDb, getAllTrades, getOpenTrades, DbTrade } from './database';
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

function updateWinRateAfter(): void {
  try {
    const db = getDb();
    const log = db.prepare('SELECT DISTINCT version FROM strategy_log').all() as any[];

    for (const entry of log) {
      const version = entry.version;
      const trades = db.prepare('SELECT result FROM trades WHERE strategy_version = ? AND closed_at IS NOT NULL').all(version) as any[];
      if (trades.length === 0) continue;
      const wins = trades.filter((t: any) => t.result === 'WIN').length;
      const winRate = Math.round(wins / trades.length * 100);
      db.prepare('UPDATE strategy_log SET win_rate_after = ?, trades_after = ? WHERE version = ?')
        .run(winRate, trades.length, version);
    }
  } catch (err) {
    // ignore
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
}

export async function sendDailyReport(telegram: TelegramNotifier): Promise<void> {
  logger.info('Generating daily report...');

  // v1.3: All data from SQLite DB — single source of truth
  const allDbTrades = getAllTrades();
  const openDbTrades = getOpenTrades();
  const now = new Date();

  const windowStart = new Date(now);
  windowStart.setUTCHours(windowStart.getUTCHours() - 24);
  const windowISO = windowStart.toISOString();

  const closedToday = allDbTrades.filter(t =>
    t.closed_at && t.closed_at >= windowISO
  );

  const wins      = closedToday.filter(t => t.result === 'WIN');
  const losses    = closedToday.filter(t => t.result === 'LOSS');
  const breakeven = closedToday.filter(t => t.result === 'BREAKEVEN');
  const longs     = closedToday.filter(t => t.type === 'LONG');
  const shorts    = closedToday.filter(t => t.type === 'SHORT');

  const totalPnlEUR  = closedToday.reduce((sum, t) => sum + (t.pnl_eur ?? 0), 0);
  const totalPnlPips = closedToday.reduce((sum, t) => sum + (t.pnl_pips ?? 0), 0);
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
      const pips = t.pnl_pips ?? 0;
      const eur = t.pnl_eur ?? 0;
      msg += `${resultEmoji} ${dir} ${t.symbol}  ${pips >= 0 ? '+' : ''}${pips.toFixed(1)} pips  (${eur >= 0 ? '+' : ''}€${eur.toFixed(2)})\n`;
    });
  } else {
    msg += `\nKeine abgeschlossenen Trades in den letzten 24h.\n`;
  }

  // Open positions
  msg += `\n<b>📂 Offene Positionen (${openDbTrades.length})</b>\n`;
  if (openDbTrades.length > 0) {
    openDbTrades.forEach(t => {
      const dir = t.type === 'LONG' ? '📈' : '📉';
      const since = formatDate(t.opened_at);
      const dec = t.symbol.includes('JPY') ? 3 : 5;
      msg += `${dir} ${t.symbol}  SL: <code>${t.stop_loss.toFixed(dec)}</code>  TP: <code>${t.target1.toFixed(dec)}</code>  seit ${since}\n`;
    });
  } else {
    msg += `Keine offenen Positionen.\n`;
  }

  // All-time stats from DB
  const allClosed  = allDbTrades.filter(t => t.closed_at);
  const allWins    = allClosed.filter(t => t.result === 'WIN');
  const allPnlEUR  = allClosed.reduce((sum, t) => sum + (t.pnl_eur ?? 0), 0);
  const allWinRate = allClosed.length > 0 ? Math.round((allWins.length / allClosed.length) * 100) : 0;
  const allPnlEmoji = allPnlEUR >= 0 ? '🟢' : '🔴';

  msg += `\n<b>📈 Gesamt (alle Trades)</b>\n`;
  msg += `Trades:   <b>${allClosed.length}</b>  |  Win Rate: <b>${allWinRate}%</b>\n`;
  msg += `${allPnlEmoji} P&amp;L:   <b>${allPnlEUR >= 0 ? '+' : ''}€${allPnlEUR.toFixed(2)}</b>\n`;

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `<i>🤖 TTFM Bot | ${now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })} MEZ</i>`;

  await telegram.sendMessage(msg);
  logger.info('Daily report sent.');
  updateWinRateAfter();

  // Zone coverage check
  await checkZoneCoverage(telegram);

  // AI analysis — only if there were closed trades
  if (closedToday.length > 0) {
    logger.info('Requesting AI trade analysis...');
    const analysis = await analyzeTradesWithAI();
    if (analysis) {
      await telegram.sendMessage(
        `🤖 <b>KI-Analyse — ${dateStr}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` + analysis
      );
    }
  }
}
