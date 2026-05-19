/**
 * fractalAnalyzer.ts — v2.4
 *
 * Backtestvalidierte Strategie (957% über 10 Jahre, 72% Win-Rate):
 *
 * D1  → Trend: 2× HH+HL = LONG, 2× LH+LL = SHORT
 *         Swing-Lookback: n=2 (2 Kerzen links/rechts)
 * M15 → Entry: Market Structure Shift (MSS)
 *         Swing-Lookback: n=6 (6 Kerzen links/rechts)
 *
 * Kein H4, kein H1, keine Order Blocks, keine Zonen.
 * SL: unter/über der MSS-Kerze + 2 Pips Buffer
 * TP: Entry + Risk × 1.3
 */

import { Candle } from './mt5Api';
import { ATR } from './atr14';
import { logger } from './logger';

export type SignalType = 'LONG' | 'SHORT';
export type SetupPhase = 'C3_ENTRY' | 'C4_RETEST';

export interface AnalyzeResult {
  signal: TradeSignal | null;
  rejected: boolean;
  reason: string | null;
}

export interface TradeSignal {
  symbol:         string;
  type:           SignalType;
  phase:          SetupPhase;
  currentPrice:   number;
  entryZone:      [number, number];
  stopLoss:       number;
  target1:        number;
  target2:        number;
  riskReward:     number;
  dailyBias:      SignalType;
  dailyCandle:    string;
  h4Confirmation: string;
  h1Context:      string;
  m15Setup:       string;
  protectedSwing: number;
  fvgLevel:       number | null;
  timestamp:      string;
  keyLevels:      { label: string; price: number }[];
  atr14?:         number;
}

export class FractalAnalyzer {
  constructor(
    private symbol: string,
    private daily:  Candle[],
    private h4:     Candle[],  // nicht genutzt in v2.4
    private h1:     Candle[],  // nicht genutzt in v2.4
    private m15:    Candle[]
  ) {}

  private _lastRejectionReason: string | null = null;
  private pip(): number { return this.symbol.includes('JPY') ? 0.01 : this.symbol === 'BTCUSD' ? 1.0 : 0.0001; }
  private dec(): number { return this.symbol.includes('JPY') ? 3 : this.symbol === 'BTCUSD' ? 2 : 5; }

  analyze(): AnalyzeResult {
    const bias = this.getDailyBias();
    if (!bias) return { signal: null, rejected: false, reason: null };

    const mss = this.getM15MSS(bias);
    if (!mss) return { signal: null, rejected: false, reason: null };

    const signal = this.buildSignal(bias, mss);
    if (!signal) {
      logger.scan(`${this.symbol}: REJECTED — ${this._lastRejectionReason}`);
      return { signal: null, rejected: true, reason: this._lastRejectionReason ?? 'Filter rejected' };
    }

    logger.setup(
      `${this.symbol}: ${bias} Setup (v2.4)\n` +
      `  D1: ${bias === 'LONG' ? '2×HH+HL Aufwärtstrend' : '2×LH+LL Abwärtstrend'}\n` +
      `  ${mss.description}\n` +
      `  Entry: ${signal.entryZone[0].toFixed(this.dec())}–${signal.entryZone[1].toFixed(this.dec())} | SL: ${signal.stopLoss.toFixed(this.dec())} | TP: ${signal.target1.toFixed(this.dec())} | RR: 1.3:1`
    );

    return { signal, rejected: false, reason: null };
  }

  // ─── STEP 1: D1 Trend ─────────────────────────────────────────────────────────
  // Lookback n=2: Swing High braucht 2 höhere Kerzen links UND rechts
  // 2× HH+HL = LONG, 2× LH+LL = SHORT
  private getDailyBias(): SignalType | null {
    const c = this.daily;
    if (c.length < 12) return null;

    const N = 2;
    const swingHighs: number[] = [];
    const swingLows:  number[] = [];

    for (let i = N; i < c.length - N; i++) {
      const isSwingHigh = c.slice(i - N, i).every(x => x.high < c[i].high) &&
                          c.slice(i + 1, i + N + 1).every(x => x.high < c[i].high);
      const isSwingLow  = c.slice(i - N, i).every(x => x.low > c[i].low) &&
                          c.slice(i + 1, i + N + 1).every(x => x.low > c[i].low);
      if (isSwingHigh) swingHighs.push(c[i].high);
      if (isSwingLow)  swingLows.push(c[i].low);
    }

    if (swingHighs.length < 3 || swingLows.length < 3) {
      logger.scan(`${this.symbol}: zu wenige D1 Swings (H:${swingHighs.length} L:${swingLows.length})`);
      return null;
    }

    // Letzte 3 Swings müssen 2× aufsteigend (LONG) oder 2× absteigend (SHORT) sein
    const [sh1, sh2, sh3] = swingHighs.slice(-3);
    const [sl1, sl2, sl3] = swingLows.slice(-3);

    const isUptrend   = sh3 > sh2 && sh2 > sh1 && sl3 > sl2 && sl2 > sl1;
    const isDowntrend = sh3 < sh2 && sh2 < sh1 && sl3 < sl2 && sl2 < sl1;

    if (isUptrend && !isDowntrend)   return 'LONG';
    if (isDowntrend && !isUptrend)   return 'SHORT';

    logger.scan(`${this.symbol}: D1 kein klarer Trend`);
    return null;
  }

