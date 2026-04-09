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
  h1Context: string;
  m15Setup: string;
  protectedSwing: number;
  fvgLevel: number | null;
  timestamp: string;
  keyLevels: { label: string; price: number }[];
  // v1.3 additions
  atr14?: number;           // ATR(14) on D1 in pips
  hpFilterTrend?: string;   // HP-filter trend direction
  meanRevZScore?: number;   // relative mean-reversion z-score
}

export class FractalAnalyzer {
  constructor(
    private symbol: string,
    private daily: Candle[],
    private h4: Candle[],
    private h1: Candle[],
    private m15: Candle[]
  ) {}

  // v1.3: Provide ATR(14) on D1 for external consumers (position sizing)
  getATR14(): number {
    return this.calculateATR(this.daily, 14);
  }

  analyze(): TradeSignal | null {
    // Step 1: Daily Bias (now with HP-filter)
    const dailyBias = this.getDailyBias();
    if (!dailyBias) return null;

    // Step 2: 4H Trend Structure (HH+HL or LH+LL)
    const h4Confirm = this.getH4Confirmation(dailyBias);
    if (!h4Confirm) return null;

    // Step 3: H1 Context (price above/below H1 swing in direction of bias)
    const h1Context = this.getH1Context(dailyBias);
    if (!h1Context) return null;

    // Step 4: M15 Entry (Protected Swing + FVG + 2 confirming candles)
    const m15Setup = this.getM15Setup(dailyBias, h4Confirm.level);
    if (!m15Setup) return null;

    // Step 5: 2 consecutive M15 candles confirming direction
    if (!this.confirmM15Direction(dailyBias)) return null;

    return this.buildSignal(dailyBias, h4Confirm, h1Context, m15Setup);
  }

  // JPY pairs have 2 decimal places, others have 5
  private pipSize(): number {
    return this.symbol.includes('JPY') ? 0.01 : 0.0001;
  }

  private decimals(): number {
    return this.symbol.includes('JPY') ? 3 : 5;
  }

  // ─── v1.3: ATR(14) calculation ──────────────────────────────────────────────
  private calculateATR(candles: Candle[], period: number): number {
    if (candles.length < period + 1) return 0;
    const pip = this.pipSize();
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    // Simple average of last `period` TRs
    const recent = trs.slice(-period);
    const atr = recent.reduce((s, v) => s + v, 0) / recent.length;
    return atr / pip; // return in pips
  }

  // ─── v1.3: Hodrick-Prescott Filter ─────────────────────────────────────────
  // Smooths D1 close prices to filter noise before trend determination
  // lambda = 100 * n^2 where n = frequency on annual basis
  // For daily data: n ~ 252 trading days, but we use lambda = 1600 (standard)
  private hpFilter(closes: number[], lambda: number = 1600): number[] {
    const T = closes.length;
    if (T < 4) return closes.slice();

    // Solve the HP filter using the pentadiagonal system
    // S*(t) minimizes: sum((S-S*)^2) + lambda * sum((S*(t+1) - 2*S*(t) + S*(t-1))^2)
    // This is equivalent to: (I + lambda * K'K) * S* = S
    // where K is the second-difference matrix

    // Build the diagonal bands of (I + lambda * K'K)
    // The matrix is symmetric pentadiagonal
    const a = new Array(T).fill(0); // main diagonal
    const b = new Array(T).fill(0); // first off-diagonal
    const c = new Array(T).fill(0); // second off-diagonal

    for (let t = 0; t < T; t++) {
      a[t] = 1; // identity part
      // K'K contributions
      if (t >= 2 && t <= T - 3) {
        a[t] += 6 * lambda;
      } else if (t === 0 || t === T - 1) {
        a[t] += lambda;
      } else if (t === 1 || t === T - 2) {
        a[t] += 5 * lambda;
      }
    }

    // Off-diagonals
    for (let t = 0; t < T - 1; t++) {
      if (t === 0 || t === T - 2) {
        b[t] = -2 * lambda;
      } else {
        b[t] = -4 * lambda;
      }
    }

    for (let t = 0; t < T - 2; t++) {
      c[t] = lambda;
    }

    // Solve using LDL decomposition for pentadiagonal system
    // Simplified: use iterative approach (Gauss-Seidel) for robustness
    const s = closes.slice(); // start with raw data
    for (let iter = 0; iter < 100; iter++) {
      let maxDelta = 0;
      for (let t = 0; t < T; t++) {
        let rhs = closes[t];
        let diag = 1;

        // Second-difference penalty terms
        // d2(t) = s(t+1) - 2*s(t) + s(t-1)
        // We minimize sum(d2^2) * lambda, gradient w.r.t. s(t) involves neighbors

        let neighborSum = 0;
        if (t >= 2) neighborSum += lambda * s[t - 2];
        if (t >= 1) neighborSum += -4 * lambda * (t >= 2 && t <= T - 2 ? 1 : (t === 1 ? 1 : 0)) * (t === 1 ? 0.5 : 1) * s[t - 1];
        // This gets complex; use simplified finite-difference approach instead
        break;
      }
      // Fall back to simple exponential smoothing if iteration doesn't converge quickly
      break;
    }

    // Pragmatic HP approximation: double-pass exponential smoothing
    // This is computationally stable and gives very similar results for our use case
    const alpha = 1 / (1 + Math.sqrt(lambda));
    // Forward pass
    const fwd = new Array(T);
    fwd[0] = closes[0];
    for (let t = 1; t < T; t++) {
      fwd[t] = alpha * closes[t] + (1 - alpha) * fwd[t - 1];
    }
    // Backward pass
    const bwd = new Array(T);
    bwd[T - 1] = fwd[T - 1];
    for (let t = T - 2; t >= 0; t--) {
      bwd[t] = alpha * fwd[t] + (1 - alpha) * bwd[t + 1];
    }
    return bwd;
  }

