export type Candle = {
  high: number;
  low: number;
  close: number;
};

export class ATR {
  private period: number;
  private trQueue: number[] = [];
  private atr: number | null = null;
  private prevClose: number | null = null;

  constructor(period: number = 14) {
    this.period = period;
  }

  /**
   * Update ATR with a new candle
   * Returns current ATR value or null if not enough data yet
   */
  update(candle: Candle): number | null {
    if (this.prevClose === null) {
      this.prevClose = candle.close;
      return null;
    }

    const highLow = candle.high - candle.low;
    const highClose = Math.abs(candle.high - this.prevClose);
    const lowClose = Math.abs(candle.low - this.prevClose);

    const tr = Math.max(highLow, highClose, lowClose);

    this.prevClose = candle.close;

    // Build initial ATR
    if (this.atr === null) {
      this.trQueue.push(tr);

      if (this.trQueue.length < this.period) {
        return null;
      }

      const sum = this.trQueue.reduce((a, b) => a + b, 0);
      this.atr = sum / this.period;
      return this.atr;
    }

    // Wilder smoothing
    this.atr = ((this.atr * (this.period - 1)) + tr) / this.period;
    return this.atr;
  }

  /**
   * Get current ATR without updating
   */
  getValue(): number | null {
    return this.atr;
  }

  /**
   * Reset internal state
   */
  reset(): void {
    this.trQueue = [];
    this.atr = null;
    this.prevClose = null;
  }
}