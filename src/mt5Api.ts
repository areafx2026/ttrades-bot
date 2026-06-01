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
    } catch (err: any) {
      const detail = err?.response?.data?.error ?? err?.message ?? String(err);
      logger.error(`MT5 nicht erreichbar: ${detail} — läuft mt5_server.py und ist MT5 verbunden?`);
      throw err;
    }
  }

  async getCandles(symbol: string, resolution: Resolution, count: number = 20): Promise<Candle[]> {
    try {
      const res = await axios.get(`${MT5_SERVER}/candles`, {
        params: { symbol, resolution, count },
        timeout: Math.max(10000, count * 80),
      });
      return res.data as Candle[];
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        // Symbol hat (noch) keine Daten für diesen Timeframe — kein Fehler, leer zurückgeben.
        // Passiert häufig beim ersten Zugriff auf ein Symbol oder bei HOUR (H1) für einige Paare.
        logger.scan(`getCandles: keine Daten für ${symbol} ${resolution} (404) — leeres Array`);
        return [];
      }
      // Echter Fehler (Timeout, 500, etc.) → als ERROR loggen aber NICHT werfen.
      // Wirft nichts mehr, damit der Rest des Scans für dieses Symbol noch läuft.
      logger.error(`getCandles Fehler für ${symbol} ${resolution}: ${err?.message ?? err}`);
      return [];
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