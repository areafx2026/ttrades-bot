import { Candle } from './capitalApi';
import { logger } from './logger';

export interface SweepZone {
  symbol: string;
  direction: 'BULLISH' | 'BEARISH'; // Bullish = support zone, Bearish = resistance zone
  zoneLow: number;   // bottom of zone
  zoneHigh: number;  // top of zone
  sweepLow: number;  // absolute low of sweep candle (for invalidation)
  sweepHigh: number; // absolute high of sweep candle (for invalidation)
  wickRatio: number;
  sweepVolume: number;
  avgVolume: number;
  createdAt: string;
}

export interface SweepSignal {
  type: 'LONG' | 'SHORT';
  zone: SweepZone;
  retestVolume: number;
  volumeRatio: number;
}

const WICK_RATIO_MIN     = 0.65;  // min wick as fraction of total range
const VOLUME_SWEEP_MIN   = 1.5;   // sweep candle must be 1.5x avg volume
const VOLUME_RETEST_MAX  = 0.8;   // retest must be < 0.8x avg volume (weak retest)
const LOOKBACK           = 20;    // candles for avg volume

// In-memory zone storage per symbol
const activeSweepZones = new Map<string, SweepZone[]>();

/**
 * Detect new sweep zones from the last closed H1 candle.
 * Call this every scan with the latest H1 candles.
 */
export function detectSweepZones(symbol: string, h1Candles: Candle[]): SweepZone[] {
  if (h1Candles.length < LOOKBACK + 1) return [];

  const closed  = h1Candles.slice(-(LOOKBACK + 1), -1); // last 20 closed candles
  const last    = closed[closed.length - 1];             // most recent closed candle

  const avgVol  = closed.slice(0, LOOKBACK).reduce((s, c) => s + (c.volume ?? 0), 0) / LOOKBACK;
  if (avgVol === 0) return [];

  const volMulti = (last.volume ?? 0) / avgVol;
  if (volMulti < VOLUME_SWEEP_MIN) return [];

  const range      = last.high - last.low;
  if (range === 0) return [];

  const body       = Math.abs(last.close - last.open);
  const upperWick  = last.high - Math.max(last.open, last.close);
  const lowerWick  = Math.min(last.open, last.close) - last.low;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  const newZones: SweepZone[] = [];

  // Bullish sweep zone: long lower wick — price swept below and recovered
  // Zone: Low → Close (area where liquidity was grabbed)
  if (lowerRatio >= WICK_RATIO_MIN) {
    const zone: SweepZone = {
      symbol,
      direction: 'BULLISH',
      zoneLow:    last.low,
      zoneHigh:   last.close,
      sweepLow:   last.low,
      sweepHigh:  last.high,
      wickRatio:  lowerRatio,
      sweepVolume: last.volume ?? 0,
      avgVolume:  avgVol,
      createdAt:  new Date().toISOString(),
    };
    newZones.push(zone);
    logger.info(`Sweep zone BULLISH detected: ${symbol} Low=${last.low.toFixed(5)} Close=${last.close.toFixed(5)} Vol=${volMulti.toFixed(2)}x WickRatio=${lowerRatio.toFixed(2)}`);
  }

  // Bearish sweep zone: long upper wick — price swept above and rejected
  // Zone: Close → High
  if (upperRatio >= WICK_RATIO_MIN) {
    const zone: SweepZone = {
      symbol,
      direction: 'BEARISH',
      zoneLow:    last.close,
      zoneHigh:   last.high,
      sweepLow:   last.low,
      sweepHigh:  last.high,
      wickRatio:  upperRatio,
      sweepVolume: last.volume ?? 0,
      avgVolume:  avgVol,
      createdAt:  new Date().toISOString(),
    };
    newZones.push(zone);
    logger.info(`Sweep zone BEARISH detected: ${symbol} Close=${last.close.toFixed(5)} High=${last.high.toFixed(5)} Vol=${volMulti.toFixed(2)}x WickRatio=${upperRatio.toFixed(2)}`);
  }

  // Add new zones to active zones
  if (newZones.length > 0) {
    const existing = activeSweepZones.get(symbol) ?? [];
    activeSweepZones.set(symbol, [...existing, ...newZones]);
  }

  return newZones;
}

/**
 * Check if current price is retesting an active sweep zone with weak volume.
 * Returns a signal if a valid retest is detected.
 */
export function checkSweepRetest(
  symbol: string,
  h1Candles: Candle[]
): SweepSignal | null {
  const zones = activeSweepZones.get(symbol);
  if (!zones || zones.length === 0) return null;
  if (h1Candles.length < LOOKBACK + 1) return null;

  const closed     = h1Candles.slice(-(LOOKBACK + 1), -1);
  const lastCandle = closed[closed.length - 1];
  const currentMid = (lastCandle.high + lastCandle.low) / 2;

  const avgVol   = closed.slice(0, LOOKBACK).reduce((s, c) => s + (c.volume ?? 0), 0) / LOOKBACK;
  if (avgVol === 0) return null;

  const retestVol  = lastCandle.volume ?? 0;
  const volRatio   = retestVol / avgVol;

  // Only proceed if retest volume is weak
  if (volRatio >= VOLUME_RETEST_MAX) return null;

  // Check each active zone
  for (const zone of zones) {
    const inZone = currentMid >= zone.zoneLow && currentMid <= zone.zoneHigh;
    if (!inZone) continue;

    const signal: SweepSignal = {
      type:         zone.direction === 'BULLISH' ? 'LONG' : 'SHORT',
      zone,
      retestVolume: retestVol,
      volumeRatio:  volRatio,
    };

    logger.info(
      `Sweep retest signal: ${symbol} ${signal.type} | Zone ${zone.zoneLow.toFixed(5)}-${zone.zoneHigh.toFixed(5)} | ` +
      `RetestVol=${retestVol} (${volRatio.toFixed(2)}x avg)`
    );

    return signal;
  }

  return null;
}

/**
 * Invalidate zones where price has closed beyond the sweep extreme.
 * Call every scan to keep zones clean.
 */
export function invalidateSweepZones(symbol: string, h1Candles: Candle[]): void {
  const zones = activeSweepZones.get(symbol);
  if (!zones || zones.length === 0) return;

  const lastClose = h1Candles[h1Candles.length - 2]?.close ?? 0; // last closed candle

  const valid = zones.filter(zone => {
    if (zone.direction === 'BULLISH' && lastClose < zone.sweepLow) {
      logger.info(`Sweep zone BULLISH invalidated: ${symbol} — close ${lastClose.toFixed(5)} below sweep low ${zone.sweepLow.toFixed(5)}`);
      return false;
    }
    if (zone.direction === 'BEARISH' && lastClose > zone.sweepHigh) {
      logger.info(`Sweep zone BEARISH invalidated: ${symbol} — close ${lastClose.toFixed(5)} above sweep high ${zone.sweepHigh.toFixed(5)}`);
      return false;
    }
    return true;
  });

  activeSweepZones.set(symbol, valid);
}

/**
 * Get all active sweep zones for a symbol (for dashboard/logging).
 */
export function getActiveSweepZones(symbol: string): SweepZone[] {
  return activeSweepZones.get(symbol) ?? [];
}

/**
 * Clear all zones for a symbol (e.g. on bot restart).
 */
export function clearSweepZones(symbol: string): void {
  activeSweepZones.delete(symbol);
}
