/**
 * srAnalyzer.ts
 *
 * Support/Resistance Zones berechnen — portiert von PineScript
 * "Support Resistance Channels/Zones Multi Time Frame" by LonesomeTheBlue
 *
 * Parameter (analog zum Original):
 *   prd         = 5    (Pivot lookback links/rechts)
 *   loopback    = 250  (Anzahl D1-Kerzen)
 *   channelW    = 6%   (max. Zone-Breite als % der Gesamtrange)
 *   minStrength = 2    (min. Pivot Points pro Zone)
 *   maxZones    = 6    (max. Anzahl Zonen)
 */

import { Candle } from './mt5Api';
import { logger } from './logger';

export interface SRZone {
  hi:       number;   // obere Grenze der Zone
  lo:       number;   // untere Grenze der Zone
  strength: number;   // Stärke (Anzahl Pivots × 20 + Berührungen)
  type:     'support' | 'resistance' | 'in_zone'; // relativ zum aktuellen Preis
}

export interface SRResult {
  zones:          SRZone[];
  nearSupport:    boolean;  // Preis innerhalb 15 Pips über Support
  nearResistance: boolean;  // Preis innerhalb 15 Pips unter Resistance
  inZone:         boolean;  // Preis innerhalb einer Zone
}

const PRD         = 5;
const CHANNEL_W   = 6;    // %
const MIN_STR     = 2;    // min. Pivot Points
const MAX_ZONES   = 6;
const NEARBY_PIPS = 15;

// ─── Pivot Points finden ──────────────────────────────────────────────────────
function getPivotVals(candles: Candle[]): number[] {
  const highs = candles.map(c => c.high);
  const lows  = candles.map(c => c.low);
  const pivots: number[] = [];

  for (let x = PRD; x < candles.length - PRD; x++) {
    // Swing High: höher als PRD Kerzen links UND rechts
    const isSwingHigh = highs.slice(x - PRD, x).every(h => h <= highs[x]) &&
                        highs.slice(x + 1, x + PRD + 1).every(h => h <= highs[x]);
    // Swing Low: tiefer als PRD Kerzen links UND rechts
    const isSwingLow  = lows.slice(x - PRD, x).every(l => l >= lows[x]) &&
                        lows.slice(x + 1, x + PRD + 1).every(l => l >= lows[x]);

    if (isSwingHigh) pivots.push(highs[x]);
    if (isSwingLow)  pivots.push(lows[x]);
  }

  return pivots;
}

// ─── Channel/Zone berechnen ───────────────────────────────────────────────────
function getSrVals(pivots: number[], cwidth: number, ind: number): { hi: number; lo: number; numpp: number } {
  let lo    = pivots[ind];
  let hi    = lo;
  let numpp = 0;

  for (const cpp of pivots) {
    const wdth = cpp <= hi ? hi - cpp : cpp - lo;
    if (wdth <= cwidth) {
      if (cpp <= hi) lo = Math.min(lo, cpp);
      else            hi = Math.max(hi, cpp);
      numpp += 20;
    }
  }

  return { hi, lo, numpp };
}

