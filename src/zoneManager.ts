import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

export interface Zone {
  symbol: string;
  type: 'support' | 'resistance';
  priceFrom: number;
  priceTo: number;
  dateFrom: string;
  dateTo: string;
  note?: string;
}

export interface ZoneCheckResult {
  hasZone: boolean;
  zone: Zone | null;
  status: 'in_zone' | 'respects_zone' | 'breaks_through' | 'no_zone';
  adjustedStopLoss: number | null;
  reason: string;
}

const ZONES_FILE = path.join(process.cwd(), 'data', 'zones.json');

export function loadZones(): Zone[] {
  if (!fs.existsSync(ZONES_FILE)) return [];
  try {
    const zones = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf-8')) as Zone[];
    const today = new Date().toISOString().slice(0, 10);
    return zones.filter(z => z.dateFrom <= today && z.dateTo >= today);
  } catch {
    logger.warn('Could not load zones.json');
    return [];
  }
}

export function saveZones(zones: Zone[]): void {
  const dir = path.dirname(ZONES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ZONES_FILE, JSON.stringify(zones, null, 2), 'utf-8');
}

export function initZones(): void {
  if (!fs.existsSync(ZONES_FILE)) {
    saveZones([]);
    logger.info('zones.json created (empty)');
    return;
  }

  // Log zone coverage summary on startup
  const zones = loadZones();
  const SYMBOLS = [
    'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
    'EURGBP','EURJPY','EURCHF','EURAUD','EURCAD',
    'GBPNZD','GBPJPY','GBPCHF','GBPCAD','GBPAUD',
    'AUDJPY','CHFJPY','AUDNZD','AUDCAD','CADJPY',
  ];

  const summary = SYMBOLS.map(s => {
    const sz = zones.filter(z => z.symbol === s);
    const sup = sz.filter(z => z.type === 'support').length;
    const res = sz.filter(z => z.type === 'resistance').length;
    if (sup === 0 && res === 0) return null;
    return `${s}:${sup}S/${res}R`;
  }).filter(Boolean);

  const total = zones.length;
  if (total === 0) {
    logger.info('Zones: none defined yet');
  } else {
    logger.info(`Zones loaded (${total} total): ${summary.join(' | ')}`);
  }
}

export function checkZone(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  currentPrice: number,
  lastCandleClose: number,
  currentStopLoss: number
): ZoneCheckResult {
  const zones = loadZones();
  const pip = symbol.includes('JPY') ? 0.01 : 0.0001;
  const relevantType = direction === 'LONG' ? 'support' : 'resistance';
  const symbolZones = zones.filter(z => z.symbol === symbol && z.type === relevantType);

  if (symbolZones.length === 0) {
    return { hasZone: false, zone: null, status: 'no_zone', adjustedStopLoss: null, reason: 'Keine Zone definiert' };
  }

  const zoneBuffer = pip * 3;

  // Step 1: Check ALL zones for break-through — any break blocks the trade
  for (const z of symbolZones) {
    const zTop    = Math.max(z.priceFrom, z.priceTo);
    const zBottom = Math.min(z.priceFrom, z.priceTo);
    const closeInZone = lastCandleClose >= zBottom - zoneBuffer && lastCandleClose <= zTop + zoneBuffer;

    if (direction === 'LONG' && lastCandleClose < zBottom && !closeInZone) {
      return {
        hasZone: true, zone: z, status: 'breaks_through', adjustedStopLoss: null,
        reason: `Support-Zone (${zBottom.toFixed(5)}–${zTop.toFixed(5)}) nach unten durchbrochen — kein Trade${z.note ? ` [${z.note}]` : ''}`,
      };
    }
    if (direction === 'SHORT' && lastCandleClose > zTop && !closeInZone) {
      return {
        hasZone: true, zone: z, status: 'breaks_through', adjustedStopLoss: null,
        reason: `Resistance-Zone (${zBottom.toFixed(5)}–${zTop.toFixed(5)}) nach oben durchbrochen — kein Trade${z.note ? ` [${z.note}]` : ''}`,
      };
    }
  }

  // Step 2: Find closest active zone for SL adjustment
  const sorted = [...symbolZones].sort((a, b) => {
    const midA = (a.priceFrom + a.priceTo) / 2;
    const midB = (b.priceFrom + b.priceTo) / 2;
    return Math.abs(currentPrice - midA) - Math.abs(currentPrice - midB);
  });

  const zone    = sorted[0];
  const zoneTop    = Math.max(zone.priceFrom, zone.priceTo);
  const zoneBottom = Math.min(zone.priceFrom, zone.priceTo);
  const priceInZone = currentPrice >= zoneBottom - zoneBuffer && currentPrice <= zoneTop + zoneBuffer;
  const closeInZone = lastCandleClose >= zoneBottom - zoneBuffer && lastCandleClose <= zoneTop + zoneBuffer;
  const noteStr = zone.note ? ` [${zone.note}]` : '';

  if (direction === 'LONG') {
    if (closeInZone || priceInZone) {
      return {
        hasZone: true, zone, status: 'in_zone',
        adjustedStopLoss: zoneBottom - pip * 5,
        reason: `Preis in Support-Zone (${zoneBottom.toFixed(5)}–${zoneTop.toFixed(5)}) — Rebound-Trade, SL unter Zone${noteStr}`,
      };
    }
    if (lastCandleClose > zoneTop) {
      return {
        hasZone: true, zone, status: 'respects_zone',
        adjustedStopLoss: zoneBottom - pip * 5,
        reason: `Support-Zone respektiert (${zoneBottom.toFixed(5)}–${zoneTop.toFixed(5)}) — SL unter Zone${noteStr}`,
      };
    }
  }

  if (direction === 'SHORT') {
    if (closeInZone || priceInZone) {
      return {
        hasZone: true, zone, status: 'in_zone',
        adjustedStopLoss: zoneTop + pip * 5,
        reason: `Preis in Resistance-Zone (${zoneBottom.toFixed(5)}–${zoneTop.toFixed(5)}) — Rebound-Trade, SL über Zone${noteStr}`,
      };
    }
    if (lastCandleClose < zoneBottom) {
      return {
        hasZone: true, zone, status: 'respects_zone',
        adjustedStopLoss: zoneTop + pip * 5,
        reason: `Resistance-Zone respektiert (${zoneBottom.toFixed(5)}–${zoneTop.toFixed(5)}) — SL über Zone${noteStr}`,
      };
    }
  }

  return { hasZone: true, zone, status: 'no_zone', adjustedStopLoss: null, reason: `Zone(n) nicht relevant für aktuellen Preis` };
}
