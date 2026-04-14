import express from 'express';
import { getAllTrades, getOpenTrades, getStrategyLog, getStats, insertStrategyLog, getCurrentStrategyVersion, DbTrade } from './database';
import { logger } from './logger';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function resultBadge(result?: string, closeReason?: string): string {
  const isTimeClose = closeReason?.startsWith('TIME_CLOSE');
  if (isTimeClose) return '<span class="badge timeout">⏰ TIME</span>';
  if (result === 'WIN')  return '<span class="badge win">WIN</span>';
  if (result === 'LOSS') return '<span class="badge loss">LOSS</span>';
  if (result === 'BREAKEVEN') return '<span class="badge be">BE</span>';
  return '<span class="badge open">OPEN</span>';
}

function pnlColor(val?: number): string {
  if (!val) return '';
  return val > 0 ? 'style="color:#22c55e"' : val < 0 ? 'style="color:#ef4444"' : '';
}

app.get('/', (req, res) => {
  const stats = getStats();
  const openTrades = getOpenTrades();
  const sortAsc = req.query.sort === 'asc';
  const logSortAsc = req.query.logSort === 'asc';
  // Only restore tab when coming from logSort action, otherwise always show trades
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
  const timeCloses  = totalClosed.filter(t => t.close_reason?.startsWith('TIME_CLOSE')).length;
  const avgHoldMin  = totalClosed.filter(t => t.hold_duration_min).reduce((s, t) => s + (t.hold_duration_min ?? 0), 0) / (totalClosed.filter(t => t.hold_duration_min).length || 1);
  const avgHoldStr  = avgHoldMin >= 1440 ? (avgHoldMin / 1440).toFixed(1) + 'd' : avgHoldMin >= 60 ? (avgHoldMin / 60).toFixed(1) + 'h' : Math.round(avgHoldMin) + 'min';

  const equityPoints = (stats.equity as any[]).map((e, i) => `{x:${i},y:${e.cumulative?.toFixed(2) ?? 0}}`).join(',');

  // Win rate over time — rolling win rate per trade
  const closedSorted = allTrades.filter(t => t.closed_at && t.result).sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime());
  let wins = 0;
  const winRatePoints = closedSorted.map((t, i) => {
    if (t.result === 'WIN') wins++;
    const wr = Math.round(wins / (i + 1) * 100);
    return `{x:${i},y:${wr},label:'${t.symbol} ${t.type}',date:'${formatDate(t.closed_at)}',version:'${t.strategy_version ?? ''}'}`;
  }).join(',');

  // Version change markers for charts
  const versionMarkers = strategyLog.map(v => {
    const tradeIdx = closedSorted.findIndex(t => t.closed_at && t.closed_at >= v.changed_at);
    return `{idx:${tradeIdx},version:'${v.version}'}`;
  }).filter(v => !v.includes('idx:-1')).join(',');

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TTFM Trading Dashboard</title>
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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 15px; }
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap');
  header { padding: 1.5rem 2rem; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  header h1 { font-size: 22px; font-weight: 700; letter-spacing: 2px; color: var(--blue); }
  header span { color: var(--muted); font-size: 13px; }
  .container { max-width: 1920px; margin: 0 auto; padding: 1rem 2rem; }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
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
  tr:hover td { background: rgba(255,255,255,0.02); }
  .badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 4px; letter-spacing: 1px; }
  .badge.win  { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge.loss { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge.be   { background: rgba(245,158,11,0.15); color: var(--amber); }
  .badge.open { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge.timeout { background: rgba(168,85,247,0.15); color: #a855f7; }
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

  /* ─── Mobile / Responsive ─────────────────────────────────────────── */
  @media (max-width: 1024px) {
    .grid4 { grid-template-columns: repeat(2, 1fr); }
    .grid2 { grid-template-columns: 1fr; }
    .container { padding: 0.75rem 1rem; }
    header { padding: 1rem 1rem; }
  }

  @media (max-width: 640px) {
    body { font-size: 13px; }
    .grid4 { grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .grid2 { grid-template-columns: 1fr; }
    .container { padding: 0.5rem 0.5rem; }
    header { padding: 0.75rem 0.75rem; flex-direction: column; align-items: flex-start; gap: 0.25rem; }
    header h1 { font-size: 17px; }
    header span { font-size: 11px; }
    .metric-value { font-size: 22px; }
    .metric-label { font-size: 10px; }
    .card { padding: 0.75rem; border-radius: 6px; }
    .section-title { font-size: 11px; letter-spacing: 1px; }

    /* Tabs: horizontal scroll on mobile */
    .tab-nav { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; flex-wrap: nowrap; }
    .tab-nav::-webkit-scrollbar { display: none; }
    .tab-btn { font-size: 11px; padding: 0.6rem 0.75rem; white-space: nowrap; flex-shrink: 0; }

    /* Tables: scroll horizontally, smaller text */
    .card { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { min-width: 700px; }
    th { font-size: 10px; padding: 0.4rem 0.5rem; }
    td { font-size: 12px; padding: 0.4rem 0.5rem; }
    .badge { font-size: 10px; padding: 2px 6px; }

    /* Form row stacks on mobile */
    .form-row { flex-direction: column; }
    .form-row input { width: 100% !important; }
    button { width: 100%; padding: 0.6rem; }

    /* Charts smaller */
    .canvas-wrap { height: 160px; }
  }
</style>
</head>
<body>
<header>
  <h1>◈ TTFM DASHBOARD</h1>
  <span>Strategie ${version} · ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} MEZ</span>
</header>
<div class="container">

  <!-- KPIs -->
  <div class="grid4" style="grid-template-columns: repeat(3, 1fr);">
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
    <div class="card">
      <div class="metric-label">Ø Haltezeit</div>
      <div class="metric-value blue" style="font-size:22px">${avgHoldStr}</div>
    </div>
    <div class="card">
      <div class="metric-label">Time-Closes</div>
      <div class="metric-value" style="font-size:22px;color:#a855f7">${timeCloses} <span style="font-size:12px;color:var(--muted)">von ${totalClosed.length}</span></div>
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
  </div>

  <!-- Trades -->
  <div id="tab-trades" class="tab-content">
    <div class="card">
      <div class="section-title">Alle Trades</div>
      <table>
        <tr><th>Symbol</th><th>Typ</th><th>Phase</th><th>Signal</th><th>Fill</th><th>SL</th><th>TP</th><th>R:R</th><th>Close</th><th>P&L Pips</th><th>P&L EUR</th><th>MAE</th><th>MFE</th><th>Ergebnis</th><th>Haltezeit</th><th>Close Grund</th><th>Eröffnet</th><th>Geschlossen</th><th>Version</th></tr>
        ${allTrades.map(t => {
          const dec = t.symbol.includes('JPY') ? 3 : 5;
          const zoneMid = ((t.entry_zone_low + t.entry_zone_high) / 2);
          const fillDiff = t.entry_price ? Math.abs(t.entry_price - zoneMid) / (t.symbol.includes('JPY') ? 0.01 : 0.0001) : 0;
          const fillColor = fillDiff > 3 ? 'color:var(--amber)' : '';
          const holdMin = t.hold_duration_min;
          const holdStr = holdMin != null
            ? (holdMin >= 1440 ? (holdMin / 1440).toFixed(1) + 'd' : holdMin >= 60 ? (holdMin / 60).toFixed(1) + 'h' : holdMin + 'min')
            : (t.closed_at ? '—' : (() => { const m = Math.round((Date.now() - new Date(t.opened_at).getTime()) / 60000); return m >= 1440 ? '<b>' + (m/1440).toFixed(1) + 'd</b>' : m >= 60 ? (m/60).toFixed(1) + 'h' : m + 'min'; })());
          const holdColor = holdMin != null && holdMin > 48 * 60 ? 'color:var(--amber)' : '';
          const closeReason = t.close_reason ?? '';
          const reasonShort = closeReason.startsWith('TIME_CLOSE') ? '⏰ Time' : closeReason === 'TP' ? '🎯 TP' : closeReason === 'SL' ? '🛑 SL' : closeReason || '—';
          return `
        <tr>
          <td><strong>${t.symbol}</strong></td>
          <td>${t.type === 'LONG' ? '▲' : '▼'} ${t.type}</td>
          <td style="color:var(--muted)">${t.phase}</td>
          <td style="color:var(--muted)">${zoneMid.toFixed(dec)}</td>
          <td style="${fillColor}">${t.entry_price?.toFixed(dec) ?? '—'}</td>
          <td>${t.stop_loss.toFixed(dec)}</td>
          <td>${t.target1.toFixed(dec)}</td>
          <td style="color:var(--muted)">${t.risk_reward != null ? t.risk_reward.toFixed(2) + ':1' : '—'}</td>
          <td>${t.close_price?.toFixed(dec) ?? '—'}</td>
          <td ${pnlColor(t.pnl_pips)}>${t.pnl_pips != null ? (t.pnl_pips >= 0 ? '+' : '') + t.pnl_pips.toFixed(1) : '—'}</td>
          <td ${pnlColor(t.pnl_eur)}>${t.pnl_eur != null ? (t.pnl_eur >= 0 ? '+' : '') + '€' + t.pnl_eur.toFixed(2) : '—'}</td>
          <td style="color:var(--red)">${t.mae_pips?.toFixed(1) ?? '—'}</td>
          <td style="color:var(--green)">${t.mfe_pips?.toFixed(1) ?? '—'}</td>
          <td>${resultBadge(t.result ?? undefined, t.close_reason ?? undefined)}</td>
          <td style="${holdColor}">${holdStr}</td>
          <td style="color:var(--muted);font-size:11px">${reasonShort}</td>
          <td style="color:var(--muted)">${formatDate(t.opened_at)}</td>
          <td style="color:var(--muted)">${formatDate(t.closed_at)}</td>
          <td style="color:var(--muted)">${t.strategy_version ?? '—'}</td>
        </tr>`}).join('')}
      </table>
    </div>
  </div>

  <!-- MAE/MFE -->
  <div id="tab-maemfe" class="tab-content">
    <div class="card">
      <div class="section-title">MAE/MFE Analyse — Stop &amp; Target Qualität</div>
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
            <td>${resultBadge(t.result ?? undefined, t.close_reason ?? undefined)}</td>
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

  <!-- Symbole -->
  <div id="tab-symbols" class="tab-content">
    <div class="card">
      <div class="section-title">Win/Loss nach Symbol</div>
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

  <!-- Versionen -->
  <div id="tab-versions" class="tab-content">
    <div class="card">
      <div class="section-title">Win/Loss nach Strategieversion</div>
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

  <!-- Logbuch -->
  <div id="tab-log" class="tab-content">
    <div class="card" style="margin-bottom:1rem">
      <div class="section-title">Strategieänderung eintragen</div>
      <form method="POST" action="/log">
        <div class="form-row">
          <input type="text" name="version" placeholder="Version (z.B. v1.5)" required style="width:120px">
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
          <td>${e.description.replace(/(.{130}[^ ]*) /g, '$1<br>')}</td>
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

// Set initial active tab without flicker
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
  // Clean URL when switching tabs manually
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

  // Segment colors: green above 50%, red below
  const segmentColor = (ctx2) => {
    const y0 = ctx2.p0.parsed.y;
    const y1 = ctx2.p1.parsed.y;
    if (y0 >= 50 && y1 >= 50) return '#22c55e';
    if (y0 < 50 && y1 < 50) return '#ef4444';
    return y0 >= 50 ? '#22c55e' : '#ef4444';
  };

  // Version marker points — only show dots at version change indices
  const versionIndices = new Set(markers.map(m => m.idx));
  const pointRadius = data.map((_, i) => versionIndices.has(i) ? 8 : 0);
  const pointStyle = data.map((_, i) => versionIndices.has(i) ? 'circle' : 'circle');
  const pointColors = data.map((d, i) => versionIndices.has(i) ? '#f59e0b' : 'transparent');
  const pointBorder = data.map((_, i) => versionIndices.has(i) ? '#f59e0b' : 'transparent');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i + 1),
      datasets: [
        // 50% reference line
        {
          label: '50%',
          data: data.map(() => 50),
          borderColor: 'rgba(255,255,255,0.4)',
          borderWidth: 2.5,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        // Win rate line
        {
          label: 'Win Rate %',
          data: data.map(d => d.y),
          segment: { borderColor: segmentColor },
          backgroundColor: 'rgba(34,197,94,0.05)',
          fill: false,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: pointRadius,
          pointBackgroundColor: pointColors,
          pointBorderColor: pointBorder,
          pointHoverRadius: 8,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx2 => {
              if (ctx2.datasetIndex === 0) return '50% Linie';
              const d = data[ctx2.dataIndex];
              const marker = markers.find(m => m.idx === ctx2.dataIndex);
              const lines = [ctx2.parsed.y + '%'];
              if (marker) lines.push('Version: ' + marker.version);
              if (d) lines.push(d.date);
              return lines;
            }
          }
        }
      },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: '#1e1e2e' },
          ticks: { color: '#64748b', callback: v => v + '%' }
        }
      }
    }
  });

  // Draw version labels above dots
  // (done via afterDraw plugin workaround — labels shown in tooltip instead)
}
function renderEquity() {
  if (equityRendered) return;
  equityRendered = true;
  const data = [${equityPoints}];
  new Chart(document.getElementById('equityChart'), {
    type: 'line',
    data: {
      labels: data.map(d => d.x),
      datasets: [{
        data: data.map(d => d.y),
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.05)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: data.map(d => d.y >= 0 ? '#22c55e' : '#ef4444'),
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { grid: { color: '#1e1e2e' }, ticks: { color: '#64748b', callback: v => '€' + v } }
      }
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
