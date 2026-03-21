import axios from 'axios';
import { TradeSignal } from './fractalAnalyzer';
import { logger } from './logger';

export class TelegramNotifier {
  private baseUrl: string;

  constructor(private botToken: string, private chatId: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendSignal(signal: TradeSignal): Promise<void> {
    const msg = this.formatMessage(signal);
    await this.sendMessage(msg);
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
      });
      logger.info('Telegram message sent');
    } catch (err) {
      logger.error('Telegram send error:', err);
    }
  }

  private pipSize(symbol: string): number {
    return symbol.includes('JPY') ? 0.01 : 0.0001;
  }

  private decimals(symbol: string): number {
    return symbol.includes('JPY') ? 3 : 5;
  }

  private toPips(symbol: string, diff: number): string {
    return (Math.abs(diff) / this.pipSize(symbol)).toFixed(1);
  }

  private formatMessage(s: TradeSignal): string {
    const dir = s.type === 'LONG' ? 'LONG' : 'SHORT';
    const emoji = s.type === 'LONG' ? 'GREEN' : 'RED';
    const emojiChar = s.type === 'LONG' ? '🟢' : '🔴';
    const dirEmoji = s.type === 'LONG' ? '📈' : '📉';
    const phaseLabel = s.phase === 'C3_ENTRY' ? 'C3 Expansion Entry' : 'C4 Retest Entry';
    const dec = this.decimals(s.symbol);

    const entryMid = (s.entryZone[0] + s.entryZone[1]) / 2;
    const pipRisk = this.toPips(s.symbol, entryMid - s.stopLoss);
    const pipT1   = this.toPips(s.symbol, s.target1 - entryMid);
    const pipT2   = this.toPips(s.symbol, s.target2 - entryMid);

    const keyLvls = s.keyLevels
      .map(k => `  - ${k.label}: <code>${k.price.toFixed(dec)}</code>`)
      .join('\n');

    return `
${emojiChar} <b>TTFM Signal - ${s.symbol}</b>
${dirEmoji} ${dir} | ${phaseLabel}
--------------------

<b>Daily Context</b>
${s.dailyCandle}

<b>4H Confirmation</b>
${s.h4Confirmation}

<b>H1 Setup</b>
${s.m15Setup}

--------------------
<b>Trade Levels</b>
Current:      <code>${s.currentPrice.toFixed(dec)}</code>
Entry Zone:   <code>${s.entryZone[0].toFixed(dec)} - ${s.entryZone[1].toFixed(dec)}</code>
Stop Loss:    <code>${s.stopLoss.toFixed(dec)}</code>  (-${pipRisk} pips)
Target 1:     <code>${s.target1.toFixed(dec)}</code>  (+${pipT1} pips)
Target 2:     <code>${s.target2.toFixed(dec)}</code>  (+${pipT2} pips)
R:R           <b>${s.riskReward.toFixed(1)}:1</b>

<b>Key Levels</b>
${keyLvls}

<b>Invalidation</b>
Close beyond: <code>${s.protectedSwing.toFixed(dec)}</code>
${s.fvgLevel ? `\n<b>FVG Level</b>\n<code>${s.fvgLevel.toFixed(dec)}</code>` : ''}
--------------------
<i>${new Date(s.timestamp).toUTCString()}</i>
`.trim();
  }
}