  // ─── STEP 2: M15 Market Structure Shift ───────────────────────────────────────
  // Lookback n=6: Swing braucht 6 Kerzen links UND rechts
  // MSS LONG:  letzte Kerze schließt ÜBER letztem M15 Swing High (vorherige war darunter)
  // MSS SHORT: letzte Kerze schließt UNTER letztem M15 Swing Low (vorherige war darüber)
  private getM15MSS(bias: SignalType): {
    entryPrice:  number;
    swingLevel:  number;
    mssCandle:   Candle;
    description: string;
  } | null {
    const c = this.m15;
    if (c.length < 20) return null;

    const N = 6;
    const swingHighs: { price: number; idx: number }[] = [];
    const swingLows:  { price: number; idx: number }[] = [];

    // Swing Points bestimmen (bis length-N damit rechte Seite vollständig)
    for (let i = N; i < c.length - N; i++) {
      const isSwingHigh = c.slice(i - N, i).every(x => x.high < c[i].high) &&
                          c.slice(i + 1, i + N + 1).every(x => x.high < c[i].high);
      const isSwingLow  = c.slice(i - N, i).every(x => x.low > c[i].low) &&
                          c.slice(i + 1, i + N + 1).every(x => x.low > c[i].low);
      if (isSwingHigh) swingHighs.push({ price: c[i].high, idx: i });
      if (isSwingLow)  swingLows.push({ price: c[i].low,  idx: i });
    }

    const last = c[c.length - 1];
    const prev = c[c.length - 2];

    // Mindestdistanz für MSS-Breakout: 2 Pips (kein Rauschen / Spread-Breakout)
    const MSS_MIN_PIPS = 2;

    if (bias === 'LONG' && swingHighs.length > 0) {
      const lastSH = swingHighs[swingHighs.length - 1];
      const breakoutDist = (last.close - lastSH.price) / this.pip();
      // MSS: vorherige Kerze unter Swing High, aktuelle Kerze schließt darüber
      if (prev.close < lastSH.price && last.close > lastSH.price) {
        if (breakoutDist < MSS_MIN_PIPS) {
          logger.scan(`${this.symbol}: D1=LONG | MSS-Breakout zu klein (${breakoutDist.toFixed(1)} pips < ${MSS_MIN_PIPS}) — ignoriert`);
          return null;
        }
        return {
          entryPrice:  last.close,
          swingLevel:  lastSH.price,
          mssCandle:   last,
          description: `M15 MSS LONG: Close ${last.close.toFixed(this.dec())} > Swing High ${lastSH.price.toFixed(this.dec())} (+${breakoutDist.toFixed(1)}p)`,
        };
      }
      logger.scan(`${this.symbol}: D1=LONG | M15 kein MSS (SH=${lastSH.price.toFixed(this.dec())} close=${last.close.toFixed(this.dec())})`);
    }

    if (bias === 'SHORT' && swingLows.length > 0) {
      const lastSL = swingLows[swingLows.length - 1];
      const breakoutDist = (lastSL.price - last.close) / this.pip();
      // MSS: vorherige Kerze über Swing Low, aktuelle Kerze schließt darunter
      if (prev.close > lastSL.price && last.close < lastSL.price) {
        if (breakoutDist < MSS_MIN_PIPS) {
          logger.scan(`${this.symbol}: D1=SHORT | MSS-Breakout zu klein (${breakoutDist.toFixed(1)} pips < ${MSS_MIN_PIPS}) — ignoriert`);
          return null;
        }
        return {
          entryPrice:  last.close,
          swingLevel:  lastSL.price,
          mssCandle:   last,
          description: `M15 MSS SHORT: Close ${last.close.toFixed(this.dec())} < Swing Low ${lastSL.price.toFixed(this.dec())} (-${breakoutDist.toFixed(1)}p)`,
        };
      }
      logger.scan(`${this.symbol}: D1=SHORT | M15 kein MSS (SL=${lastSL.price.toFixed(this.dec())} close=${last.close.toFixed(this.dec())})`);
    }

    return null;
  }

