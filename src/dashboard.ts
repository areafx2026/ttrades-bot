import express from 'express';
import axios from 'axios';
import { getAllTrades, getOpenTrades, getStrategyLog, getStats, insertStrategyLog, getCurrentStrategyVersion, getFilterRejections, getFilterRejectionsBySymbol, DbTrade } from './database';
import { logger } from './logger';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MT5_SERVER = 'http://127.0.0.1:5000';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function resultBadge(result?: string, closeReason?: string): string {
  const timePrefix = closeReason && closeReason.startsWith('TIME_CLOSE') ? '⏰ ' : '';
  if (result === 'WIN')  return `<span class="badge win">${timePrefix}WIN</span>`;
  if (result === 'LOSS') return `<span class="badge loss">${timePrefix}LOSS</span>`;
  if (result === 'BREAKEVEN') return `<span class="badge be">${timePrefix}BE</span>`;
  return '<span class="badge open">OPEN</span>';
}

function pnlColor(val?: number): string {
  if (!val) return '';
  return val > 0 ? 'style="color:#22c55e"' : val < 0 ? 'style="color:#ef4444"' : '';
}

// MT5 status endpoint — proxied from Python server
app.get('/api/mt5-status', async (req, res) => {
  try {
    const health = await axios.get(`${MT5_SERVER}/health`, { timeout: 3000 });
    const positions = await axios.get(`${MT5_SERVER}/positions`, { timeout: 3000 });
    const eurusd = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol: 'EURUSD' }, timeout: 3000 });
    res.json({
      connected: health.data.mt5,
      login: health.data.login,
      balance: health.data.balance,
      openPositions: positions.data.length,
      eurusd: eurusd.data,
    });
  } catch {
    res.json({ connected: false, login: null, balance: null, openPositions: 0, eurusd: null });
  }
});

