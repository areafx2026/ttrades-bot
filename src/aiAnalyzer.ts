import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { TradeRecord, loadTrades } from './tradeLogger';
import { logger } from './logger';

function formatTrade(t: TradeRecord): string {
  const entry = ((t.entryZone[0] + t.entryZone[1]) / 2).toFixed(5);
  const duration = t.closedAt
    ? Math.round((new Date(t.closedAt).getTime() - new Date(t.openedAt).getTime()) / 60000)
    : null;
  return `
Symbol: ${t.symbol}
Richtung: ${t.type}
Phase: ${t.phase}
Entry: ${entry}
Stop Loss: ${t.stopLoss}
Target 1: ${t.target1}
Eröffnet: ${new Date(t.openedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}
Geschlossen: ${t.closedAt ? new Date(t.closedAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : 'noch offen'}
${t.closePrice ? `Close Preis: ${t.closePrice}` : ''}
${t.pnlPips !== undefined ? `P&L: ${t.pnlPips > 0 ? '+' : ''}${t.pnlPips} Pips / ${t.pnlEUR && t.pnlEUR > 0 ? '+' : ''}€${t.pnlEUR?.toFixed(2)}` : ''}
Ergebnis: ${t.result ?? 'offen'}
${duration ? `Haltedauer: ${duration} Minuten` : ''}
R:R geplant: ${t.riskReward.toFixed(1)}:1
`.trim();
}

function loadCurrentRules(): string {
  const filePath = path.join(process.cwd(), 'rules.txt');
  if (!fs.existsSync(filePath)) return '(keine rules.txt gefunden)';
  return fs.readFileSync(filePath, 'utf-8');
}

function appendRuleComment(comment: string): void {
  const filePath = path.join(process.cwd(), 'rules.txt');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + comment + '\n', 'utf-8');
  logger.info('KI-Regelvorschlag in rules.txt geschrieben');
}

export async function analyzeTradesWithAI(): Promise<string | null> {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentTrades = loadTrades().filter(t =>
    t.closedAt && new Date(t.closedAt) >= windowStart
  );

  if (recentTrades.length === 0) {
    logger.info('AI analysis: no closed trades in last 24h, skipping.');
    return null;
  }

  const currentRules = loadCurrentRules();
  const today = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });

  const tradeDetails = recentTrades.map((t, i) =>
    `--- Trade ${i + 1} ---\n${formatTrade(t)}`
  ).join('\n\n');

  const prompt = `Du analysierst die Trades eines vollautomatischen Forex-Trading-Bots (TTrades Fractal Model / TTFM).
Es gibt keinen menschlichen Trader - alle Trades werden algorithmisch ausgefuehrt.

## TATSAECHLICH IMPLEMENTIERTE FILTER (nur diese existieren):
1. Session-Filter: Nur London Open 08:30-10:30 MEZ und NY Open 14:30-16:30 MEZ
2. Currency Strength: Top2 stark vs Bottom2 schwach
3. Entry Distance: Max 15 Pips vom aktuellen Preis
4. TP/D1 Distance: TP mind. 20 Pips von D1 High/Low entfernt
5. Mindest-Stop: 8 Pips JPY, 5 Pips andere Pairs
6. Max Size: 5000 Points hard cap
7. Max Trades: 3 gleichzeitig
8. Cooldown: 8h nach Trade pro Pair
9. S/R Zonen: Rebound oder Block je nach Zonenkontext
10. 4H Trend: HH+HL bullish, LH+LL bearish
11. H1 Kontext: Preis ueber/unter H1 Swing
12. M15 Entry: Protected Swing + FVG + 2 bestaetigende Kerzen
13. Weekend Block: Fr 18:00 - Mo 08:00 MEZ
14. NYSE Buffer: +-15 Min um 15:30 MEZ

## NICHT IMPLEMENTIERT - Kommentare in rules.txt sind KEINE aktiven Filter:
- Mindest-Haltezeit jeglicher Art
- Hardware-Level Locks
- Automatische Bot-Deaktivierung
- Trade-Pause nach Breakeven

## Wichtige Hinweise:
- Kurze Haltezeiten unter 1 Minute entstehen weil Capital.com die Position sofort schliesst
  Moegliche Gruende: SL/TP zu nah am aktuellen Preis, Margin-Problem, oder Spread
  Das ist ein Entry-Validierungs-Problem, kein Haltezeit-Bug
- Breakeven mit 0 Pips bedeutet Capital.com hat Position sofort geschlossen, nicht der Bot
- Erfinde KEINE Filter die nicht in der Liste oben stehen

## Heutige Trades:
${tradeDetails}

## Aktuelles Regelwerk - Kommentare mit // sind NICHT aktiv:
${currentRules}

## Deine Aufgabe:
1. **Signal-Qualitaet**: War D1 Bias, 4H Trend, H1 Kontext und M15 Entry aligned?
2. **Filter-Check**: Welche der 14 Filter haben gegriffen? Bei sofortigem Close: welcher Entry-Validierungs-Filter fehlte?
3. **Stop**: War der Stop sinnvoll fuer das Pair?
4. **Size**: War die Positionsgroesse max 5000 Points?
5. **Ergebnis**: Bei Loss - welcher konkrete Code-Fix wuerde helfen?

Code-Vorschlag nur wenn konkret:
// KI-Vorschlag [${today}]: [spezifischer Filter] - wegen [konkretem Problem]

Maximal 400 Woerter. Keine Panik-Empfehlungen.`;

  try {
    logger.info('Sending trades to Claude for analysis...');

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
      }
    );

    const blocks = response.data.content as Array<{ type: string; text?: string }>;
    const analysis = blocks
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('');

    // Extract rule suggestions and append to rules.txt as comments
    const ruleMatches = analysis.match(/\/\/ KI-Vorschlag[^\n]+/g);
    if (ruleMatches) {
      for (const rule of ruleMatches) {
        appendRuleComment(rule);
      }
      logger.info(`${ruleMatches.length} Regelvorschlag/Vorschläge in rules.txt eingetragen`);
    }

    return analysis;
  } catch (err: any) {
    logger.error('AI analysis error:', err.response?.data || err.message);
    return null;
  }
}
