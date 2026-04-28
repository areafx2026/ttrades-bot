import axios from 'axios';
import { TradeSignal } from './fractalAnalyzer';
import { logger } from './logger';

const MT5_SERVER = 'http://127.0.0.1:5000';
const COOLDOWN_MS = 8 * 60 * 60 * 1000;
const cooldownMap = new Map<string, number>();

interface OpenPosition {
  dealId: string;
  symbol: string;
  direction: string;
  size: number;
  openLevel: number;
  stopLevel: number;
  profitLevel: number;
  profit: number;
}

export class MT5TradeExecutor {

  async getOpenPositions(): Promise<OpenPosition[]> {
    try {
      const res = await axios.get(`${MT5_SERVER}/positions`);
      return res.data;
    } catch (err) {
      logger.error('Error fetching open positions:', err);
      return [];
    }
  }

  async hasOpenPosition(symbol: string): Promise<boolean> {
    const positions = await this.getOpenPositions();
    return positions.some(p => p.symbol === symbol);
  }

  isCoolingDown(symbol: string): { cooling: boolean; remainingMinutes: number } {
    const lastClose = cooldownMap.get(symbol);
    if (!lastClose) return { cooling: false, remainingMinutes: 0 };
    const elapsed = Date.now() - lastClose;
    if (elapsed >= COOLDOWN_MS) {
      cooldownMap.delete(symbol);
      return { cooling: false, remainingMinutes: 0 };
    }
    return { cooling: true, remainingMinutes: Math.ceil((COOLDOWN_MS - elapsed) / 60000) };
  }

  async closePosition(dealId: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await axios.delete(`${MT5_SERVER}/positions/${dealId}`);
      if (res.data.success) {
        return { success: true, message: `Position ${dealId} closed` };
      }
      return { success: false, message: res.data.error };
    } catch (err: any) {
      logger.error(`Failed to close position ${dealId}:`, err.message);
      return { success: false, message: err.message };
    }
  }

  private calculateLotSize(signal: TradeSignal, currentPrice: number): number {
    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const stopPips = Math.abs(currentPrice - signal.stopLoss) / pip;
    if (stopPips <= 0) return 0.01;

    const riskEUR = 100;

    let pipValuePer001Lot: number;
    if (signal.symbol.includes('JPY')) {
      pipValuePer001Lot = 0.07;
    } else if (signal.symbol.startsWith('USD') || signal.symbol.endsWith('USD')) {
      pipValuePer001Lot = 0.09;
    } else {
      pipValuePer001Lot = 0.08;
    }

    const ATR_REFERENCE = 80;
    const atr14 = signal.atr14 ?? ATR_REFERENCE;
    const atrFactor = atr14 > 0 ? Math.min(ATR_REFERENCE / atr14, 2.0) : 1.0;
    const clampedFactor = Math.max(atrFactor, 0.3);

    const rawLots = (riskEUR / (stopPips * pipValuePer001Lot)) * 0.01 * clampedFactor;

    // Round to 0.01, min 0.01, max 1.00
    const rounded = Math.round(rawLots / 0.01) * 0.01;
    const size = Math.min(Math.max(rounded, 0.01), 1.00);

    logger.info(`Size calc: ${signal.symbol} SL=${stopPips.toFixed(1)}pips ATR=${atr14.toFixed(0)} factor=${clampedFactor.toFixed(2)} lots=${size}`);
    return size;
  }

  async openTrade(signal: TradeSignal): Promise<{ success: boolean; dealId?: string; message: string }> {
    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const dec = signal.symbol.includes('JPY') ? 3 : 5;

    // 1. Cooldown check
    const cooldown = this.isCoolingDown(signal.symbol);
    if (cooldown.cooling) {
      return {
        success: false,
        message: `${signal.symbol} in Cooldown — noch ${cooldown.remainingMinutes} Min.`,
      };
    }

    // 2. Check existing position
    const alreadyOpen = await this.hasOpenPosition(signal.symbol);
    if (alreadyOpen) {
      return { success: false, message: `Position bereits offen für ${signal.symbol}` };
    }

    // 3. Get current price (real fill price)
    let currentPrice: number;
    try {
      const tickRes = await axios.get(`${MT5_SERVER}/tick`, { params: { symbol: signal.symbol } });
      currentPrice = signal.type === 'LONG' ? tickRes.data.ask : tickRes.data.bid;
    } catch {
      return { success: false, message: `Konnte Preis für ${signal.symbol} nicht abrufen` };
    }

    // 4. Validate SL/TP
    const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
    const distanceFromEntry = Math.abs(currentPrice - entryMid) / pip;
    const maxEntryDistance = 15;

    if (signal.type === 'LONG') {
      if (currentPrice >= signal.target1) return { success: false, message: `${signal.symbol}: Preis bereits über TP` };
      if (currentPrice <= signal.stopLoss) return { success: false, message: `${signal.symbol}: Preis bereits unter SL` };
      if (currentPrice < signal.entryZone[0] && distanceFromEntry > maxEntryDistance) {
        return { success: false, message: `${signal.symbol}: Entry verpasst (${distanceFromEntry.toFixed(1)} pips)` };
      }
    } else {
      if (currentPrice <= signal.target1) return { success: false, message: `${signal.symbol}: Preis bereits unter TP` };
      if (currentPrice >= signal.stopLoss) return { success: false, message: `${signal.symbol}: Preis bereits über SL` };
      if (currentPrice > signal.entryZone[1] && distanceFromEntry > maxEntryDistance) {
        return { success: false, message: `${signal.symbol}: Entry verpasst (${distanceFromEntry.toFixed(1)} pips)` };
      }
    }

    // 5. Calculate TP from REAL fill price and SL distance — ensures correct R:R
    const RR = 1.3;
    const realRisk = Math.abs(currentPrice - signal.stopLoss);
    const realTP = signal.type === 'LONG'
      ? currentPrice + realRisk * RR
      : currentPrice - realRisk * RR;

    const realRiskPips = realRisk / pip;
    const realTPPips   = Math.abs(realTP - currentPrice) / pip;
    logger.info(`R:R check: ${signal.symbol} Entry=${currentPrice.toFixed(dec)} SL=${signal.stopLoss.toFixed(dec)} Risk=${realRiskPips.toFixed(1)}pips TP=${realTP.toFixed(dec)} Reward=${realTPPips.toFixed(1)}pips R:R=1.3:1`);

    // 6. Calculate lot size based on real fill price
    const size = this.calculateLotSize(signal, currentPrice);
    const direction = signal.type === 'LONG' ? 'BUY' : 'SELL';

    logger.info(`Opening ${direction} ${signal.symbol} | Size: ${size} lots | SL: ${signal.stopLoss.toFixed(dec)} | TP: ${realTP.toFixed(dec)}`);

    try {
      const res = await axios.post(`${MT5_SERVER}/positions/open`, {
        symbol: signal.symbol,
        direction,
        size,
        sl: signal.stopLoss,
        tp: realTP,
      });

      logger.info(`openTrade result: ${JSON.stringify(res.data)}`);

      if (res.data.success) {
        const dealId = String(res.data.dealId);
        return { success: true, dealId, message: `Trade geöffnet: ${dealId}` };
      }
      return { success: false, message: res.data.error ?? 'Unbekannter Fehler' };
    } catch (err: any) {
      logger.error(`openTrade error for ${signal.symbol}:`, err.message);
      return { success: false, message: err.message };
    }
  }
}
