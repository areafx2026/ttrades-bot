from flask import Flask, jsonify, request
import MetaTrader5 as mt5
from datetime import datetime, timezone
import logging
import logging.handlers
import os
import time

app = Flask(__name__)

# ─── File Logging ──────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.getcwd(), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

def get_log_filename():
    return os.path.join(LOG_DIR, f"mt5server-{datetime.now().strftime('%d-%m-%Y')}.log")

class DailyFileHandler(logging.Handler):
    def emit(self, record):
        try:
            with open(get_log_filename(), 'a', encoding='utf-8') as f:
                f.write(self.format(record) + '\n')
        except Exception:
            pass

log = logging.getLogger('mt5server')
log.setLevel(logging.DEBUG)

formatter = logging.Formatter('[%(asctime)s] %(levelname)-5s %(message)s',
                               datefmt='%d.%m.%Y, %H:%M:%S')

file_handler = DailyFileHandler()
file_handler.setFormatter(formatter)
log.addHandler(file_handler)

console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)
log.addHandler(console_handler)

# Werkzeug (Flask HTTP request logs) in dieselbe Datei umleiten
werkzeug_log = logging.getLogger('werkzeug')
werkzeug_log.setLevel(logging.DEBUG)
werkzeug_log.addHandler(file_handler)
werkzeug_log.addHandler(console_handler)

# Auch Flask selbst
flask_log = logging.getLogger('flask.app')
flask_log.setLevel(logging.DEBUG)
flask_log.addHandler(file_handler)
flask_log.addHandler(console_handler)

def ts():
    return datetime.now().strftime('%d.%m.%Y, %H:%M:%S')

TIMEFRAMES = {
    'MINUTE':    mt5.TIMEFRAME_M1,
    'MINUTE_5':  mt5.TIMEFRAME_M5,
    'MINUTE_15': mt5.TIMEFRAME_M15,
    'MINUTE_30': mt5.TIMEFRAME_M30,
    'HOUR':      mt5.TIMEFRAME_H1,
    'HOUR_4':    mt5.TIMEFRAME_H4,
    'DAY':       mt5.TIMEFRAME_D1,
    'WEEK':      mt5.TIMEFRAME_W1,
}

def ensure_mt5():
    # Erster Versuch
    if mt5.initialize():
        return True
    # Fehlgeschlagen → shutdown + erneut versuchen (z.B. nach Verbindungsverlust)
    err1 = mt5.last_error()
    log.warning(f'MT5 initialize() fehlgeschlagen: {err1} — versuche Reconnect...')
    try:
        mt5.shutdown()
    except Exception:
        pass
    time.sleep(1)
    if mt5.initialize():
        log.info('MT5 Reconnect erfolgreich')
        return True
    log.error(f'MT5 Reconnect fehlgeschlagen: {mt5.last_error()}')
    return False

@app.route('/health', methods=['GET'])
def health():
    ok = ensure_mt5()
    info = mt5.account_info()
    log.debug(f'GET /health — mt5={ok} balance={info.balance if info else None}')
    return jsonify({
        'mt5': ok,
        'balance': info.balance if info else None,
        'login': info.login if info else None,
    })

@app.route('/candles', methods=['GET'])
def get_candles():
    symbol = request.args.get('symbol')
    resolution = request.args.get('resolution', 'HOUR')
    count = int(request.args.get('count', 20))
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500
    mt5.symbol_select(symbol, True)
    tf = TIMEFRAMES.get(resolution, mt5.TIMEFRAME_H1)
    # Erster Versuch — MT5 braucht manchmal einen Moment nach symbol_select()
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        time.sleep(0.5)   # kurz warten, dann nochmal
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        log.warning(f'No data for {symbol} {resolution} after retry — last_error={mt5.last_error()}')
        return jsonify({'error': f'No data for {symbol}'}), 404
    candles = []
    for r in rates:
        candles.append({
            'time':   datetime.utcfromtimestamp(r['time']).isoformat() + 'Z',
            'open':   float(r['open']),
            'high':   float(r['high']),
            'low':    float(r['low']),
            'close':  float(r['close']),
            'volume': int(r['tick_volume']),
        })
    return jsonify(candles)

