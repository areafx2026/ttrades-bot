"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeTradesWithAI = analyzeTradesWithAI;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const axios_1 = __importDefault(require("axios"));
const tradeLogger_1 = require("./tradeLogger");
const logger_1 = require("./logger");
function formatTrade(t) {
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
function loadCurrentRules() {
    const filePath = path.join(process.cwd(), 'rules.txt');
    if (!fs.existsSync(filePath))
        return '(keine rules.txt gefunden)';
    return fs.readFileSync(filePath, 'utf-8');
}
function appendRuleComment(comment) {
    const filePath = path.join(process.cwd(), 'rules.txt');
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + comment + '\n', 'utf-8');
    logger_1.logger.info('KI-Regelvorschlag in rules.txt geschrieben');
}
async function analyzeTradesWithAI() {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTrades = (0, tradeLogger_1.loadTrades)().filter(t => t.closedAt && new Date(t.closedAt) >= windowStart);
    if (recentTrades.length === 0) {
        logger_1.logger.info('AI analysis: no closed trades in last 24h, skipping.');
        return null;
    }
    const currentRules = loadCurrentRules();
    const today = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
    const tradeDetails = recentTrades.map((t, i) => `--- Trade ${i + 1} ---\n${formatTrade(t)}`).join('\n\n');
    const prompt = `Du analysierst die Trades eines vollautomatischen Forex-Trading-Bots (TTrades Fractal Model / TTFM).
Es gibt keinen menschlichen Trader - alle Trades werden algorithmisch ausgefuehrt.
Bewerte ausschliesslich ob der Bot-Algorithmus korrekt funktioniert hat, nicht menschliches Verhalten.

## Wichtige Hinweise:
- Kurze Haltezeiten sind KEIN Zeichen von Impulsivitaet - sie entstehen durch Bot-Bugs (z.B. SL/TP zu nah, Size-Fehler)
- Regelwerk-Verletzungen bedeuten dass ein Filter im Code fehlt oder versagt hat, nicht Disziplinlosigkeit
- Analysiere ob vorhandene Filter (Currency Strength, S/R Zonen, Entry Distance, TP/D1 Distance) gegriffen haben
- Wenn ein Filter haette greifen sollen aber nicht hat, ist das ein Code-Problem

## Heutige Trades:
${tradeDetails}

## Aktuelles Regelwerk (rules.txt):
${currentRules}

## Deine Aufgabe:

Analysiere jeden Trade nach diesen Kriterien:
1. **Signal-Qualitaet**: War das Setup gueltig? (Daily Bias, 4H Trend, H1 Entry alle aligned?)
2. **Filter-Check**: Welche Filter haben gegriffen, welche haetten greifen sollen aber nicht haben?
3. **Stop-Abstand**: War der Stop sinnvoll fuer das Pair und den Timeframe?
4. **Size-Berechnung**: War die Positionsgroesse korrekt (max 5000 Points)?
5. **Ergebnis-Analyse**: Bei Loss - haette ein bestehender Filter den Trade verhindert?

Dann:
6. **Code-Vorschlag**: Wenn ein Trade durch einen neuen Filter haette verhindert werden koennen:
   Format: // KI-Vorschlag [${today}]: [Filter/Regel] - wegen [technischem Problem beim Trade]

Sei direkt und technisch. Maximal 500 Woerter.`;
    try {
        logger_1.logger.info('Sending trades to Claude for analysis...');
        const response = await axios_1.default.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }],
        }, {
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
        });
        const blocks = response.data.content;
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
            logger_1.logger.info(`${ruleMatches.length} Regelvorschlag/Vorschläge in rules.txt eingetragen`);
        }
        return analysis;
    }
    catch (err) {
        logger_1.logger.error('AI analysis error:', err.response?.data || err.message);
        return null;
    }
}
