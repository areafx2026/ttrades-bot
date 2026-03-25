import { Candle } from './capitalApi';

export type SignalType = 'LONG' | 'SHORT';
export type SetupPhase = 'C3_ENTRY' | 'C4_RETEST';

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
  m15Setup: string;
  protectedSwing: number;
  fvgLevel: number | null;
  timestamp: string;
  keyLevels: { label: string; price: number }[];
}

export class FractalAnalyzer {
  constructor(
    private symbol: string,
    private daily: Candle[],
    private h4: Candle[],
    private m15: Candle[]
  ) {}

  analyze(): TradeSignal | null {
    const dailyBias = this.getDailyBias();
    if (!dailyBias) return null;

    const h4Confirm = this.getH4Confirmation(dailyBias);
    if (!h4Confirm) return null;

    const m15Setup = this.getM15Setup(dailyBias, h4Confirm.level);
    if (!m15Setup) return null;

    return this.buildSignal(dailyBias, h4Confirm, m15Setup);
  }

  // JPY pairs have 2 decimal places, others have 5
  private pipSize(): number {
    return this.symbol.includes('JPY') ? 0.01 : 0.0001;
  }

  // Decimal places for toFixed formatting
  private decimals(): number {
    return this.symbol.includes('JPY') ? 3 : 5;
  }

  // STEP 1: Daily Bias
  private getDailyBias(): SignalType | null {
    const candles = this.daily;
    if (candles.length < 5) return null;

    const last = candles[candles.length - 1];

    const swingLow = this.detectSwingLow(candles, candles.length - 3);
    if (swingLow) {
      const c3 = candles[candles.length - 2];
      const c3Body = c3.close - c3.open;
      const c3Range = c3.high - c3.low;
      if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5) {
        return 'LONG';
      }
    }

