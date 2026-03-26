"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FractalAnalyzer = void 0;
class FractalAnalyzer {
    constructor(symbol, daily, h4, h1, m15) {
        this.symbol = symbol;
        this.daily = daily;
        this.h4 = h4;
        this.h1 = h1;
        this.m15 = m15;
    }
    analyze() {
        // Step 1: Daily Bias
        const dailyBias = this.getDailyBias();
        if (!dailyBias)
            return null;
        // Step 2: 4H Trend Structure (HH+HL or LH+LL)
        const h4Confirm = this.getH4Confirmation(dailyBias);
        if (!h4Confirm)
            return null;
        // Step 3: H1 Context (price above/below H1 swing in direction of bias)
        const h1Context = this.getH1Context(dailyBias);
        if (!h1Context)
            return null;
        // Step 4: M15 Entry (Protected Swing + FVG + 2 confirming candles)
        const m15Setup = this.getM15Setup(dailyBias, h4Confirm.level);
        if (!m15Setup)
            return null;
        // Step 5: 2 consecutive M15 candles confirming direction
        if (!this.confirmM15Direction(dailyBias))
            return null;
        return this.buildSignal(dailyBias, h4Confirm, h1Context, m15Setup);
    }
    // JPY pairs have 2 decimal places, others have 5
    pipSize() {
        return this.symbol.includes('JPY') ? 0.01 : 0.0001;
    }
    decimals() {
        return this.symbol.includes('JPY') ? 3 : 5;
    }
    // STEP 1: Daily Bias
    getDailyBias() {
        const candles = this.daily;
        if (candles.length < 5)
            return null;
        const last = candles[candles.length - 1];
        const pip = this.pipSize();
        const swingLow = this.detectSwingLow(candles, candles.length - 3);
        if (swingLow) {
            const c3 = candles[candles.length - 2];
            const c3Body = c3.close - c3.open;
            const c3Range = c3.high - c3.low;
            if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5)
                return 'LONG';
        }
        const swingHigh = this.detectSwingHigh(candles, candles.length - 3);
        if (swingHigh) {
            const c3 = candles[candles.length - 2];
            const c3Body = c3.open - c3.close;
            const c3Range = c3.high - c3.low;
            if (c3Body > 0 && c3Range > 0 && c3Body / c3Range > 0.5)
                return 'SHORT';
        }
        // Mean reversion: extended move >200 pips in 6 days
        const recentHigh = Math.max(...candles.slice(-6).map(c => c.high));
        const pipDrop = (recentHigh - last.close) / pip;
        if (pipDrop > 200 && last.close > last.open)
            return 'LONG';
        const recentLow = Math.min(...candles.slice(-6).map(c => c.low));
        const pipRise = (last.close - recentLow) / pip;
        if (pipRise > 200 && last.close < last.open)
            return 'SHORT';
        return null;
    }
    // STEP 2: 4H Trend Structure (HH+HL for LONG, LH+LL for SHORT)
    getH4Confirmation(bias) {
        const candles = this.h4;
        if (candles.length < 10)
            return null;
        const dec = this.decimals();
        const swingHighs = [];
        const swingLows = [];
        for (let i = 1; i < candles.length - 1; i++) {
            if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high)
                swingHighs.push(candles[i].high);
            if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low)
                swingLows.push(candles[i].low);
        }
        if (swingHighs.length < 2 || swingLows.length < 2)
            return null;
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
    // LONG: current price must be above the last H1 swing low (bullish context)
    // SHORT: current price must be below the last H1 swing high (bearish context)
    getH1Context(bias) {
        const candles = this.h1;
        if (candles.length < 10)
            return null;
        const dec = this.decimals();
        const currentPrice = candles[candles.length - 1].close;
        const swingHighs = [];
        const swingLows = [];
        for (let i = 1; i < candles.length - 1; i++) {
            if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i + 1].high)
                swingHighs.push(candles[i].high);
            if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i + 1].low)
                swingLows.push(candles[i].low);
        }
        if (bias === 'LONG' && swingLows.length > 0) {
            const lastH1SwingLow = swingLows[swingLows.length - 1];
            // Price must be above H1 swing low — confirms bullish H1 context
            if (currentPrice > lastH1SwingLow) {
                return {
                    level: lastH1SwingLow,
                    description: `H1 Bullish context: price ${currentPrice.toFixed(dec)} above H1 swing low ${lastH1SwingLow.toFixed(dec)}`,
                };
            }
        }
        if (bias === 'SHORT' && swingHighs.length > 0) {
            const lastH1SwingHigh = swingHighs[swingHighs.length - 1];
            // Price must be below H1 swing high — confirms bearish H1 context
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
    getM15Setup(bias, h4Level) {
        const candles = this.m15;
        if (candles.length < 10)
            return null;
        const dec = this.decimals();
        const pip = this.pipSize();
        const last5 = candles.slice(-5);
        if (bias === 'LONG') {
            const swingLow = Math.min(...last5.map(c => c.low));
            const fvg = this.findBullishFVG(candles.slice(-10));
            const exhaustion = this.detectExhaustion(candles.slice(-5), 'BULL');
            const entryLow = fvg ?? swingLow;
            const entryHigh = entryLow + pip * 1.5;
            const lastCandle = candles[candles.length - 1];
            if (lastCandle.close > swingLow && lastCandle.close > lastCandle.open) {
                return {
                    protectedSwing: swingLow,
                    fvg,
                    entryZone: [entryLow, entryHigh],
                    description: `M15 Protected Swing Low @ ${swingLow.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustion ? ' | Exhaustion ✅' : ''}`,
                };
            }
        }
        if (bias === 'SHORT') {
            const swingHigh = Math.max(...last5.map(c => c.high));
            const fvg = this.findBearishFVG(candles.slice(-10));
            const exhaustion = this.detectExhaustion(candles.slice(-5), 'BEAR');
            const entryHigh = fvg ?? swingHigh;
            const entryLow = entryHigh - pip * 1.5;
            const lastCandle = candles[candles.length - 1];
            if (lastCandle.close < swingHigh && lastCandle.close < lastCandle.open) {
                return {
                    protectedSwing: swingHigh,
                    fvg,
                    entryZone: [entryLow, entryHigh],
                    description: `M15 Protected Swing High @ ${swingHigh.toFixed(dec)}${fvg ? ` | FVG @ ${fvg.toFixed(dec)}` : ''}${exhaustion ? ' | Exhaustion ✅' : ''}`,
                };
            }
        }
        return null;
    }
    // STEP 5: 2 consecutive M15 candles confirming direction
    confirmM15Direction(bias) {
        const candles = this.m15;
        if (candles.length < 3)
            return false;
        const c1 = candles[candles.length - 3];
        const c2 = candles[candles.length - 2];
        if (bias === 'LONG')
            return c1.close > c1.open && c2.close > c2.open;
        if (bias === 'SHORT')
            return c1.close < c1.open && c2.close < c2.open;
        return false;
    }
    // Signal Builder
    buildSignal(bias, h4, h1, m15) {
        const currentPrice = this.m15[this.m15.length - 1].close;
        const [entryLow, entryHigh] = m15.entryZone;
        const entryMid = (entryLow + entryHigh) / 2;
        const pip = this.pipSize();
        let stopLoss, target1, target2;
        if (bias === 'LONG') {
            stopLoss = m15.protectedSwing - pip * 5;
            if (stopLoss >= entryMid)
                stopLoss = entryMid - pip * 10;
            const risk = Math.abs(entryMid - stopLoss);
            target1 = entryMid + risk * 2;
            target2 = entryMid + risk * 4;
        }
        else {
            stopLoss = m15.protectedSwing + pip * 5;
            if (stopLoss <= entryMid)
                stopLoss = entryMid + pip * 10;
            const risk = Math.abs(stopLoss - entryMid);
            target1 = entryMid - risk * 2;
            target2 = entryMid - risk * 4;
        }
        const risk = Math.abs(entryMid - stopLoss);
        // Minimum stop: 8 pips JPY, 5 pips others
        const minRisk = this.symbol.includes('JPY') ? pip * 8 : pip * 5;
        if (risk < minRisk)
            return null;
        // TP must be at least 20 pips from nearest D1 High/Low
        const d1Highs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
        const d1Lows = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
        const minTPBuffer = pip * 20;
        if (bias === 'LONG' && Math.abs(target1 - d1Highs[0]) < minTPBuffer)
            return null;
        if (bias === 'SHORT' && Math.abs(target1 - d1Lows[0]) < minTPBuffer)
            return null;
        const reward = Math.abs(target1 - entryMid);
        const riskReward = risk > 0 ? reward / risk : 0;
        const recentHighs = this.daily.slice(-10).map(c => c.high).sort((a, b) => b - a);
        const recentLows = this.daily.slice(-10).map(c => c.low).sort((a, b) => a - b);
        const keyLevels = [
            { label: 'Recent D1 High', price: recentHighs[0] },
            { label: 'Recent D1 Low', price: recentLows[0] },
            { label: '4H Level', price: h4.level },
            { label: 'H1 Context Level', price: h1.level },
            { label: 'M15 Swing', price: m15.protectedSwing },
        ];
        const dailyLast = this.daily[this.daily.length - 1];
        const dailyC3Body = Math.abs(dailyLast.close - dailyLast.open);
        const dailyC3Range = dailyLast.high - dailyLast.low;
        const phase = dailyC3Range > 0 && dailyC3Body / dailyC3Range > 0.6 ? 'C4_RETEST' : 'C3_ENTRY';
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
        };
    }
    detectExhaustion(candles, bias) {
        if (candles.length < 2)
            return false;
        const last3 = candles.slice(-3);
        let rejectionCount = 0;
        for (const c of last3) {
            const range = c.high - c.low;
            if (range === 0)
                continue;
            const body = Math.abs(c.close - c.open);
            const upperWick = c.high - Math.max(c.open, c.close);
            const lowerWick = Math.min(c.open, c.close) - c.low;
            if (bias === 'BEAR' && upperWick / range > 0.55 && body / range < 0.30)
                rejectionCount++;
            if (bias === 'BULL' && lowerWick / range > 0.55 && body / range < 0.30)
                rejectionCount++;
        }
        return rejectionCount >= 2;
    }
    detectSwingLow(candles, idx) {
        if (idx < 1 || idx >= candles.length - 1)
            return false;
        return candles[idx].low < candles[idx - 1].low && candles[idx].low < candles[idx + 1].low;
    }
    detectSwingHigh(candles, idx) {
        if (idx < 1 || idx >= candles.length - 1)
            return false;
        return candles[idx].high > candles[idx - 1].high && candles[idx].high > candles[idx + 1].high;
    }
    findBullishFVG(candles) {
        const pip = this.pipSize();
        const minGap = pip * 1; // 1 pip minimum for M15 FVGs
        for (let i = 0; i < candles.length - 2; i++) {
            const gap = candles[i + 2].low - candles[i].high;
            if (gap >= minGap)
                return (candles[i].high + candles[i + 2].low) / 2;
        }
        return null;
    }
    findBearishFVG(candles) {
        const pip = this.pipSize();
        const minGap = pip * 1;
        for (let i = 0; i < candles.length - 2; i++) {
            const gap = candles[i].low - candles[i + 2].high;
            if (gap >= minGap)
                return (candles[i].low + candles[i + 2].high) / 2;
        }
        return null;
    }
}
exports.FractalAnalyzer = FractalAnalyzer;