@app.route('/tick', methods=['GET'])
def get_tick():
    symbol = request.args.get('symbol')
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({'error': f'No tick for {symbol}'}), 404
    return jsonify({'bid': tick.bid, 'ask': tick.ask, 'time': tick.time})

@app.route('/positions', methods=['GET'])
def get_positions():
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500
    log.debug('GET /positions')
    positions = mt5.positions_get()
    if positions is None:
        return jsonify([])
    result = []
    for p in positions:
        result.append({
            'dealId':      str(p.ticket),
            'symbol':      p.symbol,
            'direction':   'BUY' if p.type == 0 else 'SELL',
            'size':        p.volume,
            'openLevel':   p.price_open,
            'stopLevel':   p.sl,
            'profitLevel': p.tp,
            'profit':      p.profit,
        })
    return jsonify(result)

@app.route('/positions/open', methods=['POST'])
def open_position():
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500
    data = request.json
    symbol    = data['symbol']
    direction = data['direction']
    size      = float(data['size'])
    sl        = float(data['sl'])
    tp        = float(data['tp'])

    mt5.symbol_select(symbol, True)
    info = mt5.symbol_info(symbol)
    if info is None:
        return jsonify({'error': f'Symbol {symbol} not found'}), 404

    order_type = mt5.ORDER_TYPE_BUY if direction == 'BUY' else mt5.ORDER_TYPE_SELL
    price = mt5.symbol_info_tick(symbol).ask if direction == 'BUY' else mt5.symbol_info_tick(symbol).bid

    request_obj = {
        'action':        mt5.TRADE_ACTION_DEAL,
        'symbol':        symbol,
        'volume':        size,
        'type':          order_type,
        'price':         price,
        'sl':            sl,
        'tp':            tp,
        'deviation':     20,
        'magic':         234000,
        'comment':       'TTFM Bot',
        'type_time':     mt5.ORDER_TIME_GTC,
        'type_filling':  mt5.ORDER_FILLING_IOC,
    }

    log.info(f'ORDER SEND: {symbol} {direction} size={size} sl={sl} tp={tp}')
    t0 = time.time()
    result = mt5.order_send(request_obj)
    elapsed = round((time.time() - t0) * 1000)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        log.info(f'ORDER OK: {symbol} ticket={result.order} ({elapsed}ms)')
        return jsonify({'success': True, 'dealId': str(result.order)})
    else:
        log.error(f'ORDER FAILED: {symbol} retcode={result.retcode} comment={result.comment} ({elapsed}ms)')
        return jsonify({'success': False, 'error': result.comment, 'retcode': result.retcode}), 400

@app.route('/positions/<ticket>', methods=['DELETE'])
def close_position(ticket):
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500

    positions = mt5.positions_get(ticket=int(ticket))
    if not positions:
        return jsonify({'error': f'Position {ticket} not found'}), 404

    pos = positions[0]
    direction = mt5.ORDER_TYPE_SELL if pos.type == 0 else mt5.ORDER_TYPE_BUY
    price = mt5.symbol_info_tick(pos.symbol).bid if pos.type == 0 else mt5.symbol_info_tick(pos.symbol).ask

    request_obj = {
        'action':        mt5.TRADE_ACTION_DEAL,
        'symbol':        pos.symbol,
        'volume':        pos.volume,
        'type':          direction,
        'position':      pos.ticket,
        'price':         price,
        'deviation':     20,
        'magic':         234000,
        'comment':       'TTFM Close',
        'type_time':     mt5.ORDER_TIME_GTC,
        'type_filling':  mt5.ORDER_FILLING_IOC,
    }

    log.info(f'CLOSE SEND: ticket={ticket} {pos.symbol} {direction}')
    t0 = time.time()
    result = mt5.order_send(request_obj)
    elapsed = round((time.time() - t0) * 1000)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        log.info(f'CLOSE OK: ticket={ticket} ({elapsed}ms)')
        return jsonify({'success': True, 'message': f'Position {ticket} closed'})
    else:
        log.error(f'CLOSE FAILED: ticket={ticket} retcode={result.retcode} comment={result.comment} ({elapsed}ms)')
        return jsonify({'success': False, 'error': result.comment, 'retcode': result.retcode}), 400

