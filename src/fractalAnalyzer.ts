/**
 * fractalAnalyzer.ts — v2.2
 *
 * Strategie: Trend-Following mit Pullback-Entry
 *
 * D1  → Trend-Richtung: HH+HL für LONG, LH+LL für SHORT (keine Mean-Reversion)
 * H4  → Bestätigung: gleiche Struktur wie D1
 * H1  → Echter Retest: Preis berührt H1 Swing Level und zeigt Rejection
 * M15 → Entry-Kerze: Hammer/Bullish (LONG) oder ShootingStar/Bearish (SHORT)
 *
 * SL: unter/über M15 Protected Swing + 3 Pips (nicht mehr H1-Minimum über 20h)
 * TP: Entry + Risk × 1.3
 */

import { Candle } from './mt5Api';
import { logger } from './logger';
import { ATR } from './atr14';

export type SignalType = 'LONG' | 'SHORT';
export type SetupPhase = 'C3_ENTRY' | 'C4_RETEST';

export interface AnalyzeResult {
  signal: TradeSignal | null;
  rejected: boolean;
  reason: string | null;
}

export interface TradeSignal {
  symbol: string;
  type: SignalType;
  phase: SetupPhase;
  currentPrice: number;
  entryZone: [number, number];
  stopLoss: number;
  target1: number;
  target2: number;
  riskReward: number;
  dailyBias: SignalType;
  dailyCandle: string;
  h4Confirmation: string;
  h1Context: string;
  m15Setup: string;
  protectedSwing: number;
  fvgLevel: number | null;
  timestamp: string;
  keyLevels: { label: string; price: number }[];
  atr14?: number;
}

export class FractalAnalyzer {
  constructor(
    private symbol: string,
    private daily: Candle[],
    private h4: Candle[],
    private h1: Candle[],
    private m15: Candle[]
  ) {}

  private _lastRejectionReason: string | null = null;
  private pip(): number { return this.symbol.includes('JPY') ? 0.01 : 0.0001; }
  private dec(): number { return this.symbol.includes('JPY') ? 3 : 5; }

  analyze(): AnalyzeResult {
    const bias = this.getDailyBias();
    if (!bias) return { signal: null, rejected: false, reason: null };

    const h4 = this.getH4Confirmation(bias);
    if (!h4) {
      logger.scan(`${this.symbol}: kein H4-${bias === 'LONG' ? 'HH+HL' : 'LH+LL'} — kein Setup`);
      return { signal: null, rejected: false, reason: null };
    }

    const h1 = this.getH1Retest(bias);
    if (!h1) {
      logger.scan(`${this.symbol}: D1/H4=${bias} | kein H1-Retest in 15-Pip-Fenster`);
      return { signal: null, rejected: false, reason: null };
    }

    const m15 = this.getM15Entry(bias, h1.level);
    if (!m15) {
      logger.scan(`${this.symbol}: D1/H4=${bias} | H1-Retest=${h1.level.toFixed(this.dec())} | kein M15-Entry`);
      return { signal: null, rejected: false, reason: null };
    }

    const signal = this.buildSignal(bias, h4, h1, m15);
    if (!signal) {
      logger.scan(`${this.symbol}: REJECTED — ${this._lastRejectionReason}`);
      return { signal: null, rejected: true, reason: this._lastRejectionReason ?? 'Filter rejected' };
    }

    logger.setup(
      `${this.symbol}: ${bias} Setup\n` +
      `  D1: ${bias === 'LONG' ? 'HH+HL Aufwärtstrend' : 'LH+LL Abwärtstrend'}\n` +
      `  H4: ${h4.description}\n` +
      `  H1: ${h1.description}\n` +
      `  M15: ${m15.description}\n` +
      `  Entry: ${signal.entryZone[0].toFixed(this.dec())}–${signal.entryZone[1].toFixed(this.dec())} | SL: ${signal.stopLoss.toFixed(this.dec())} | TP: ${signal.target1.toFixed(this.dec())} | RR: 1.3:1`
    );

    return { signal, rejected: false, reason: null };
  }

