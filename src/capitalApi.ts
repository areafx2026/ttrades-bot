import axios, { AxiosInstance } from 'axios';
import { logger } from './logger';

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Resolution =
  | 'MINUTE' | 'MINUTE_5' | 'MINUTE_15' | 'MINUTE_30'
  | 'HOUR' | 'HOUR_4' | 'DAY' | 'WEEK';

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
    }));
  }
}
