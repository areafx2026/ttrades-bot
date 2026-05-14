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
  try {
    fs.appendFileSync(getLogFile(), line + '\n', 'utf-8');
  } catch { /* ignore */ }
}

rotateLogs();

const timestamp = () => new Date().toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

// ─── Konsolen-Filter ──────────────────────────────────────────────────────────
// Nur diese Kategorien erscheinen in der Konsole (Live-Monitoring)
// Alles andere geht nur ins File-Log
const CONSOLE_CATEGORIES = new Set(['SETUP', 'TRADE', 'RISK', 'ERROR', 'WARN']);

function log(category: string, label: string, msg: string, args: any[]): void {
  const extra = args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : '';
  const line = `[${timestamp()}] ${label} ${msg}${extra}`;

  // Immer ins File
  writeToFile(line);

  // Konsole nur für relevante Kategorien
  if (CONSOLE_CATEGORIES.has(category)) {
    if (category === 'ERROR') console.error(line);
    else if (category === 'WARN') console.warn(line);
    else console.log(line);
  }
}

export const logger = {
  // Trade-relevante Kategorien → Konsole + File
  setup:  (msg: string, ...args: any[]) => log('SETUP', 'SETUP', msg, args),
  trade:  (msg: string, ...args: any[]) => log('TRADE', 'TRADE', msg, args),
  risk:   (msg: string, ...args: any[]) => log('RISK',  'RISK ', msg, args),
  warn:   (msg: string, ...args: any[]) => log('WARN',  'WARN ', msg, args),
  error:  (msg: string, ...args: any[]) => log('ERROR', 'ERROR', msg, args),

  // Nur File
  sys:    (msg: string, ...args: any[]) => log('SYS',   'SYS  ', msg, args),
  scan:   (msg: string, ...args: any[]) => log('SCAN',  'SCAN ', msg, args),
  sync:   (msg: string, ...args: any[]) => log('SYNC',  'SYNC ', msg, args),
  info:   (msg: string, ...args: any[]) => log('INFO',  'INFO ', msg, args),
};
