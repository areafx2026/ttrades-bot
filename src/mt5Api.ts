import axios from 'axios';
import { logger } from './logger';

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Resolution =
  | 'MINUTE' | 'MINUTE_5' | 'MINUTE_15' | 'MINUTE_30'
  | 'HOUR' | 'HOUR_4' | 'DAY' | 'WEEK';

const MT5_SERVER = 'http://127.0.0.1:5000';

export class MT5API {
  // Keine Session nötig — MT5 ist lokal verbunden
  async createSession(): Promise<void> {
    try {
      const res = await axios.get(`${MT5_SERVER}/health`);
      if (!res.data.mt5) throw new Error('MT5 nicht verbunden');
      logger.sys(`MT5 verbunden — Login: ${res.data.login}, Balance: ${res.data.balance}`);
    } catch (err) {
      logger.error('MT5 Server nicht erreichbar — läuft mt5_server.py?');
      throw err;
    }
  }

  async getCandles(symbol: string, resolution: Resolution, count: number = 20): Promise<Candle[]> {
    try {
      const res = await axios.get(`${MT5_SERVER}/candles`, {
        params: { symbol, resolution, count },
        timeout: 10000,
      });
      return res.data as Candle[];
    } catch (err) {
      logger.error(`getCandles Fehler für ${symbol} ${resolution}: ${err}`);
      throw err;
    }
  }

  async getTick(symbol: string): Promise<{ bid: number; ask: number; time: number }> {
    try {
      const res = await axios.get(`${MT5_SERVER}/tick`, {
        params: { symbol },
        timeout: 5000,
      });
      return res.data;
    } catch (err) {
      logger.error(`getTick Fehler für ${symbol}: ${err}`);
      throw err;
    }
  }
}