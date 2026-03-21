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

  const prompt = `Du bist ein erfahrener Forex-Trader und Trading-Coach der das TTrades Fractal Model (TTFM) analysiert.

Du erhältst die Trades des heutigen Handelstages und sollst eine ehrliche, konstruktive Analyse auf Deutsch liefern.

## Heutige Trades:
${tradeDetails}

## Aktuelles Regelwerk (rules.txt):
${currentRules}

## Deine Aufgabe:

Analysiere jeden Trade nach diesen Kriterien:
1. **Struktur-Analyse**: War die Candle-Nummerierung (C2/C3/C4) korrekt erkannt?
2. **Entry-Timing**: War der Entry zu früh (vor CISD-Bestätigung) oder zu spät?
3. **Stop-Abstand**: War der Stop zu eng für das jeweilige Pair und den Timeframe?
4. **Daily Bias**: Passte der Daily Bias zur übergeordneten Struktur?
5. **Marktbedingungen**: Gab es bekannte News-Ereignisse oder ungewöhnliche Volatilität?

Dann:
6. **Regelwerk-Vorschlag**: Wenn ein Trade-Problem durch eine neue Regel verhindert werden könnte, formuliere einen konkreten Vorschlag.
   Format: // KI-Vorschlag [${today}]: [Regel] — wegen [Trade-Problem]

Sei direkt und ehrlich. Maximal 500 Wörter.`;

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
