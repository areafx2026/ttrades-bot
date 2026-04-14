import axios, { AxiosInstance } from 'axios';
import { TradeSignal } from './fractalAnalyzer';
import { throttle } from './capitalApi';
import { logger } from './logger';

interface OpenPosition {
  dealId: string;
  epic: string;
  direction: string;
  size: number;
  openLevel: number;
  stopLevel: number;
  profitLevel: number;
}

interface ClosedPosition {
  epic: string;
  closeDate: string; // ISO string
}

const COOLDOWN_MS = 8 * 60 * 60 * 1000; // 8 hours

// In-memory cooldown map: epic -> timestamp of last close
const cooldownMap = new Map<string, number>();

export class TradeExecutor {
  private client: AxiosInstance;

  constructor(
    private apiKey: string,
    private isDemo: boolean,
    private cst: string,
    private securityToken: string
  ) {
    const baseURL = isDemo
      ? 'https://demo-api-capital.backend-capital.com/api/v1'
      : 'https://api-capital.backend-capital.com/api/v1';

    this.client = axios.create({ baseURL, timeout: 10000 });
  }

  private get authHeaders() {
    return {
      'CST': this.cst,
      'X-SECURITY-TOKEN': this.securityToken,
      'Content-Type': 'application/json',
    };
  }

  // Fetch open positions
  async getOpenPositions(): Promise<OpenPosition[]> {
    try {
      await throttle();
      const res = await this.client.get('/positions', { headers: this.authHeaders });
      return (res.data.positions || []).map((p: any) => ({
        dealId: p.position.dealId,
        epic: p.market.epic,
        direction: p.position.direction,
        size: p.position.size,
        openLevel: p.position.openLevel,
        stopLevel: p.position.stopLevel,
        profitLevel: p.position.limitLevel,
      }));
    } catch (err) {
      logger.error('Error fetching open positions:', err);
      return [];
    }
  }

