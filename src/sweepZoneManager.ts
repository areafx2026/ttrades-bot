import { Candle } from './capitalApi';
import { logger } from './logger';
import { getDb } from './database';

export interface SweepZone {
  id?: number;
  symbol: string;
  direction: 'BULLISH' | 'BEARISH';
  zoneLow: number;
  zoneHigh: number;
  sweepLow: number;
  sweepHigh: number;
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

const WICK_RATIO_MIN    = 0.65;
const VOLUME_SWEEP_MIN  = 1.5;
const VOLUME_RETEST_MAX = 0.8;
const LOOKBACK          = 20;

// ── DB helpers ────────────────────────────────────────────────────────────────

function saveZone(zone: SweepZone): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sweep_zones
      (symbol, direction, zone_low, zone_high, sweep_low, sweep_high,
       wick_ratio, sweep_volume, avg_volume, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    zone.symbol, zone.direction,
    zone.zoneLow, zone.zoneHigh,
    zone.sweepLow, zone.sweepHigh,
    zone.wickRatio, zone.sweepVolume, zone.avgVolume,
    zone.createdAt
  );
}

function markInvalid(id: number): void {
  const db = getDb();
  db.prepare(`UPDATE sweep_zones SET invalidated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function getActiveSweepZones(symbol: string): SweepZone[] {
  const db = getDb();
  return (db.prepare(`
    SELECT * FROM sweep_zones
    WHERE symbol = ? AND invalidated_at IS NULL
    ORDER BY created_at DESC
  `).all(symbol) as any[]).map(r => ({
    id:          r.id,
    symbol:      r.symbol,
    direction:   r.direction,
    zoneLow:     r.zone_low,
    zoneHigh:    r.zone_high,
    sweepLow:    r.sweep_low,
    sweepHigh:   r.sweep_high,
    wickRatio:   r.wick_ratio,
    sweepVolume: r.sweep_volume,
    avgVolume:   r.avg_volume,
    createdAt:   r.created_at,
  }));
}

// ── Core logic ────────────────────────────────────────────────────────────────

export function detectSweepZones(symbol: string, h1Candles: Candle[]): SweepZone[] {
  if (h1Candles.length < LOOKBACK + 1) return [];

  const closed = h1Candles.slice(-(LOOKBACK + 1), -1);
  const last   = closed[closed.length - 1];

  const avgVol = closed.slice(0, LOOKBACK)
    .reduce((s, c) => s + (c.volume ?? 0), 0) / LOOKBACK;
  if (avgVol === 0) return [];

  const volMulti = (last.volume ?? 0) / avgVol;
  if (volMulti < VOLUME_SWEEP_MIN) return [];

  const range = last.high - last.low;
  if (range === 0) return [];

  const upperWick  = last.high - Math.max(last.open, last.close);
  const lowerWick  = Math.min(last.open, last.close) - last.low;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  const newZones: SweepZone[] = [];

  if (lowerRatio >= WICK_RATIO_MIN) {
    // Check if identical zone already exists
    const existing = getActiveSweepZones(symbol).find(z =>
      z.direction === 'BULLISH' &&
      Math.abs(z.sweepLow - last.low) < 0.0001
    );
    if (!existing) {
      const zone: SweepZone = {
        symbol, direction: 'BULLISH',
        zoneLow: last.low, zoneHigh: last.close,
        sweepLow: last.low, sweepHigh: last.high,
        wickRatio: lowerRatio,
        sweepVolume: last.volume ?? 0, avgVolume: avgVol,
        createdAt: new Date().toISOString(),
      };
      saveZone(zone);
      newZones.push(zone);
      logger.info(`Sweep zone BULLISH saved: ${symbol} Low=${last.low.toFixed(5)} Close=${last.close.toFixed(5)} Vol=${volMulti.toFixed(2)}x Wick=${lowerRatio.toFixed(2)}`);
    }
  }

  if (upperRatio >= WICK_RATIO_MIN) {
    const existing = getActiveSweepZones(symbol).find(z =>
      z.direction === 'BEARISH' &&
      Math.abs(z.sweepHigh - last.high) < 0.0001
    );
    if (!existing) {
      const zone: SweepZone = {
        symbol, direction: 'BEARISH',
        zoneLow: last.close, zoneHigh: last.high,
        sweepLow: last.low, sweepHigh: last.high,
        wickRatio: upperRatio,
        sweepVolume: last.volume ?? 0, avgVolume: avgVol,
        createdAt: new Date().toISOString(),
      };
      saveZone(zone);
      newZones.push(zone);
      logger.info(`Sweep zone BEARISH saved: ${symbol} Close=${last.close.toFixed(5)} High=${last.high.toFixed(5)} Vol=${volMulti.toFixed(2)}x Wick=${upperRatio.toFixed(2)}`);
    }
  }

  return newZones;
}

export function invalidateSweepZones(symbol: string, h1Candles: Candle[]): void {
  const zones = getActiveSweepZones(symbol);
  if (zones.length === 0) return;

  const lastClose = h1Candles[h1Candles.length - 2]?.close ?? 0;

  for (const zone of zones) {
    if (!zone.id) continue;
    if (zone.direction === 'BULLISH' && lastClose < zone.sweepLow) {
      markInvalid(zone.id);
      logger.info(`Sweep zone BULLISH invalidated: ${symbol} close ${lastClose.toFixed(5)} < sweepLow ${zone.sweepLow.toFixed(5)}`);
    } else if (zone.direction === 'BEARISH' && lastClose > zone.sweepHigh) {
      markInvalid(zone.id);
      logger.info(`Sweep zone BEARISH invalidated: ${symbol} close ${lastClose.toFixed(5)} > sweepHigh ${zone.sweepHigh.toFixed(5)}`);
    }
  }
}

export function checkSweepRetest(symbol: string, h1Candles: Candle[]): SweepSignal | null {
  const zones = getActiveSweepZones(symbol);
  if (zones.length === 0) return null;
  if (h1Candles.length < LOOKBACK + 1) return null;

  const closed     = h1Candles.slice(-(LOOKBACK + 1), -1);
  const lastCandle = closed[closed.length - 1];
  const currentMid = (lastCandle.high + lastCandle.low) / 2;

  const avgVol  = closed.slice(0, LOOKBACK)
    .reduce((s, c) => s + (c.volume ?? 0), 0) / LOOKBACK;
  if (avgVol === 0) return null;

  const retestVol = lastCandle.volume ?? 0;
  const volRatio  = retestVol / avgVol;

  if (volRatio >= VOLUME_RETEST_MAX) return null;

  for (const zone of zones) {
    if (currentMid >= zone.zoneLow && currentMid <= zone.zoneHigh) {
      logger.info(`Sweep retest: ${symbol} ${zone.direction} zone ${zone.zoneLow.toFixed(5)}-${zone.zoneHigh.toFixed(5)} | Vol ${volRatio.toFixed(2)}x`);
      return {
        type:         zone.direction === 'BULLISH' ? 'LONG' : 'SHORT',
        zone,
        retestVolume: retestVol,
        volumeRatio:  volRatio,
      };
    }
  }

  return null;
}
