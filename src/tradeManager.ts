/**
 * tradeManager.ts — Resiliente Trade/DB-Mechanik
 *
 * Prinzip: Write-Ahead mit Verification
 *
 * ÖFFNEN:
 *   1. DB INSERT mit temp-id (SYMBOL-DATUM-UHRZEIT)
 *   2. MT5 order_send
 *   3. MT5 positions_get → echte dealId + Fill-Preis → DB UPDATE
 *   4. Bei Fehler → DB DELETE (temp-id)
 *
 * SCHLIESSEN:
 *   1. Symbol nicht mehr in MT5 → history/position holen
 *   2. DB UPDATE mit echten Werten (pnl, mae/mfe, hold_duration etc.)
 *   3. Bei History-Fehler → retry nächster Zyklus
 *
 * RECONCILIATION (Startup + jeder Zyklus):
 *   - Temp-IDs → MT5 positions_get → UPDATE mit echter dealId
 *   - MT5-Positionen ohne DB-Eintrag → INSERT
 *   - DB-offene ohne MT5-Gegenstück → History holen → schließen
 */

import axios from 'axios';
import { getDb, insertTrade, closeTrade, recordPriceTick, getOpenTrades, DbTrade } from './database';
import { brokerToUtc } from './marketHours';
import { savePineScript } from './tradeLogger';
import { logger } from './logger';
import { MT5TradeExecutor } from './mt5TradeExecutor';

const MT5_SERVER = 'http://127.0.0.1:5000';

// ─── TLOG: Verbose Trade/DB Logging ──────────────────────────────────────────

function tlog(action: string, symbol: string, id: string, detail: string): void {
  logger.info(`[TLOG] ${action} | ${symbol} [${id}] | ${detail}`);
}

function tlogError(action: string, symbol: string, id: string, err: string): void {
  logger.error(`[TLOG] ${action} FEHLER | ${symbol} [${id}] | ${err}`);
}

// ─── Temp-ID generieren ───────────────────────────────────────────────────────