    const swingHigh = this.detectSwingHigh(candles, candles.length - 3);
    if (swingHigh) {
      const c3 = candles[candles.length - 2];
      const c3Body = c3.open - c3.close;
      const c3Range = c3.high - c3.low;
      if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5) {
        return 'SHORT';
      }
    }

    // Mean reversion: extended move check
    const recentHigh = Math.max(...candles.slice(-6).map(c => c.high));
    const pip = this.pipSize();
    const pipDrop = (recentHigh - last.close) / pip;
    if (pipDrop > 200 && last.close > last.open) return 'LONG';

    const recentLow = Math.min(...candles.slice(-6).map(c => c.low));
    const pipRise = (last.close - recentLow) / pip;
    if (pipRise > 200 && last.close < last.open) return 'SHORT';

    return null;
  }

  // STEP 2: 4H Trend Confirmation
  // 4H trend must align with Daily bias:
  // LONG: 4H must show bullish structure (HH + HL = higher highs and higher lows)
  // SHORT: 4H must show bearish structure (LH + LL = lower highs and lower lows)
  private getH4Confirmation(bias: SignalType): { confirmed: boolean; level: number; description: string } | null {
    const candles = this.h4;
    if (candles.length < 10) return null;

    const dec = this.decimals();

    // Find last 3 swing highs and lows from 4H candles
    // A swing high: candle with higher high than both neighbors
    // A swing low: candle with lower low than both neighbors
    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high) {
        swingHighs.push(candles[i].high);
      }
      if (candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low) {
        swingLows.push(candles[i].low);
      }
    }

    // Need at least 2 swing highs and 2 swing lows to determine trend
    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const prevSwingHigh = swingHighs[swingHighs.length - 2];
    const lastSwingLow  = swingLows[swingLows.length - 1];
    const prevSwingLow  = swingLows[swingLows.length - 2];

    const h4Bullish = lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow;
    const h4Bearish = lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow;

    // Use last swing low/high as the key level for SL reference
    if (bias === 'LONG' && h4Bullish) {
      return {
        confirmed: true,
        level: lastSwingLow,
        description: `4H Bullish structure: HH ${lastSwingHigh.toFixed(dec)} > ${prevSwingHigh.toFixed(dec)}, HL ${lastSwingLow.toFixed(dec)} > ${prevSwingLow.toFixed(dec)}`,
      };
    }

    if (bias === 'SHORT' && h4Bearish) {
      return {
        confirmed: true,
        level: lastSwingHigh,
        description: `4H Bearish structure: LH ${lastSwingHigh.toFixed(dec)} < ${prevSwingHigh.toFixed(dec)}, LL ${lastSwingLow.toFixed(dec)} < ${prevSwingLow.toFixed(dec)}`,
      };
    }

    return null;
  }

  // STEP 3: 15M Entry Setup
  private getM15Setup(bias: SignalType, h4Level: number): {
    protectedSwing: number;
    fvg: number | null;
    entryZone: [number, number];
    description: string;
  } | null {
    const candles = this.m15;
    if (candles.length < 10) return null;

    const dec = this.decimals();
    const pip = this.pipSize();
    const last5 = candles.slice(-5);

    if (bias === 'LONG') {
      const swingLow = Math.min(...last5.map(c => c.low));
      const fvg = this.findBullishFVG(candles.slice(-10));
      const exhaustion = this.detectExhaustion(candles.slice(-5), 'BULL');
      // Entry at FVG if valid, otherwise directly at protected swing
      const entryLow  = fvg ?? swingLow;
      const entryHigh = entryLow + pip * 1.5;
      const lastCandle = candles[candles.length - 1];
      if (lastCandle.close > swingLow && lastCandle.close > lastCandle.open) {
        const exhaustionNote = exhaustion ? ' | Bullish Exhaustion ✅' : '';
        return {
          protectedSwing: swingLow,
          fvg,
          entryZone: [entryLow, entryHigh],
          description: `H1 Protected Swing Low @ ${swingLow.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustionNote}`,
        };
      }
    }

    if (bias === 'SHORT') {
      const swingHigh = Math.max(...last5.map(c => c.high));
      const fvg = this.findBearishFVG(candles.slice(-10));
      const exhaustion = this.detectExhaustion(candles.slice(-5), 'BEAR');
      // Entry at FVG if valid, otherwise directly at protected swing
      const entryHigh = fvg ?? swingHigh;
      const entryLow  = entryHigh - pip * 1.5;
      const lastCandle = candles[candles.length - 1];
      if (lastCandle.close < swingHigh && lastCandle.close < lastCandle.open) {
        const exhaustionNote = exhaustion ? ' | Bearish Exhaustion ✅' : '';
        return {
          protectedSwing: swingHigh,
          fvg,
          entryZone: [entryLow, entryHigh],
          description: `H1 Protected Swing High @ ${swingHigh.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustionNote}`,
        };
      }
    }

    return null;
  }

  // Signal Builder
  private buildSignal(
    bias: SignalType,
    h4: { confirmed: boolean; level: number; description: string },
    m15: { protectedSwing: number; fvg: number | null; entryZone: [number, number]; description: string }
  ): TradeSignal | null {
    const currentPrice = this.daily[this.daily.length - 1].close;
    const [entryLow, entryHigh] = m15.entryZone;
    const entryMid = (entryLow + entryHigh) / 2;
    const pip = this.pipSize();

    let stopLoss: number, target1: number, target2: number;

    if (bias === 'LONG') {
      // Stop 5 pips below protected swing, never above entry
      stopLoss = m15.protectedSwing - (pip * 5);
      // Ensure stop is actually below entry
      if (stopLoss >= entryMid) stopLoss = entryMid - (pip * 10);
      const risk = Math.abs(entryMid - stopLoss);
      target1 = entryMid + risk * 2;
      target2 = entryMid + risk * 4;
    } else {
      // Stop 5 pips above protected swing, never below entry
      stopLoss = m15.protectedSwing + (pip * 5);
      // Ensure stop is actually above entry
      if (stopLoss <= entryMid) stopLoss = entryMid + (pip * 10);
      const risk = Math.abs(stopLoss - entryMid);
      target1 = entryMid - risk * 2;
      target2 = entryMid - risk * 4;
    }

    const risk = Math.abs(entryMid - stopLoss);

    // Minimum stop: 8 pips for JPY pairs, 5 pips for others
    const minRisk = this.symbol.includes('JPY') ? pip * 8 : pip * 5;
    if (risk < minRisk) return null;

    // Filter 1: TP must be at least 20 pips away from recent D1 High/Low
    // to ensure there is enough room to run
    const d1Highs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const d1Lows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
    const nearestD1High = d1Highs[0];
    const nearestD1Low  = d1Lows[0];
    const minTPBuffer = pip * 20;

    if (bias === 'LONG') {
      const distanceToD1High = Math.abs(target1 - nearestD1High);
      if (distanceToD1High < minTPBuffer) return null;
    } else {
      const distanceToD1Low = Math.abs(target1 - nearestD1Low);
      if (distanceToD1Low < minTPBuffer) return null;
    }

    const reward = Math.abs(target1 - entryMid);
    const riskReward = risk > 0 ? reward / risk : 0;

    const recentHighs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const recentLows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);

    const keyLevels = [
      { label: 'Recent D1 High',  price: recentHighs[0] },
      { label: 'Recent D1 Low',   price: recentLows[0] },
      { label: '4H CISD Level',   price: h4.level },
      { label: 'Protected Swing', price: m15.protectedSwing },
    ];

    const dailyLast = this.daily[this.daily.length - 1];
    const dailyC3Body = Math.abs(dailyLast.close - dailyLast.open);
    const dailyC3Range = dailyLast.high - dailyLast.low;
    const phase: SetupPhase = dailyC3Range > 0 && dailyC3Body / dailyC3Range > 0.6 ? 'C4_RETEST' : 'C3_ENTRY';

    const dailyCandleDesc = phase === 'C3_ENTRY'
      ? `C3 ${bias === 'LONG' ? 'Bullish' : 'Bearish'} Expansion forming`
      : `C4 Retest - wick into ${bias === 'LONG' ? 'upper' : 'lower'} 50% of C3`;

    return {
      symbol: this.symbol,
      type: bias,
      phase,
      currentPrice,
      entryZone: m15.entryZone,
      stopLoss,
      target1,
      target2,
      riskReward,
      dailyBias: bias,
      dailyCandle: dailyCandleDesc,
      h4Confirmation: h4.description,
      m15Setup: m15.description,
      protectedSwing: m15.protectedSwing,
      fvgLevel: m15.fvg,
      timestamp: new Date().toISOString(),
      keyLevels,
    };
  }

  // Wick rejection / exhaustion detection
  // Returns true if 2+ consecutive candles show rejection at a level
  private detectExhaustion(candles: Candle[], bias: 'BULL' | 'BEAR'): boolean {
    if (candles.length < 2) return false;
    const last3 = candles.slice(-3);
    let rejectionCount = 0;

    for (const c of last3) {
      const range = c.high - c.low;
      if (range === 0) continue;
      const body = Math.abs(c.close - c.open);
      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;

      if (bias === 'BEAR') {
        // Bearish exhaustion: upper wick > 55% of range, body < 30%
        if (upperWick / range > 0.55 && body / range < 0.30) rejectionCount++;
      } else {
        // Bullish exhaustion: lower wick > 55% of range, body < 30%
        if (lowerWick / range > 0.55 && body / range < 0.30) rejectionCount++;
      }
    }
    return rejectionCount >= 2;
  }

  // Helpers
  private detectSwingLow(candles: Candle[], idx: number): boolean {
    if (idx < 1 || idx >= candles.length - 1) return false;
    return candles[idx].low < candles[idx - 1].low && candles[idx].low < candles[idx + 1].low;
  }

  private detectSwingHigh(candles: Candle[], idx: number): boolean {
    if (idx < 1 || idx >= candles.length - 1) return false;
    return candles[idx].high > candles[idx - 1].high && candles[idx].high > candles[idx + 1].high;
  }

  private findBullishFVG(candles: Candle[]): number | null {
    const pip = this.pipSize();
    const minGap = pip * 3; // minimum 3 pips gap to qualify as FVG
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i + 2].low - candles[i].high;
      if (gap >= minGap) return (candles[i].high + candles[i + 2].low) / 2;
    }
    return null;
  }

  private findBearishFVG(candles: Candle[]): number | null {
    const pip = this.pipSize();
    const minGap = pip * 3; // minimum 3 pips gap to qualify as FVG
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i].low - candles[i + 2].high;
      if (gap >= minGap) return (candles[i].low + candles[i + 2].high) / 2;
    }
    return null;
  }
}