  // ─── Signal Builder ───────────────────────────────────────────────────────────
  private buildSignal(
    bias: SignalType,
    mss:  { entryPrice: number; swingLevel: number; mssCandle: Candle; description: string }
  ): TradeSignal | null {
    const pip = this.pip();
    const RR  = 1.3;

    const entryPrice = mss.entryPrice;

    // SL: Low der MSS-Kerze - 2 Pips (LONG) oder High + 2 Pips (SHORT)
    let stopLoss: number;
    if (bias === 'LONG') {
      stopLoss = parseFloat((mss.mssCandle.low - pip * 2).toFixed(this.dec()));
      if (stopLoss >= entryPrice) {
        this._lastRejectionReason = `SL >= Entry`;
        return null;
      }
    } else {
      stopLoss = parseFloat((mss.mssCandle.high + pip * 2).toFixed(this.dec()));
      if (stopLoss <= entryPrice) {
        this._lastRejectionReason = `SL <= Entry`;
        return null;
      }
    }

    const risk = Math.abs(entryPrice - stopLoss);

    // Min Stop: 8 Pips (JPY: 10 Pips, BTC: 50 Pips)
    // Erhöht von 5 auf 8: Trades <6 Pips hatten 0% WR (zu anfällig für Spread/Rauschen)
    const minRisk = pip * (this.symbol.includes('JPY') ? 10 : this.symbol === 'BTCUSD' ? 50 : 8);
    if (risk < minRisk - pip * 0.5) { // 0.5 pip Toleranz für Floating-Point
      this._lastRejectionReason = `Stop zu klein: ${(risk / pip).toFixed(1)} < ${minRisk / pip} pips`;
      return null;
    }

    // Max Stop: D1 ATR14 × 0.75
    const atrCalc = new ATR(14);
    for (const c of this.daily) atrCalc.update(c);
    const atrValue = atrCalc.getValue();
    if (atrValue !== null) {
      const maxRisk = atrValue * 0.75;
      if (risk > maxRisk) {
        this._lastRejectionReason = `Stop zu weit: ${(risk / pip).toFixed(1)} > ${(maxRisk / pip).toFixed(1)} pips (ATR×0.75)`;
        return null;
      }
    }

    // TP 1.3:1
    const target1 = bias === 'LONG'
      ? parseFloat((entryPrice + risk * RR).toFixed(this.dec()))
      : parseFloat((entryPrice - risk * RR).toFixed(this.dec()));
    const target2 = bias === 'LONG'
      ? parseFloat((entryPrice + risk * RR * 2).toFixed(this.dec()))
      : parseFloat((entryPrice - risk * RR * 2).toFixed(this.dec()));

    // TP nicht zu nah an D1 Extreme (15 Pips)
    const d1Highs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
    const d1Lows  = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
    if (bias === 'LONG'  && Math.abs(target1 - d1Highs[0]) < pip * 15) {
      this._lastRejectionReason = `TP zu nah an D1 High ${d1Highs[0].toFixed(this.dec())}`;
      return null;
    }
    if (bias === 'SHORT' && Math.abs(target1 - d1Lows[0])  < pip * 15) {
      this._lastRejectionReason = `TP zu nah an D1 Low ${d1Lows[0].toFixed(this.dec())}`;
      return null;
    }

    const riskReward = Math.round((Math.abs(target1 - entryPrice) / risk) * 100) / 100;
    const atr14Pips  = atrValue !== null ? Math.round(atrValue / pip) : undefined;

    return {
      symbol:         this.symbol,
      type:           bias,
      phase:          'C3_ENTRY',
      currentPrice:   entryPrice,
      entryZone:      [
        parseFloat((entryPrice - pip * 2).toFixed(this.dec())),
        parseFloat((entryPrice + pip * 2).toFixed(this.dec())),
      ],
      stopLoss,
      target1,
      target2,
      riskReward,
      dailyBias:      bias,
      dailyCandle:    `D1 ${bias === 'LONG' ? '2×HH+HL' : '2×LH+LL'}`,
      h4Confirmation: 'n/a (v2.4)',
      h1Context:      'n/a (v2.4)',
      m15Setup:       mss.description,
      protectedSwing: mss.swingLevel,
      fvgLevel:       null,
      timestamp:      new Date().toISOString(),
      atr14:          atr14Pips,
      keyLevels: [
        { label: 'D1 High',      price: d1Highs[0] },
        { label: 'D1 Low',       price: d1Lows[0] },
        { label: 'M15 MSS',      price: mss.swingLevel },
        { label: 'MSS Candle L', price: mss.mssCandle.low },
        { label: 'MSS Candle H', price: mss.mssCandle.high },
      ],
    };
  }
}
