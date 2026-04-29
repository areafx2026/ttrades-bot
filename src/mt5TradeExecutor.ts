import axios from 'axios';
import { TradeSignal } from './fractalAnalyzer';
import { logger } from './logger';

const MT5_SERVER = 'http://127.0.0.1:5000';
const COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours
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
      const res = await axios.get(`${MT5_SERVER}/positions`, { timeout: 15000 });
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

  setCooldown(symbol: string): void {
    cooldownMap.set(symbol, Date.now());
    logger.info(`Cooldown set for ${symbol} — 8h`);
  }

  async closePosition(dealId: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await axios.delete(`${MT5_SERVER}/positions/${dealId}`, { timeout: 15000 });
      if (res.data.success) {
        return { success: true, message: `Position ${dealId} closed` };
      }
      return { success: false, message: res.data.error };
    } catch (err: any) {
      logger.error(`Failed to close position ${dealId}:`, err.message);
      return { success: false, message: err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lot-Size Berechnung mit dynamischem Pip-Wert
  //
  // Ziel: SL-Risiko immer ~€100, unabhängig vom Pair
  //
  // Formel:
  //   Pip-Wert (€) = pip_size × lot × 100_000 / quote_eur_rate
  //
  //   quote_eur_rate = Kurs der Quote-Währung gegen EUR
  //   Beispiele:
  //     EURAUD  → Quote=AUD → brauche AUDEUR = 1/EURAUD ≈ 0.57
  //     GBPNZD  → Quote=NZD → brauche NZDEUR = 1/EURNZD ≈ 0.54
  //     EURCHF  → Quote=CHF → brauche CHFEUR = 1/EURCHF ≈ 0.94
  //     EURJPY  → Quote=JPY → brauche JPYEUR = 1/EURJPY ≈ 0.0064
  //     EURUSD  → Quote=USD → brauche USDEUR = 1/EURUSD ≈ 0.92
  //     GBPUSD  → Quote=USD → brauche USDEUR = 1/EURUSD ≈ 0.92
  //     USDJPY  → Quote=JPY → brauche JPYEUR = 1/EURJPY ≈ 0.0064
  //
  // ─────────────────────────────────────────────────────────────────────────────
  private async calculateLotSize(
    signal: TradeSignal,
    currentPrice: number
  ): Promise<number> {
    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const stopPips = Math.abs(currentPrice - signal.stopLoss) / pip;

    if (stopPips <= 0) return 0.01;

    const riskEUR = 100;

    // Bestimme Quote-Währung aus dem Symbol (letzten 3 Zeichen)
    const quoteCurrency = signal.symbol.slice(-3); // z.B. "AUD", "NZD", "JPY", "USD", "CHF"

    // Kurs der Quote-Währung gegen EUR (= 1 Quote-Einheit in EUR)
    let quoteEurRate = 1.0; // Fallback: Quote = EUR

    if (quoteCurrency !== 'EUR') {
      // Ticker um den Rate abzurufen: EUR{quote} → rate = 1 / eurQuoteRate
      const eurTicker = `EUR${quoteCurrency}`;
      try {
        const tickRes = await axios.get(`${MT5_SERVER}/tick`, {
          params: { symbol: eurTicker },
          timeout: 5000,
        });
        const eurQuoteRate = (tickRes.data.bid + tickRes.data.ask) / 2;
        if (eurQuoteRate > 0) {
          quoteEurRate = 1 / eurQuoteRate;
        }
      } catch {
        // Fallback auf statische Näherungswerte wenn Tick nicht verfügbar
        const fallbacks: Record<string, number> = {
          USD: 0.92,
          GBP: 1.17,
          JPY: 0.0064,
          CHF: 1.05,
          AUD: 0.57,
          NZD: 0.54,
          CAD: 0.68,
        };
        quoteEurRate = fallbacks[quoteCurrency] ?? 0.85;
        logger.warn(`${signal.symbol}: Konnte EUR${quoteCurrency} nicht abrufen — Fallback ${quoteEurRate}`);
      }
    }

    // Pip-Wert in EUR bei 0.01 Lot (Standardlot = 100.000)
    // pip_value_per_001_lot = pip_size × 0.01 × 100_000 × quoteEurRate
    //                       = pip_size × 1_000 × quoteEurRate
    const pipValuePer001Lot = pip * 1000 * quoteEurRate;

    // Lots = riskEUR / (stopPips × pipValuePer001Lot) × 0.01
    const rawLots = (riskEUR / (stopPips * pipValuePer001Lot)) * 0.01;

    // Auf 0.01 runden, min 0.01, max 1.00
    const rounded = Math.round(rawLots / 0.01) * 0.01;
    const size = Math.min(Math.max(rounded, 0.01), 1.00);

    logger.info(
      `Size calc: ${signal.symbol} | SL=${stopPips.toFixed(1)}pips | ` +
      `quoteEurRate=${quoteEurRate.toFixed(5)} | pipVal/0.01lot=${pipValuePer001Lot.toFixed(4)}€ | ` +
      `raw=${rawLots.toFixed(3)} → ${size} lots | riskEUR≈${(stopPips * pipValuePer001Lot * size / 0.01).toFixed(2)}€`
    );

    return size;
  }

  async openTrade(signal: TradeSignal): Promise<{ success: boolean; dealId?: string; message: string }> {

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

    // 3. Get current price
    let currentPrice: number;
    try {
      const tickRes = await axios.get(`${MT5_SERVER}/tick`, {
        params: { symbol: signal.symbol },
        timeout: 15000,
      });
      currentPrice = signal.type === 'LONG' ? tickRes.data.ask : tickRes.data.bid;
    } catch {
      return { success: false, message: `Konnte Preis für ${signal.symbol} nicht abrufen` };
    }

    // 4. Validate SL/TP still on correct side
    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
    const distanceFromEntry = Math.abs(currentPrice - entryMid) / pip;
    const maxEntryDistance = 15;

    if (signal.type === 'LONG') {
      if (currentPrice >= signal.target1)
        return { success: false, message: `${signal.symbol}: Preis bereits über TP` };
      if (currentPrice <= signal.stopLoss)
        return { success: false, message: `${signal.symbol}: Preis bereits unter SL` };
      if (currentPrice < signal.entryZone[0] && distanceFromEntry > maxEntryDistance)
        return { success: false, message: `${signal.symbol}: Entry verpasst (${distanceFromEntry.toFixed(1)} pips)` };
    } else {
      if (currentPrice <= signal.target1)
        return { success: false, message: `${signal.symbol}: Preis bereits unter TP` };
      if (currentPrice >= signal.stopLoss)
        return { success: false, message: `${signal.symbol}: Preis bereits über SL` };
      if (currentPrice > signal.entryZone[1] && distanceFromEntry > maxEntryDistance)
        return { success: false, message: `${signal.symbol}: Entry verpasst (${distanceFromEntry.toFixed(1)} pips)` };
    }

    // 5. TP aus echtem Fill-Preis und SL-Abstand berechnen → garantiert 1.3:1
    const direction = signal.type === 'LONG' ? 'BUY' : 'SELL';
    const dec = signal.symbol.includes('JPY') ? 3 : 5;
    const realRisk = Math.abs(currentPrice - signal.stopLoss);
    const realTP = direction === 'BUY'
      ? parseFloat((currentPrice + realRisk * 1.3).toFixed(dec))
      : parseFloat((currentPrice - realRisk * 1.3).toFixed(dec));

    const realRiskPips = realRisk / pip;
    const realTPPips = (realRisk * 1.3) / pip;
    logger.info(
      `R:R check: ${signal.symbol} | Entry=${currentPrice} | SL=${signal.stopLoss} | ` +
      `Risk=${realRiskPips.toFixed(1)}pips | TP=${realTP} (+${realTPPips.toFixed(1)}pips) | R:R=1.3:1`
    );

    // 6. Lot-Größe berechnen (dynamischer Pip-Wert)
    const size = await this.calculateLotSize(signal, currentPrice);

    logger.info(`Opening ${direction} ${signal.symbol} | Size: ${size} lots | Entry: ${currentPrice} | SL: ${signal.stopLoss} | TP: ${realTP}`);

    // 7. Trade senden
    try {
      const res = await axios.post(
        `${MT5_SERVER}/positions/open`,
        {
          symbol: signal.symbol,
          direction,
          size,
          sl: signal.stopLoss,
          tp: realTP,
        },
        { timeout: 15000 }
      );

      logger.info(`openTrade result: ${JSON.stringify(res.data)}`);

      if (res.data.success) {
        return {
          success: true,
          dealId: String(res.data.dealId ?? res.data.order ?? 'unknown'),
          message: `Trade geöffnet: ${res.data.dealId ?? res.data.order}`,
        };
      }
      return { success: false, message: res.data.error ?? 'Unbekannter Fehler' };

    } catch (err: any) {
      logger.error(`openTrade error for ${signal.symbol}:`, err.message);
      return { success: false, message: err.message };
    }
  }
}
