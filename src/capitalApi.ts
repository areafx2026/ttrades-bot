import axios, { AxiosInstance } from 'axios';
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

// ─── Global request throttle ─────────────────────────────────────────────────
// Capital.com allows 10 req/sec — we cap at 8 to leave headroom
const MAX_REQUESTS_PER_SEC = 8;
const WINDOW_MS = 1000;
const requestTimestamps: number[] = [];

export async function throttle(): Promise<void> {
  const now = Date.now();
  // Remove timestamps older than 1 second
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - WINDOW_MS) {
    requestTimestamps.shift();
  }
  // If at limit, wait until the oldest request falls out of the window
  if (requestTimestamps.length >= MAX_REQUESTS_PER_SEC) {
    const waitMs = requestTimestamps[0] + WINDOW_MS - now + 10; // +10ms buffer
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }
    // Clean up again after waiting
    const now2 = Date.now();
    while (requestTimestamps.length > 0 && requestTimestamps[0] <= now2 - WINDOW_MS) {
      requestTimestamps.shift();
    }
  }
  requestTimestamps.push(Date.now());
}

export class CapitalAPI {
  private client: AxiosInstance;
  public cst: string = '';
  public securityToken: string = '';

  constructor(
    public apiKey: string,
    private identifier: string,
    private password: string,
    public isDemo: boolean = false
  ) {
    const baseURL = isDemo
      ? 'https://demo-api-capital.backend-capital.com/api/v1'
      : 'https://api-capital.backend-capital.com/api/v1';

    this.client = axios.create({ baseURL, timeout: 10000 });
  }

  async createSession(): Promise<void> {
    await throttle();
    const res = await this.client.post(
      '/session',
      { identifier: this.identifier, password: this.password, encryptedPassword: false },
      { headers: { 'X-CAP-API-KEY': this.apiKey, 'Content-Type': 'application/json' } }
    );
    this.cst = res.headers['cst'];
    this.securityToken = res.headers['x-security-token'];
    logger.info('Capital.com session created');
  }

  private get authHeaders() {
    return {
      'CST': this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
      'Content-Type': 'application/json',
    };
  }

  async getCandles(epic: string, resolution: Resolution, max: number = 20): Promise<Candle[]> {
    await throttle();
    const res = await this.client.get(`/prices/${epic}`, {
      headers: this.authHeaders,
      params: { resolution, max, pageSize: max },
    });

    const prices = res.data.prices as any[];
    return prices.map(p => ({
      time: p.snapshotTimeUTC,
      open:  (p.openPrice.bid  + p.openPrice.ask)  / 2,
      high:  (p.highPrice.bid  + p.highPrice.ask)  / 2,
      low:   (p.lowPrice.bid   + p.lowPrice.ask)   / 2,
      close: (p.closePrice.bid + p.closePrice.ask) / 2,
        volume: p.lastTradedVolume ?? 0,
    }));
  }
}
