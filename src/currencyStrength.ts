import { MT5API } from './mt5Api';
import { logger } from './logger';

const STRENGTH_PAIRS: { epic: string; base: string; quote: string }[] = [
  { epic: 'EURUSD', base: 'EUR', quote: 'USD' },
  { epic: 'GBPUSD', base: 'GBP', quote: 'USD' },
  { epic: 'USDJPY', base: 'USD', quote: 'JPY' },
  { epic: 'USDCHF', base: 'USD', quote: 'CHF' },
  { epic: 'USDCAD', base: 'USD', quote: 'CAD' },
  { epic: 'AUDUSD', base: 'AUD', quote: 'USD' },
  { epic: 'NZDUSD', base: 'NZD', quote: 'USD' },
  { epic: 'EURGBP', base: 'EUR', quote: 'GBP' },
  { epic: 'EURJPY', base: 'EUR', quote: 'JPY' },
  { epic: 'EURCHF', base: 'EUR', quote: 'CHF' },
  { epic: 'EURCAD', base: 'EUR', quote: 'CAD' },
  { epic: 'EURAUD', base: 'EUR', quote: 'AUD' },
  { epic: 'EURNZD', base: 'EUR', quote: 'NZD' },
  { epic: 'GBPJPY', base: 'GBP', quote: 'JPY' },
  { epic: 'GBPCHF', base: 'GBP', quote: 'CHF' },
  { epic: 'GBPAUD', base: 'GBP', quote: 'AUD' },
  { epic: 'GBPCAD', base: 'GBP', quote: 'CAD' },
  { epic: 'AUDJPY', base: 'AUD', quote: 'JPY' },
  { epic: 'AUDCAD', base: 'AUD', quote: 'CAD' },
  { epic: 'AUDNZD', base: 'AUD', quote: 'NZD' },
  { epic: 'CADJPY', base: 'CAD', quote: 'JPY' },
  { epic: 'CHFJPY', base: 'CHF', quote: 'JPY' },
  { epic: 'NZDJPY', base: 'NZD', quote: 'JPY' },
];

export interface StrengthResult {
  scores: Record<string, number>;
  ranked: string[];
  strong: string[];
  weak: string[];
  timestamp: Date;
}

let cachedStrength: StrengthResult | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getCurrencyStrength(mt5: MT5API): Promise<StrengthResult> {
  if (cachedStrength && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedStrength;
  }

  const currencies = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
  const scores: Record<string, number> = {};
  currencies.forEach(c => scores[c] = 0);

  let successCount = 0;

  for (const pair of STRENGTH_PAIRS) {
    try {
      const candles = await mt5.getCandles(pair.epic, 'HOUR', 24);
      await new Promise(r => setTimeout(r, 50));

      if (candles.length < 2) continue;

      const open  = candles[0].open;
      const close = candles[candles.length - 1].close;
      const pip   = pair.epic.includes('JPY') ? 0.01 : 0.0001;
      const change = (close - open) / pip;

      scores[pair.base]  += change;
      scores[pair.quote] -= change;

      successCount++;
    } catch {
      // Skip pairs that fail silently
    }
  }

  const appearances: Record<string, number> = {};
  currencies.forEach(c => appearances[c] = 0);
  STRENGTH_PAIRS.forEach(p => {
    appearances[p.base]++;
    appearances[p.quote]++;
  });
  currencies.forEach(c => {
    if (appearances[c] > 0) scores[c] = scores[c] / appearances[c];
  });

  const ranked = [...currencies].sort((a, b) => scores[b] - scores[a]);
  const strong = ranked.slice(0, 2);
  const weak   = ranked.slice(-2);

  const result: StrengthResult = { scores, ranked, strong, weak, timestamp: new Date() };

  cachedStrength = result;
  cacheTime = Date.now();

  logger.sys(`Currency strength updated (${successCount} pairs): Strong=${strong.join('/')} Weak=${weak.join('/')}`);
  return result;
}

export function isStrengthAligned(
  symbol: string,
  direction: 'LONG' | 'SHORT',
  strength: StrengthResult
): { aligned: boolean; reason: string } {
  const base  = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  const baseRank  = strength.ranked.indexOf(base);
  const quoteRank = strength.ranked.indexOf(quote);

  if (direction === 'LONG') {
    const baseStrong = strength.strong.includes(base);
    const quoteWeak  = strength.weak.includes(quote);
    if (baseStrong && quoteWeak) return { aligned: true, reason: `${base} stark (#${baseRank + 1}) + ${quote} schwach (#${quoteRank + 1})` };
    if (baseStrong) return { aligned: false, reason: `${base} stark aber ${quote} nicht schwach genug (#${quoteRank + 1})` };
    if (quoteWeak)  return { aligned: false, reason: `${quote} schwach aber ${base} nicht stark genug (#${baseRank + 1})` };
    return { aligned: false, reason: `${base} (#${baseRank + 1}) nicht stark, ${quote} (#${quoteRank + 1}) nicht schwach` };
  } else {
    const baseWeak    = strength.weak.includes(base);
    const quoteStrong = strength.strong.includes(quote);
    if (baseWeak && quoteStrong) return { aligned: true, reason: `${base} schwach (#${baseRank + 1}) + ${quote} stark (#${quoteRank + 1})` };
    if (baseWeak)    return { aligned: false, reason: `${base} schwach aber ${quote} nicht stark genug (#${quoteRank + 1})` };
    if (quoteStrong) return { aligned: false, reason: `${quote} stark aber ${base} nicht schwach genug (#${baseRank + 1})` };
    return { aligned: false, reason: `${base} (#${baseRank + 1}) nicht schwach, ${quote} (#${quoteRank + 1}) nicht stark` };
  }
}

export function invalidateStrengthCache(): void {
  cachedStrength = null;
  cacheTime = 0;
}