// ─── Haupt-Funktion ───────────────────────────────────────────────────────────
export function calculateSR(
  candles: Candle[],  // D1-Kerzen, mindestens 250
  symbol:  string
): SRResult {
  const pip = symbol.includes('JPY') ? 0.01 : 0.0001;

  if (candles.length < PRD * 10) {
    logger.scan(`${symbol}: zu wenige D1-Kerzen für S/R (${candles.length})`);
    return { zones: [], nearSupport: false, nearResistance: false, inZone: false };
  }

  const currentPrice = candles[candles.length - 1].close;
  const pivots = getPivotVals(candles);

  if (pivots.length < 2) {
    return { zones: [], nearSupport: false, nearResistance: false, inZone: false };
  }

  // Max. Zonen-Breite
  const prdhighest = Math.max(...pivots);
  const prdlowest  = Math.min(...pivots);
  const cwidth     = (prdhighest - prdlowest) * CHANNEL_W / 100;

  // Alle Zonen berechnen
  const supres: { strength: number; hi: number; lo: number }[] = [];
  for (let x = 0; x < pivots.length; x++) {
    const { hi, lo, numpp } = getSrVals(pivots, cwidth, x);
    supres.push({ strength: numpp, hi, lo });
  }

  // Stärke erhöhen durch Berührungen in den letzten 500 Kerzen
  // (nutze verfügbare Kerzen, max 500)
  const lookbackCandles = candles.slice(-Math.min(500, candles.length));
  for (let x = 0; x < supres.length; x++) {
    const { hi, lo } = supres[x];
    let touches = 0;
    for (const c of lookbackCandles) {
      if ((c.high <= hi && c.high >= lo) ||
          (c.low  <= hi && c.low  >= lo) ||
          (c.open <= hi && c.open >= lo) ||
          (c.close<= hi && c.close>= lo)) {
        touches++;
      }
    }
    supres[x].strength += touches;
  }

  // Stärkste Zonen auswählen (greedy, keine Überlappungen)
  const selected: { hi: number; lo: number; strength: number }[] = [];
  const used = new Set<number>();

  for (let iter = 0; iter < MAX_ZONES; iter++) {
    let bestStr = -1;
    let bestIdx = -1;

    for (let y = 0; y < supres.length; y++) {
      if (!used.has(y) && supres[y].strength >= MIN_STR * 20 && supres[y].strength > bestStr) {
        bestStr = supres[y].strength;
        bestIdx = y;
      }
    }

    if (bestIdx < 0) break;

    const { hi, lo } = supres[bestIdx];
    selected.push({ hi, lo, strength: bestStr });

    // Alle überlappenden Zonen als genutzt markieren
    for (let y = 0; y < supres.length; y++) {
      if ((supres[y].hi <= hi && supres[y].hi >= lo) ||
          (supres[y].lo <= hi && supres[y].lo >= lo)) {
        used.add(y);
      }
    }
    used.add(bestIdx);
  }

  // Zonen klassifizieren relativ zum aktuellen Preis
  const nearby = pip * NEARBY_PIPS;
  let nearSupport    = false;
  let nearResistance = false;
  let inZone         = false;

  const zones: SRZone[] = selected.map(z => {
    let type: SRZone['type'];

    if (currentPrice >= z.lo && currentPrice <= z.hi) {
      type   = 'in_zone';
      inZone = true;
    } else if (currentPrice > z.hi) {
      type = 'support';
      // Preis knapp über Support
      if (currentPrice - z.hi <= nearby) nearSupport = true;
    } else {
      type = 'resistance';
      // Preis knapp unter Resistance
      if (z.lo - currentPrice <= nearby) nearResistance = true;
    }

    return { hi: z.hi, lo: z.lo, strength: z.strength, type };
  });

  // Nach Preis sortieren (nächste Zone zuerst)
  zones.sort((a, b) => Math.abs(currentPrice - (a.hi + a.lo) / 2) - Math.abs(currentPrice - (b.hi + b.lo) / 2));

  logger.scan(
    `${symbol}: S/R ${zones.length} Zonen | ` +
    `nearSup=${nearSupport} nearRes=${nearResistance} inZone=${inZone} | ` +
    zones.slice(0, 3).map(z => `${z.type}[${z.lo.toFixed(5)}–${z.hi.toFixed(5)}]`).join(' ')
  );

  return { zones, nearSupport, nearResistance, inZone };
}

// ─── Filter-Funktion ──────────────────────────────────────────────────────────
/**
 * Prüft ob ein Trade-Signal mit den S/R Zonen kompatibel ist.
 *
 * Regeln:
 * - Preis IN Zone → blockiert (zu viel Rauschen)
 * - LONG + Resistance innerhalb 15 Pips über Entry → blockiert
 * - SHORT + Support innerhalb 15 Pips unter Entry → blockiert
 * - LONG + nahe Support → erlaubt (bestärkt)
 * - SHORT + nahe Resistance → erlaubt (bestärkt)
 */
export function checkSRFilter(
  sr:        SRResult,
  direction: 'LONG' | 'SHORT',
  symbol:    string
): { allowed: boolean; reason: string; boosted: boolean } {
  if (sr.zones.length === 0) {
    return { allowed: true, reason: 'keine S/R Zonen', boosted: false };
  }

  // Preis in Zone → blockiert
  if (sr.inZone) {
    return { allowed: false, reason: 'Preis in S/R Zone', boosted: false };
  }

  if (direction === 'LONG') {
    // LONG blockiert wenn Resistance nah über Entry
    if (sr.nearResistance) {
      return { allowed: false, reason: 'LONG blockiert — Resistance innerhalb 15 Pips', boosted: false };
    }
    // LONG an Support → bestärkt
    if (sr.nearSupport) {
      return { allowed: true, reason: 'LONG bestärkt — nahe Support Zone', boosted: true };
    }
    // LONG an Resistance-Zone → kein LONG
    const atResistance = sr.zones.some(z => z.type === 'resistance' && z.lo - (sr.zones[0]?.hi ?? 0) < 0);
    return { allowed: true, reason: 'LONG OK', boosted: false };
  }

  if (direction === 'SHORT') {
    // SHORT blockiert wenn Support nah unter Entry
    if (sr.nearSupport) {
      return { allowed: false, reason: 'SHORT blockiert — Support innerhalb 15 Pips', boosted: false };
    }
    // SHORT an Resistance → bestärkt
    if (sr.nearResistance) {
      return { allowed: true, reason: 'SHORT bestärkt — nahe Resistance Zone', boosted: true };
    }
    return { allowed: true, reason: 'SHORT OK', boosted: false };
  }

  return { allowed: true, reason: 'OK', boosted: false };
}
