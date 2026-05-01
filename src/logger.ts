import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const MAX_LOG_FILES = 7;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getLogFile(): string {
  const date = new Date().toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).replace(/\./g, '-');
  return path.join(LOG_DIR, `bot-${date}.log`);
}

function rotateLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
      .map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);
    for (const file of files.slice(MAX_LOG_FILES)) {
      fs.unlinkSync(path.join(LOG_DIR, file.name));
    }
  } catch { /* ignore */ }
}

function writeToFile(line: string): void {
  try { fs.appendFileSync(getLogFile(), line + '\n', 'utf-8'); } catch { /* ignore */ }
}

rotateLogs();

const timestamp = () => new Date().toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// Kategorie-Breite: 5 Zeichen für saubere Ausrichtung
// SCAN  — Symbol analysiert, kein/ablehnendes Setup
// SETUP — vollständiges Signal gefunden
// TRADE — Trade geöffnet oder geschlossen
// RISK  — Lot-Berechnung, SL/TP/RR Details
// SYNC  — MT5-Sync, Positionen, History
// SYS   — Bot-Start, Verbindung, Konfiguration
// WARN  — Warnungen
// ERROR — Fehler

function log(category: string, msg: string, args: any[]): string {
  const cat = category.padEnd(5).slice(0, 5);
  const extra = args.length
    ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
    : '';
  return `[${timestamp()}] ${cat} ${msg}${extra}`;
}

export const logger = {
  // Standard-Levels (Kompatibilität mit bestehendem Code)
  info:  (msg: string, ...args: any[]) => { const l = log('INFO', msg, args); console.log(l);   writeToFile(l); },
  warn:  (msg: string, ...args: any[]) => { const l = log('WARN', msg, args); console.warn(l);  writeToFile(l); },
  error: (msg: string, ...args: any[]) => { const l = log('ERROR', msg, args); console.error(l); writeToFile(l); },

  // Neue Kategorien
  scan:  (msg: string, ...args: any[]) => { const l = log('SCAN', msg, args);  console.log(l);  writeToFile(l); },
  setup: (msg: string, ...args: any[]) => { const l = log('SETUP', msg, args); console.log(l);  writeToFile(l); },
  trade: (msg: string, ...args: any[]) => { const l = log('TRADE', msg, args); console.log(l);  writeToFile(l); },
  risk:  (msg: string, ...args: any[]) => { const l = log('RISK', msg, args);  console.log(l);  writeToFile(l); },
  sync:  (msg: string, ...args: any[]) => { const l = log('SYNC', msg, args);  console.log(l);  writeToFile(l); },
  sys:   (msg: string, ...args: any[]) => { const l = log('SYS', msg, args);   console.log(l);  writeToFile(l); },
};
