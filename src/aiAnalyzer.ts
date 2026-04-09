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

## STRATEGIE v1.3 (Stand April 2026)
Timeframe-Hierarchie: D1 Bias -> 4H Trend -> H1 Kontext -> M15 Entry
D1 Bias: LONG wenn Swing Low + bullische C3-Kerze (Body >50%) + D1 Trend bullisch (HH+HL in letzten 6 Kerzen) + HP-Filter-Trend nicht BEARISH. SHORT analog mit LH+LL + HP-Filter nicht BULLISH.
HP-Filter: Hodrick-Prescott-Glaettung der D1 Closes filtert Noise. Doppelpass-Exponentialglaettung mit lambda=1600.
Mean Reversion: Relativer z-Score cross-pair statt fester Pips. z = (Ri - Rm) / sigma_i. |z| > 1.5 blockiert Trade in ueberextendierter Richtung. Extremfall-Fallback bei >300 Pips.
4H: HH+HL fuer LONG, LH+LL fuer SHORT.
H1: Preis ueber letztem H1 Swing Low (LONG) / unter H1 Swing High (SHORT).
M15 Entry: Protected Swing + FVG + 2 bestaetigende Kerzen.
Stop Loss: H1 Swing Low/High (letzte 20 Kerzen) +/- 5 Pips.
R:R: Immer 1:1.5 basierend auf echtem Fill-Preis.
Position Sizing: ATR(14)-normiert. Referenz-ATR 80 Pips, Faktor 0.3-2.0. Volatile Pairs (GBP/JPY) = kleinere Size. Ruhige Pairs (EUR/CHF) = groessere Size.

## IMPLEMENTIERTE FILTER (nur diese - keine anderen erfinden):
1. Session-Filter: KEINE neuen Trades WAEHREND London Open (08:30-10:30 MEZ) und NY Open (14:30-16:30 MEZ). Trades AUSSERHALB dieser Zeiten (z.B. 03:00, 22:00) sind KORREKT und ERWARTET.
2. Currency Exposure: Max 2 offene Trades pro Waehrung
3. Spread-Filter: Kein Trade wenn Spread > 2x Normalwert (spreads.json)
4. Currency Strength: Top2 stark vs Bottom2 schwach
5. Entry Distance: Max 15 Pips vom aktuellen Preis
6. TP/D1 Distance: TP mind. 20 Pips von D1 High/Low entfernt
7. Mindest-Stop: 8 Pips JPY, 5 Pips andere Pairs
8. Position Size: ATR(14)-normiert, Basis ~EUR 100 pro Trade, Max 10.000 Points. ATR-Referenz 80 Pips, Faktor 0.3-2.0.
9. Max Trades: 3 gleichzeitig
10. Cooldown: 8h nach Trade pro Pair
11. S/R Zonen: aus zones.json
12. D1 Trend: HH+HL fuer LONG, LH+LL fuer SHORT
13. Weekend Block: Fr 18:00 - Mo 08:00 MEZ
14. NYSE Buffer: +/-15 Min um 15:30 MEZ
15. HP-Filter: D1 Close-Glaettung, blockiert LONG wenn HP-Trend BEARISH, SHORT wenn BULLISH
16. Mean-Reversion z-Score: Cross-pair relativ, |z| > 1.5 blockiert Trade in ueberextendierter Richtung

## WICHTIGE HINWEISE:
- Trades um 03:00, 22:00 oder andere Nachtzeiten sind VOELLIG NORMAL - Session-Filter blockiert nur Trade-Eroeffnung WAEHREND der Opens
- Position-Tracking (MAE/MFE) laeuft 24/5 unabhaengig von Sessions
- Breakeven/0 Pips = Capital.com hat Position unerwartet geschlossen, nicht der Bot
- Keine Filter erfinden die nicht in der Liste stehen

## Heutige Trades:
${tradeDetails}

## Aktuelles Regelwerk (// Kommentare sind NICHT aktiv):
${currentRules}

## Deine Aufgabe:
1. **Signal**: War D1 Bias, 4H, H1, M15 korrekt aligned?
2. **Filter**: Welche haben gegriffen oder haetten greifen sollen?
3. **Stop**: War H1-basierter Stop sinnvoll?
4. **Size**: Ca. EUR 100 Risiko eingehalten?
5. **Verbesserung**: Bei Loss - konkreter Code-Fix?

Code-Vorschlag Format:
// KI-Vorschlag [${today}]: [Filter] - wegen [Problem]

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