# ─── NEU: Geschlossene Trades aus MT5-History ─────────────────────────────────
# Gibt alle Deals der letzten N Stunden zurück (nur Entry/Exit-Deals, kein Balance)
# Rückgabe pro Deal:
#   ticket, symbol, type (BUY/SELL), volume, price (close price),
#   profit (echte EUR P&L aus MT5), time (close time ISO)
@app.route('/history', methods=['GET'])
def get_history():
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500

    hours = int(request.args.get('hours', 168))
    # MT5 history_deals_get mit Unix-Timestamps (int) ist am zuverlässigsten
    # Vermeidet alle Timezone-Interpretationsprobleme mit datetime-Objekten
    now_ts  = int(time.time())
    from_ts = now_ts - hours * 3600
    deals = mt5.history_deals_get(from_ts, now_ts)
    if deals is None:
        return jsonify([])

    result = []
    for d in deals:
        if d.symbol == '':
            continue
        # Filter: alle=1 gibt alle Deals zurück, sonst nur Closing-Deals (entry=1,2,3)
        show_all = request.args.get('all', '0') == '1'
        if not show_all and d.entry not in (1, 2, 3):
            continue

        result.append({
            'ticket':     str(d.order),
            'deal':       str(d.ticket),
            'symbol':     d.symbol,
            'entry':      d.entry,           # 0=IN, 1=OUT, 2=INOUT, 3=OUT_BY
            'type':       'BUY' if d.type == 0 else 'SELL',
            'volume':     d.volume,
            'price':      d.price,
            'profit':     d.profit,
            'commission': d.commission,
            'swap':       d.swap,
            'time':       datetime.utcfromtimestamp(d.time).isoformat() + 'Z',
            'comment':    d.comment,
        })

    return jsonify(result)


# ─── History per Position-Ticket ──────────────────────────────────────────────
# Sucht alle Deals die zu einer bestimmten Position gehören (DEAL_POSITION_ID)
# Das ist zuverlässiger als Zeitfenster-Suche.
# Verwendung: GET /history/position?ticket=68288606
@app.route('/history/position', methods=['GET'])
def get_history_by_position():
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500

    ticket = request.args.get('ticket')
    if not ticket:
        return jsonify({'error': 'ticket parameter required'}), 400

    # history_deals_get mit position= gibt alle Deals mit DEAL_POSITION_ID == ticket zurück
    deals = mt5.history_deals_get(position=int(ticket))
    if deals is None:
        return jsonify([])

    result = []
    for d in deals:
        if d.symbol == '':
            continue
        result.append({
            'ticket':     str(d.order),
            'deal':       str(d.ticket),
            'symbol':     d.symbol,
            'entry':      d.entry,  # 0=IN, 1=OUT, 2=INOUT, 3=OUT_BY
            'type':       'BUY' if d.type == 0 else 'SELL',
            'volume':     d.volume,
            'price':      d.price,
            'profit':     d.profit,
            'commission': d.commission,
            'swap':       d.swap,
            'time':       datetime.utcfromtimestamp(d.time).isoformat() + 'Z',
            'comment':    d.comment,
        })

    return jsonify(result)

@app.route('/positions/<ticket>/sl', methods=['PUT'])
def modify_sl(ticket):
    if not ensure_mt5():
        return jsonify({'error': 'MT5 not connected'}), 500
    data = request.json
    new_sl = float(data['sl'])

    positions = mt5.positions_get(ticket=int(ticket))
    if not positions:
        return jsonify({'error': f'Position {ticket} not found'}), 404

    pos = positions[0]
    request_obj = {
        'action':   mt5.TRADE_ACTION_SLTP,
        'symbol':   pos.symbol,
        'position': pos.ticket,
        'sl':       new_sl,
        'tp':       pos.tp,
    }

    log.info(f'MODIFY SL: ticket={ticket} {pos.symbol} new_sl={new_sl}')
    result = mt5.order_send(request_obj)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        log.info(f'MODIFY SL OK: ticket={ticket} new_sl={new_sl}')
        return jsonify({'success': True})
    else:
        log.error(f'MODIFY SL FAILED: ticket={ticket} retcode={result.retcode} comment={result.comment}')
        return jsonify({'success': False, 'error': result.comment, 'retcode': result.retcode}), 400


if __name__ == '__main__':
    log.info('MT5 Server startet auf Port 5000...')
    app.run(host='127.0.0.1', port=5000)
