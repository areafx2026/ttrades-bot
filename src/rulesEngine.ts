import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

interface ParsedRule {
  raw: string;
  type: 'TIME_BLOCK' | 'TIME_RANGE_BLOCK' | 'MAX_TRADES' | 'WEEKEND_BLOCK' | 'NYSE_BUFFER' | 'UNKNOWN';
  // TIME_BLOCK / NYSE_BUFFER
  blockHour?: number;
  blockMinute?: number;
  bufferMinutes?: number;
  // TIME_RANGE_BLOCK
  fromHour?: number;
  fromMinute?: number;
  toHour?: number;
  toMinute?: number;
  // WEEKEND_BLOCK
  fridayFromHour?: number;
  fridayFromMinute?: number;
  mondayToHour?: number;
  mondayToMinute?: number;
  // MAX_TRADES
  maxTrades?: number;
}

let rules: ParsedRule[] = [];

// NYSE opens at 15:30 MEZ (14:30 UTC in winter, 15:30 in summer)
// We use 15:30 MEZ as the reference — DST handled by MEZ time
const NYSE_OPEN_MEZ = { h: 15, m: 30 };

function parseTime(str: string): { h: number; m: number } | null {
  const match = str.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return { h: parseInt(match[1]), m: parseInt(match[2]) };
}

function parseRule(raw: string): ParsedRule {
  const lower = raw.toLowerCase();

  // MAX_TRADES: "maximale anzahl ... trades: N"
  const maxMatch = lower.match(/maximale.*trades.*?:\s*(\d+)/);
  if (maxMatch) {
    return { raw, type: 'MAX_TRADES', maxTrades: parseInt(maxMatch[1]) };
  }

  // NYSE_BUFFER: "X minuten vor und nach" NYSE / nyse
  const nyseMatch = lower.match(/(\d+)\s*minuten?\s+vor\s+und\s+nach/);
  if (nyseMatch && (lower.includes('nyse') || lower.includes('nasdaq') || lower.includes('eroeffnung') || lower.includes('eröffnung'))) {
    return {
      raw,
      type: 'NYSE_BUFFER',
      blockHour: NYSE_OPEN_MEZ.h,
      blockMinute: NYSE_OPEN_MEZ.m,
      bufferMinutes: parseInt(nyseMatch[1]),
    };
  }

  // WEEKEND_BLOCK: "freitag HH:MM ... montag HH:MM"
  if (lower.includes('freitag') && lower.includes('montag')) {
    const times = [...raw.matchAll(/(\d{1,2}):(\d{2})/g)];
    if (times.length >= 2) {
      return {
        raw,
        type: 'WEEKEND_BLOCK',
        fridayFromHour:   parseInt(times[0][1]),
        fridayFromMinute: parseInt(times[0][2]),
        mondayToHour:     parseInt(times[1][1]),
        mondayToMinute:   parseInt(times[1][2]),
      };
    }
  }

  // TIME_RANGE_BLOCK: "zwischen HH:MM und HH:MM"
  const rangeMatch = lower.match(/zwischen\s+(\d{1,2}:\d{2})\s+und\s+(\d{1,2}:\d{2})/);
  if (rangeMatch) {
    const from = parseTime(rangeMatch[1]);
    const to   = parseTime(rangeMatch[2]);
    if (from && to) {
      return { raw, type: 'TIME_RANGE_BLOCK', fromHour: from.h, fromMinute: from.m, toHour: to.h, toMinute: to.m };
    }
  }

  // TIME_BLOCK: "um HH:MM"
  const timeMatch = lower.match(/um\s+(\d{1,2}:\d{2})/);
  if (timeMatch) {
    const t = parseTime(timeMatch[1]);
    if (t) return { raw, type: 'TIME_BLOCK', blockHour: t.h, blockMinute: t.m };
  }

  return { raw, type: 'UNKNOWN' };
}

export function loadRules(): void {
  const filePath = path.join(process.cwd(), 'rules.txt');
  if (!fs.existsSync(filePath)) {
    logger.warn('rules.txt not found — no trading rules loaded.');
    rules = [];
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  rules = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('-') || trimmed.startsWith('#')) {
      const ruleText = trimmed.replace(/^[-#]\s*/, '').trim();
      const parsed = parseRule(ruleText);
      rules.push(parsed);
      if (parsed.type !== 'UNKNOWN') {
        logger.info(`Rule loaded: [${parsed.type}] ${ruleText}`);
      } else {
        logger.warn(`Rule nicht erkannt: ${ruleText}`);
      }
    }
  }

  logger.info(`${rules.length} rules loaded from rules.txt`);
}

export function getMaxTrades(): number {
  const rule = rules.find(r => r.type === 'MAX_TRADES');
  return rule?.maxTrades ?? 99;
}

export function isBlockedByRules(nowMEZ: Date): { blocked: boolean; reason?: string } {
  const day      = nowMEZ.getDay(); // 0=So, 1=Mo ... 5=Fr, 6=Sa
  const hour     = nowMEZ.getHours();
  const min      = nowMEZ.getMinutes();
  const totalMin = hour * 60 + min;

  for (const rule of rules) {

    if (rule.type === 'NYSE_BUFFER') {
      const center = rule.blockHour! * 60 + rule.blockMinute!;
      const buffer = rule.bufferMinutes!;
      if (totalMin >= center - buffer && totalMin <= center + buffer) {
        return { blocked: true, reason: `NYSE Puffer (±${buffer}min um ${rule.blockHour}:${String(rule.blockMinute).padStart(2,'0')} MEZ): ${rule.raw}` };
      }
    }

    if (rule.type === 'WEEKEND_BLOCK') {
      const fridayFrom = rule.fridayFromHour! * 60 + rule.fridayFromMinute!;
      const mondayTo   = rule.mondayToHour!   * 60 + rule.mondayToMinute!;
      // Friday after fridayFrom
      if (day === 5 && totalMin >= fridayFrom) {
        return { blocked: true, reason: `Wochenend-Pause ab Fr ${rule.fridayFromHour}:${String(rule.fridayFromMinute).padStart(2,'0')}: ${rule.raw}` };
      }
      // Saturday all day
      if (day === 6) {
        return { blocked: true, reason: `Wochenend-Pause (Samstag): ${rule.raw}` };
      }
      // Sunday all day
      if (day === 0) {
        return { blocked: true, reason: `Wochenend-Pause (Sonntag): ${rule.raw}` };
      }
      // Monday before mondayTo
      if (day === 1 && totalMin < mondayTo) {
        return { blocked: true, reason: `Wochenend-Pause bis Mo ${rule.mondayToHour}:${String(rule.mondayToMinute).padStart(2,'0')}: ${rule.raw}` };
      }
    }

    if (rule.type === 'TIME_BLOCK') {
      const ruleMin = rule.blockHour! * 60 + rule.blockMinute!;
      if (Math.abs(totalMin - ruleMin) <= 5) {
        return { blocked: true, reason: `Zeitregel (±5min): ${rule.raw}` };
      }
    }

    if (rule.type === 'TIME_RANGE_BLOCK') {
      const from = rule.fromHour! * 60 + rule.fromMinute!;
      const to   = rule.toHour!   * 60 + rule.toMinute!;
      if (totalMin >= from && totalMin <= to) {
        return { blocked: true, reason: `Zeitbereich gesperrt: ${rule.raw}` };
      }
    }
  }

  return { blocked: false };
}