  // Fetch recently closed positions (last 24h) and update cooldown map
  async syncClosedPositions(): Promise<void> {
    try {
      // Capital.com expects date in format: YYYY-MM-DDTHH:MM:SS
      const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const from = fromDate.toISOString().slice(0, 19); // strip milliseconds and Z
      await throttle();
      const res = await this.client.get('/history/activity', {
        headers: this.authHeaders,
        params: { from, detailed: true },
      });

      const activities = res.data.activities || [];

      for (const activity of activities) {
        if (activity.type === 'POSITION' && activity.status === 'ACCEPTED') {
          const epic: string = activity.details?.epic || activity.epic;
          const closeDate: string = activity.date;

          if (epic && closeDate && activity.details?.actions) {
            const isClosed = activity.details.actions.some(
              (a: any) => a.actionType === 'POSITION_CLOSED' || a.actionType === 'POSITION_DELETED'
            );

            if (isClosed) {
              const closeTime = new Date(closeDate).getTime();
              const existing = cooldownMap.get(epic);

              // Only update if this close is more recent
              if (!existing || closeTime > existing) {
                cooldownMap.set(epic, closeTime);
                logger.info(`Cooldown set for ${epic} — closed at ${closeDate}`);
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error('Error syncing closed positions:', err);
    }
  }

  // Check if pair is in cooldown
  isCoolingDown(epic: string): { cooling: boolean; remainingMinutes: number } {
    const lastClose = cooldownMap.get(epic);
    if (!lastClose) return { cooling: false, remainingMinutes: 0 };

    const elapsed = Date.now() - lastClose;
    if (elapsed >= COOLDOWN_MS) {
      cooldownMap.delete(epic);
      return { cooling: false, remainingMinutes: 0 };
    }

    const remainingMinutes = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
    return { cooling: true, remainingMinutes };
  }

  // Check if there is already an open position for a given epic
  async hasOpenPosition(epic: string): Promise<boolean> {
    const positions = await this.getOpenPositions();
    return positions.some(p => p.epic === epic);
  }

  // Close a position by dealId (DELETE /positions/{dealId})
  async closePosition(dealId: string): Promise<{ success: boolean; message: string }> {
    try {
      await throttle();
      await this.client.delete(`/positions/${dealId}`, { headers: this.authHeaders });
      return { success: true, message: `Position ${dealId} closed` };
    } catch (err: any) {
      const errorMsg = err.response?.data?.errorCode || err.message || 'Unknown error';
      logger.error(`Failed to close position ${dealId}:`, errorMsg);
      return { success: false, message: errorMsg };
    }
  }

  // Calculate position size in Points (Capital.com unit)
  // Position size scaled by inverse ATR — volatile pairs get smaller size
  // Base risk stays EUR 100, but size adjusts so that a 1-ATR adverse move
  // has roughly equal EUR impact across all pairs
  //
  // Capital.com uses Points, not Lots. Min 100 points, increment 100.
  private calculateLotSize(signal: TradeSignal): number {
    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
    const stopPips = Math.abs(entryMid - signal.stopLoss) / pip;

    if (stopPips <= 0) return 100;

    const riskEUR = 100;

    // Conservative pip value per 1000 Points
    let pipValuePer1000: number;
    if (signal.symbol.includes('JPY')) {
      pipValuePer1000 = 0.07;
    } else if (signal.symbol.startsWith('USD') || signal.symbol.endsWith('USD')) {
      pipValuePer1000 = 0.09;
    } else {
      pipValuePer1000 = 0.08;
    }

    // v1.3: ATR-based volatility scaling
    // Reference ATR: 80 pips (typical major pair D1 ATR)
    // If ATR is 160 pips (GBP/JPY), scale factor = 80/160 = 0.5 (half size)
    // If ATR is 40 pips (EUR/CHF), scale factor = 80/40 = 2.0 (double size, capped)
    const ATR_REFERENCE = 80; // pips — calibrated to major pair average
    const atr14 = signal.atr14 ?? ATR_REFERENCE;
    const atrFactor = atr14 > 0 ? Math.min(ATR_REFERENCE / atr14, 2.0) : 1.0;
    // Floor at 0.3 to avoid tiny positions on extremely volatile pairs
    const clampedFactor = Math.max(atrFactor, 0.3);

    const rawSize = (riskEUR / (stopPips * pipValuePer1000)) * 1000 * clampedFactor;

    // Round to nearest 100, min 100, max 10000
    const rounded = Math.round(rawSize / 100) * 100;
    const size = Math.min(Math.max(rounded, 100), 10000);

    if (atr14 !== ATR_REFERENCE) {
      logger.info(`Size calc: ${signal.symbol} ATR(14)=${atr14.toFixed(0)} pips, factor=${clampedFactor.toFixed(2)}, raw=${rawSize.toFixed(0)}, final=${size} pts`);
    }

    return size;
  }

  // Open a position based on a signal
  async openTrade(signal: TradeSignal): Promise<{ success: boolean; dealId?: string; message: string }> {
    // 1. Sync closed positions to update cooldown map
    await this.syncClosedPositions();

    // 2. Check cooldown
    const cooldown = this.isCoolingDown(signal.symbol);
    if (cooldown.cooling) {
      return {
        success: false,
        message: `${signal.symbol} in Cooldown — noch ${cooldown.remainingMinutes} Min. (8h nach letztem Trade)`,
      };
    }

    // 3. Check for existing open position
    const alreadyOpen = await this.hasOpenPosition(signal.symbol);
    if (alreadyOpen) {
      return { success: false, message: `Position bereits offen für ${signal.symbol} — übersprungen.` };
    }

    // 4. Get current price and validate SL/TP are still on correct side
    let currentPrice: number;
    try {
      await throttle();
      const priceRes = await this.client.get(`/markets/${signal.symbol}`, { headers: this.authHeaders });
      const snap = priceRes.data.snapshot;
      currentPrice = signal.type === 'LONG'
        ? parseFloat(snap.offer) // we buy at offer
        : parseFloat(snap.bid);  // we sell at bid
    } catch {
      return { success: false, message: `Konnte aktuellen Preis für ${signal.symbol} nicht abrufen` };
    }

    const pip = signal.symbol.includes('JPY') ? 0.01 : 0.0001;
    const entryMid = (signal.entryZone[0] + signal.entryZone[1]) / 2;
    const distanceFromEntry = Math.abs(currentPrice - entryMid) / pip;
    const maxEntryDistance = 15; // max 15 pips from entry zone

    if (signal.type === 'LONG') {
      // Price must be near or below entry zone (not already above TP or below SL)
      if (currentPrice >= signal.target1) {
        return { success: false, message: `${signal.symbol}: Preis bereits über TP — Trade übersprungen` };
      }
      if (currentPrice <= signal.stopLoss) {
        return { success: false, message: `${signal.symbol}: Preis bereits unter SL — Trade übersprungen` };
      }
      // Price must not be more than 20 pips below entry (missed entry)
      if (currentPrice < signal.entryZone[0] && distanceFromEntry > maxEntryDistance) {
        return { success: false, message: `${signal.symbol}: Preis ${distanceFromEntry.toFixed(1)} Pips unter Entry Zone — Entry verpasst` };
      }
    } else {
      // SHORT
      if (currentPrice <= signal.target1) {
        return { success: false, message: `${signal.symbol}: Preis bereits unter TP — Trade übersprungen` };
      }
      if (currentPrice >= signal.stopLoss) {
        return { success: false, message: `${signal.symbol}: Preis bereits über SL — Trade übersprungen` };
      }
      // Price must not be more than 20 pips above entry (missed entry)
      if (currentPrice > signal.entryZone[1] && distanceFromEntry > maxEntryDistance) {
        return { success: false, message: `${signal.symbol}: Preis ${distanceFromEntry.toFixed(1)} Pips über Entry Zone — Entry verpasst` };
      }
    }

    // 5. Validate TP distance (Capital.com requires min 0.01% from current price)
    const minDistancePct = 0.0001; // 0.01%
    const minTPDistance = currentPrice * minDistancePct;
    const tpDistance = Math.abs(signal.target1 - currentPrice);
    if (tpDistance < minTPDistance) {
      return { success: false, message: `${signal.symbol}: TP zu nah am aktuellen Preis (${tpDistance.toFixed(5)} < min ${minTPDistance.toFixed(5)})` };
    }

    const slDistance = Math.abs(signal.stopLoss - currentPrice);
    if (slDistance < minTPDistance) {
      return { success: false, message: `${signal.symbol}: SL zu nah am aktuellen Preis` };
    }

    // 5. Calculate size and open trade
    const lotSize = this.calculateLotSize(signal);
    const direction = signal.type === 'LONG' ? 'BUY' : 'SELL';
    const dec = signal.symbol.includes('JPY') ? 3 : 5;

    const body = {
      epic: signal.symbol,
      direction,
      size: lotSize,
      guaranteedStop: false,
      stopLevel: signal.stopLoss,
      profitLevel: signal.target1,
    };

    logger.info(`Opening ${direction} ${signal.symbol} | Entry: ${currentPrice.toFixed(dec)} | Size: ${lotSize} pts | SL: ${signal.stopLoss.toFixed(dec)} | TP: ${signal.target1.toFixed(dec)}`);

    try {
      await throttle();
      const res = await this.client.post('/positions', body, { headers: this.authHeaders });
      const dealId = res.data.dealReference || res.data.dealId || 'unknown';
      return { success: true, dealId, message: `Trade geöffnet: ${dealId}` };
    } catch (err: any) {
      const errorMsg = err.response?.data?.errorCode || err.message || 'Unknown error';
      logger.error(`Failed to open trade for ${signal.symbol}:`, errorMsg);
      return { success: false, message: `Trade fehlgeschlagen: ${errorMsg}` };
    }
  }
}
