import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

interface CachedSignal {
  symbol: string;
  type: string;
  phase: string;
  timestamp: number;
}

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_FILE = path.join(process.cwd(), 'data', 'signal_cache.json');

function ensureDir(): void {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadCache(): Map<string, CachedSignal> {
  ensureDir();
  if (!fs.existsSync(CACHE_FILE)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CachedSignal>;
    const map = new Map<string, CachedSignal>();
    const now = Date.now();
    for (const [key, entry] of Object.entries(raw)) {
      // Only load entries that are still within TTL
      if (now - entry.timestamp < CACHE_TTL_MS) {
        map.set(key, entry);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CachedSignal>): void {
  ensureDir();
  const obj: Record<string, CachedSignal> = {};
  for (const [key, entry] of cache.entries()) {
    obj[key] = entry;
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

// Load cache from disk on module init
const cache = loadCache();
logger.info(`Signal cache loaded: ${cache.size} active entries`);

export function isDuplicate(symbol: string, type: string, phase: string): boolean {
  const key = `${symbol}_${type}_${phase}`;
  const cached = cache.get(key);
  if (!cached) return false;

  const age = Date.now() - cached.timestamp;
  if (age > CACHE_TTL_MS) {
    cache.delete(key);
    saveCache(cache);
    return false;
  }
  return true;
}

export function cacheSignal(symbol: string, type: string, phase: string): void {
  const key = `${symbol}_${type}_${phase}`;
  cache.set(key, { symbol, type, phase, timestamp: Date.now() });
  saveCache(cache);
}

export function clearCache(): void {
  cache.clear();
  saveCache(cache);
}
