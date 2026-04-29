from flask import Flask, jsonify, request
import MetaTrader5 as mt5
from datetime import datetime, timezone

app = Flask(__name__)

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
    if not mt5.initialize():
        return False
    return True

@app.route('/health', methods=['GET'])
def health():
    ok = ensure_mt5()
    info = mt5.account_info()
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
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        return jsonify({'error': f'No data for {symbol}'}), 404
    candles = []
    for r in rates:
        candles.append({
            'time':   datetime.utcfromtimestamp(r['time']).isoformat(),
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

    result = mt5.order_send(request_obj)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        return jsonify({'success': True, 'dealId': str(result.order)})
    else:
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

    result = mt5.order_send(request_obj)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        return jsonify({'success': True, 'message': f'Position {ticket} closed'})
    else:
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

    hours = int(request.args.get('hours', 48))
    from_time = datetime.now(timezone.utc).timestamp() - hours * 3600

    # deals_get gibt alle Deals im Zeitraum zurück
    deals = mt5.history_deals_get(from_time, datetime.now(timezone.utc).timestamp())
    if deals is None:
        return jsonify([])

    result = []
    for d in deals:
        if d.symbol == '':
            continue
        # Nur Closing-Deals: entry=1 (OUT), 2 (INOUT), 3 (OUT_BY)
        # entry=0 sind Opening-Deals — werden ignoriert
        if d.entry not in (1, 2, 3):
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
            'time':       datetime.utcfromtimestamp(d.time).isoformat(),
            'comment':    d.comment,
        })

    return jsonify(result)

if __name__ == '__main__':
    print("MT5 Server startet auf Port 5000...")
    app.run(host='127.0.0.1', port=5000)