app.get('/', async (req, res) => {
  const stats = getStats();
  const openTrades = getOpenTrades();
  const sortAsc = req.query.sort === 'asc';
  const logSortAsc = req.query.logSort === 'asc';
  const filterStats = getFilterRejections(7);
  const filterBySymbol = getFilterRejectionsBySymbol(7);
  const activeTab = req.query.logSort !== undefined ? 'log' : 'trades';
  const allTrades = getAllTrades().sort((a, b) => {
    const da = new Date(a.opened_at).getTime();
    const db2 = new Date(b.opened_at).getTime();
    return sortAsc ? da - db2 : db2 - da;
  });
  const strategyLog = getStrategyLog().sort((a, b) => {
    const da = new Date(a.changed_at).getTime();
    const db2 = new Date(b.changed_at).getTime();
    return logSortAsc ? da - db2 : db2 - da;
  });
  const version = getCurrentStrategyVersion();

  const totalClosed = allTrades.filter(t => t.closed_at);
  const totalWins   = totalClosed.filter(t => t.result === 'WIN').length;
  const totalPnL    = totalClosed.reduce((s, t) => s + (t.pnl_eur ?? 0), 0);
  const winRate     = totalClosed.length > 0 ? Math.round(totalWins / totalClosed.length * 100) : 0;
  const avgMAE      = totalClosed.filter(t => t.mae_pips).reduce((s, t) => s + (t.mae_pips ?? 0), 0) / (totalClosed.filter(t => t.mae_pips).length || 1);
  const avgMFE      = totalClosed.filter(t => t.mfe_pips).reduce((s, t) => s + (t.mfe_pips ?? 0), 0) / (totalClosed.filter(t => t.mfe_pips).length || 1);

  const equityPoints = (stats.equity as any[]).map((e, i) => `{x:${i},y:${e.cumulative?.toFixed(2) ?? 0}}`).join(',');

  const closedSorted = allTrades.filter(t => t.closed_at && t.result).sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
  let wins = 0;
  const winRatePoints = closedSorted.map((t, i) => {
    if (t.result === 'WIN') wins++;
    const wr = Math.round(wins / (i + 1) * 100);
    return `{x:${i},y:${wr},label:'${t.symbol} ${t.type}',date:'${formatDate(t.closed_at)}',version:'${t.strategy_version ?? ''}'}`;
  }).join(',');

  const versionMarkers = strategyLog.map(v => {
    const tradeIdx = closedSorted.findIndex(t => t.closed_at && t.closed_at >= v.changed_at);
    return `{idx:${tradeIdx},version:'${v.version}'}`;
  }).filter(v => !v.includes('idx:-1')).join(',');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTFM Dashboard v2.0</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --text: #e2e8f0;
    --muted: #64748b;
    --green: #22c55e;
    --red: #ef4444;
    --blue: #3b82f6;
    --amber: #f59e0b;
    --purple: #a855f7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 15px; }
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
  header { padding: 1.5rem 2rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-size: 22px; font-weight: 700; letter-spacing: 2px; color: var(--blue); }
  header .header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  header .version-tag { color: var(--muted); font-size: 13px; }
  header .broker-tag { font-size: 12px; color: var(--purple); letter-spacing: 1px; }
  .container { max-width: 1920px; margin: 0 auto; padding: 1rem 2rem; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1rem; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
  .table-wrap { overflow-x: auto; width: 100%; }
  .metric-label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin-bottom: 0.5rem; }
  .metric-value { font-size: 28px; font-weight: 700; }
  .metric-value.green { color: var(--green); }
  .metric-value.red { color: var(--red); }
  .metric-value.blue { color: var(--blue); }
  .section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 2px; color: var(--muted); margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); font-size: 14px; white-space: nowrap; }
  #tab-log td { white-space: normal; }
  #tab-log td:nth-child(3) { min-width: 300px; max-width: 600px; white-space: normal; word-wrap: break-word; }
  tr:hover td { background: rgba(0,0,0,0.03); }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 4px; letter-spacing: 1px; }
  .badge.win  { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge.loss { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge.time  { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .badge.be   { background: rgba(245,158,11,0.15); color: var(--amber); }
  .badge.open { background: rgba(59,130,246,0.15); color: var(--blue); }
  .form-row { display: flex; gap: 0.75rem; margin-top: 1rem; }
  input, textarea, select { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 0.5rem 0.75rem; font-family: inherit; font-size: 14px; }
  input:focus, textarea:focus { outline: none; border-color: var(--blue); }
  button { background: var(--blue); color: white; border: none; border-radius: 6px; padding: 0.5rem 1.25rem; font-family: inherit; font-size: 14px; cursor: pointer; font-weight: 700; letter-spacing: 1px; }
  button:hover { opacity: 0.85; }
  .tab-nav { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
  .tab-btn { background: none; border: none; color: var(--muted); padding: 0.75rem 1.25rem; cursor: pointer; font-family: inherit; font-size: 13px; letter-spacing: 1px; text-transform: uppercase; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .canvas-wrap { position: relative; height: 200px; }

  /* MT5 Status Bar */
  .mt5-bar { display: flex; align-items: center; gap: 1.5rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1.25rem; margin-bottom: 1rem; font-size: 13px; }
  .mt5-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .mt5-dot.online { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .mt5-dot.offline { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .mt5-item { display: flex; align-items: center; gap: 0.5rem; color: var(--muted); }
  .mt5-item strong { color: var(--text); }
  .mt5-divider { width: 1px; height: 16px; background: var(--border); }
  .mt5-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .mt5-broker { color: var(--purple); font-weight: 700; letter-spacing: 1px; }
</style>
</head>
<body>
<header>
  <h1>◈ TTFM DASHBOARD</h1>
  <div class="header-right">
    <span class="version-tag">Strategie ${version} · ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} MEZ</span>
    <span class="broker-tag">MT5 ENGINE v2.0 · PEPPERSTONE RAZOR</span>
  </div>
</header>
<div class="container">

  <!-- MT5 Status Bar -->
  <div class="mt5-bar" id="mt5-status-bar">
    <div class="mt5-dot" id="mt5-dot"></div>
    <div class="mt5-item"><span class="mt5-label">Broker</span> <span class="mt5-broker">Pepperstone UK</span></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">Status</span> <strong id="mt5-status-text">Verbinde...</strong></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">Login</span> <strong id="mt5-login">—</strong></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">Balance</span> <strong id="mt5-balance">—</strong></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">Offene Positionen</span> <strong id="mt5-positions">—</strong></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">EURUSD</span> <strong id="mt5-eurusd">—</strong></div>
    <div class="mt5-divider"></div>
    <div class="mt5-item"><span class="mt5-label">Modus</span> <strong style="color:var(--amber)">PAPER</strong></div>
  </div>

  <!-- KPIs -->
  <div class="grid4">
    <div class="card">
      <div class="metric-label">Gesamt P&amp;L</div>
      <div class="metric-value ${totalPnL >= 0 ? 'green' : 'red'}">${totalPnL >= 0 ? '+' : ''}€${totalPnL.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="metric-label">Win Rate</div>
      <div class="metric-value blue">${winRate}%</div>
    </div>
    <div class="card">
      <div class="metric-label">Trades (offen / gesamt)</div>
      <div class="metric-value">${openTrades.length} / ${allTrades.length}</div>
    </div>
    <div class="card">
      <div class="metric-label">Ø MAE / MFE</div>
      <div class="metric-value" style="font-size:20px"><span style="color:var(--red)">${avgMAE.toFixed(1)}</span> / <span style="color:var(--green)">${avgMFE.toFixed(1)}</span> <span style="font-size:11px;color:var(--muted)">pips</span></div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tab-nav">
    <button class="tab-btn" id="btn-trades" onclick="showTab('trades')">Trades</button>
    <button class="tab-btn" id="btn-maemfe" onclick="showTab('maemfe')">MAE/MFE</button>
    <button class="tab-btn" id="btn-symbols" onclick="showTab('symbols')">Symbole</button>
    <button class="tab-btn" id="btn-versions" onclick="showTab('versions')">Versionen</button>
    <button class="tab-btn" id="btn-equity" onclick="showTab('equity')">Equity</button>
    <button class="tab-btn" id="btn-winrate" onclick="showTab('winrate')">Win Rate</button>
    <button class="tab-btn" id="btn-log" onclick="showTab('log')">Logbuch</button>
    <button class="tab-btn" id="btn-filters" onclick="showTab('filters')">Filter-Stats</button>
  </div>

  <!-- Trades -->
  <div id="tab-trades" class="tab-content">
    <div class="card">
      <div class="section-title">Alle Trades</div>
      <div class="table-wrap">
      <table>
        <tr><th>Symbol</th><th>Typ</th><th>Phase</th><th>Entry</th><th>SL</th><th>TP</th><th>R:R</th><th>Close</th><th>P&L Pips</th><th>P&L EUR</th><th>MAE</th><th>MFE</th><th>Ergebnis</th><th>Eröffnet</th><th>Geschlossen</th><th>Version</th></tr>
        ${allTrades.map(t => `
        <tr>
          <td><strong>${t.symbol}</strong></td>
          <td>${t.type === 'LONG' ? '▲' : '▼'} ${t.type}</td>
          <td style="color:var(--muted)">${t.phase}</td>
          <td>${t.entry_price?.toFixed(t.symbol.includes('JPY') ? 3 : 5) ?? '—'}</td>
          <td>${t.stop_loss.toFixed(t.symbol.includes('JPY') ? 3 : 5)}</td>
          <td>${t.target1.toFixed(t.symbol.includes('JPY') ? 3 : 5)}</td>
          <td style="color:var(--muted)">${t.risk_reward != null ? t.risk_reward.toFixed(2) + ':1' : '—'}</td>
          <td>${t.close_price?.toFixed(t.symbol.includes('JPY') ? 3 : 5) ?? '—'}</td>
          <td ${pnlColor(t.pnl_pips)}>${t.pnl_pips != null ? (t.pnl_pips >= 0 ? '+' : '') + t.pnl_pips.toFixed(1) : '—'}</td>
          <td ${pnlColor(t.pnl_eur)}>${t.pnl_eur != null ? (t.pnl_eur >= 0 ? '+' : '') + '€' + t.pnl_eur.toFixed(2) : '—'}</td>
          <td style="color:var(--red)">${t.mae_pips?.toFixed(1) ?? '—'}</td>
          <td style="color:var(--green)">${t.mfe_pips?.toFixed(1) ?? '—'}</td>
          <td>${resultBadge(t.result ?? undefined, t.close_reason ?? undefined)}</td>
          <td style="color:var(--muted)">${formatDate(t.opened_at)}</td>
          <td style="color:var(--muted)">${formatDate(t.closed_at)}</td>
          <td style="color:var(--muted)">${t.strategy_version ?? '—'}</td>
        </tr>`).join('')}
      </table>
      </div>
    </div>
  </div>

  <!-- MAE/MFE -->
  <div id="tab-maemfe" class="tab-content">
    <div class="card">
      <div class="section-title">MAE/MFE Analyse — Stop &amp; Target Qualität</div>
      <div class="table-wrap">
      <table>
        <tr><th>Symbol</th><th>Ergebnis</th><th>MAE (Pips)</th><th>MFE (Pips)</th><th>Entry</th><th>SL</th><th>TP</th><th>Close</th><th>SL-Qualität</th><th>TP-Qualität</th></tr>
        ${allTrades.filter(t => t.closed_at && t.mae_pips != null).map(t => {
          const dec = t.symbol.includes('JPY') ? 3 : 5;
          const pip = t.symbol.includes('JPY') ? 0.01 : 0.0001;
          const entryMid = (t.entry_zone_low + t.entry_zone_high) / 2;
          const slPips = Math.abs(entryMid - t.stop_loss) / pip;
          const slQuality = t.mae_pips != null ? (Math.abs(t.mae_pips) < slPips * 0.5 ? '✅ Gut' : Math.abs(t.mae_pips) < slPips ? '⚠️ OK' : '❌ Eng') : '—';
          const tpQuality = t.mfe_pips != null && t.result === 'LOSS' ? (t.mfe_pips > 5 ? '⚠️ TP zu weit' : '—') : t.mfe_pips != null && t.result === 'WIN' ? '✅ Erreicht' : '—';
          return `<tr>
            <td><strong>${t.symbol}</strong></td>
            <td>${resultBadge(t.result ?? undefined)}</td>
            <td style="color:var(--red)">${t.mae_pips?.toFixed(1) ?? '—'}</td>
            <td style="color:var(--green)">${t.mfe_pips?.toFixed(1) ?? '—'}</td>
            <td>${entryMid.toFixed(dec)}</td>
            <td style="color:var(--red)">${t.stop_loss.toFixed(dec)}</td>
            <td style="color:var(--green)">${t.target1.toFixed(dec)}</td>
            <td>${t.close_price?.toFixed(dec) ?? '—'}</td>
            <td>${slQuality}</td>
            <td>${tpQuality}</td>
          </tr>`;
        }).join('')}
      </table>
      </div>
    </div>
  </div>

  <!-- Symbole -->
  <div id="tab-symbols" class="tab-content">
    <div class="card">
      <div class="section-title">Win/Loss nach Symbol</div>
      <div class="table-wrap">
      <table>
        <tr><th>Symbol</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>P&L EUR</th><th>Ø MAE</th><th>Ø MFE</th></tr>
        ${(stats.bySymbol as any[]).map(s => `
        <tr>
          <td><strong>${s.symbol}</strong></td>
          <td>${s.total}</td>
          <td style="color:var(--green)">${s.wins}</td>
          <td style="color:var(--red)">${s.losses}</td>
          <td>${s.total > 0 ? Math.round(s.wins/s.total*100) : 0}%</td>
          <td ${pnlColor(s.pnl_eur)}>${s.pnl_eur >= 0 ? '+' : ''}€${s.pnl_eur?.toFixed(2)}</td>
          <td style="color:var(--red)">${s.avg_mae?.toFixed(1) ?? '—'}</td>
          <td style="color:var(--green)">${s.avg_mfe?.toFixed(1) ?? '—'}</td>
        </tr>`).join('')}
      </table>
      </div>
    </div>
  </div>

  <!-- Versionen -->
  <div id="tab-versions" class="tab-content">
    <div class="card">
      <div class="section-title">Win/Loss nach Strategieversion</div>
      <div class="table-wrap">
      <table>
        <tr><th>Version</th><th>Trades</th><th>Wins</th><th>Win Rate</th><th>P&L EUR</th></tr>
        ${(stats.byVersion as any[]).map(v => `
        <tr>
          <td><strong>${v.strategy_version}</strong></td>
          <td>${v.total}</td>
          <td style="color:var(--green)">${v.wins}</td>
          <td>${v.total > 0 ? Math.round(v.wins/v.total*100) : 0}%</td>
          <td ${pnlColor(v.pnl_eur)}>${v.pnl_eur >= 0 ? '+' : ''}€${v.pnl_eur?.toFixed(2)}</td>
        </tr>`).join('')}
      </table>
      </div>
    </div>
  </div>

  <!-- Equity -->
  <div id="tab-equity" class="tab-content">
    <div class="card">
      <div class="section-title">Equity-Kurve</div>
      <div class="canvas-wrap"><canvas id="equityChart"></canvas></div>
    </div>
  </div>

  <!-- Win Rate -->
  <div id="tab-winrate" class="tab-content">
    <div class="card">
      <div class="section-title">Win Rate Entwicklung</div>
      <div class="canvas-wrap" style="height:300px"><canvas id="winrateChart"></canvas></div>
    </div>
  </div>

  <!-- Filter Stats -->
  <div id="tab-filters" class="tab-content">
    <div class="card" style="margin-bottom:1rem">
      <div class="section-title">Filter-Ablehnungen — letzte 7 Tage</div>
      <table>
        <tr><th>Grund</th><th>Anzahl</th><th>Zuletzt</th></tr>
        ${filterStats.length > 0 ? filterStats.map((f: any) => `
        <tr>
          <td>${f.reason}</td>
          <td><strong>${f.count}</strong></td>
          <td style="color:var(--muted)">${formatDate(f.last_seen)}</td>
        </tr>`).join('') : '<tr><td colspan="3" style="color:var(--muted)">Keine Ablehnungen in den letzten 7 Tagen</td></tr>'}
      </table>
    </div>
    <div class="card">
      <div class="section-title">Ablehnungen nach Symbol — letzte 7 Tage</div>
      <table>
        <tr><th>Symbol</th><th>Grund</th><th>Anzahl</th></tr>
        ${filterBySymbol.length > 0 ? filterBySymbol.map((f: any) => `
        <tr>
          <td><strong>${f.symbol}</strong></td>
          <td>${f.reason}</td>
          <td>${f.count}</td>
        </tr>`).join('') : '<tr><td colspan="3" style="color:var(--muted)">Keine Daten</td></tr>'}
      </table>
    </div>
  </div>

  <!-- Logbuch -->
  <div id="tab-log" class="tab-content">
    <div class="card" style="margin-bottom:1rem">
      <div class="section-title">Strategieänderung eintragen</div>
      <form method="POST" action="/log">
        <div class="form-row">
          <input type="text" name="version" placeholder="Version (z.B. v2.0)" required style="width:120px">
          <input type="text" name="description" placeholder="Was wurde geändert?" required style="flex:1">
          <button type="submit">Eintragen</button>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Strategie-Logbuch</span>
        <button onclick="toggleLogSort()" id="logSortBtn" style="font-size:12px;padding:4px 12px;">
          ${logSortAsc ? 'Neueste zuerst' : 'Älteste zuerst'}
        </button>
      </div>
      <table>
        <tr><th>Datum</th><th>Version</th><th>Beschreibung</th><th>WR vorher</th><th>Trades vorher</th><th>WR nachher</th><th>Trades nachher</th></tr>
        ${strategyLog.map(e => `
        <tr>
          <td style="color:var(--muted)">${formatDate(e.changed_at)}</td>
          <td><strong>${e.version}</strong></td>
          <td>${e.description}</td>
          <td>${e.win_rate_before != null ? e.win_rate_before + '%' : '—'}</td>
          <td>${e.trades_before ?? '—'}</td>
          <td ${(e as any).win_rate_after != null ? ((e as any).win_rate_after >= (e.win_rate_before ?? 0) ? 'style="color:var(--green)"' : 'style="color:var(--red)"') : ''}>${(e as any).win_rate_after != null ? (e as any).win_rate_after + '%' : '—'}</td>
          <td>${(e as any).trades_after ?? '—'}</td>
        </tr>`).join('')}
      </table>
    </div>
  </div>

</div>

<script>
// MT5 Status — live poll every 10 seconds
async function updateMT5Status() {
  try {
    const res = await fetch('/api/mt5-status');
    const d = await res.json();
    const dot = document.getElementById('mt5-dot');
    const statusText = document.getElementById('mt5-status-text');
    const login = document.getElementById('mt5-login');
    const balance = document.getElementById('mt5-balance');
    const positions = document.getElementById('mt5-positions');
    const eurusd = document.getElementById('mt5-eurusd');

    if (d.connected) {
      dot.className = 'mt5-dot online';
      statusText.textContent = 'Verbunden';
      statusText.style.color = '#16a34a';
    } else {
      dot.className = 'mt5-dot offline';
      statusText.textContent = 'Getrennt';
      statusText.style.color = '#ef4444';
    }
    login.textContent = d.login ?? '—';
    balance.textContent = d.balance != null ? '€' + d.balance.toLocaleString('de-DE', {minimumFractionDigits:2}) : '—';
    positions.textContent = d.openPositions ?? '—';
    if (d.eurusd) {
      eurusd.textContent = d.eurusd.bid.toFixed(5) + ' / ' + d.eurusd.ask.toFixed(5);
    }
  } catch {
    document.getElementById('mt5-dot').className = 'mt5-dot offline';
    const offlineEl = document.getElementById('mt5-status-text'); offlineEl.textContent = 'Offline'; offlineEl.style.color = '#dc2626';
  }
}

updateMT5Status();
setInterval(updateMT5Status, 10000);

function toggleLogSort() {
  const url = new URL(window.location.href);
  const current = url.searchParams.get('logSort');
  url.searchParams.set('logSort', current === 'asc' ? 'desc' : 'asc');
  url.searchParams.set('activeTab', 'log');
  window.location.href = url.toString();
}

function toggleSort() {
  const url = new URL(window.location.href);
  const current = url.searchParams.get('sort');
  url.searchParams.set('sort', current === 'asc' ? 'desc' : 'asc');
  window.location.href = url.toString();
}

const _initTab = '${activeTab}';
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const el = document.getElementById('tab-' + _initTab);
  const btn = document.getElementById('btn-' + _initTab);
  if (el) el.classList.add('active');
  if (btn) btn.classList.add('active');
  if (_initTab === 'equity') renderEquity();
  if (_initTab === 'winrate') renderWinRate();
});

function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
  if (name === 'equity') renderEquity();
  if (name === 'winrate') renderWinRate();
  if (name !== 'log') {
    window.history.replaceState({}, '', '/');
  }
}

let equityRendered = false;
let winrateRendered = false;

function renderWinRate() {
  if (winrateRendered) return;
  winrateRendered = true;
  const data = [${winRatePoints}];
  const markers = [${versionMarkers}];
  const ctx = document.getElementById('winrateChart').getContext('2d');
  const segmentColor = (ctx2) => {
    const y0 = ctx2.p0.parsed.y;
    const y1 = ctx2.p1.parsed.y;
    if (y0 >= 50 && y1 >= 50) return '#22c55e';
    if (y0 < 50 && y1 < 50) return '#ef4444';
    return y0 >= 50 ? '#22c55e' : '#ef4444';
  };
  const versionIndices = new Set(markers.map(m => m.idx));
  const pointRadius = data.map((_, i) => versionIndices.has(i) ? 8 : 0);
  const pointColors = data.map((d, i) => versionIndices.has(i) ? '#f59e0b' : 'transparent');
  const pointBorder = data.map((_, i) => versionIndices.has(i) ? '#f59e0b' : 'transparent');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i + 1),
      datasets: [
        { label: '50%', data: data.map(() => 50), borderColor: 'rgba(255,255,255,0.4)', borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0 },
        { label: 'Win Rate %', data: data.map(d => d.y), segment: { borderColor: segmentColor }, backgroundColor: 'rgba(34,197,94,0.05)', fill: false, tension: 0.3, borderWidth: 2, pointRadius: pointRadius, pointBackgroundColor: pointColors, pointBorderColor: pointBorder, pointHoverRadius: 8 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx2 => { if (ctx2.datasetIndex === 0) return '50% Linie'; const d = data[ctx2.dataIndex]; const marker = markers.find(m => m.idx === ctx2.dataIndex); const lines = [ctx2.parsed.y + '%']; if (marker) lines.push('Version: ' + marker.version); if (d) lines.push(d.date); return lines; } } } },
      scales: { x: { display: false }, y: { min: 0, max: 100, grid: { color: '#1e1e2e' }, ticks: { color: '#64748b', callback: v => v + '%' } } }
    }
  });
}

function renderEquity() {
  if (equityRendered) return;
  equityRendered = true;
  const data = [${equityPoints}];
  new Chart(document.getElementById('equityChart'), {
    type: 'line',
    data: {
      labels: data.map(d => d.x),
      datasets: [{ data: data.map(d => d.y), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.05)', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: data.map(d => d.y >= 0 ? '#22c55e' : '#ef4444') }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { grid: { color: '#1e1e2e' }, ticks: { color: '#64748b', callback: v => '€' + v } } }
    }
  });
}
</script>
</body>
</html>`;
  res.send(html);
});

app.post('/log', (req, res) => {
  const { version, description } = req.body;
  if (version && description) {
    insertStrategyLog({ changed_at: new Date().toISOString(), version, description });
  }
  res.redirect('/');
});

export function startDashboard(): void {
  const port = parseInt(process.env.DASHBOARD_PORT ?? '3001');
  app.listen(port, '0.0.0.0', () => {
    logger.info(`Dashboard running at http://0.0.0.0:${port}`);
  });
}