export function makeTempId(symbol: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${symbol}-${date}-${time}`;
}

export function isTempId(id: string): boolean {
  return id.includes('-') && isNaN(Number(id));
}

// ─── ÖFFNEN ───────────────────────────────────────────────────────────────────

export async function openTradeResilient(
  signal: any,
  executor: MT5TradeExecutor,
  session: string | null,
  assetClass: 'forex' | 'crypto',
  strategyVersion: string
): Promise<{ success: boolean; dealId?: string; message: string }> {
  const db = getDb();
  const pip = signal.symbol.includes('JPY') ? 0.01 : signal.symbol === 'BTCUSD' ? 1.0 : 0.0001;
  const tempId = makeTempId(signal.symbol);
  const now = new Date().toISOString();
  const entryMid = signal.currentPrice;
  const stopPips = Math.abs(entryMid - signal.stopLoss) / pip;

  // ── SCHRITT 1: DB INSERT mit temp-id ─────────────────────────────────────
  tlog('INSERT', signal.symbol, tempId, `temp-id | entry=${entryMid} sl=${signal.stopLoss} tp=${signal.target1}`);
  try {
    db.prepare(`
      INSERT INTO trades (
        id, symbol, type, phase,
        entry_zone_low, entry_zone_high, entry_price,
        stop_loss, stop_pips, target1, target2, risk_reward,
        opened_at, strategy_version, asset_class,
        session, weekday,
        daily_bias, h4_confirmation, h1_context, m15_setup,
        entry_distance_pips, fvg_present, size_points,
        zone_note, zone_status, exhaustion_detected,
        currency_strength, strength_score
      ) VALUES (
        @id, @symbol, @type, @phase,
        @ezl, @ezh, @entry,
        @sl, @stopPips, @tp, @target2, @rr,
        @openedAt, @version, @assetClass,
        @session, @weekday,
        @dailyBias, @h4, @h1, @m15,
        0, 0, 0,
        null, null, null, null, null
      )
    `).run({
      id:          tempId,
      symbol:      signal.symbol,
      type:        signal.type,
      phase:       signal.phase,
      ezl:         signal.entryZone?.[0] ?? entryMid,
      ezh:         signal.entryZone?.[1] ?? entryMid,
      entry:       entryMid,
      sl:          signal.stopLoss,
      stopPips:    Math.round(stopPips * 10) / 10,
      tp:          signal.target1,
      target2:     signal.target2 ?? signal.target1,
      rr:          signal.riskReward ?? 1.3,
      openedAt:    now,
      version:     strategyVersion,
      assetClass,
      session:     session ?? null,
      weekday:     new Date().getDay(),
      dailyBias:   signal.dailyBias ?? signal.type,
      h4:          signal.h4Confirmation ?? null,
      h1:          signal.h1Context ?? null,
      m15:         signal.m15Setup ?? null,
    });
    tlog('INSERT OK', signal.symbol, tempId, 'DB-Eintrag mit temp-id erstellt');
  } catch (err: any) {
    tlogError('INSERT', signal.symbol, tempId, err.message);
    return { success: false, message: `DB INSERT fehlgeschlagen: ${err.message}` };
  }

  // ── SCHRITT 2: MT5 Order senden ───────────────────────────────────────────
  tlog('ORDER', signal.symbol, tempId, 'sende Order an MT5');
  const result = await executor.openTrade(signal);

  if (!result.success || !result.dealId) {
    // Order fehlgeschlagen → temp-id aus DB löschen
    tlogError('ORDER', signal.symbol, tempId, result.message);
    try {
      db.prepare('DELETE FROM trades WHERE id = ?').run(tempId);
      tlog('DELETE', signal.symbol, tempId, 'temp-id gelöscht nach Order-Fehler');
    } catch (delErr: any) {
      tlogError('DELETE', signal.symbol, tempId, delErr.message);
    }
    return { success: false, message: result.message };
  }

  tlog('ORDER OK', signal.symbol, tempId, `MT5 dealId=${result.dealId}`);

  // ── SCHRITT 3: MT5 Position verifizieren + DB UPDATE ─────────────────────
  tlog('VERIFY', signal.symbol, result.dealId, 'lese Position von MT5');
  try {
    // Kurz warten damit MT5 Position verbucht
    await new Promise(r => setTimeout(r, 1000));

    const posRes = await axios.get(`${MT5_SERVER}/positions`, { timeout: 5000 });
    const positions: any[] = posRes.data ?? [];
    const pos = positions.find((p: any) => String(p.dealId) === String(result.dealId));

    const realEntry = pos?.openLevel ?? entryMid;
    const realId    = String(result.dealId);

    // temp-id → echte dealId umbenennen + echten Fill-Preis eintragen
    db.prepare(`
      UPDATE trades SET
        id          = @realId,
        entry_price = @realEntry
      WHERE id = @tempId
    `).run({ realId, realEntry, tempId });

    tlog('UPDATE OK', signal.symbol, realId,
      `temp-id ${tempId} → ${realId} | entry_price=${realEntry}`
    );

    // Opening-Zeit aus MT5 History holen
    try {
      const histRes = await axios.get(`${MT5_SERVER}/history/position`, {
        params: { ticket: realId }, timeout: 5000,
      });
      const openDeal = (histRes.data ?? []).find((d: any) => d.entry === 0);
      if (openDeal) {
        const openedAt = brokerToUtc(openDeal.time);
        db.prepare('UPDATE trades SET opened_at = ? WHERE id = ?').run(openedAt, realId);
        tlog('UPDATE', signal.symbol, realId, `opened_at korrigiert auf ${openedAt}`);
      }
    } catch { /* opening time stays as now */ }

    return { success: true, dealId: realId, message: `Trade geöffnet: ${realId}` };

  } catch (err: any) {
    tlogError('VERIFY', signal.symbol, result.dealId!, err.message);
    // Trotzdem temp-id auf echte Id umbenennen auch wenn verify fehlschlägt
    try {
      db.prepare('UPDATE trades SET id = ? WHERE id = ?').run(String(result.dealId), tempId);
      tlog('UPDATE', signal.symbol, String(result.dealId), `temp-id umbenannt trotz verify-Fehler`);
    } catch { /* ignore */ }
    return { success: true, dealId: String(result.dealId), message: `Trade geöffnet (verify fehlgeschlagen): ${result.dealId}` };
  }
}

// ─── SCHLIESSEN ───────────────────────────────────────────────────────────────

export async function closeTradeResilient(
  dbTrade: DbTrade,
  telegram: any
): Promise<boolean> {
  const db = getDb();
  const pip = dbTrade.symbol.includes('JPY') ? 0.01 : dbTrade.symbol === 'BTCUSD' ? 1.0 : 0.0001;
  const dec = dbTrade.symbol.includes('JPY') ? 3 : dbTrade.symbol === 'BTCUSD' ? 2 : 5;

  tlog('CLOSE DETECT', dbTrade.symbol, dbTrade.id, 'Symbol nicht mehr in MT5 — hole History');

  // ── History per Position-Ticket holen ────────────────────────────────────
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
    const closingDeal = deals.find((d: any) => d.entry === 1);

    if (!closingDeal) {
      tlog('CLOSE RETRY', dbTrade.symbol, dbTrade.id, 'kein Closing-Deal — retry nächster Zyklus');
      return false; // retry
    }

    closePrice  = closingDeal.price;
    pnlEUR      = Math.round((closingDeal.profit + closingDeal.commission + closingDeal.swap) * 100) / 100;
    closedAt    = brokerToUtc(closingDeal.time);
    closeReason = closingDeal.comment ?? 'SL/TP/Market';

    tlog('CLOSE DATA', dbTrade.symbol, dbTrade.id,
      `close=${closePrice} pnlEUR=${pnlEUR} reason="${closeReason}"`
    );

  } catch (err: any) {
    tlogError('CLOSE HISTORY', dbTrade.symbol, dbTrade.id, err.message);
    return false; // retry
  }

  // ── Pips berechnen ────────────────────────────────────────────────────────
  const entryPrice = dbTrade.entry_price ?? closePrice;
  const rawPnlPips = dbTrade.type === 'LONG'
    ? (closePrice - entryPrice) / pip
    : (entryPrice - closePrice) / pip;
  const pnlPips = Math.round(rawPnlPips * 10) / 10;
  const result  = pnlEUR > 0.5 ? 'WIN' : pnlEUR < -0.5 ? 'LOSS' : 'BREAKEVEN';

  // ── MAE/MFE aus Ticks berechnen ───────────────────────────────────────────
  let maePips: number | undefined;
  let mfePips: number | undefined;
  let maePrice: number | undefined;
  let mfePrice: number | undefined;
  let maePctOfSl: number | undefined;
  let mfePctOfTp: number | undefined;

  try {
    const ticks = db.prepare(
      'SELECT price FROM price_ticks WHERE trade_id = ? ORDER BY recorded_at ASC'
    ).all(dbTrade.id) as { price: number }[];

    if (ticks.length > 0) {
      const prices = ticks.map(t => t.price);
      if (dbTrade.type === 'LONG') {
        maePrice = Math.min(...prices);
        mfePrice = Math.max(...prices);
        maePips  = Math.round(((maePrice - entryPrice) / pip) * 10) / 10;
        mfePips  = Math.round(((mfePrice - entryPrice) / pip) * 10) / 10;
      } else {
        maePrice = Math.max(...prices);
        mfePrice = Math.min(...prices);
        maePips  = Math.round(((entryPrice - maePrice) / pip) * 10) / 10;
        mfePips  = Math.round(((entryPrice - mfePrice) / pip) * 10) / 10;
      }
      const slDist = Math.abs(entryPrice - dbTrade.stop_loss) / pip;
      const tpDist = Math.abs(dbTrade.target1 - entryPrice) / pip;
      if (slDist > 0) maePctOfSl = Math.round(Math.abs(maePips ?? 0) / slDist * 100);
      if (tpDist > 0) mfePctOfTp = Math.round(Math.abs(mfePips ?? 0) / tpDist * 100);

      tlog('MAE/MFE', dbTrade.symbol, dbTrade.id,
        `MAE=${maePips}pips (${maePctOfSl}% of SL) | MFE=${mfePips}pips (${mfePctOfTp}% of TP) | ticks=${ticks.length}`
      );
    }
  } catch (err: any) {
    tlogError('MAE/MFE', dbTrade.symbol, dbTrade.id, err.message);
  }

  // ── Hold-Duration ─────────────────────────────────────────────────────────
  const holdMin = Math.round(
    (new Date(closedAt).getTime() - new Date(dbTrade.opened_at).getTime()) / 60000
  );

  // ── DB UPDATE ─────────────────────────────────────────────────────────────
  tlog('DB UPDATE', dbTrade.symbol, dbTrade.id,
    `result=${result} pnlEUR=${pnlEUR} holdMin=${holdMin}`
  );

  try {
    db.prepare(`
      UPDATE trades SET
        closed_at        = @closedAt,
        close_price      = @closePrice,
        close_reason     = @closeReason,
        pnl_pips         = @pnlPips,
        pnl_eur          = @pnlEUR,
        result           = @result,
        hold_duration_min = @holdMin,
        mae_pips         = @maePips,
        mfe_pips         = @mfePips,
        mae_price        = @maePrice,
        mfe_price        = @mfePrice,
        mae_pct_of_sl    = @maePctOfSl,
        mfe_pct_of_tp    = @mfePctOfTp
      WHERE id = @id
    `).run({
      id: dbTrade.id,
      closedAt, closePrice, closeReason,
      pnlPips, pnlEUR: pnlEUR, result, holdMin,
      maePips:    maePips ?? null,
      mfePips:    mfePips ?? null,
      maePrice:   maePrice ?? null,
      mfePrice:   mfePrice ?? null,
      maePctOfSl: maePctOfSl ?? null,
      mfePctOfTp: mfePctOfTp ?? null,
    });
    tlog('DB UPDATE OK', dbTrade.symbol, dbTrade.id, 'alle Felder geschrieben');
  } catch (err: any) {
    tlogError('DB UPDATE', dbTrade.symbol, dbTrade.id, err.message);
    return false;
  }

  // ── Strategy-Log win_rate_after aktualisieren ─────────────────────────────
  try {
    const allClosed = db.prepare(
      'SELECT result FROM trades WHERE closed_at IS NOT NULL AND strategy_version = ?'
    ).all(dbTrade.strategy_version ?? 'v2.4') as { result: string }[];
    const wins = allClosed.filter(t => t.result === 'WIN').length;
    const winRate = allClosed.length > 0 ? Math.round(wins / allClosed.length * 100) : 0;
    db.prepare(
      'UPDATE strategy_log SET win_rate_after = ?, trades_after = ? WHERE version = ?'
    ).run(winRate, allClosed.length, dbTrade.strategy_version ?? 'v2.4');
    tlog('STRATEGY LOG', dbTrade.symbol, dbTrade.id, `win_rate_after=${winRate}% trades=${allClosed.length}`);
  } catch { /* ignore */ }

  // ── PineScript ───────────────────────────────────────────────────────────
  try {
    savePineScript();
    tlog('PINESCRIPT', dbTrade.symbol, dbTrade.id, 'PineScript aktualisiert');
  } catch { /* ignore */ }

  // ── Telegram ─────────────────────────────────────────────────────────────
  try {
    const emoji = result === 'WIN' ? '✅' : result === 'LOSS' ? '❌' : '➖';
    const dir   = dbTrade.type === 'LONG' ? '📈' : '📉';
    await telegram.sendMessage(
      `${emoji} <b>Trade geschlossen — ${dbTrade.symbol}</b>\n` +
      `${dir} ${dbTrade.type} | ${result}\n` +
      `Close: <code>${closePrice.toFixed(dec)}</code>\n` +
      `P&L: <b>${pnlPips >= 0 ? '+' : ''}${pnlPips.toFixed(1)} pips</b> ` +
      `(<b>${pnlEUR >= 0 ? '+' : ''}€${pnlEUR.toFixed(2)}</b>)\n` +
      `Haltedauer: ${holdMin} Min | MAE: ${maePips ?? '?'}p | MFE: ${mfePips ?? '?'}p`
    );
  } catch { /* ignore */ }

  return true;
}

// ─── RECONCILIATION ──────────────────────────────────────────────────────────
// Läuft beim Startup UND bei jedem Sync-Zyklus

export async function reconcile(
  mt5Positions: any[],
  isStartup: boolean = false
): Promise<void> {
  const db = getDb();
  const openTickets = new Set(mt5Positions.map((p: any) => String(p.dealId)));
  const prefix = isStartup ? 'STARTUP' : 'LIVE';

  // ── 1. Temp-IDs in DB → echte Position suchen ────────────────────────────
  const dbOpenTrades = getOpenTrades();
  for (const t of dbOpenTrades) {
    if (!isTempId(t.id)) continue;

    // Symbol aus temp-id extrahieren: "EURUSD-20260511-171800"
    const sym = t.id.split('-')[0];
    const matchingPos = mt5Positions.find((p: any) => p.symbol === sym);

    if (matchingPos) {
      const realId = String(matchingPos.dealId);
      tlog(`${prefix} TEMP→REAL`, sym, t.id, `→ ${realId}`);
      try {
        db.prepare('UPDATE trades SET id = ?, entry_price = ? WHERE id = ?')
          .run(realId, matchingPos.openLevel, t.id);
        tlog(`${prefix} UPDATE OK`, sym, realId, 'temp-id aufgelöst');
      } catch (err: any) {
        tlogError(`${prefix} TEMP→REAL`, sym, t.id, err.message);
      }
    } else {
      // Temp-id aber keine offene MT5-Position → Trade fehlgeschlagen, löschen
      tlog(`${prefix} DELETE`, sym, t.id, 'kein MT5-Gegenstück — lösche PENDING');
      try {
        db.prepare('DELETE FROM trades WHERE id = ?').run(t.id);
      } catch { /* ignore */ }
    }
  }

  // ── 2. MT5-Positionen ohne DB-Eintrag → INSERT ───────────────────────────
  const dbIds = new Set(getOpenTrades().map(t => t.id));
  for (const pos of mt5Positions) {
    const posId = String(pos.dealId);
    if (dbIds.has(posId)) continue;

    tlog(`${prefix} INSERT`, pos.symbol, posId, `entry=${pos.openLevel} sl=${pos.stopLevel}`);
    const pip  = pos.symbol.includes('JPY') ? 0.01 : pos.symbol === 'BTCUSD' ? 1.0 : 0.0001;
    const entry = pos.openLevel;
    const sl    = pos.stopLevel;
    const tp    = pos.profitLevel;
    const risk  = Math.abs(entry - sl) || pip * 15;
    const type  = pos.direction === 'BUY' ? 'LONG' : 'SHORT';

    // Opening-Zeit aus History
    let openedAt = new Date().toISOString();
    try {
      const histRes = await axios.get(`${MT5_SERVER}/history/position`, {
        params: { ticket: posId }, timeout: 5000,
      });
      const openDeal = (histRes.data ?? []).find((d: any) => d.entry === 0);
      if (openDeal) {
        openedAt = brokerToUtc(openDeal.time);
      }
    } catch { /* use now */ }

    try {
      db.prepare(`
        INSERT OR IGNORE INTO trades (
          id, symbol, type, phase,
          entry_zone_low, entry_zone_high, entry_price,
          stop_loss, target1, target2, risk_reward,
          opened_at, strategy_version, asset_class,
          entry_distance_pips, stop_pips, size_points,
          zone_note, zone_status, exhaustion_detected,
          currency_strength, strength_score, fvg_present
        ) VALUES (
          @id, @symbol, @type, 'RECONCILED',
          @entry, @entry, @entry,
          @sl, @tp, @target2, 1.3,
          @openedAt, 'v2.4', @assetClass,
          0, @stopPips, 0,
          null, null, null, null, null, 0
        )
      `).run({
        id:         posId,
        symbol:     pos.symbol,
        type,
        entry,
        sl,
        tp,
        target2:    type === 'LONG' ? entry + risk * 2.6 : entry - risk * 2.6,
        openedAt,
        assetClass: pos.symbol === 'BTCUSD' ? 'crypto' : 'forex',
        stopPips:   Math.round((risk / pip) * 10) / 10,
      });
      tlog(`${prefix} INSERT OK`, pos.symbol, posId, `openedAt=${openedAt}`);
    } catch (err: any) {
      tlogError(`${prefix} INSERT`, pos.symbol, posId, err.message);
    }
  }

  // ── 3. History-Reconciliation beim Startup: fehlende geschlossene Trades ──
  if (isStartup) {
    try {
      const histRes = await axios.get(`${MT5_SERVER}/history`, {
        params: { hours: 48, all: '1' }, timeout: 5000,
      });
      const allDeals: any[] = histRes.data ?? [];
      const openingDeals = allDeals.filter((d: any) =>
        d.entry === 0 && d.comment === 'TTFM Bot' && d.symbol !== ''
      );

      for (const deal of openingDeals) {
        const dealId = String(deal.ticket);
        const existing = db.prepare('SELECT id FROM trades WHERE id = ?').get(dealId);
        if (existing) continue;

        tlog('STARTUP HISTORY', deal.symbol, dealId, 'nicht in DB — trage nach');
        const pip   = deal.symbol.includes('JPY') ? 0.01 : deal.symbol === 'BTCUSD' ? 1.0 : 0.0001;
        const entry = deal.price;
        const type  = deal.type === 'SELL' ? 'SHORT' : 'LONG';
        const openedAt = brokerToUtc(deal.time);

        // SL/TP aus Closing-Deal-Kommentar
        const closingDeal = allDeals.find((d: any) =>
          d.entry === 1 && d.symbol === deal.symbol &&
          new Date(d.time.endsWith('Z') ? d.time : d.time + 'Z').getTime() > new Date(openedAt).getTime()
        );
        let sl = entry, tp = entry;
        if (closingDeal?.comment?.includes('[sl ')) sl = parseFloat(closingDeal.comment.replace('[sl ', '').replace(']', ''));
        if (closingDeal?.comment?.includes('[tp ')) tp = parseFloat(closingDeal.comment.replace('[tp ', '').replace(']', ''));
        const risk = Math.abs(entry - sl) || pip * 15;

        try {
          db.prepare(`
            INSERT OR IGNORE INTO trades (
              id, symbol, type, phase,
              entry_zone_low, entry_zone_high, entry_price,
              stop_loss, target1, target2, risk_reward,
              opened_at, strategy_version, asset_class,
              entry_distance_pips, stop_pips, size_points,
              zone_note, zone_status, exhaustion_detected,
              currency_strength, strength_score, fvg_present
            ) VALUES (
              @id, @symbol, @type, 'RECONCILED',
              @entry, @entry, @entry,
              @sl, @tp, @target2, 1.3,
              @openedAt, 'v2.4', @assetClass,
              0, @stopPips, 0,
              null, null, null, null, null, 0
            )
          `).run({
            id:         dealId,
            symbol:     deal.symbol,
            type,
            entry,
            sl,
            tp,
            target2:    type === 'LONG' ? entry + risk * 2.6 : entry - risk * 2.6,
            openedAt,
            assetClass: deal.symbol === 'BTCUSD' ? 'crypto' : 'forex',
            stopPips:   Math.round((risk / pip) * 10) / 10,
          });
          tlog('STARTUP HISTORY OK', deal.symbol, dealId, 'eingetragen');
        } catch (err: any) {
          tlogError('STARTUP HISTORY INSERT', deal.symbol, dealId, err.message);
        }
      }
    } catch (err: any) {
      tlogError('STARTUP HISTORY', 'ALL', '-', err.message);
    }
  }
}