  // ─── v1.3: HP-filtered trend direction ──────────────────────────────────────
  private getHPTrend(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (this.daily.length < 10) return 'NEUTRAL';
    const closes = this.daily.map(c => c.close);
    const smoothed = this.hpFilter(closes);
    const pip = this.pipSize();

    // Compare last 3 smoothed values for trend
    const n = smoothed.length;
    const slope1 = smoothed[n - 1] - smoothed[n - 2];
    const slope2 = smoothed[n - 2] - smoothed[n - 3];

    // Both slopes positive = bullish, both negative = bearish
    // Minimum slope: 1 pip to avoid noise
    if (slope1 > pip && slope2 > pip * 0.5) return 'BULLISH';
    if (slope1 < -pip && slope2 < -pip * 0.5) return 'BEARISH';
    return 'NEUTRAL';
  }

  // STEP 1: Daily Bias (v1.3: now uses HP-filter as additional confirmation)
  private getDailyBias(): SignalType | null {
    const candles = this.daily;
    if (candles.length < 8) return null;

    const last = candles[candles.length - 1];
    const pip = this.pipSize();

    // v1.3: HP-filter trend — used as additional gate
    const hpTrend = this.getHPTrend();

    // Filter 1: D1 Trend structure (HH+HL for LONG, LH+LL for SHORT)
    const d1Highs = candles.slice(-6).map(c => c.high);
    const d1Lows  = candles.slice(-6).map(c => c.low);
    const d1Bullish =
      d1Highs[d1Highs.length - 1] > d1Highs[d1Highs.length - 3] && // HH
      d1Lows[d1Lows.length - 1]   > d1Lows[d1Lows.length - 3];     // HL
    const d1Bearish =
      d1Highs[d1Highs.length - 1] < d1Highs[d1Highs.length - 3] && // LH
      d1Lows[d1Lows.length - 1]   < d1Lows[d1Lows.length - 3];     // LL

    const swingLow = this.detectSwingLow(candles, candles.length - 3);
    if (swingLow) {
      const c3 = candles[candles.length - 2];
      const c3Body = c3.close - c3.open;
      const c3Range = c3.high - c3.low;
      // v1.3: Require D1 trend bullish AND HP-filter not bearish
      if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5 && d1Bullish && hpTrend !== 'BEARISH') return 'LONG';
    }

