import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const MAX_LOG_FILES = 7; // keep 7 days

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getLogFile(): string {
  const date = new Date().toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric',
  }).replace(/\./g, '-'); // DD-MM-YYYY
  return path.join(LOG_DIR, `bot-${date}.log`);
}

function rotateLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('bot-') && f.endsWith('.log'))
      .map(f => ({ name: f, time: fs.statSync(path.join(LOG_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    // Delete files older than MAX_LOG_FILES
    for (const file of files.slice(MAX_LOG_FILES)) {
      fs.unlinkSync(path.join(LOG_DIR, file.name));
    }
  } catch { /* ignore rotation errors */ }
}

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(getLogFile(), line + '\n', 'utf-8');
  } catch { /* ignore file write errors */ }
}

// Rotate on startup
rotateLogs();

const timestamp = () => new Date().toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export const logger = {
  info: (msg: string, ...args: any[]) => {
    const line = `[${timestamp()}] INFO  ${msg}${args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : ''}`;
    console.log(line);
    writeToFile(line);
  },
  warn: (msg: string, ...args: any[]) => {
    const line = `[${timestamp()}] WARN  ${msg}${args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : ''}`;
    console.warn(line);
    writeToFile(line);
  },
  error: (msg: string, ...args: any[]) => {
    const line = `[${timestamp()}] ERROR ${msg}${args.length ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') : ''}`;
    console.error(line);
    writeToFile(line);
  },
};
