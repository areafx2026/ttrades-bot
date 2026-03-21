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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDuplicate = isDuplicate;
exports.cacheSignal = cacheSignal;
exports.clearCache = clearCache;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_FILE = path.join(process.cwd(), 'data', 'signal_cache.json');
function ensureDir() {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
function loadCache() {
    ensureDir();
    if (!fs.existsSync(CACHE_FILE))
        return new Map();
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        const map = new Map();
        const now = Date.now();
        for (const [key, entry] of Object.entries(raw)) {
            // Only load entries that are still within TTL
            if (now - entry.timestamp < CACHE_TTL_MS) {
                map.set(key, entry);
            }
        }
        return map;
    }
    catch {
        return new Map();
    }
}
function saveCache(cache) {
    ensureDir();
    const obj = {};
    for (const [key, entry] of cache.entries()) {
        obj[key] = entry;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}
// Load cache from disk on module init
const cache = loadCache();
logger_1.logger.info(`Signal cache loaded: ${cache.size} active entries`);
function isDuplicate(symbol, type, phase) {
    const key = `${symbol}_${type}_${phase}`;
    const cached = cache.get(key);
    if (!cached)
        return false;
    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL_MS) {
        cache.delete(key);
        saveCache(cache);
        return false;
    }
    return true;
}
function cacheSignal(symbol, type, phase) {
    const key = `${symbol}_${type}_${phase}`;
    cache.set(key, { symbol, type, phase, timestamp: Date.now() });
    saveCache(cache);
}
function clearCache() {
    cache.clear();
    saveCache(cache);
}