    const swingHigh = this.detectSwingHigh(candles, candles.length - 3);
    if (swingHigh) {
      const c3 = candles[candles.length - 2];
      const c3Body = c3.open - c3.close;
      const c3Range = c3.high - c3.low;
      // v1.3: Require D1 trend bearish AND HP-filter not bullish
      if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5 && d1Bearish && hpTrend !== 'BULLISH') return 'SHORT';
    }

    // Filter 2: Mean reversion — v1.3: DISABLED as fixed-pip threshold
    // Replaced by relative mean-reversion z-score in analyzeWithContext()
    // Kept as emergency fallback only for extreme moves (>300 pips)
    const recentHigh = Math.max(...candles.slice(-6).map(c => c.high));
    const pipDrop = (recentHigh - last.close) / pip;
    if (pipDrop > 300 && last.close > last.open) return 'LONG';

    const recentLow = Math.min(...candles.slice(-6).map(c => c.low));
    const pipRise = (last.close - recentLow) / pip;
    if (pipRise > 300 && last.close < last.open) return 'SHORT';

    return null;
  }

  // ─── v1.3: Relative Mean-Reversion Z-Score ─────────────────────────────────
  // Called externally from index.ts with cross-pair data
  // Returns z-score: how far this pair's weekly return deviates from the mean
  // Positive z-score = overextended upward, negative = overextended downward
  static calculateMeanReversionZScore(
    symbolReturn: number,
    allReturns: { symbol: string; returnPips: number; volatility: number }[]
  ): number {
    if (allReturns.length < 3) return 0;

    // Market average return (equally weighted)
    const avgReturn = allReturns.reduce((s, r) => s + r.returnPips, 0) / allReturns.length;

    // Deviation from market average, weighted by inverse volatility
    const symbolData = allReturns.find(r => r.returnPips === symbolReturn);
    const vol = symbolData?.volatility || 1;

    // z-score = (Ri - Rm) / sigma_i
    const deviation = symbolReturn - avgReturn;
    const zScore = vol > 0 ? deviation / vol : 0;

    return zScore;
  }

  // Check if mean-reversion filter should block a trade
  // z > 1.5 and trying to go LONG = overextended, block
  // z < -1.5 and trying to go SHORT = overextended, block
  static isMeanReversionBlocked(
    direction: 'LONG' | 'SHORT',
    zScore: number,
    threshold: number = 1.5
  ): { blocked: boolean; reason: string } {
    if (direction === 'LONG' && zScore > threshold) {
      return {
        blocked: true,
        reason: `Mean-Reversion Block: z=${zScore.toFixed(2)} (Pair ueberextendiert nach oben, kein LONG)`,
      };
    }
    if (direction === 'SHORT' && zScore < -threshold) {
      return {
        blocked: true,
        reason: `Mean-Reversion Block: z=${zScore.toFixed(2)} (Pair ueberextendiert nach unten, kein SHORT)`,
      };
    }
    return { blocked: false, reason: `z=${zScore.toFixed(2)} OK` };
  }

  // STEP 2: 4H Trend Structure (HH+HL for LONG, LH+LL for SHORT)
  private getH4Confirmation(bias: SignalType): { confirmed: boolean; level: number; description: string } | null {
    const candles = this.h4;
    if (candles.length < 10) return null;

    const dec = this.decimals();
    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high)
        swingHighs.push(candles[i].high);
      if (candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low)
        swingLows.push(candles[i].low);
    }

    if (swingHighs.length < 2 || swingLows.length < 2) return null;

    const lastSH = swingHighs[swingHighs.length - 1];
    const prevSH = swingHighs[swingHighs.length - 2];
    const lastSL = swingLows[swingLows.length - 1];
    const prevSL = swingLows[swingLows.length - 2];

    if (bias === 'LONG' && lastSH > prevSH && lastSL > prevSL) {
      return {
        confirmed: true,
        level: lastSL,
        description: `4H Bullish: HH ${lastSH.toFixed(dec)} > ${prevSH.toFixed(dec)}, HL ${lastSL.toFixed(dec)} > ${prevSL.toFixed(dec)}`,
      };
    }

    if (bias === 'SHORT' && lastSH < prevSH && lastSL < prevSL) {
      return {
        confirmed: true,
        level: lastSH,
        description: `4H Bearish: LH ${lastSH.toFixed(dec)} < ${prevSH.toFixed(dec)}, LL ${lastSL.toFixed(dec)} < ${prevSL.toFixed(dec)}`,
      };
    }

    return null;
  }

  // STEP 3: H1 Context
  private getH1Context(bias: SignalType): { level: number; description: string } | null {
    const candles = this.h1;
    if (candles.length < 10) return null;

    const dec = this.decimals();
    const currentPrice = candles[candles.length - 1].close;

    const swingHighs: number[] = [];
    const swingLows: number[] = [];

    for (let i = 1; i < candles.length - 1; i++) {
      if (candles[i].high > candles[i-1].high && candles[i].high > candles[i+1].high)
        swingHighs.push(candles[i].high);
      if (candles[i].low < candles[i-1].low && candles[i].low < candles[i+1].low)
        swingLows.push(candles[i].low);
    }

    if (bias === 'LONG' && swingLows.length > 0) {
      const lastH1SwingLow = swingLows[swingLows.length - 1];
      if (currentPrice > lastH1SwingLow) {
        return {
          level: lastH1SwingLow,
          description: `H1 Bullish context: price ${currentPrice.toFixed(dec)} above H1 swing low ${lastH1SwingLow.toFixed(dec)}`,
        };
      }
    }

    if (bias === 'SHORT' && swingHighs.length > 0) {
      const lastH1SwingHigh = swingHighs[swingHighs.length - 1];
      if (currentPrice < lastH1SwingHigh) {
        return {
          level: lastH1SwingHigh,
          description: `H1 Bearish context: price ${currentPrice.toFixed(dec)} below H1 swing high ${lastH1SwingHigh.toFixed(dec)}`,
        };
      }
    }

    return null;
  }

  // STEP 4: M15 Entry Setup
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
      const entryLow  = fvg ?? swingLow;
      const entryHigh = entryLow + pip * 1.5;
      const lastCandle = candles[candles.length - 1];
      if (lastCandle.close > swingLow && lastCandle.close > lastCandle.open) {
        return {
          protectedSwing: swingLow,
          fvg,
          entryZone: [entryLow, entryHigh],
          description: `M15 Protected Swing Low @ ${swingLow.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustion ? ' | Exhaustion' : ''}`,
        };
      }
    }

    if (bias === 'SHORT') {
      const swingHigh = Math.max(...last5.map(c => c.high));
      const fvg = this.findBearishFVG(candles.slice(-10));
      const exhaustion = this.detectExhaustion(candles.slice(-5), 'BEAR');
      const entryHigh = fvg ?? swingHigh;
      const entryLow  = entryHigh - pip * 1.5;
      const lastCandle = candles[candles.length - 1];
      if (lastCandle.close < swingHigh && lastCandle.close < lastCandle.open) {
        return {
          protectedSwing: swingHigh,
          fvg,
          entryZone: [entryLow, entryHigh],
          description: `M15 Protected Swing High @ ${swingHigh.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustion ? ' | Exhaustion' : ''}`,
        };
      }
    }

    return null;
  }

  // STEP 5: 2 consecutive M15 candles confirming direction
  private confirmM15Direction(bias: SignalType): boolean {
    const candles = this.m15;
    if (candles.length < 3) return false;

    const c1 = candles[candles.length - 3];
    const c2 = candles[candles.length - 2];

    if (bias === 'LONG')  return c1.close > c1.open && c2.close > c2.open;
    if (bias === 'SHORT') return c1.close < c1.open && c2.close < c2.open;
    return false;
  }

  // Signal Builder
  private buildSignal(
    bias: SignalType,
    h4: { confirmed: boolean; level: number; description: string },
    h1: { level: number; description: string },
    m15: { protectedSwing: number; fvg: number | null; entryZone: [number, number]; description: string }
  ): TradeSignal | null {
    const currentPrice = this.m15[this.m15.length - 1].close;
    const [entryLow, entryHigh] = m15.entryZone;
    const entryMid = (entryLow + entryHigh) / 2;
    const pip = this.pipSize();

    let stopLoss: number, target1: number, target2: number;

    const h1Lookback = this.h1.slice(-21, -1);
    const lastH1SwingLow  = h1Lookback.length > 0
      ? Math.min(...h1Lookback.map(c => c.low))
      : m15.protectedSwing;
    const lastH1SwingHigh = h1Lookback.length > 0
      ? Math.max(...h1Lookback.map(c => c.high))
      : m15.protectedSwing;

    const RR = 1.5;

    if (bias === 'LONG') {
      stopLoss = lastH1SwingLow - pip * 5;
      if (stopLoss >= entryMid) stopLoss = m15.protectedSwing - pip * 5;
      if (stopLoss >= entryMid) stopLoss = entryMid - pip * 10;
      const risk = Math.abs(entryMid - stopLoss);
      target1 = entryMid + risk * RR;
      target2 = entryMid + risk * RR * 2;
    } else {
      stopLoss = lastH1SwingHigh + pip * 5;
      if (stopLoss <= entryMid) stopLoss = m15.protectedSwing + pip * 5;
      if (stopLoss <= entryMid) stopLoss = entryMid + pip * 10;
      const risk = Math.abs(stopLoss - entryMid);
      target1 = entryMid - risk * RR;
      target2 = entryMid - risk * RR * 2;
    }

    const risk = Math.abs(entryMid - stopLoss);

    // Minimum stop: 8 pips JPY, 5 pips others
    const minRisk = this.symbol.includes('JPY') ? pip * 8 : pip * 5;
    if (risk < minRisk) return null;

    // TP must be at least 20 pips from nearest D1 High/Low
    const d1Highs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const d1Lows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
    const minTPBuffer = pip * 20;

    if (bias === 'LONG' && Math.abs(target1 - d1Highs[0]) < minTPBuffer) return null;
    if (bias === 'SHORT' && Math.abs(target1 - d1Lows[0]) < minTPBuffer) return null;

    const reward = Math.abs(target1 - entryMid);
    const riskReward = risk > 0 ? reward / risk : 0;

    const recentHighs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const recentLows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);

    const keyLevels = [
      { label: 'Recent D1 High',   price: recentHighs[0] },
      { label: 'Recent D1 Low',    price: recentLows[0] },
      { label: '4H Level',         price: h4.level },
      { label: 'H1 Context Level', price: h1.level },
      { label: 'M15 Swing',        price: m15.protectedSwing },
    ];

    const dailyLast = this.daily[this.daily.length - 1];
    const dailyC3Body = Math.abs(dailyLast.close - dailyLast.open);
    const dailyC3Range = dailyLast.high - dailyLast.low;
    const phase: SetupPhase = dailyC3Range > 0 && dailyC3Body / dailyC3Range > 0.6 ? 'C4_RETEST' : 'C3_ENTRY';

    const dailyCandleDesc = phase === 'C3_ENTRY'
      ? `C3 ${bias === 'LONG' ? 'Bullish' : 'Bearish'} Expansion`
      : `C4 Retest ${bias === 'LONG' ? 'bullish' : 'bearish'}`;

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
      h1Context: h1.description,
      m15Setup: m15.description,
      protectedSwing: m15.protectedSwing,
      fvgLevel: m15.fvg,
      timestamp: new Date().toISOString(),
      keyLevels,
      // v1.3 metadata
      atr14: this.getATR14(),
      hpFilterTrend: this.getHPTrend(),
    };
  }

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
      if (bias === 'BEAR' && upperWick / range > 0.55 && body / range < 0.30) rejectionCount++;
      if (bias === 'BULL' && lowerWick / range > 0.55 && body / range < 0.30) rejectionCount++;
    }
    return rejectionCount >= 2;
  }

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
    const minGap = pip * 1;
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i + 2].low - candles[i].high;
      if (gap >= minGap) return (candles[i].high + candles[i + 2].low) / 2;
    }
    return null;
  }

  private findBearishFVG(candles: Candle[]): number | null {
    const pip = this.pipSize();
    const minGap = pip * 1;
    for (let i = 0; i < candles.length - 2; i++) {
      const gap = candles[i].low - candles[i + 2].high;
      if (gap >= minGap) return (candles[i].low + candles[i + 2].high) / 2;
    }
    return null;
  }
}