  // ─── STEP 1: Daily Bias ────────────────────────────────────────────────────
  // HH+HL = LONG, LH+LL = SHORT, sonst kein Signal
  // Mean-Reversion-Logik komplett entfernt
  private getDailyBias(): SignalType | null {
    const c = this.daily;
    if (c.length < 10) return null;

    const swingHighs: number[] = [];
    const swingLows:  number[] = [];

    for (let i = 1; i < c.length - 1; i++) {
      if (c[i].high > c[i-1].high && c[i].high > c[i+1].high) swingHighs.push(c[i].high);
      if (c[i].low  < c[i-1].low  && c[i].low  < c[i+1].low)  swingLows.push(c[i].low);
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    const [prevSH, lastSH] = swingHighs.slice(-2);
    const [prevSL, lastSL] = swingLows.slice(-2);

    if (lastSH > prevSH && lastSL > prevSL) return 'LONG';  // HH + HL
    if (lastSH < prevSH && lastSL < prevSL) return 'SHORT'; // LH + LL
    return null;
  }

  // ─── STEP 2: H4 Confirmation ───────────────────────────────────────────────
  // H4 muss dieselbe Swing-Struktur zeigen wie D1
  private getH4Confirmation(bias: SignalType): { level: number; description: string } | null {
    const c = this.h4;
    if (c.length < 10) return null;

    const swingHighs: number[] = [];
    const swingLows:  number[] = [];

    for (let i = 1; i < c.length - 1; i++) {
      if (c[i].high > c[i-1].high && c[i].high > c[i+1].high) swingHighs.push(c[i].high);
      if (c[i].low  < c[i-1].low  && c[i].low  < c[i+1].low)  swingLows.push(c[i].low);
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    const [prevSH, lastSH] = swingHighs.slice(-2);
    const [prevSL, lastSL] = swingLows.slice(-2);

    if (bias === 'LONG' && lastSH > prevSH && lastSL > prevSL) {
      return {
        level: lastSL,
        description: `H4 Bullisch: HH ${lastSH.toFixed(this.dec())} HL ${lastSL.toFixed(this.dec())}`,
      };
    }
    if (bias === 'SHORT' && lastSH < prevSH && lastSL < prevSL) {
      return {
        level: lastSH,
        description: `H4 Bärisch: LH ${lastSH.toFixed(this.dec())} LL ${lastSL.toFixed(this.dec())}`,
      };
    }
    return null;
  }

  // ─── STEP 3: H1 Retest ────────────────────────────────────────────────────
  // Preis muss ein H1 Swing Level retestet haben UND Rejection zeigen
  // LONG: Preis berührt H1 Swing Low von oben, letzte H1 Kerze bullisch
  // SHORT: Preis berührt H1 Swing High von unten, letzte H1 Kerze bärisch
  private getH1Retest(bias: SignalType): { level: number; description: string } | null {
    const c = this.h1;
    if (c.length < 10) return null;

    const pip          = this.pip();
    const retestWindow = pip * 15;
    const currentPrice = c[c.length - 1].close;
    const lastCandle   = c[c.length - 1];

    const swingHighs: number[] = [];
    const swingLows:  number[] = [];

    // Letzte 20 H1 Kerzen für relevante Levels
    const lookback = c.slice(-20);
    for (let i = 1; i < lookback.length - 1; i++) {
      if (lookback[i].high > lookback[i-1].high && lookback[i].high > lookback[i+1].high)
        swingHighs.push(lookback[i].high);
      if (lookback[i].low < lookback[i-1].low && lookback[i].low < lookback[i+1].low)
        swingLows.push(lookback[i].low);
    }

    if (bias === 'LONG' && swingLows.length > 0) {
      const relevantLows = swingLows.filter(l => l < currentPrice).sort((a, b) => b - a);
      if (relevantLows.length === 0) return null;
      const level    = relevantLows[0];
      const distance = currentPrice - level;
      if (distance > retestWindow) return null;
      // Rejection: letzte H1 Kerze bullisch
      if (lastCandle.close <= lastCandle.open) return null;
      return {
        level,
        description: `H1 Retest Swing Low ${level.toFixed(this.dec())} (${(distance/pip).toFixed(1)} pips)`,
      };
    }

    if (bias === 'SHORT' && swingHighs.length > 0) {
      const relevantHighs = swingHighs.filter(h => h > currentPrice).sort((a, b) => a - b);
      if (relevantHighs.length === 0) return null;
      const level    = relevantHighs[0];
      const distance = level - currentPrice;
      if (distance > retestWindow) return null;
      // Rejection: letzte H1 Kerze bärisch
      if (lastCandle.close >= lastCandle.open) return null;
      return {
        level,
        description: `H1 Retest Swing High ${level.toFixed(this.dec())} (${(distance/pip).toFixed(1)} pips)`,
      };
    }

    return null;
  }

  // ─── STEP 4: M15 Entry ────────────────────────────────────────────────────
  // Rejection-Kerze auf M15 in der Nähe des H1 Retest Levels
  // LONG: Hammer oder bullische Kerze (body > 40% range)
  // SHORT: Shooting Star oder bärische Kerze (body > 40% range)
  private getM15Entry(
    bias: SignalType,
    h1Level: number
  ): { entryZone: [number, number]; protectedSwing: number; fvg: number | null; description: string } | null {
    const c = this.m15;
    if (c.length < 5) return null;

    const pip              = this.pip();
    const proximityWindow  = pip * 20;
    const currentPrice     = c[c.length - 1].close;

    if (Math.abs(currentPrice - h1Level) > proximityWindow) return null;

    const last  = c[c.length - 1];
    const prev  = c[c.length - 2];
    const prev2 = c[c.length - 3];

    const range     = last.high - last.low;
    if (range === 0) return null;
    const body      = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const bodyRatio = body / range;

    if (bias === 'LONG') {
      const isHammer  = lowerWick / range > 0.50 && bodyRatio < 0.40;
      const isBullish = last.close > last.open && bodyRatio > 0.40;
      if (!isHammer && !isBullish) return null;

      const protectedSwing = Math.min(last.low, prev.low, prev2.low);
      const fvg = this.findBullishFVG(c.slice(-10));
      return {
        entryZone:     [currentPrice - pip * 2, currentPrice + pip * 2],
        protectedSwing,
        fvg,
        description: `M15 ${isHammer ? 'Hammer' : 'Bullish'} @ H1 ${h1Level.toFixed(this.dec())}${fvg ? ` FVG ${fvg.toFixed(this.dec())}` : ''}`,
      };
    }

    if (bias === 'SHORT') {
      const isShootingStar = upperWick / range > 0.50 && bodyRatio < 0.40;
      const isBearish      = last.close < last.open && bodyRatio > 0.40;
      if (!isShootingStar && !isBearish) return null;

      const protectedSwing = Math.max(last.high, prev.high, prev2.high);
      const fvg = this.findBearishFVG(c.slice(-10));
      return {
        entryZone:     [currentPrice - pip * 2, currentPrice + pip * 2],
        protectedSwing,
        fvg,
        description: `M15 ${isShootingStar ? 'Shooting Star' : 'Bearish'} @ H1 ${h1Level.toFixed(this.dec())}${fvg ? ` FVG ${fvg.toFixed(this.dec())}` : ''}`,
      };
    }

    return null;
  }

  // ─── Signal Builder ────────────────────────────────────────────────────────
  private buildSignal(
    bias: SignalType,
    h4: { level: number; description: string },
    h1: { level: number; description: string },
    m15: { entryZone: [number, number]; protectedSwing: number; fvg: number | null; description: string }
  ): TradeSignal | null {
    const pip = this.pip();
    const RR  = 1.3;
    const [entryLow, entryHigh] = m15.entryZone;
    const entryMid = (entryLow + entryHigh) / 2;
    const currentPrice = this.m15[this.m15.length - 1].close;

    // SL: M15 Protected Swing + 3 Pips Buffer
    let stopLoss: number;
    if (bias === 'LONG') {
      stopLoss = m15.protectedSwing - pip * 3;
      if (stopLoss >= entryMid) { this._lastRejectionReason = 'SL über Entry'; return null; }
    } else {
      stopLoss = m15.protectedSwing + pip * 3;
      if (stopLoss <= entryMid) { this._lastRejectionReason = 'SL unter Entry'; return null; }
    }

    const risk = Math.abs(entryMid - stopLoss);

    // Min Stop
    const minRisk = pip * (this.symbol.includes('JPY') ? 8 : 5);
    if (risk < minRisk) {
      this._lastRejectionReason = `Stop zu klein: ${(risk/pip).toFixed(1)} < ${(minRisk/pip).toFixed(0)} pips`;
      return null;
    }

    // Max Stop: D1 ATR14 × 0.75
    const atrCalc = new ATR(14);
    for (const c of this.daily) atrCalc.update(c);
    const atrValue = atrCalc.getValue();
    if (atrValue !== null) {
      const maxRisk = atrValue * 0.75;
      if (risk > maxRisk) {
        this._lastRejectionReason = `Stop zu weit: ${(risk/pip).toFixed(1)} > ${(maxRisk/pip).toFixed(1)} pips (ATR×0.75)`;
        return null;
      }
    }

    // TP
    const target1 = bias === 'LONG' ? entryMid + risk * RR : entryMid - risk * RR;
    const target2 = bias === 'LONG' ? entryMid + risk * RR * 2 : entryMid - risk * RR * 2;

    // TP nicht zu nah an D1 Extreme
    const d1Highs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const d1Lows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
    if (bias === 'LONG'  && Math.abs(target1 - d1Highs[0]) < pip * 15) { this._lastRejectionReason = `TP zu nah an D1 High ${d1Highs[0].toFixed(this.dec())}`; return null; }
    if (bias === 'SHORT' && Math.abs(target1 - d1Lows[0])  < pip * 15) { this._lastRejectionReason = `TP zu nah an D1 Low ${d1Lows[0].toFixed(this.dec())}`; return null; }

    // H4 Proximity Filter
    const pip15 = pip * 15;
    if (bias === 'LONG') {
      const h4R: number[] = [];
      for (let i = 1; i < this.h4.length - 1; i++)
        if (this.h4[i].high > this.h4[i-1].high && this.h4[i].high > this.h4[i+1].high) h4R.push(this.h4[i].high);
      const near = h4R.filter(r => r > entryMid && r - entryMid < pip15);
      if (near.length > 0) { this._lastRejectionReason = `Entry zu nah an H4 Widerstand ${near.sort((a,b)=>a-b)[0].toFixed(this.dec())}`; return null; }
    }
    if (bias === 'SHORT') {
      const h4S: number[] = [];
      for (let i = 1; i < this.h4.length - 1; i++)
        if (this.h4[i].low < this.h4[i-1].low && this.h4[i].low < this.h4[i+1].low) h4S.push(this.h4[i].low);
      const near = h4S.filter(s => s < entryMid && entryMid - s < pip15);
      if (near.length > 0) { this._lastRejectionReason = `Entry zu nah an H4 Support ${near.sort((a,b)=>b-a)[0].toFixed(this.dec())}`; return null; }
    }

    const reward     = Math.abs(target1 - entryMid);
    const riskReward = risk > 0 ? reward / risk : 0;
    const atr14Pips  = atrValue !== null ? Math.round(atrValue / pip) : undefined;

    const dailyLast  = this.daily[this.daily.length - 1];
    const dailyBody  = Math.abs(dailyLast.close - dailyLast.open);
    const dailyRange = dailyLast.high - dailyLast.low;
    const phase: SetupPhase = dailyRange > 0 && dailyBody / dailyRange > 0.6 ? 'C4_RETEST' : 'C3_ENTRY';

    return {
      symbol:         this.symbol,
      type:           bias,
      phase,
      currentPrice,
      entryZone:      m15.entryZone,
      stopLoss,
      target1,
      target2,
      riskReward,
      dailyBias:      bias,
      dailyCandle:    `D1 ${bias === 'LONG' ? 'Bullisch' : 'Bärisch'} Struktur`,
      h4Confirmation: h4.description,
      h1Context:      h1.description,
      m15Setup:       m15.description,
      protectedSwing: m15.protectedSwing,
      fvgLevel:       m15.fvg,
      timestamp:      new Date().toISOString(),
      atr14:          atr14Pips,
      keyLevels: [
        { label: 'D1 High',   price: d1Highs[0] },
        { label: 'D1 Low',    price: d1Lows[0] },
        { label: 'H4 Level',  price: h4.level },
        { label: 'H1 Retest', price: h1.level },
        { label: 'M15 Swing', price: m15.protectedSwing },
      ],
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private findBullishFVG(candles: Candle[]): number | null {
    const pip = this.pip();
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i + 2].low - candles[i].high;
      if (gap >= pip * 2) return (candles[i].high + candles[i + 2].low) / 2;
    }
    return null;
  }

  private findBearishFVG(candles: Candle[]): number | null {
    const pip = this.pip();
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i].low - candles[i + 2].high;
      if (gap >= pip * 2) return (candles[i].low + candles[i + 2].high) / 2;
    }
    return null;
  }
}
